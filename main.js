require("dotenv").config();
const store = require("./redis-store");
const instanceManager = require("./instance-manager");
const { createOidc } = require("./oidc");
const { createApp } = require("./app");

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

const PORT = process.env.PORT || 13000;
const ONLYOFFICE_INSTANCES = process.env.ONLYOFFICE_INSTANCES || "http://localhost:18080,http://localhost:18081,http://localhost:18082";
const TENANTS = JSON.parse(requireEnv("TENANTS"));

const oidc = createOidc({
  issuer: requireEnv("OIDC_ISSUER"),
  audience: requireEnv("OIDC_AUDIENCE"),
  clientId: requireEnv("OIDC_CLIENT_ID"),
  clientSecret: requireEnv("OIDC_CLIENT_SECRET"),
});

instanceManager.init(ONLYOFFICE_INSTANCES);

const app = createApp({
  TENANTS,
  JWT_SECRET: process.env.JWT_SECRET || "my-secret-key-change-me",
  BACKEND_URL: process.env.BACKEND_URL || "http://host.docker.internal:13000",
  // URL con la que el navegador abre la pestaña del editor; BACKEND_URL es la que ven los contenedores de OnlyOffice.
  PUBLIC_URL: process.env.PUBLIC_URL || "http://localhost:13000",
  // Documentos que un usuario puede tener abiertos a la vez; abrir otro lo desconecta del más antiguo.
  MAX_DOCS_PER_USER: Math.max(1, Number(process.env.MAX_DOCS_PER_USER) || 1),
  oidc,
  store,
  instanceManager,
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
  instanceManager.stop();
  await store.disconnect();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
