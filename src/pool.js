const http = require("http");
const https = require("https");

const HEALTH_CHECK_INTERVAL = 30_000;
const HEALTH_CHECK_TIMEOUT = 5_000;
const DEFAULT_ASSIGNMENT_TTL_SECONDS = 60 * 60 * 24;
const MAX_ASSIGN_ATTEMPTS = 3;

// Reemplaza la asignación solo si nadie la cambió desde que se leyó.
const REPLACE_IF_UNCHANGED = `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3]) end`;

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
 * @param {number} [deps.assignmentTtlSeconds] - vida de una asignación sin aperturas nuevas
 */
function createPool({ redis, instances: instancesEnv, assignmentTtlSeconds = DEFAULT_ASSIGNMENT_TTL_SECONDS }) {
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

  // Carga de cada instancia: sorted set `load:<instancia>` de docRef con su vencimiento como score,
  // para que una asignación vencida por TTL deje de contar sin que nadie la libere.
  const loadKey = (instanceUrl) => `load:${instanceUrl}`;

  async function loadByInstance() {
    const now = Date.now();
    const counts = await Promise.all(
      instances.map(async (inst) => {
        await redis.zremrangebyscore(loadKey(inst.url), "-inf", now);
        return [inst.url, await redis.zcard(loadKey(inst.url))];
      })
    );
    return new Map(counts);
  }

  const countLoad = (instanceUrl, docRef) => redis.zadd(loadKey(instanceUrl), Date.now() + assignmentTtlSeconds * 1000, docRef);

  async function leastLoadedInstance() {
    const healthy = instances.filter((inst) => inst.healthy);
    if (healthy.length === 0) throw new Error("No hay instancias de OnlyOffice disponibles");
    const load = await loadByInstance();
    return healthy.reduce((best, inst) => (load.get(inst.url) < load.get(best.url) ? inst : best));
  }

  /** @returns {Promise<{instanceUrl: string, documentKey: string, assignedAt: number} | null>} */
  async function lookup(docRef) {
    const value = await redis.get(`doc:${docRef}`);
    return value ? JSON.parse(value) : null;
  }

  /**
   * Asigna el documento a una instancia, o lo une a su sesión abierta si su instancia sigue sana.
   * Con la instancia caída reasigna y la sesión arranca con `candidateKey`. Dos aperturas simultáneas
   * del mismo documento terminan en la misma asignación: la que pierde la escritura se une a la ganadora.
   * @param {string} docRef
   * @param {string} candidateKey - key para el documento si no tiene sesión abierta
   * @returns {Promise<Assignment>}
   */
  async function assign(docRef, candidateKey) {
    const key = `doc:${docRef}`;
    for (let attempt = 0; attempt < MAX_ASSIGN_ATTEMPTS; attempt++) {
      const raw = await redis.get(key);
      const active = raw && JSON.parse(raw);
      const activeInstance = active && instances.find((inst) => inst.url === active.instanceUrl && inst.healthy);
      if (activeInstance) {
        await redis.expire(key, assignmentTtlSeconds);
        await countLoad(activeInstance.url, docRef);
        return { instanceUrl: activeInstance.url, publicUrl: activeInstance.publicUrl, documentKey: active.documentKey, joined: true };
      }

      const instance = await leastLoadedInstance();
      const value = JSON.stringify({ instanceUrl: instance.url, documentKey: candidateKey, assignedAt: Date.now() });
      const written = raw
        ? await redis.eval(REPLACE_IF_UNCHANGED, 1, key, raw, value, assignmentTtlSeconds)
        : await redis.set(key, value, "EX", assignmentTtlSeconds, "NX");
      if (!written) continue;

      if (active) await redis.zrem(loadKey(active.instanceUrl), docRef);
      await countLoad(instance.url, docRef);
      return { instanceUrl: instance.url, publicUrl: instance.publicUrl, documentKey: candidateKey, joined: false };
    }
    throw new Error(`Asignación de ${docRef} en conflicto tras ${MAX_ASSIGN_ATTEMPTS} intentos`);
  }

  async function release(docRef) {
    const active = await lookup(docRef);
    await redis.del(`doc:${docRef}`);
    if (active) await redis.zrem(loadKey(active.instanceUrl), docRef);
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
