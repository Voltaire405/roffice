const http = require("http");
const https = require("https");

const HEALTH_CHECK_INTERVAL = 30_000;
const HEALTH_CHECK_TIMEOUT = 5_000;
const ASSIGNMENT_TTL_SECONDS = 60 * 60 * 24;

/**
 * @typedef {Object} Instance
 * @property {string} url - URL interna de la instancia (health checks, CommandService)
 * @property {string} publicUrl - URL con la que el navegador carga el editor
 * @property {boolean} healthy
 * @property {Date|null} lastCheck
 */

/**
 * @typedef {Object} Assignment
 * @property {string} instanceUrl - URL interna de la instancia
 * @property {string} publicUrl
 * @property {string} documentKey - key de la sesión de OnlyOffice abierta para el documento
 * @property {boolean} joined - true si el documento ya tenía sesión abierta en una instancia sana
 */

const withoutTrailingSlash = (url) => url.replace(/\/$/, "");

function checkHealth(instance) {
  return new Promise((resolve) => {
    const url = new URL("/healthcheck", instance.url);
    const protocol = url.protocol === "https:" ? https : http;

    const req = protocol.get(url.toString(), { timeout: HEALTH_CHECK_TIMEOUT }, (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });

    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Pool de instancias de OnlyOffice. Es dueño del registro `doc:<docRef>` → instancia + key activa:
 * todos los editores de un documento caen en la misma instancia (requisito de co-edición).
 * @param {Object} deps
 * @param {import("ioredis").Redis} deps.redis
 * @param {string} deps.instances - Entradas `interna|pública` separadas por coma; sin `|`, la pública es la interna
 */
function createPool({ redis, instances: instancesEnv }) {
  const entries = instancesEnv.split(",").map((u) => u.trim()).filter(Boolean);
  if (entries.length === 0) throw new Error("ONLYOFFICE_INSTANCES no contiene URLs válidas");

  /** @type {Instance[]} */
  const instances = entries.map((entry) => {
    const [url, publicUrl = url] = entry.split("|").map((u) => withoutTrailingSlash(u.trim()));
    return { url, publicUrl, healthy: true, lastCheck: null };
  });
  let healthCheckTimer = null;

  async function runHealthChecks() {
    await Promise.all(
      instances.map(async (inst) => {
        const healthy = await checkHealth(inst);
        if (inst.healthy !== healthy) console.log(`[Pool] ${inst.url} → ${healthy ? "✅ UP" : "❌ DOWN"}`);
        inst.healthy = healthy;
        inst.lastCheck = new Date();
      })
    );
    if (!instances.some((inst) => inst.healthy)) console.warn("[Pool] ⚠️  NINGUNA instancia saludable disponible");
  }

  /** Documentos asignados por instancia. ponytail: SCAN de todo doc:*, O(documentos) por apertura; contador por instancia si la carga crece. */
  async function loadByInstance() {
    const load = new Map(instances.map((inst) => [inst.url, 0]));
    let cursor = "0";
    do {
      const [nextCursor, keys] = await redis.scan(cursor, "MATCH", "doc:*", "COUNT", 100);
      cursor = nextCursor;
      if (keys.length === 0) continue;
      for (const value of await redis.mget(keys)) {
        const instanceUrl = value && JSON.parse(value).instanceUrl;
        if (load.has(instanceUrl)) load.set(instanceUrl, load.get(instanceUrl) + 1);
      }
    } while (cursor !== "0");
    return load;
  }

  async function leastLoadedInstance() {
    const healthy = instances.filter((inst) => inst.healthy);
    if (healthy.length === 0) throw new Error("No hay instancias de OnlyOffice disponibles");
    const load = await loadByInstance();
    return healthy.reduce((best, inst) => (load.get(inst.url) < load.get(best.url) ? inst : best));
  }

  /** @returns {Promise<{instanceUrl: string, documentKey: string} | null>} */
  async function lookup(docRef) {
    const value = await redis.get(`doc:${docRef}`);
    return value ? JSON.parse(value) : null;
  }

  /**
   * Asigna el documento a una instancia, o lo une a su sesión abierta si su instancia sigue sana.
   * Con la instancia caída reasigna y la sesión arranca con `candidateKey`.
   * @param {string} docRef
   * @param {string} candidateKey - key para el documento si no tiene sesión abierta
   * @returns {Promise<Assignment>}
   */
  async function assign(docRef, candidateKey) {
    const active = await lookup(docRef);
    const activeInstance = active && instances.find((inst) => inst.url === active.instanceUrl && inst.healthy);
    // ponytail: leer y luego escribir no es atómico; dos aperturas simultáneas pueden elegir instancias distintas. SET NX si ocurre.
    const instance = activeInstance ?? (await leastLoadedInstance());
    const documentKey = activeInstance ? active.documentKey : candidateKey;

    await redis.set(`doc:${docRef}`, JSON.stringify({ instanceUrl: instance.url, documentKey, assignedAt: Date.now() }), "EX", ASSIGNMENT_TTL_SECONDS);
    return { instanceUrl: instance.url, publicUrl: instance.publicUrl, documentKey, joined: Boolean(activeInstance) };
  }

  async function release(docRef) {
    await redis.del(`doc:${docRef}`);
  }

  async function status() {
    const load = await loadByInstance();
    return instances.map((inst) => ({ url: inst.url, healthy: inst.healthy, lastCheck: inst.lastCheck, activeDocuments: load.get(inst.url) }));
  }

  function start() {
    runHealthChecks();
    healthCheckTimer = setInterval(runHealthChecks, HEALTH_CHECK_INTERVAL);
  }

  function stop() {
    clearInterval(healthCheckTimer);
  }

  return { assign, lookup, release, status, start, stop };
}

module.exports = { createPool };
