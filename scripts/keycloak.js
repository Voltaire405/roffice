#!/usr/bin/env node
// Configura el realm de Roffice en Keycloak vía Admin REST API. Idempotente: se puede re-ejecutar.
//
//   node scripts/keycloak.js init
//   node scripts/keycloak.js add-tenant <clientId> <saveUrl> <audienciaDelGateway>
//
// Credenciales de administración en .env.admin (no en .env: Roffice no las necesita en runtime).
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

const ENV_FILE = path.resolve(".env");
dotenv.config({ path: path.resolve(".env.admin") });

const KEYCLOAK_URL = requireEnv("KEYCLOAK_URL").replace(/\/$/, "");
const ADMIN_REALM = process.env.KEYCLOAK_ADMIN_REALM || "master";
const REALM = process.env.ROFFICE_REALM || "roffice";
const ROFFICE_CLIENT_ID = "roffice";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) fail(`Falta ${name} en .env.admin`);
  return value;
}

function fail(message) {
  console.error(`✖ ${message}`);
  process.exit(1);
}

/** Con client secret usa una cuenta de servicio de admin (recomendado); si no, usuario y contraseña vía admin-cli. */
async function adminToken() {
  const form = process.env.KEYCLOAK_ADMIN_CLIENT_SECRET
    ? { grant_type: "client_credentials", client_id: requireEnv("KEYCLOAK_ADMIN_CLIENT_ID"), client_secret: process.env.KEYCLOAK_ADMIN_CLIENT_SECRET }
    : { grant_type: "password", client_id: "admin-cli", username: requireEnv("KEYCLOAK_ADMIN_USER"), password: requireEnv("KEYCLOAK_ADMIN_PASSWORD") };

  const res = await fetch(`${KEYCLOAK_URL}/realms/${ADMIN_REALM}/protocol/openid-connect/token`, { method: "POST", body: new URLSearchParams(form) });
  if (!res.ok) fail(`Login de administración rechazado (${res.status}): revisa .env.admin`);
  return (await res.json()).access_token;
}

function createAdminApi(token) {
  return async function api(method, route, body) {
    const res = await fetch(`${KEYCLOAK_URL}/admin/realms${route}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body && { "Content-Type": "application/json" }) },
      body: body && JSON.stringify(body),
    });
    if (method === "GET" && res.status === 404) return null;
    if (!res.ok) fail(`${method} ${route} → ${res.status} ${await res.text()}`);
    return res.status === 204 || res.status === 201 ? null : res.json();
  };
}

const audienceMapper = (name, config) => ({
  name,
  protocol: "openid-connect",
  protocolMapper: "oidc-audience-mapper",
  config: { ...config, "access.token.claim": "true", "id.token.claim": "false" },
});

async function findClient(api, clientId) {
  const [client] = await api("GET", `/${REALM}/clients?clientId=${encodeURIComponent(clientId)}`);
  return client;
}

/** Client confidencial solo para client_credentials: sin login de usuarios. */
async function ensureServiceClient(api, clientId, protocolMappers) {
  let client = await findClient(api, clientId);
  if (client) {
    console.log(`• client ${clientId} ya existe`);
  } else {
    await api("POST", `/${REALM}/clients`, {
      clientId,
      publicClient: false,
      serviceAccountsEnabled: true,
      standardFlowEnabled: false,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      protocolMappers,
    });
    client = await findClient(api, clientId);
    console.log(`✔ client ${clientId} creado`);
  }
  const { value: secret } = await api("GET", `/${REALM}/clients/${client.id}/client-secret`);
  return { client, secret };
}

async function ensureMapper(api, client, mapper) {
  const mappers = await api("GET", `/${REALM}/clients/${client.id}/protocol-mappers/models`);
  if (mappers.some((m) => m.name === mapper.name)) return console.log(`• mapper ${mapper.name} ya existe`);
  await api("POST", `/${REALM}/clients/${client.id}/protocol-mappers/models`, mapper);
  console.log(`✔ mapper ${mapper.name} agregado a ${client.clientId}`);
}

function readEnvFile() {
  return fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
}

function upsertEnv(values) {
  let content = readEnvFile();
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    content = pattern.test(content) ? content.replace(pattern, () => line) : `${content.replace(/\n?$/, "\n")}${line}\n`;
  }
  fs.writeFileSync(ENV_FILE, content);
  fs.chmodSync(ENV_FILE, 0o600);
}

async function init(api) {
  if (await api("GET", `/${REALM}`)) {
    console.log(`• realm ${REALM} ya existe`);
  } else {
    await api("POST", "", { realm: REALM, enabled: true });
    console.log(`✔ realm ${REALM} creado`);
    // El token previo no trae los roles del realm recién creado: sin renovarlo, Keycloak responde 403.
    api = createAdminApi(await adminToken());
  }

  const { secret } = await ensureServiceClient(api, ROFFICE_CLIENT_ID, []);
  upsertEnv({
    OIDC_ISSUER: `${KEYCLOAK_URL}/realms/${REALM}`,
    OIDC_AUDIENCE: ROFFICE_CLIENT_ID,
    OIDC_CLIENT_ID: ROFFICE_CLIENT_ID,
    OIDC_CLIENT_SECRET: secret,
  });
  console.log(`✔ OIDC_* escritos en ${ENV_FILE}`);
}

async function addTenant(api, [clientId, saveUrl, gatewayAudience]) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(clientId ?? "")) fail("clientId: minúsculas, números y guiones (ej. acme-backend)");
  if (!/^https?:\/\//.test(saveUrl ?? "")) fail("saveUrl debe ser una URL http(s)");
  if (!gatewayAudience) fail("Falta la audiencia que exige el gateway del cliente");

  const roffice = await findClient(api, ROFFICE_CLIENT_ID);
  if (!roffice) fail(`No existe el client ${ROFFICE_CLIENT_ID}: ejecuta primero init`);

  const { secret } = await ensureServiceClient(api, clientId, [audienceMapper("aud-roffice", { "included.client.audience": ROFFICE_CLIENT_ID })]);
  await ensureMapper(api, roffice, audienceMapper(`aud-${gatewayAudience}`, { "included.custom.audience": gatewayAudience }));

  const tenants = JSON.parse(dotenv.parse(readEnvFile()).TENANTS || "{}");
  upsertEnv({ TENANTS: JSON.stringify({ ...tenants, [clientId]: { saveUrl } }) });
  console.log(`✔ ${clientId} agregado a TENANTS en ${ENV_FILE}. Reinicia Roffice para aplicarlo.`);

  console.log(`\nEntregar al equipo de ${clientId} por un canal seguro:`);
  console.log(`  token_endpoint: ${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/token`);
  console.log(`  client_id:      ${clientId}`);
  console.log(`  client_secret:  ${secret}`);
  console.log(`  Su gateway debe aceptar en la saveUrl: iss=${KEYCLOAK_URL}/realms/${REALM}, azp=${ROFFICE_CLIENT_ID}, aud=${gatewayAudience}`);
}

const commands = { init, "add-tenant": addTenant };
const [command, ...args] = process.argv.slice(2);
if (!commands[command]) fail("Uso: keycloak.js init | add-tenant <clientId> <saveUrl> <audienciaDelGateway>");

adminToken()
  .then((token) => commands[command](createAdminApi(token), args))
  .catch((err) => fail(err.message));
