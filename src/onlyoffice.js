const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const PATTERNS_PLUGIN_GUID = require("../plugins/patterns/config.json").guid;
const RELATED_DOCUMENTS_PLUGIN_GUID = require("../plugins/related-documents/config.json").guid;

// Solo los OOXML y el PDF se guardan en su formato: OnlyOffice devuelve el resto convertido a OOXML con la extensión original.
const EDITABLE_FILE_TYPES = new Set(["docx", "xlsx", "pptx", "pdf"]);

// Control de cambios: solo el editor de texto tiene modo «Revisión», y solo en un formato que se guarda tal cual.
const REVIEWABLE_FILE_TYPES = new Set(["docx"]);

const FILE_TYPES = {
  docx: { documentType: "word", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  doc: { documentType: "word", mime: "application/msword" },
  odt: { documentType: "word", mime: "application/vnd.oasis.opendocument.text" },
  rtf: { documentType: "word", mime: "application/rtf" },
  txt: { documentType: "word", mime: "text/plain" },
  xlsx: { documentType: "cell", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  xls: { documentType: "cell", mime: "application/vnd.ms-excel" },
  ods: { documentType: "cell", mime: "application/vnd.oasis.opendocument.spreadsheet" },
  csv: { documentType: "cell", mime: "text/csv" },
  pptx: { documentType: "slide", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
  ppt: { documentType: "slide", mime: "application/vnd.ms-powerpoint" },
  odp: { documentType: "slide", mime: "application/vnd.oasis.opendocument.presentation" },
  pdf: { documentType: "pdf", mime: "application/pdf" },
};

function isSupportedFileType(fileType) {
  return Object.hasOwn(FILE_TYPES, fileType);
}

function mimeType(fileType) {
  return FILE_TYPES[fileType].mime;
}

/** OnlyOffice acepta keys de hasta 128 caracteres [0-9a-zA-Z.=_-]; un sha256 en hex cumple. */
function documentKey(docRef, version) {
  return crypto.createHash("sha256").update(`${docRef}\n${version}`).digest("hex");
}

/**
 * Plugins de Roffice (plugins/):
 * - patterns, solo en el editor de texto en edición: ofrece «Insertar patrón» con los patrones del tenant (si los hay)
 *   y fija es-CO como idioma del texto cuando el documento no trae uno.
 * - related-documents, en cualquier editor y modo cuando el tenant envía documentos relacionados: el usuario lo abre
 *   desde la pestaña Extensiones, no arranca solo.
 */
function editorPlugins({ canEdit, documentType, patterns = [], patternGroups = [], relatedDocuments = [], pluginsUrl }) {
  const plugins = { autostart: [], pluginsData: [], options: {} };
  if (canEdit && documentType === "word") {
    plugins.autostart.push(PATTERNS_PLUGIN_GUID);
    plugins.pluginsData.push(`${pluginsUrl}/patterns/config.json`);
    plugins.options[PATTERNS_PLUGIN_GUID] = { patterns, patternGroups };
  }
  if (relatedDocuments.length) {
    plugins.pluginsData.push(`${pluginsUrl}/related-documents/config.json`);
    plugins.options[RELATED_DOCUMENTS_PLUGIN_GUID] = { relatedDocuments };
  }
  return plugins.pluginsData.length ? plugins : undefined;
}

function buildEditorConfig({ key, title, fileType, fileUrl, callbackUrl, user, permissions, returnUrl, patterns, patternGroups, relatedDocuments, pluginsUrl, secret }) {
  const canEdit = permissions.edit === true && EDITABLE_FILE_TYPES.has(fileType);
  // Sin `edit`, `review: true` abre en modo Revisión (solo sugerir cambios): OnlyOffice lo exige en mode "edit" con edit:false.
  const reviewOnly = !canEdit && permissions.review === true && REVIEWABLE_FILE_TYPES.has(fileType);
  const { documentType } = FILE_TYPES[fileType];
  const plugins = editorPlugins({ canEdit, documentType, patterns, patternGroups, relatedDocuments, pluginsUrl });
  const config = {
    height: "100%",
    width: "100%",
    document: {
      fileType,
      key,
      title,
      url: fileUrl,
      permissions: {
        edit: canEdit,
        comment: permissions.comment ?? (canEdit || reviewOnly),
        review: permissions.review ?? canEdit,
        download: permissions.download ?? true,
        print: permissions.print ?? true,
        chat: permissions.chat ?? true,
        protect: permissions.protect === true,
      },
    },
    editorConfig: {
      mode: canEdit || reviewOnly ? "edit" : "view",
      callbackUrl,
      lang: "es",
      user: { id: user.id, name: user.name },
      customization: {
        autosave: true,
        forcesave: true,
        comments: true,
        help: false,
        close: { visible: true, text: "Terminar edición y cerrar" },
        ...(returnUrl && { goback: { url: returnUrl, blank: false } }),
      },
      ...(plugins && { plugins }),
    },
    documentType,
  };
  return { ...config, token: jwt.sign(config, secret) };
}

/**
 * Con JWT_IN_BODY=true OnlyOffice firma el body en `token`; sin él, lo envía
 * en el header como `{ payload: body }`. Se confía solo en el contenido firmado.
 */
function verifyCallback(body, authorizationHeader, secret) {
  const options = { algorithms: ["HS256"] };
  if (body?.token) return jwt.verify(body.token, secret, options);

  const headerToken = authorizationHeader?.replace(/^Bearer /, "");
  if (headerToken) return jwt.verify(headerToken, secret, options).payload;

  throw new Error("Callback sin token");
}

/**
 * Adapter HTTP del CommandService de OnlyOffice: firma el comando con el secreto compartido.
 * @returns {(instanceUrl: string, command: Object) => Promise<{status: number, body: string}>}
 */
function createCommandSender(secret) {
  return async function sendCommand(instanceUrl, command) {
    const token = jwt.sign(command, secret);
    const response = await fetch(`${instanceUrl}/coauthoring/CommandService.ashx`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...command, token }),
    });
    return { status: response.status, body: await response.text() };
  };
}

const escapeHtml = (text) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Página de la pestaña del editor. El config lleva datos del cliente (título, nombre de usuario): se escapa para que no cierre el <script>. */
function renderEditorPage({ config, publicUrl }) {
  const configJson = JSON.stringify(config).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(config.document.title)}</title>
  <style>html, body, #editor { height: 100%; margin: 0; }</style>
  <script src="${escapeHtml(publicUrl)}/web-apps/apps/api/documents/api.js"></script>
</head>
<body>
  <div id="editor"></div>
  <script>
    const config = ${configJson};

    // En la primera carga sin caché el editor a veces no arranca: un módulo de OnlyOffice se ejecuta antes que su
    // dependencia, lanza una excepción y la pantalla queda en blanco; recargar lo resuelve porque ya hay caché.
    // Si onAppReady no llega a tiempo se recarga sola (hasta MAX_RELOADS veces) y, si no, avisa en vez de quedar en blanco.
    const APP_READY_TIMEOUT_MS = 10000;
    const MAX_RELOADS = 2;
    const reloadsKey = "roffice-reloads:" + location.pathname;
    const reloads = Number(sessionStorage.getItem(reloadsKey) || 0);
    const appReadyTimer = setTimeout(() => {
      if (reloads < MAX_RELOADS) {
        sessionStorage.setItem(reloadsKey, reloads + 1);
        location.reload();
      } else {
        document.body.textContent = "No se pudo cargar el editor. Recarga la página para reintentar.";
      }
    }, APP_READY_TIMEOUT_MS);
    function appReady() {
      clearTimeout(appReadyTimer);
      sessionStorage.removeItem(reloadsKey);
    }

    const editor = new DocsAPI.DocEditor("editor", { ...config, events: { onAppReady: appReady, onRequestClose: finishEditing } });

    // OnlyOffice llama a onRequestClose desde su botón de cerrar tras confirmar los cambios sin guardar;
    // al destruir el editor la sesión se libera y el guardado llega ~10 s después.
    function finishEditing() {
      editor.destroyEditor();
      window.close();
      // El navegador solo deja cerrar pestañas abiertas por script (window.open del tenant).
      setTimeout(() => {
        if (window.closed) return;
        const returnUrl = config.editorConfig.customization.goback?.url;
        if (returnUrl) location.href = returnUrl;
        else document.body.textContent = "Edición terminada. Ya puedes cerrar esta pestaña.";
      }, 300);
    }
  </script>
</body>
</html>`;
}

module.exports = { isSupportedFileType, mimeType, documentKey, buildEditorConfig, verifyCallback, renderEditorPage, createCommandSender };
