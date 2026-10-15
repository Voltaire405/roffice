const crypto = require("crypto");
const { isSupportedFileType, documentKey, buildEditorConfig } = require("./onlyoffice");
const { logger } = require("./logger");

const SESSION_TTL_SECONDS = 60 * 60 * 24;
const LAUNCH_TOKEN_TTL_SECONDS = 60;

/**
 * Error de la sesión de edición con un código de dominio; las rutas lo traducen a HTTP.
 * Códigos: invalid_request · link_expired · tab_forbidden · file_not_found · not_open · open_failed · save_failed · command_failed
 */
class SessionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * @typedef {Object} OpenRequest
 * @property {string} docId
 * @property {string} version
 * @property {string} fileType
 * @property {string} getUrl
 * @property {{ id: string, name: string }} user
 * @property {string} [title]
 * @property {string} [returnUrl]
 * @property {Object} [permissions]
 */

/**
 * @typedef {Object} SessionRecord - `key:<documentKey>`, una por sesión de OnlyOffice
 * @property {string} tenant
 * @property {string} docId
 * @property {string} version - versión del documento al abrir la sesión
 * @property {string} fileType
 * @property {string} fileToken - token opaco del proxy /files/:fileToken
 */

function isHttpUrl(value) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function validateOpenRequest({ docId, version, fileType, getUrl, user, returnUrl }) {
  if (typeof docId !== "string" || !docId) return "docId requerido";
  if (typeof version !== "string" || !version) return "version requerida";
  if (!isSupportedFileType(fileType)) return "fileType no soportado";
  if (!isHttpUrl(getUrl)) return "getUrl debe ser una URL http(s)";
  if (typeof user?.id !== "string" || typeof user?.name !== "string") return "user.id y user.name requeridos";
  if (returnUrl !== undefined && !isHttpUrl(returnUrl)) return "returnUrl debe ser una URL http(s)";
  return null;
}

function sameSecret(a, b) {
  return typeof a === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Documentos abiertos por un usuario, del más reciente al más antiguo. Reabrir uno lo sube al frente;
 * los que quedan fuera del límite se devuelven en `evicted` para desconectar al usuario de ellos.
 */
function trackOpenDocument(openDocs, opened, limit) {
  const others = openDocs.filter((doc) => doc.docRef !== opened.docRef);
  return { open: [opened, ...others].slice(0, limit), evicted: others.slice(limit - 1) };
}

const docRefOf = (tenant, docId) => `${tenant}:${docId}`;

/**
 * Ciclo de la sesión de edición: abrir (o unirse), canjear el enlace de un solo uso por la pestaña,
 * servir el documento a OnlyOffice, procesar sus callbacks y forzar guardados.
 * Es dueña de las claves Redis key:, file:, tab:, launch: y user:; `doc:` es del pool.
 * @param {Object} deps
 * @param {import("ioredis").Redis} deps.redis
 * @param {ReturnType<typeof import("./pool").createPool>} deps.pool
 * @param {(instanceUrl: string, command: Object) => Promise<{status: number, body: string}>} deps.sendCommand - CommandService de OnlyOffice
 * @param {(session: SessionRecord, downloadUrl: string) => Promise<void>} deps.saveToTenant - sube la versión editada al storage del tenant
 * @param {string} deps.jwtSecret - secreto compartido con OnlyOffice
 * @param {string} deps.backendUrl - URL de Roffice vista por los contenedores de OnlyOffice
 * @param {number} deps.maxDocsPerUser - documentos abiertos a la vez por usuario; abrir otro desconecta del más antiguo
 */
function createEditSessions({ redis, pool, sendCommand, saveToTenant, jwtSecret, backendUrl, maxDocsPerUser }) {
  const setJson = (key, value, ttl = SESSION_TTL_SECONDS) => redis.set(key, JSON.stringify(value), "EX", ttl);
  const getJson = async (key) => {
    const value = await redis.get(key);
    return value ? JSON.parse(value) : null;
  };

  async function getSessionRecord(key) {
    try {
      return await getJson(`key:${key}`);
    } catch {
      // Valor de la versión anterior (key → filename en texto plano): no es una sesión de este formato.
      return null;
    }
  }

  async function closeSession(key, session) {
    await pool.release(docRefOf(session.tenant, session.docId));
    await redis.del(`key:${key}`, `file:${session.fileToken}`);
  }

  async function dropUser({ docRef, key, instanceUrl }, userId) {
    try {
      const { body } = await sendCommand(instanceUrl, { c: "drop", key, users: [userId] });
      logger.info("Sessions", "Usuario desconectado del documento anterior", { docRef, key, error: JSON.parse(body).error });
    } catch (err) {
      logger.warn("Sessions", "No se pudo desconectar al usuario del documento anterior", { docRef, error: err.message });
    }
  }

  /** Registra la apertura y desconecta al usuario de los documentos que exceden maxDocsPerUser. */
  async function limitOpenDocuments(userRef, userId, opened) {
    const live = [];
    // Una sesión cerrada por callback (status 2/4) deja la entrada en el índice: solo cuenta si su key sigue activa.
    // ponytail: un usuario que cerró su pestaña mientras otros siguen editando aún cuenta hasta su siguiente apertura.
    for (const doc of (await getJson(`user:${userRef}`)) ?? []) {
      if ((await pool.lookup(doc.docRef))?.documentKey === doc.key) live.push(doc);
    }

    const { open, evicted } = trackOpenDocument(live, opened, maxDocsPerUser);
    await setJson(`user:${userRef}`, open);
    const reopened = live.find((doc) => doc.docRef === opened.docRef);
    if (reopened) await redis.del(`tab:${reopened.tabId}`);
    for (const doc of evicted) {
      await redis.del(`tab:${doc.tabId}`);
      dropUser(doc, userId);
    }
  }

  /**
   * Abre la sesión de edición del documento, o une al usuario a la abierta.
   * @param {string} tenant - client_id (azp) del backend que pide la apertura
   * @param {OpenRequest} request
   * @returns {Promise<{ launchToken: string, expiresIn: number }>} enlace de un solo uso a la pestaña
   */
  async function open(tenant, request) {
    const problem = validateOpenRequest(request);
    if (problem) throw new SessionError("invalid_request", problem);

    const { docId, version, fileType, getUrl, user, returnUrl, permissions = {} } = request;
    const docRef = docRefOf(tenant, docId);

    try {
      // Quien se une a una sesión abierta debe recibir la misma key aunque un forcesave
      // ya haya cambiado la versión en el storage; si no, OnlyOffice abre otra sesión.
      // ponytail: una edición externa del documento con la sesión abierta no rota la key hasta status 2/4 o el TTL de 24 h.
      const { instanceUrl, publicUrl, documentKey: key, joined } = await pool.assign(docRef, documentKey(docRef, version));

      let session = await getSessionRecord(key);
      if (!session) {
        session = { tenant, docId, version, fileType, fileToken: crypto.randomUUID() };
        await setJson(`key:${key}`, session);
      }
      // Cada apertura renueva la getUrl: la del primer editor pudo expirar si OnlyOffice aún no la descargó.
      await redis.set(`file:${session.fileToken}`, getUrl, "EX", SESSION_TTL_SECONDS);

      const config = buildEditorConfig({
        key,
        title: request.title || `${docId}.${fileType}`,
        fileType: session.fileType,
        fileUrl: `${backendUrl}/files/${session.fileToken}`,
        callbackUrl: `${backendUrl}/api/callback`,
        user,
        permissions,
        returnUrl,
        secret: jwtSecret,
      });

      const tabId = crypto.randomUUID();
      const launchToken = crypto.randomBytes(32).toString("base64url");
      await setJson(`tab:${tabId}`, { config, publicUrl, cookieSecret: crypto.randomBytes(32).toString("base64url") });
      await redis.set(`launch:${launchToken}`, tabId, "EX", LAUNCH_TOKEN_TTL_SECONDS);
      await limitOpenDocuments(`${tenant}:${user.id}`, user.id, { docRef, key, instanceUrl, tabId });

      logger.info("Sessions", "Sesión de edición entregada", { docRef, instance: instanceUrl, key, joined });
      return { launchToken, expiresIn: LAUNCH_TOKEN_TTL_SECONDS };
    } catch (err) {
      logger.error("Sessions", "Error abriendo sesión", { docRef, error: err.message });
      throw new SessionError("open_failed", "No se pudo abrir la sesión de edición");
    }
  }

  /**
   * Canjea el enlace de un solo uso: GETDEL lo invalida de forma atómica aunque lleguen dos canjes a la vez.
   * @returns {Promise<{ tabId: string, cookieSecret: string, expiresIn: number }>} la cookie que habilita la pestaña
   */
  async function redeemLaunch(launchToken) {
    const tabId = await redis.getdel(`launch:${launchToken}`);
    const tab = tabId && (await getJson(`tab:${tabId}`));
    if (!tab) throw new SessionError("link_expired", "El enlace expiró o ya se usó. Vuelve a abrir el documento desde la aplicación.");
    return { tabId, cookieSecret: tab.cookieSecret, expiresIn: SESSION_TTL_SECONDS };
  }

  /** @returns {Promise<{ config: Object, publicUrl: string }>} config firmado del editor y URL pública de su instancia */
  async function getTab(tabId, cookieSecret) {
    const tab = await getJson(`tab:${tabId}`);
    if (!tab || !sameSecret(cookieSecret, tab.cookieSecret)) {
      throw new SessionError("tab_forbidden", "Esta pestaña no tiene acceso al documento. Vuelve a abrirlo desde la aplicación.");
    }
    return { config: tab.config, publicUrl: tab.publicUrl };
  }

  /** @returns {Promise<string>} getUrl del tenant para el token opaco que OnlyOffice recibió en el config */
  async function fileSource(fileToken) {
    const getUrl = await redis.get(`file:${fileToken}`);
    if (!getUrl) throw new SessionError("file_not_found", "Archivo no encontrado");
    return getUrl;
  }

  /**
   * Procesa un callback ya verificado de OnlyOffice:
   * 2 - listo para guardar (todos cerraron) · 4 - cerrado sin cambios · 6 - forcesave.
   * Un guardado fallido lanza save_failed y conserva la sesión para que OnlyOffice reintente.
   */
  async function handleCallback({ status, key, url, users }) {
    logger.info("Callback", "Callback recibido", { status, key, users });
    const session = await getSessionRecord(key);
    if (!session) {
      logger.warn("Callback", "Sin sesión para la key", { key });
      return;
    }

    try {
      if (status === 2 || status === 6) {
        await saveToTenant(session, url);
        logger.info("Callback", "Documento guardado en el storage del cliente", { tenant: session.tenant, docId: session.docId, status });
      }
      if (status === 2 || status === 4) await closeSession(key, session);
    } catch (err) {
      logger.error("Callback", "Error guardando en el storage del cliente", { tenant: session.tenant, docId: session.docId, error: err.message });
      throw new SessionError("save_failed", err.message);
    }
  }

  /** @returns {Promise<{ status: number, body: string }>} respuesta del CommandService de OnlyOffice, tal cual */
  async function forcesave(tenant, docId) {
    const active = await pool.lookup(docRefOf(tenant, docId));
    if (!active) throw new SessionError("not_open", "El documento no tiene sesión abierta");

    try {
      return await sendCommand(active.instanceUrl, { c: "forcesave", key: active.documentKey });
    } catch (err) {
      logger.error("Forcesave", "Error", { docId, error: err.message });
      throw new SessionError("command_failed", err.message);
    }
  }

  return { open, redeemLaunch, getTab, fileSource, handleCallback, forcesave };
}

module.exports = { createEditSessions, SessionError };
