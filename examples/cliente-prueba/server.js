// Tenant de prueba: implementación de referencia de un tenant contra un prefijo sandbox del storage.
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const express = require("express");
const { S3Client, ListObjectsV2Command, HeadObjectCommand, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { createOidc } = require("../../src/oidc");

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Falta ${name} en examples/cliente-prueba/.env`);
  return value;
}

const PORT = process.env.PORT || 13100;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const ROFFICE_URL = requireEnv("ROFFICE_URL");
const S3_BUCKET = requireEnv("S3_BUCKET");
const S3_PREFIX = process.env.S3_PREFIX || "roffice-sandbox/";
const PRESIGN_TTL_SECONDS = 300;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const SUPPORTED_FILE_TYPES = new Set(["docx", "doc", "odt", "rtf", "txt", "xlsx", "xls", "ods", "csv", "pptx", "ppt", "odp"]);

// Roffice sube con un PUT simple: sin esto, el SDK firma checksums que ese PUT no envía.
const s3 = new S3Client({
  region: process.env.S3_REGION || "auto",
  endpoint: requireEnv("S3_ENDPOINT"),
  forcePathStyle: true,
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
  credentials: { accessKeyId: requireEnv("S3_ACCESS_KEY_ID"), secretAccessKey: requireEnv("S3_SECRET_ACCESS_KEY") },
});

const rofficeVerifier = createOidc({ issuer: requireEnv("ROFFICE_ISSUER"), audience: requireEnv("ROFFICE_SAVE_AUDIENCE") });

const fileTypeOf = (name) => path.extname(name).slice(1).toLowerCase();

/** Nombre plano con extensión soportada: así toda clave queda dentro de S3_PREFIX. */
function sandboxKey(name) {
  const isPlainName = typeof name === "string" && /^[\w][\w .-]*$/.test(name) && !name.includes("..");
  return isPlainName && SUPPORTED_FILE_TYPES.has(fileTypeOf(name)) ? `${S3_PREFIX}${name}` : null;
}

let serviceToken = null;
async function rofficeServiceToken() {
  if (serviceToken && serviceToken.expiresAt > Date.now()) return serviceToken.value;
  const res = await fetch(requireEnv("ROFFICE_TOKEN_ENDPOINT"), {
    method: "POST",
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: requireEnv("ROFFICE_CLIENT_ID"), client_secret: requireEnv("ROFFICE_CLIENT_SECRET") }),
  });
  if (!res.ok) throw new Error(`Token de servicio rechazado (${res.status})`);
  const { access_token, expires_in } = await res.json();
  serviceToken = { value: access_token, expiresAt: Date.now() + expires_in * 1000 - 30_000 };
  return access_token;
}

const saveEvents = [];

const app = express();
app.use(express.static(path.join(__dirname, "public")));

/** Formato real según la firma de los primeros bytes: muestra si un .doc guardado volvió como OOXML. */
async function detectContainer(key) {
  const { Body } = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key, Range: "bytes=0-3" }));
  const magic = Buffer.from(await Body.transformToByteArray()).toString("hex");
  if (magic === "504b0304") return "OOXML / ODF (zip)";
  if (magic === "d0cf11e0") return "Office binario (OLE)";
  return "texto u otro";
}

app.get("/api/documents", async (req, res) => {
  try {
    const { Contents = [] } = await s3.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: S3_PREFIX }));
    const docs = Contents.map((obj) => ({ key: obj.Key, name: obj.Key.slice(S3_PREFIX.length), size: obj.Size, lastModified: obj.LastModified }))
      .filter((doc) => sandboxKey(doc.name));
    // ponytail: una lectura de 4 bytes por objeto; suficiente para un prefijo sandbox de pocas decenas de archivos.
    res.json(await Promise.all(docs.map(async ({ key, ...doc }) => ({ ...doc, container: await detectContainer(key) }))));
  } catch (err) {
    res.status(502).json({ error: `Storage: ${err.message}` });
  }
});

app.get("/api/documents/:name/download", async (req, res) => {
  const key = sandboxKey(req.params.name);
  if (!key) return res.status(400).json({ error: "Nombre o formato no permitido" });
  const command = new GetObjectCommand({ Bucket: S3_BUCKET, Key: key, ResponseContentDisposition: `attachment; filename="${req.params.name}"` });
  res.redirect(await getSignedUrl(s3, command, { expiresIn: PRESIGN_TTL_SECONDS }));
});

app.post("/api/documents/:name", express.raw({ type: "*/*", limit: MAX_UPLOAD_BYTES }), async (req, res) => {
  const key = sandboxKey(req.params.name);
  if (!key) return res.status(400).json({ error: "Nombre o formato no permitido" });
  try {
    await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: req.body, ContentType: req.get("Content-Type") }));
    res.json({ name: req.params.name });
  } catch (err) {
    res.status(502).json({ error: `Storage: ${err.message}` });
  }
});

// Patrones de ejemplo del menú «Insertar patrón» del editor de texto.
const PATTERNS = ["asunto", "fechaCarta", "numeroRadicado"];
const PATTERN_GROUPS = [
  {
    label: "destinatario",
    children: [
      { label: "Nombre", pattern: "destinatario.nombre" },
      { label: "Correo", pattern: "destinatario.correo" },
      { label: "Correo trabajo", pattern: "destinatario.propiedades.correotrabajo" },
    ],
  },
];

// Equivale al endpoint «abrir editor» del HANDOFF (paso 3); el usuario se simula desde la UI.
app.post("/api/documents/:name/editor", express.json(), async (req, res) => {
  const key = sandboxKey(req.params.name);
  if (!key) return res.status(400).json({ error: "Nombre o formato no permitido" });

  try {
    const { ETag } = await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    const getUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }), { expiresIn: PRESIGN_TTL_SECONDS });
    const userName = String(req.body.userName || "Usuario de prueba").slice(0, 60);

    const session = await fetch(`${ROFFICE_URL}/api/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await rofficeServiceToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        docId: req.params.name,
        version: ETag,
        fileType: fileTypeOf(req.params.name),
        title: req.params.name,
        getUrl,
        user: { id: `prueba-${userName.toLowerCase().replace(/\W+/g, "-")}`, name: userName },
        permissions: { edit: req.body.edit !== false },
        returnUrl: PUBLIC_URL,
        patterns: PATTERNS,
        patternGroups: PATTERN_GROUPS,
      }),
    });
    const body = await session.json();
    if (!session.ok) return res.status(session.status).json({ error: `Roffice: ${body.error}` });
    res.json({ editorUrl: body.editorUrl });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// saveUrl del HANDOFF (paso 4): solo Roffice obtiene PUTs, y solo dentro del prefijo sandbox.
app.post("/roffice/save-url", express.json(), async (req, res) => {
  const token = req.get("Authorization")?.replace(/^Bearer /, "");
  let claims;
  try {
    claims = await rofficeVerifier.verifyServiceToken(token);
  } catch {
    return res.status(401).json({ error: "Token inválido" });
  }
  if (claims.azp !== "roffice") return res.status(403).json({ error: "Solo Roffice puede pedir PUTs" });

  const { docId, version, contentType } = req.body;
  const key = sandboxKey(docId);
  if (!key || typeof contentType !== "string") return res.status(400).json({ error: "docId o contentType inválido" });

  const putUrl = await getSignedUrl(s3, new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, ContentType: contentType }), { expiresIn: PRESIGN_TTL_SECONDS });
  saveEvents.unshift({ time: new Date().toISOString(), docId, version });
  saveEvents.length = Math.min(saveEvents.length, 50);
  res.json({ putUrl });
});

app.get("/api/events", (req, res) => res.json(saveEvents));

if (require.main === module) {
  // Express 5 también invoca este callback cuando el puerto falla (ej. EADDRINUSE).
  app.listen(PORT, "127.0.0.1", (err) => {
    if (err) throw err;
    console.log(`Cliente de prueba en ${PUBLIC_URL} (prefijo ${S3_BUCKET}/${S3_PREFIX})`);
  });
}

module.exports = { app, sandboxKey };
