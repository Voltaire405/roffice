const crypto = require("crypto");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const express = require("express");
const jwt = require("jsonwebtoken");
const { isSupportedFileType, mimeType, documentKey, buildEditorConfig, verifyCallback, renderEditorPage } = require("./onlyoffice");
const { trackOpenDocument } = require("./open-documents");
const { logger, requestLogger } = require("./logger");

const LAUNCH_TOKEN_TTL_SECONDS = 60;
const TAB_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24;

/**
 * Rutas HTTP de Roffice, sin efectos al importar: el cableado (env, Redis, timers, listen) vive en main.js.
 * TENANTS: client_id (azp) autorizado → { saveUrl }. La saveUrl es configuración de Roffice, no del request,
 * para no enviar su token de servicio a URLs arbitrarias.
 */
function createApp({ TENANTS, JWT_SECRET, BACKEND_URL, PUBLIC_URL, MAX_DOCS_PER_USER, oidc, store, instanceManager }) {
  const app = express();
  app.use(requestLogger);
  app.use(express.json());

  // ── Autenticación de servicio (backend del cliente → Roffice) ─

  async function requireServiceToken(req, res, next) {
    const token = req.get("Authorization")?.replace(/^Bearer /, "");
    if (!token) return res.status(401).json({ error: "Falta token de servicio" });

    try {
      const claims = await oidc.verifyServiceToken(token);
      if (!Object.hasOwn(TENANTS, claims.azp)) {
        logger.warn("Auth", "Cliente no registrado en TENANTS", { azp: claims.azp });
        return res.status(403).json({ error: "Cliente no autorizado" });
      }
      req.tenant = claims.azp;
      next();
    } catch (err) {
      logger.warn("Auth", "Token de servicio rechazado", { error: err.message });
      res.status(401).json({ error: "Token de servicio inválido" });
    }
  }

  // ── Helpers ──────────────────────────────────────────────────

  function isHttpUrl(value) {
    try {
      return ["http:", "https:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }

  function validateSessionRequest({ docId, version, fileType, getUrl, user, returnUrl }) {
    if (typeof docId !== "string" || !docId) return "docId requerido";
    if (typeof version !== "string" || !version) return "version requerida";
    if (!isSupportedFileType(fileType)) return "fileType no soportado";
    if (!isHttpUrl(getUrl)) return "getUrl debe ser una URL http(s)";
    if (typeof user?.id !== "string" || typeof user?.name !== "string") return "user.id y user.name requeridos";
    if (returnUrl !== undefined && !isHttpUrl(returnUrl)) return "returnUrl debe ser una URL http(s)";
    return null;
  }

  function readTabCookie(req) {
    return req.get("Cookie")?.match(/(?:^|;\s*)roffice_tab=([^;]+)/)?.[1];
  }

  function sameSecret(a, b) {
    return typeof a === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }

  function sendEditorError(res, status, message) {
    res.status(status).type("html").send(`<!doctype html><meta charset="utf-8"><title>Roffice</title><p>${message}</p>`);
  }

  const docRefOf = (tenant, docId) => `${tenant}:${docId}`;

  /** Descarga la versión editada de OnlyOffice y la sube con un PUT prefirmado que el cliente emite en ese momento. */
  async function saveToClient({ tenant, docId, version, fileType }, downloadUrl) {
    const download = await fetch(downloadUrl);
    if (!download.ok) throw new Error(`Descarga desde OnlyOffice respondió ${download.status}`);
    const file = Buffer.from(await download.arrayBuffer());
    const contentType = mimeType(fileType);

    const grant = await fetch(TENANTS[tenant].saveUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${await oidc.getServiceToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ docId, version, contentType }),
    });
    if (!grant.ok) throw new Error(`saveUrl de ${tenant} respondió ${grant.status}`);
    const { putUrl } = await grant.json();
    if (!isHttpUrl(putUrl)) throw new Error(`saveUrl de ${tenant} no devolvió putUrl`);

    const upload = await fetch(putUrl, { method: "PUT", headers: { "Content-Type": contentType }, body: file });
    if (!upload.ok) throw new Error(`PUT al storage de ${tenant} respondió ${upload.status}`);
  }

  function sendCommand(instanceUrl, command) {
    const token = jwt.sign(command, JWT_SECRET);
    return fetch(`${instanceUrl}/coauthoring/CommandService.ashx`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...command, token }),
    });
  }

  /** Registra la apertura y desconecta al usuario de los documentos que exceden MAX_DOCS_PER_USER. */
  async function limitOpenDocuments(userRef, userId, opened) {
    const live = [];
    // Una sesión cerrada por callback (status 2/4) deja la entrada en el índice: solo cuenta si su key sigue activa.
    // ponytail: un usuario que cerró su pestaña mientras otros siguen editando aún cuenta hasta su siguiente apertura.
    for (const doc of await store.getOpenDocuments(userRef)) {
      const active = await store.getDocumentInstance(doc.docRef);
      if (active?.documentKey === doc.key) live.push(doc);
    }

    const { open, evicted } = trackOpenDocument(live, opened, MAX_DOCS_PER_USER);
    await store.setOpenDocuments(userRef, open);
    const reopened = live.find((doc) => doc.docRef === opened.docRef);
    if (reopened) await store.removeEditorTab(reopened.tabId);
    for (const doc of evicted) {
      await store.removeEditorTab(doc.tabId);
      dropUser(doc, userId);
    }
  }

  async function dropUser({ docRef, key, instanceUrl }, userId) {
    try {
      const { error } = await (await sendCommand(instanceUrl, { c: "drop", key, users: [userId] })).json();
      logger.info("Sessions", "Usuario desconectado del documento anterior", { docRef, key, error });
    } catch (err) {
      logger.warn("Sessions", "No se pudo desconectar al usuario del documento anterior", { docRef, error: err.message });
    }
  }

  async function closeSession(key, session) {
    await store.removeDocumentAssignment(docRefOf(session.tenant, session.docId));
    await store.removeKeySession(key);
    await store.removeFileSource(session.fileToken);
  }

  // ── Rutas ────────────────────────────────────────────────────

  // Abre (o se une a) la sesión de edición de un documento del cliente.
  app.post("/api/sessions", requireServiceToken, async (req, res) => {
    const problem = validateSessionRequest(req.body);
    if (problem) return res.status(400).json({ error: problem });

    const { docId, version, fileType, getUrl, user, returnUrl, permissions = {} } = req.body;
    const title = req.body.title || `${docId}.${fileType}`;
    const docRef = docRefOf(req.tenant, docId);

    try {
      const instanceUrl = await instanceManager.assignInstance(docRef);
      // Quien se une a una sesión abierta debe recibir la misma key aunque un forcesave
      // ya haya cambiado la versión en el storage; si no, OnlyOffice abre otra sesión.
      // ponytail: una edición externa del documento con la sesión abierta no rota la key hasta status 2/4 o el TTL de 24 h.
      const active = await store.getDocumentInstance(docRef);
      const key = active?.documentKey ?? documentKey(docRef, version);

      let session = await store.getKeySession(key);
      if (!session) {
        session = { tenant: req.tenant, docId, version, fileType, fileToken: crypto.randomUUID() };
        await store.setKeySession(key, session);
      }
      // Cada apertura renueva la getUrl: la del primer editor pudo expirar si OnlyOffice aún no la descargó.
      await store.setFileSource(session.fileToken, getUrl);
      await store.assignDocument(docRef, instanceUrl, key);

      const config = buildEditorConfig({
        key,
        title,
        fileType: session.fileType,
        fileUrl: `${BACKEND_URL}/files/${session.fileToken}`,
        callbackUrl: `${BACKEND_URL}/api/callback`,
        user,
        permissions,
        returnUrl,
        secret: JWT_SECRET,
      });

      const tabId = crypto.randomUUID();
      const launchToken = crypto.randomBytes(32).toString("base64url");
      await store.setEditorTab(tabId, { config, publicUrl: instanceManager.getPublicUrl(instanceUrl), cookieSecret: crypto.randomBytes(32).toString("base64url") });
      await store.setLaunchToken(launchToken, tabId, LAUNCH_TOKEN_TTL_SECONDS);
      await limitOpenDocuments(`${req.tenant}:${user.id}`, user.id, { docRef, key, instanceUrl, tabId });

      logger.info("Sessions", "Sesión de edición entregada", { docRef, instance: instanceUrl, key, joined: Boolean(active) });
      res.json({ editorUrl: `${PUBLIC_URL}/editor/launch/${launchToken}`, expiresIn: LAUNCH_TOKEN_TTL_SECONDS });
    } catch (err) {
      logger.error("Sessions", "Error abriendo sesión", { docRef, error: err.message });
      res.status(503).json({ error: "No se pudo abrir la sesión de edición" });
    }
  });

  // Canjea el enlace de un solo uso por una cookie de la pestaña y redirige a una URL sin el token.
  app.get("/editor/launch/:launchToken", async (req, res) => {
    const tabId = await store.takeLaunchToken(req.params.launchToken);
    const tab = tabId && (await store.getEditorTab(tabId));
    if (!tab) return sendEditorError(res, 410, "El enlace expiró o ya se usó. Vuelve a abrir el documento desde la aplicación.");

    res.cookie("roffice_tab", tab.cookieSecret, {
      path: `/editor/${tabId}`,
      httpOnly: true,
      sameSite: "lax",
      secure: PUBLIC_URL.startsWith("https:"),
      maxAge: TAB_COOKIE_MAX_AGE_SECONDS * 1000,
    });
    res.set("Referrer-Policy", "no-referrer");
    res.redirect(303, `/editor/${tabId}`);
  });

  app.get("/editor/:tabId", async (req, res) => {
    const tab = await store.getEditorTab(req.params.tabId);
    if (!tab || !sameSecret(readTabCookie(req), tab.cookieSecret)) {
      return sendEditorError(res, 403, "Esta pestaña no tiene acceso al documento. Vuelve a abrirlo desde la aplicación.");
    }
    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");
    res.type("html").send(renderEditorPage(tab));
  });

  // Proxy de lectura: OnlyOffice no maneja bien las URLs prefirmadas virtual-hosted (ver APRENDIZAJES.md §2)
  // y así la getUrl del cliente nunca viaja en el config que llega al navegador.
  app.get("/files/:fileToken", async (req, res) => {
    const getUrl = await store.getFileSource(req.params.fileToken);
    if (!getUrl) return res.status(404).json({ error: "Archivo no encontrado" });

    try {
      const source = await fetch(getUrl);
      if (!source.ok) {
        logger.warn("Proxy", "El storage del cliente rechazó la lectura", { status: source.status });
        return res.status(502).json({ error: "No se pudo leer el documento del cliente" });
      }
      res.set("Content-Type", source.headers.get("content-type") || "application/octet-stream");
      res.set("Cache-Control", "no-store");
      await pipeline(Readable.fromWeb(source.body), res);
    } catch (err) {
      logger.error("Proxy", "Error leyendo el documento del cliente", { error: err.message });
      if (res.headersSent) return res.destroy();
      res.status(502).json({ error: "No se pudo leer el documento del cliente" });
    }
  });

  /**
   * Callback de OnlyOffice:
   * 2 - listo para guardar (todos cerraron) · 4 - cerrado sin cambios · 6 - forcesave
   * Un guardado fallido responde 500 + error ≠ 0 para que OnlyOffice no lo dé por persistido.
   */
  app.post("/api/callback", async (req, res) => {
    let payload;
    try {
      payload = verifyCallback(req.body, req.get("Authorization"), JWT_SECRET);
    } catch (err) {
      logger.warn("Callback", "Callback con firma inválida", { error: err.message });
      return res.status(403).json({ error: 1 });
    }

    const { status, key, url } = payload;
    logger.info("Callback", "Callback recibido", { status, key, users: payload.users });

    const session = await store.getKeySession(key);
    if (!session) {
      logger.warn("Callback", "Sin sesión para la key", { key });
      return res.json({ error: 0 });
    }

    try {
      if (status === 2 || status === 6) {
        await saveToClient(session, url);
        logger.info("Callback", "Documento guardado en el storage del cliente", { tenant: session.tenant, docId: session.docId, status });
      }
      if (status === 2 || status === 4) await closeSession(key, session);
      res.json({ error: 0 });
    } catch (err) {
      logger.error("Callback", "Error guardando en el storage del cliente", { tenant: session.tenant, docId: session.docId, error: err.message });
      res.status(500).json({ error: 1 });
    }
  });

  app.post("/api/sessions/:docId/forcesave", requireServiceToken, async (req, res) => {
    const active = await store.getDocumentInstance(docRefOf(req.tenant, req.params.docId));
    if (!active) return res.status(404).json({ error: "El documento no tiene sesión abierta" });

    try {
      const response = await sendCommand(active.instanceUrl, { c: "forcesave", key: active.documentKey });
      res.status(response.status).type("json").send(await response.text());
    } catch (err) {
      logger.error("Forcesave", "Error", { docId: req.params.docId, error: err.message });
      res.status(502).json({ error: err.message });
    }
  });

  app.get("/api/instances/status", async (req, res) => {
    try {
      res.json({ instances: await instanceManager.getStatus() });
    } catch (err) {
      logger.error("Status", "Error obteniendo estado", { error: err.message });
      res.status(500).json({ error: "Error obteniendo estado de instancias" });
    }
  });

  return app;
}

module.exports = { createApp };
