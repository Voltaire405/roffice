require("dotenv").config();
const Redis = require("ioredis");
const { createPool } = require("./pool");
const { createOidc } = require("./oidc");
const { createEditSessions } = require("./edit-session");
const { createCommandSender } = require("./onlyoffice");
const { createSaveToTenant } = require("./tenants");
const { createApp } = require("./app");

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

const PORT = process.env.PORT || 13000;
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:16379";
const ONLYOFFICE_INSTANCES = process.env.ONLYOFFICE_INSTANCES || "http://localhost:18080,http://localhost:18081,http://localhost:18082";
const JWT_SECRET = process.env.JWT_SECRET || "my-secret-key-change-me";
const TENANTS = JSON.parse(requireEnv("TENANTS"));

const redis = new Redis(REDIS_URL, { retryStrategy: (times) => Math.min(times * 200, 5000), maxRetriesPerRequest: 3 });
redis.on("error", (err) => console.error("[Redis] Error de conexión:", err.message));
redis.on("connect", () => console.log("[Redis] Conectado a", REDIS_URL));

const oidc = createOidc({
  issuer: requireEnv("OIDC_ISSUER"),
  audience: requireEnv("OIDC_AUDIENCE"),
  clientId: requireEnv("OIDC_CLIENT_ID"),
  clientSecret: requireEnv("OIDC_CLIENT_SECRET"),
});

const pool = createPool({ redis, instances: ONLYOFFICE_INSTANCES });
pool.start();

const sessions = createEditSessions({
  redis,
  pool,
  sendCommand: createCommandSender(JWT_SECRET),
  saveToTenant: createSaveToTenant({ tenants: TENANTS, oidc }),
  jwtSecret: JWT_SECRET,
  // URL de Roffice vista por los contenedores de OnlyOffice.
  backendUrl: process.env.BACKEND_URL || "http://host.docker.internal:13000",
  maxDocsPerUser: Math.max(1, Number(process.env.MAX_DOCS_PER_USER) || 1),
});

const app = createApp({
  tenants: TENANTS,
  oidc,
  sessions,
  pool,
  jwtSecret: JWT_SECRET,
  publicUrl: process.env.PUBLIC_URL || "http://localhost:13000",
});

// Express 5 también invoca este callback cuando el puerto falla (ej. EADDRINUSE).
app.listen(PORT, (err) => {
  if (err) throw err;
  console.log(`\n🚀 Roffice escuchando en http://localhost:${PORT}`);
  console.log(`🔀 Instancias OnlyOffice: ${ONLYOFFICE_INSTANCES}`);
  console.log(`🔑 Clientes autorizados: ${Object.keys(TENANTS).join(", ")}\n`);
});

async function shutdown() {
  console.log("\n[Shutdown] Cerrando conexiones...");
  pool.stop();
  await redis.quit();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
