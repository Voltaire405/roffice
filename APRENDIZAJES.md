# Aprendizajes: OnlyOffice Document Server + Cloudflare R2

## 1. Networking Docker ↔ Host

OnlyOffice corre en contenedor y necesita alcanzar el backend en el host. Las URLs que le pasas (documento, callback) **no pueden ser `localhost`** porque dentro del contenedor eso apunta a sí mismo.

- Usar `host.docker.internal` para que el contenedor llegue al host.
- En Linux agregar explícitamente: `extra_hosts: ["host.docker.internal:host-gateway"]`
- En macOS Docker Desktop lo resuelve automáticamente, pero conviene declararlo igual por portabilidad.

**Regla**: toda URL que OnlyOffice consume (document.url, callbackUrl) debe usar `host.docker.internal`, nunca `localhost`.

## 2. Presigned URLs de R2 no funcionan con OnlyOffice

OnlyOffice usa Axios internamente para descargar documentos. Las presigned URLs de R2 con estilo virtual-hosted (`{bucket}.{account}.r2.cloudflarestorage.com`) devuelven **400 Bad Request**.

**Solución**: no usar presigned URLs. En su lugar, crear un endpoint proxy en el backend que descargue de R2 y haga streaming al cliente:

```js
app.get("/files/:filename", async (req, res) => {
  const result = await s3.send(new GetObjectCommand({ Bucket, Key }));
  result.Body.pipe(res);
});
```

OnlyOffice recibe una URL limpia: `http://host.docker.internal:13000/files/doc.docx`

## 3. S3 Client + R2: forcePathStyle obligatorio

El AWS SDK v3 usa virtual-hosted-style por defecto (`{bucket}.endpoint`). R2 requiere path-style (`endpoint/{bucket}`).

```js
const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  forcePathStyle: true, // obligatorio para R2
  credentials: { ... },
});
```

## 4. document.key: debe cambiar con cada versión

OnlyOffice cachea agresivamente por `document.key`. Si el key no cambia después de guardar, el editor sigue mostrando la versión anterior.

- Generar el key basado en `filename + LastModified` (o `mtime` si es local).
- Después de cada guardado (callback status 2 o 6), actualizar el key.

```js
function generateDocumentKey(filename, lastModified) {
  const ts = new Date(lastModified).getTime().toString();
  return Buffer.from(`${filename}_${ts}`).toString("base64url").slice(0, 20);
}
```

El key tiene límite de 128 caracteres. Mantenerlo corto.

## 5. JWT: firmar TODO el config

OnlyOffice valida que el JWT contenga **todo** el objeto de configuración, no solo un subset. Si firmas parcialmente, rechaza la solicitud silenciosamente.

```js
const config = { document: {...}, editorConfig: {...}, ... };
const token = jwt.sign(config, JWT_SECRET);
config.token = token; // agregar después de firmar
```

El `JWT_SECRET` debe ser idéntico entre el backend y el `docker-compose.yml`.

## 6. Callback: estados importantes

OnlyOffice envía callbacks con diferentes status. Solo dos requieren guardar:

- **Status 2**: todos los editores cerraron → guardar versión final.
- **Status 6**: forcesave → guardar versión intermedia (autosave activo).

Siempre responder `{ "error": 0 }` para confirmar recepción, incluso si hay error interno. Si no respondes correctamente, OnlyOffice reintenta indefinidamente.

## 7. Resolución key → filename en callbacks

OnlyOffice envía el `document.key` en el callback, no el nombre del archivo. Necesitas un mecanismo para resolver key → filename.

- Con almacenamiento local: iterar archivos y recalcular keys.
- Con object storage: mantener un **mapa en memoria** (`Map<key, filename>`) que se actualiza al abrir y al guardar.

**Cuidado**: el mapa en memoria se pierde al reiniciar el servidor. En producción, usar Redis o base de datos.

## 8. El editor necesita 100% del viewport

OnlyOffice genera un iframe. Si el contenedor no tiene dimensiones explícitas, el editor aparece cortado.

```js
// En el config del editor
{ height: "100%", width: "100%" }
```

```css
/* En el CSS del contenedor */
#editor-container {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  width: 100%; height: 100%;
}
#editor-container iframe {
  width: 100% !important;
  height: 100% !important;
}
```

Ocultar cualquier header/nav propio cuando el editor está activo.

## 9. OnlyOffice tarda en iniciar

El contenedor de Document Server necesita ~1-2 minutos para estar completamente operativo después de `docker compose up`. El healthcheck (`/healthcheck`) puede responder 200 antes de que el servicio de documentos esté listo.

Verificar accesibilidad real con: `curl http://localhost:18080/web-apps/apps/api/documents/api.js`

## 10. Parámetros deprecados

OnlyOffice v8+ movió `chat` de `editorConfig.customization` a `document.permissions`. Revisar los logs del contenedor para detectar deprecations y mantener la config actualizada con la versión instalada.

## 11. Multer en memoria para object storage

Cuando el destino es object storage (no disco local), usar `multer.memoryStorage()`. El archivo llega como `req.file.buffer` y se sube directo a R2 sin tocar disco:

```js
const upload = multer({ storage: multer.memoryStorage() });

app.post("/api/upload", upload.single("file"), async (req, res) => {
  await s3.send(new PutObjectCommand({
    Bucket, Key, Body: req.file.buffer, ContentType: req.file.mimetype,
  }));
});
```

## 12. Plugin de patrones servido desde Roffice (OnlyOffice 10.0)

`plugins/patterns/` se carga con `editorConfig.plugins.pluginsData` desde `PUBLIC_URL/plugins`, no desde la instancia:

- El editor descarga el `config.json` con `fetch` desde el origen de la instancia: `/plugins` responde `Access-Control-Allow-Origin: *`.
- `plugins.js` es una copia de `sdkjs-plugins/v1/plugins.js` del contenedor. Al actualizar la imagen de OnlyOffice (`documentserver:latest`), vuelve a copiarlo (`docker cp onlyoffice-ds-1:/var/www/onlyoffice/documentserver/sdkjs-plugins/v1/plugins.js plugins/patterns/`) y repite la prueba del menú.
- `AddContextMenuItem` exige `guid` del plugin en el objeto; sin él, el SDK lanza `Cannot read properties of undefined` y el editor muestra un diálogo de error del documento.
- El SDK define su propio `event_onContextMenuClick` y pisa `attachEvent("onContextMenuClick")`: el clic se registra por id con `attachContextMenuClickEvent`.
- Los patrones llegan en `Asc.plugin.info.options` (las `options[guid]` del config). El `text` de los ítems se muestra literal: OnlyOffice escapa el HTML.
