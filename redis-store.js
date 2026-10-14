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

// ── Mapeo key → filename (para callbacks) ────────────────────

/**
 * Guarda el mapeo documentKey → filename.
 * @param {string} documentKey
 * @param {string} filename
 */
async function setKeyMapping(documentKey, filename) {
  await redis.set(`key:${documentKey}`, filename, "EX", DOC_TTL);
}

/**
 * Resuelve un documentKey a filename.
 * @param {string} documentKey
 * @returns {Promise<string | null>}
 */
async function getFilenameByKey(documentKey) {
  return redis.get(`key:${documentKey}`);
}

/**
 * Elimina un mapeo de key.
 * @param {string} documentKey
 */
async function removeKeyMapping(documentKey) {
  await redis.del(`key:${documentKey}`);
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
  setKeyMapping,
  getFilenameByKey,
  removeKeyMapping,
  getInstanceLoadMap,
  disconnect,
};
