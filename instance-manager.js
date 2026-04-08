const http = require("http");
const https = require("https");
const store = require("./redis-store");

const HEALTH_CHECK_INTERVAL = 30_000; // 30 segundos
const HEALTH_CHECK_TIMEOUT = 5_000;   // 5 segundos

/**
 * @typedef {Object} Instance
 * @property {string} url - URL base de la instancia (ej: http://localhost:8080)
 * @property {boolean} healthy - Estado de salud actual
 * @property {Date|null} lastCheck - Última verificación de salud
 */

/** @type {Instance[]} */
let instances = [];
let healthCheckTimer = null;

/**
 * Inicializa el pool de instancias desde la variable de entorno.
 * @param {string} instancesEnv - URLs separadas por coma
 */
function init(instancesEnv) {
  const urls = instancesEnv
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);

  if (urls.length === 0) {
    throw new Error("ONLYOFFICE_INSTANCES no contiene URLs válidas");
  }

  instances = urls.map((url) => ({
    url: url.replace(/\/$/, ""), // quitar trailing slash
    healthy: true, // asumir saludable al inicio
    lastCheck: null,
  }));

  console.log(`[InstanceManager] Pool inicializado con ${instances.length} instancia(s):`);
  instances.forEach((inst, i) => console.log(`  [${i}] ${inst.url}`));

  // Iniciar health checks periódicos
  runHealthChecks();
  healthCheckTimer = setInterval(runHealthChecks, HEALTH_CHECK_INTERVAL);
}

/**
 * Verifica la salud de una instancia vía /healthcheck.
 * @param {Instance} instance
 * @returns {Promise<boolean>}
 */
function checkHealth(instance) {
  return new Promise((resolve) => {
    const url = new URL("/healthcheck", instance.url);
    const protocol = url.protocol === "https:" ? https : http;

    const req = protocol.get(url.toString(), { timeout: HEALTH_CHECK_TIMEOUT }, (res) => {
      resolve(res.statusCode === 200);
      res.resume(); // consumir el body
    });

    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Ejecuta health checks en todas las instancias.
 */
async function runHealthChecks() {
  const results = await Promise.all(
    instances.map(async (inst) => {
      const healthy = await checkHealth(inst);
      const changed = inst.healthy !== healthy;
      inst.healthy = healthy;
      inst.lastCheck = new Date();

      if (changed) {
        const status = healthy ? "✅ UP" : "❌ DOWN";
        console.log(`[InstanceManager] ${inst.url} → ${status}`);
      }

      return { url: inst.url, healthy };
    })
  );

  const healthyCount = results.filter((r) => r.healthy).length;
  if (healthyCount === 0) {
    console.warn("[InstanceManager] ⚠️  NINGUNA instancia saludable disponible");
  }
}

/**
 * Obtiene las instancias saludables.
 * @returns {Instance[]}
 */
function getHealthyInstances() {
  return instances.filter((inst) => inst.healthy);
}

/**
 * Asigna una instancia a un documento usando least-connections.
 * Si el documento ya tiene instancia asignada y saludable, la reutiliza.
 * @param {string} filename
 * @returns {Promise<string>} URL de la instancia asignada
 */
async function assignInstance(filename) {
  // Verificar si ya tiene asignación
  const existing = await store.getDocumentInstance(filename);
  if (existing) {
    const inst = instances.find((i) => i.url === existing.instanceUrl);
    if (inst && inst.healthy) {
      return existing.instanceUrl;
    }
    // Instancia anterior no saludable, reasignar
    console.log(`[InstanceManager] Reasignando ${filename} (instancia anterior no disponible)`);
    await store.removeDocumentAssignment(filename);
  }

  // Asignar a la instancia saludable con menor carga
  const healthy = getHealthyInstances();
  if (healthy.length === 0) {
    throw new Error("No hay instancias de OnlyOffice disponibles");
  }

  const instanceUrls = instances.map((i) => i.url);
  const loadMap = await store.getInstanceLoadMap(instanceUrls);

  // Elegir la instancia saludable con menos documentos
  let bestInstance = healthy[0];
  let minLoad = Infinity;

  for (const inst of healthy) {
    const load = loadMap.get(inst.url) || 0;
    if (load < minLoad) {
      minLoad = load;
      bestInstance = inst;
    }
  }

  console.log(`[InstanceManager] ${filename} → ${bestInstance.url} (carga: ${minLoad} docs)`);
  return bestInstance.url;
}

/**
 * Retorna el estado de todas las instancias (para endpoint de monitoreo).
 * @returns {Promise<Object[]>}
 */
async function getStatus() {
  const instanceUrls = instances.map((i) => i.url);
  const loadMap = await store.getInstanceLoadMap(instanceUrls);

  return instances.map((inst) => ({
    url: inst.url,
    healthy: inst.healthy,
    lastCheck: inst.lastCheck,
    activeDocuments: loadMap.get(inst.url) || 0,
  }));
}

/**
 * Obtiene la instancia asignada a un documento.
 * @param {string} filename
 * @returns {Promise<string|null>}
 */
async function getInstanceForDocument(filename) {
  const data = await store.getDocumentInstance(filename);
  return data ? data.instanceUrl : null;
}

/**
 * Detiene los health checks.
 */
function stop() {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}

module.exports = {
  init,
  assignInstance,
  getInstanceForDocument,
  getStatus,
  getHealthyInstances,
  stop,
};
