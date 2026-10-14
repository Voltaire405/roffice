require("dotenv").config();
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const https = require("https");
const http = require("http");
const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const store = require("./redis-store");
const instanceManager = require("./instance-manager");
const { logger, requestLogger } = require("./logger");

const app = express();
const PORT = process.env.PORT || 13000;
const JWT_SECRET = process.env.JWT_SECRET || "my-secret-key-change-me";
const ONLYOFFICE_INSTANCES = process.env.ONLYOFFICE_INSTANCES || "http://localhost:18080,http://localhost:18081,http://localhost:18082";
const BACKEND_URL = process.env.BACKEND_URL || "http://host.docker.internal:13000";

// ── Cloudflare R2 ────────────────────────────────────────────
const R2_BUCKET = process.env.R2_BUCKET || "development";
const R2_PREFIX = process.env.R2_PREFIX || "borradores/";

const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// ── Middleware ────────────────────────────────────────────────
app.use(requestLogger);
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Multer (en memoria, para subir directo a R2) ─────────────
const upload = multer({ storage: multer.memoryStorage() });

// ── Helpers ──────────────────────────────────────────────────

const SUPPORTED_EXTENSIONS = [".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt", ".odt", ".ods", ".odp", ".txt", ".csv", ".rtf"];

/**
 * Genera un document.key único por versión del archivo.
 * Usa el ETag/LastModified de R2 para invalidar la caché de OnlyOffice.
 */
function generateDocumentKey(filename, lastModified) {
  const ts = lastModified ? new Date(lastModified).getTime().toString() : Date.now().toString();
  return Buffer.from(`${filename}_${ts}`).toString("base64url").slice(0, 20);
}

/** R2 key completo para un archivo */
function r2Key(filename) {
  return `${R2_PREFIX}${filename}`;
}

/** Obtiene metadatos de un objeto en R2 */
async function headObject(filename) {
  const command = new HeadObjectCommand({ Bucket: R2_BUCKET, Key: r2Key(filename) });
  return s3.send(command);
}

function getFileType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const types = {
    ".docx": "word",
    ".doc": "word",
    ".odt": "word",
    ".rtf": "word",
    ".txt": "word",
    ".xlsx": "cell",
    ".xls": "cell",
    ".ods": "cell",
    ".csv": "cell",
    ".pptx": "slide",
    ".ppt": "slide",
    ".odp": "slide",
  };
  return types[ext] || "word";
}

function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const mimes = {
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".doc": "application/msword",
    ".xls": "application/vnd.ms-excel",
    ".ppt": "application/vnd.ms-powerpoint",
    ".odt": "application/vnd.oasis.opendocument.text",
    ".ods": "application/vnd.oasis.opendocument.spreadsheet",
    ".odp": "application/vnd.oasis.opendocument.presentation",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".rtf": "application/rtf",
  };
  return mimes[ext] || "application/octet-stream";
}

/**
 * Firma el config completo con JWT.
 * IMPORTANTE: se firma TODO el objeto de configuración.
 */
function signConfig(config) {
  return jwt.sign(config, JWT_SECRET);
}

/** Descarga un archivo de una URL y lo devuelve como Buffer */
function downloadToBuffer(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    logger.debug("Download", "Descargando archivo", { url, redirectCount });
    const protocol = url.startsWith("https") ? https : http;
    protocol.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        const location = response.headers.location;
        logger.info("Download", `Redirect ${response.statusCode}`, { from: url, to: location, redirectCount: redirectCount + 1 });
        return downloadToBuffer(location, redirectCount + 1).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        logger.warn("Download", `Respuesta inesperada`, { url, status: response.statusCode });
      }
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const buffer = Buffer.concat(chunks);
        logger.debug("Download", "Descarga completada", { url, size: `${buffer.length} bytes` });
        resolve(buffer);
      });
      response.on("error", reject);
    }).on("error", (err) => {
      logger.error("Download", "Error de conexión", { url, error: err.message });
      reject(err);
    });
  });
}

// Inicializar el pool de instancias de OnlyOffice
instanceManager.init(ONLYOFFICE_INSTANCES);

// ── Rutas API ────────────────────────────────────────────────

// Proxy: sirve archivos de R2 a OnlyOffice via backend
// OnlyOffice accede a: http://host.docker.internal:13000/files/{filename}
app.get("/files/:filename", async (req, res) => {
  const { filename } = req.params;
  try {
    logger.debug("Proxy", "Sirviendo archivo desde R2", { filename, r2Key: r2Key(filename) });
    const command = new GetObjectCommand({ Bucket: R2_BUCKET, Key: r2Key(filename) });
    const result = await s3.send(command);

    res.set("Content-Type", result.ContentType || getMimeType(filename));
    res.set("Content-Length", result.ContentLength);
    res.set("Cache-Control", "no-cache");

    // result.Body es un Readable stream
    result.Body.pipe(res);
  } catch (err) {
    if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
      logger.warn("Proxy", "Archivo no encontrado", { filename });
      return res.status(404).json({ error: "Archivo no encontrado" });
    }
    logger.error("Proxy", "Error sirviendo archivo", { filename, error: err.message });
    res.status(500).json({ error: "Error descargando archivo" });
  }
});

// Listar documentos en R2 borradores/
app.get("/api/documents", async (req, res) => {
  try {
    const command = new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      Prefix: R2_PREFIX,
    });
    const result = await s3.send(command);
    const objects = result.Contents || [];

    const documents = objects
      .filter((obj) => {
        const filename = obj.Key.replace(R2_PREFIX, "");
        if (!filename || filename.includes("/")) return false;
        const ext = path.extname(filename).toLowerCase();
        return SUPPORTED_EXTENSIONS.includes(ext);
      })
      .map((obj) => {
        const filename = obj.Key.replace(R2_PREFIX, "");
        return {
          filename,
          key: generateDocumentKey(filename, obj.LastModified),
          fileType: getFileType(filename),
          size: obj.Size,
          lastModified: obj.LastModified,
        };
      });

    res.json(documents);
  } catch (err) {
    console.error("[R2] Error listando documentos:", err.message);
    res.status(500).json({ error: "Error listando documentos de R2" });
  }
});

// Obtener config del editor para un documento
app.get("/api/editor-config/:filename", async (req, res) => {
  const { filename } = req.params;
  const mode = req.query.mode || "edit"; // edit | view

  try {
    // Verificar que el archivo existe en R2 y obtener metadatos
    const head = await headObject(filename);
    const ext = path.extname(filename).replace(".", "");
    const documentKey = generateDocumentKey(filename, head.LastModified);

    // Asignar instancia de OnlyOffice (sticky por documento)
    const instanceUrl = await instanceManager.assignInstance(filename);
    logger.info("Router", "Documento asignado a instancia", { filename, instance: instanceUrl, key: documentKey, mode });

    // Guardar mapeos en Redis
    await store.assignDocument(filename, instanceUrl, documentKey);
    await store.setKeyMapping(documentKey, filename);

    // URL del documento vía proxy del backend (accesible desde Docker)
    const fileUrl = `${BACKEND_URL}/files/${encodeURIComponent(filename)}`;

    // Callback sigue apuntando al backend vía host.docker.internal
    const callbackUrl = `${BACKEND_URL}/api/callback`;

    const config = {
      height: "100%",
      width: "100%",
      document: {
        fileType: ext,
        key: documentKey,
        title: filename,
        url: fileUrl,
        permissions: {
          chat: true,
          comment: true,
          download: true,
          edit: mode === "edit",
          print: true,
          review: true,
        },
      },
      editorConfig: {
        mode: mode,
        callbackUrl: callbackUrl,
        lang: "es",
        customization: {
          autosave: true,
          forcesave: true,
          comments: true,
          compactHeader: false,
          compactToolbar: false,
          help: false,
          hideRightMenu: false,
          about: false,
          feedback: false,
        },
        user: {
          id: "user-1",
          name: "Usuario Demo",
        },
      },
      documentType: getFileType(filename),
    };

    // Firmar TODO el config con JWT
    const token = signConfig(config);
    config.token = token;

    res.json({
      config,
      onlyofficeUrl: instanceUrl,
    });
  } catch (err) {
    if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
      return res.status(404).json({ error: "Documento no encontrado en R2" });
    }
    logger.error("Router", "Error obteniendo config", { filename, error: err.message });
    res.status(500).json({ error: "Error obteniendo documento" });
  }
});

// Callback de OnlyOffice (descarga de OO y sube a R2)
app.post("/api/callback", async (req, res) => {
  const body = req.body;

  logger.info("Callback", "Callback recibido", { status: body.status, key: body.key, users: body.users });

  /**
   * Estados del callback:
   * 1 - Documento en edición
   * 2 - Documento listo para guardar (todos los editores cerraron)
   * 3 - Error al guardar
   * 4 - Documento cerrado sin cambios
   * 6 - Documento en proceso de edición, fuerza guardado (forcesave)
   * 7 - Error en force save
   */
  if (body.status === 2 || body.status === 6) {
    const downloadUrl = body.url;

    if (!downloadUrl) {
      logger.error("Callback", "No se recibió URL de descarga", { key: body.key });
      return res.json({ error: 0 });
    }

    // Resolver filename desde Redis
    const targetFile = await store.getFilenameByKey(body.key);

    if (!targetFile) {
      logger.warn("Callback", "No se encontró archivo para key", { key: body.key });
      return res.json({ error: 0 });
    }

    try {
      const instanceUrl = await instanceManager.getInstanceForDocument(targetFile);
      logger.info("Callback", "Guardando documento", { filename: targetFile, instance: instanceUrl, downloadUrl, status: body.status });

      // Descargar el archivo desde OnlyOffice
      const fileBuffer = await downloadToBuffer(downloadUrl);

      // Subir a R2
      const putCommand = new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: r2Key(targetFile),
        Body: fileBuffer,
        ContentType: getMimeType(targetFile),
      });
      await s3.send(putCommand);

      logger.info("Callback", "Documento guardado en R2", { filename: targetFile, r2Key: r2Key(targetFile) });

      // Actualizar key mapping en Redis (el mtime cambió)
      const head = await headObject(targetFile);
      const newKey = generateDocumentKey(targetFile, head.LastModified);
      await store.removeKeyMapping(body.key);
      await store.setKeyMapping(newKey, targetFile);
      logger.debug("Callback", "Key mapping actualizado", { oldKey: body.key, newKey, filename: targetFile });

      // Actualizar la asignación del documento con el nuevo key
      if (instanceUrl) {
        await store.assignDocument(targetFile, instanceUrl, newKey);
      }
    } catch (err) {
      logger.error("Callback", "Error guardando en R2", { filename: targetFile, error: err.message });
    }
  }

  // OnlyOffice espera { "error": 0 } para confirmar recepción
  res.json({ error: 0 });
});

// Subir documento a R2
app.post("/api/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No se envió archivo" });
  }

  const ext = path.extname(req.file.originalname);
  const name = path.basename(req.file.originalname, ext);
  const filename = `${name}-${Date.now()}${ext}`;

  try {
    const putCommand = new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: r2Key(filename),
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    });
    await s3.send(putCommand);

    logger.info("Upload", "Documento subido a R2", { filename, r2Key: r2Key(filename), size: req.file.size });

    res.json({
      filename,
      originalname: req.file.originalname,
      size: req.file.size,
    });
  } catch (err) {
    logger.error("Upload", "Error subiendo a R2", { filename, error: err.message });
    res.status(500).json({ error: "Error subiendo archivo a R2" });
  }
});

// Force save
app.post("/api/forcesave/:filename", async (req, res) => {
  const { filename } = req.params;

  try {
    // Obtener la instancia asignada al documento
    const instanceUrl = await instanceManager.getInstanceForDocument(filename);
    if (!instanceUrl) {
      logger.warn("Forcesave", "Sin instancia asignada", { filename });
      return res.status(404).json({ error: "Documento no tiene instancia asignada" });
    }

    logger.info("Forcesave", "Enviando forcesave", { filename, instance: instanceUrl });

    const head = await headObject(filename);
    const key = generateDocumentKey(filename, head.LastModified);

    const commandBody = {
      c: "forcesave",
      key: key,
    };

    const token = jwt.sign(commandBody, JWT_SECRET);
    commandBody.token = token;

    const url = new URL(`${instanceUrl}/coauthoring/CommandService.ashx`);

    const postData = JSON.stringify(commandBody);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData),
        Authorization: `Bearer ${token}`,
      },
    };

    const protocol = url.protocol === "https:" ? https : http;
    const request = protocol.request(options, (response) => {
      let data = "";
      response.on("data", (chunk) => (data += chunk));
      response.on("end", () => {
        try {
          res.json(JSON.parse(data));
        } catch {
          res.json({ raw: data });
        }
      });
    });

    request.on("error", (err) => {
      res.status(500).json({ error: err.message });
    });

    request.write(postData);
    request.end();
  } catch (err) {
    logger.error("Forcesave", "Error", { filename, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Estado de las instancias (monitoreo)
app.get("/api/instances/status", async (req, res) => {
  try {
    const status = await instanceManager.getStatus();
    res.json({ instances: status });
  } catch (err) {
    logger.error("Status", "Error obteniendo estado", { error: err.message });
    res.status(500).json({ error: "Error obteniendo estado de instancias" });
  }
});

// ── Iniciar servidor ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Servidor iniciado en http://localhost:${PORT}`);
  console.log(`📄 Editor: http://localhost:${PORT}`);
  console.log(`📁 R2 Bucket: ${R2_BUCKET}/${R2_PREFIX}`);
  console.log(`🔀 Instancias OnlyOffice: ${ONLYOFFICE_INSTANCES}`);
  console.log(`\n⚠️  Asegúrate de que OnlyOffice y Redis están corriendo:`);
  console.log(`   docker compose up -d\n`);
});

// ── Graceful shutdown ────────────────────────────────────────
process.on("SIGTERM", async () => {
  console.log("\n[Shutdown] Cerrando conexiones...");
  instanceManager.stop();
  await store.disconnect();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("\n[Shutdown] Cerrando conexiones...");
  instanceManager.stop();
  await store.disconnect();
  process.exit(0);
});
