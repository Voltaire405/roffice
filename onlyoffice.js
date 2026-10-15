const crypto = require("crypto");
const jwt = require("jsonwebtoken");

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

function buildEditorConfig({ key, title, fileType, fileUrl, callbackUrl, user, permissions, secret }) {
  const canEdit = permissions.edit === true;
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
        comment: permissions.comment ?? canEdit,
        review: permissions.review ?? canEdit,
        download: permissions.download ?? true,
        print: permissions.print ?? true,
        chat: permissions.chat ?? true,
      },
    },
    editorConfig: {
      mode: canEdit ? "edit" : "view",
      callbackUrl,
      lang: "es",
      user: { id: user.id, name: user.name },
      customization: {
        autosave: true,
        forcesave: true,
        comments: true,
        help: false,
        about: false,
        feedback: false,
      },
    },
    documentType: FILE_TYPES[fileType].documentType,
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

module.exports = { isSupportedFileType, mimeType, documentKey, buildEditorConfig, verifyCallback };
