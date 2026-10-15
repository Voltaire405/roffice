const Redis = require("ioredis");

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:16379";
const DOC_TTL = 60 * 60 * 24; // 24 horas

const redis = new Redis(REDIS_URL, {
  retryStrategy(times) {
    const delay = Math.min(times * 200, 5000);
    return delay;
  },
  maxRetriesPerRequest: 3,
});

redis.on("error", (err) => {
  console.error("[Redis] Error de conexión:", err.message);
});

redis.on("connect", () => {
  console.log("[Redis] Conectado a", REDIS_URL);
});

// ── Mapeo documento → instancia ──────────────────────────────

/**
 * Asigna un documento a una instancia de OnlyOffice.
 * @param {string} filename
 * @param {string} instanceUrl
 * @param {string} documentKey
 */
async function assignDocument(filename, instanceUrl, documentKey) {
  const data = JSON.stringify({
    instanceUrl,
    documentKey,
    assignedAt: Date.now(),
  });
  await redis.set(`doc:${filename}`, data, "EX", DOC_TTL);
}

/**
 * Obtiene la instancia asignada a un documento.
 * @param {string} filename
 * @returns {Promise<{instanceUrl: string, documentKey: string, assignedAt: number} | null>}
 */
async function getDocumentInstance(filename) {
  const data = await redis.get(`doc:${filename}`);
  return data ? JSON.parse(data) : null;
}

/**
 * Elimina la asignación de un documento.
 * @param {string} filename
 */
async function removeDocumentAssignment(filename) {
  await redis.del(`doc:${filename}`);
}

// ── Sesión de edición por documentKey (para callbacks) ───────

/**
 * @typedef {Object} EditSession
 * @property {string} tenant - client_id (azp) del backend que abrió la sesión
 * @property {string} docId
 * @property {string} version - versión del documento al abrir la sesión
 * @property {string} fileType
 * @property {string} fileToken - token opaco del proxy /files/:fileToken
 */

/**
 * @param {string} documentKey
 * @param {EditSession} session
 */
async function setKeySession(documentKey, session) {
  await redis.set(`key:${documentKey}`, JSON.stringify(session), "EX", DOC_TTL);
}

/**
 * @param {string} documentKey
 * @returns {Promise<EditSession | null>}
 */
async function getKeySession(documentKey) {
  const data = await redis.get(`key:${documentKey}`);
  try {
    return data ? JSON.parse(data) : null;
  } catch {
    // Valor de la versión anterior (key → filename en texto plano): no es una sesión de este formato.
    return null;
  }
}

/**
 * @param {string} documentKey
 */
async function removeKeySession(documentKey) {
  await redis.del(`key:${documentKey}`);
}

// ── Origen del archivo por token opaco (proxy /files) ────────

/**
 * @param {string} fileToken
 * @param {string} getUrl - URL prefirmada del cliente; nunca llega al navegador
 */
async function setFileSource(fileToken, getUrl) {
  await redis.set(`file:${fileToken}`, getUrl, "EX", DOC_TTL);
}

/**
 * @param {string} fileToken
 * @returns {Promise<string | null>}
 */
async function getFileSource(fileToken) {
  return redis.get(`file:${fileToken}`);
}

/**
 * @param {string} fileToken
 */
async function removeFileSource(fileToken) {
  await redis.del(`file:${fileToken}`);
}

// ── Pestaña del editor: enlace de un solo uso → sesión de pestaña ─

/**
 * @typedef {Object} EditorTab
 * @property {Object} config - config firmado de OnlyOffice para este usuario
 * @property {string} publicUrl - URL pública de la instancia asignada
 * @property {string} cookieSecret - valor de la cookie que habilita /editor/:tabId
 */

/**
 * @param {string} tabId
 * @param {EditorTab} tab
 */
async function setEditorTab(tabId, tab) {
  await redis.set(`tab:${tabId}`, JSON.stringify(tab), "EX", DOC_TTL);
}

/**
 * @param {string} tabId
 * @returns {Promise<EditorTab | null>}
 */
async function getEditorTab(tabId) {
  const data = await redis.get(`tab:${tabId}`);
  return data ? JSON.parse(data) : null;
}

/**
 * @param {string} tabId
 */
async function removeEditorTab(tabId) {
  await redis.del(`tab:${tabId}`);
}

/**
 * @param {string} launchToken
 * @param {string} tabId
 * @param {number} ttlSeconds
 */
async function setLaunchToken(launchToken, tabId, ttlSeconds) {
  await redis.set(`launch:${launchToken}`, tabId, "EX", ttlSeconds);
}

/**
 * Canjea el enlace: GETDEL lo invalida de forma atómica aunque lleguen dos canjes a la vez.
 * @param {string} launchToken
 * @returns {Promise<string | null>} tabId
 */
async function takeLaunchToken(launchToken) {
  return redis.getdel(`launch:${launchToken}`);
}

// ── Documentos abiertos por usuario ──────────────────────────

/**
 * @typedef {Object} OpenDocument
 * @property {string} docRef
 * @property {string} key - documentKey con la que el usuario lo abrió
 * @property {string} instanceUrl
 * @property {string} tabId
 */

/**
 * @param {string} userRef - `<tenant>:<user.id>`
 * @returns {Promise<OpenDocument[]>} del más reciente al más antiguo
 */
async function getOpenDocuments(userRef) {
  const data = await redis.get(`user:${userRef}`);
  return data ? JSON.parse(data) : [];
}

/**
 * @param {string} userRef
 * @param {OpenDocument[]} openDocs
 */
async function setOpenDocuments(userRef, openDocs) {
  await redis.set(`user:${userRef}`, JSON.stringify(openDocs), "EX", DOC_TTL);
}

// ── Conteo de documentos por instancia ───────────────────────

/**
 * Cuenta cuántos documentos están asignados a cada instancia.
 * Usa SCAN para no bloquear Redis.
 * @param {string[]} instanceUrls
 * @returns {Promise<Map<string, number>>}
 */
async function getInstanceLoadMap(instanceUrls) {
  const loadMap = new Map();
  for (const url of instanceUrls) {
    loadMap.set(url, 0);
  }

  let cursor = "0";
  do {
    const [nextCursor, keys] = await redis.scan(cursor, "MATCH", "doc:*", "COUNT", 100);
    cursor = nextCursor;

    if (keys.length > 0) {
      const pipeline = redis.pipeline();
      for (const key of keys) {
        pipeline.get(key);
      }
      const results = await pipeline.exec();

      for (const [err, val] of results) {
        if (!err && val) {
          try {
            const { instanceUrl } = JSON.parse(val);
            if (loadMap.has(instanceUrl)) {
              loadMap.set(instanceUrl, loadMap.get(instanceUrl) + 1);
            }
          } catch { /* ignorar datos corruptos */ }
        }
      }
    }
  } while (cursor !== "0");

  return loadMap;
}

/**
 * Cierra la conexión a Redis.
 */
async function disconnect() {
  await redis.quit();
}

module.exports = {
  redis,
  assignDocument,
  getDocumentInstance,
  removeDocumentAssignment,
  setKeySession,
  getKeySession,
  removeKeySession,
  setFileSource,
  getFileSource,
  removeFileSource,
  setEditorTab,
  getEditorTab,
  setLaunchToken,
  takeLaunchToken,
  removeEditorTab,
  getOpenDocuments,
  setOpenDocuments,
  getInstanceLoadMap,
  disconnect,
};
