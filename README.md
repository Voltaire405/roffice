# Roffice: Router Office

Roffice es un router que se sitúa entre tus aplicaciones y un pool de instancias de OnlyOffice Community Edition. Tu aplicación le pide abrir un documento y Roffice se encarga del resto: elige una instancia, entrega al navegador un editor ya configurado y, cuando el usuario guarda, devuelve el archivo a tu almacenamiento.

Con esto la edición de documentos queda fuera de la arquitectura de cada aplicación. Varias aplicaciones comparten el mismo pool, las instancias se escalan sin tocarlas y ninguna aplicación necesita conocer el protocolo de OnlyOffice.

## Arquitectura

```
Frontend ──JWT usuario──▶ Backend cliente ──token de servicio──▶ Roffice ──▶ OnlyOffice
                               ▲                                    │
                               └───── POST saveUrl (token Roffice) ─┘ → PUT prefirmado al storage
```

Roffice no almacena documentos ni conoce a los usuarios. El documento vive en el Object Storage de la aplicación cliente, y es su backend quien decide qué puede hacer cada usuario. Roffice solo recibe una URL prefirmada para leer el archivo y, al guardar, pide otra para escribirlo.

Abrir un documento sigue siempre el mismo recorrido:

1. El frontend abre una pestaña en blanco en el mismo click, antes de cualquier `await`, para que el bloqueador de pop-ups no la cierre.
2. El frontend pide el documento a su backend, que valida al usuario y llama a `POST /api/sessions` con un token de servicio.
3. Roffice asigna el documento a una instancia y responde con un `editorUrl` de un solo uso, válido 60 segundos.
4. El frontend navega la pestaña a ese enlace y el editor carga directamente desde la instancia asignada.
5. Cuando OnlyOffice guarda, Roffice descarga el archivo, llama a la `saveUrl` del cliente para obtener un PUT prefirmado y lo sube al storage. Esa llamada le sirve además al backend cliente como aviso de que el documento cambió.

Cuando la pestaña del editor se cierra o cambia de documento, avisa a la ventana que la abrió con `postMessage({ type: "roffice:tab-closed" }, "*")`.

### El pool de instancias

Cada documento se asigna a la instancia sana con menos carga, y todos los que abren ese mismo documento llegan a la misma instancia, que es lo que OnlyOffice necesita para la co-edición. El reparto se guarda en Redis, así que sobrevive a los reinicios de Roffice. `GET /api/instances/status` muestra el estado y la carga de cada instancia.

### Autenticación entre servicios

El JWT del usuario nunca llega a Roffice. Los servicios se autentican entre sí con OIDC *client credentials* sobre un realm de Keycloak propio de Roffice, donde cada aplicación cliente (un **tenant**) tiene su propio client:

| Client | Uso |
|---|---|
| `<cliente>-backend`, uno por tenant | Llama a `/api/sessions`. Su `client_id` se registra en `TENANTS` junto con su `saveUrl` |
| `roffice` | Llama a la `saveUrl` de cada tenant |

Sumar una aplicación es dar de alta un client; no hay que cambiar código. El tenant, por su parte, publica su `saveUrl` en una ruta que acepte únicamente tokens del realm de Roffice con `azp=roffice`.

### Contrato HTTP

El backend cliente abre una sesión con `POST /api/sessions`:

```json
{
  "docId": "contratos/123.docx",
  "version": "etag-o-version-del-objeto",
  "fileType": "docx",
  "title": "Contrato 123.docx",
  "getUrl": "https://storage/...?X-Amz-Signature=...",
  "user": { "id": "sub-del-jwt", "name": "Ana Pérez" },
  "permissions": { "edit": true, "comment": true, "review": true, "download": true, "print": true },
  "returnUrl": "https://app.cliente/docs/123"
}
```

`getUrl` es el GET prefirmado del archivo y `version` un valor que cambia cuando el objeto cambia. `permissions` decide el modo de apertura: con `edit` se abre en edición, con solo `review` en revisión (únicamente `docx`) y en cualquier otro caso en visualización. `returnUrl` es opcional y fija el destino del botón «volver».

Hay dos campos opcionales más. `patterns` o `patternGroups` añaden al editor de texto un menú «Insertar patrón»; `patternGroups` es un árbol de hojas `{ label, pattern }` y grupos `{ label, children }` de hasta 4 niveles y 500 nodos. `relatedDocuments` acepta hasta 50 `{ title, url }` con PDF de consulta que el usuario abre junto al documento; cada `url` debe seguir válida mientras dure la pestaña, hasta 24 horas.

Cada usuario puede tener abiertos hasta `MAX_DOCS_PER_USER` documentos, uno por defecto. Al abrir otro, Roffice lo desconecta del más antiguo.

Al guardar, Roffice llama a la `saveUrl` del tenant con su propio token de servicio y el cuerpo `{ "docId", "version", "contentType" }`. El tenant responde `{ "putUrl": "<PUT prefirmado>" }`, firmado con ese `Content-Type` y con una vida de pocos minutos. La `version` que recibe es la de apertura de la sesión, aunque haya habido guardados intermedios, por lo que no sirve como `If-Match`.

Para forzar un guardado sin esperar a que el usuario cierre, el backend cliente llama a `POST /api/sessions/:docId/forcesave`.

## Puesta en marcha para desarrollo

Necesitas Node.js 26, Docker y un Keycloak accesible. Copia `.env.example` a `.env` y `.env.admin.example` a `.env.admin`, y sigue los runbooks de [`docs/runbooks/`](docs/runbooks/) en este orden:

1. [`keycloak-init`](docs/runbooks/keycloak-init.md) crea el realm y el client `roffice` con `npm run keycloak -- init`.
2. [`alta-tenant`](docs/runbooks/alta-tenant.md) registra una aplicación cliente con `npm run keycloak -- add-tenant`.
3. [`entorno-local`](docs/runbooks/entorno-local.md) levanta el entorno:

```bash
docker compose up -d   # Redis y 3 instancias de OnlyOffice
npm install
npm run dev            # Roffice en http://localhost:13000
npm test
```

El compose no incluye a Roffice, que corre en el host. Por eso `BACKEND_URL` apunta por defecto a `http://host.docker.internal:13000`: es la dirección con la que los contenedores de OnlyOffice lo alcanzan. Las pruebas usan la base 15 del Redis del compose y la vacían.

Para probar el recorrido completo sin integrar una aplicación real, [`cliente-prueba`](docs/runbooks/cliente-prueba.md) levanta el tenant de ejemplo de `examples/cliente-prueba/`. Si algo falla, o Roffice responde 401, 403 o 410, consulta [`problemas`](docs/runbooks/problemas.md).

## Puesta en marcha en producción

Cada tag `v*` publica en `ghcr.io/voltaire405/roffice` una imagen para `linux/amd64` y `linux/arm64`. También puedes construirla tú:

```bash
docker build -t roffice:latest .
docker run --name roffice -d -p 13000:13000 --env-file .env roffice:latest
```

La imagen contiene solo a Roffice. Redis, las instancias de OnlyOffice y Keycloak se despliegan aparte, y `.env` le dice dónde encontrarlos. Dentro del contenedor `localhost` es el propio contenedor, así que `REDIS_URL` y las URLs internas de `ONLYOFFICE_INSTANCES` deben apuntar a donde realmente corren esos servicios.

Antes de desplegar, revisa la lista de [`produccion`](docs/runbooks/produccion.md). En resumen:

- `JWT_SECRET` es propio, distinto del de ejemplo, e idéntico en Roffice y en cada instancia de OnlyOffice. Con él se firma la configuración del editor y se verifica cada callback.
- `PUBLIC_URL` usa `https://`, lo que activa la cookie `Secure` de la pestaña.
- Cada entrada de `ONLYOFFICE_INSTANCES` tiene la forma `interna|pública`. Roffice usa la interna para los health checks y el guardado forzado; el navegador carga el editor desde la pública, que va en `https://` detrás de un reverse proxy.
- Cada instancia de OnlyOffice alcanza a Roffice en `BACKEND_URL`.
- `.env` tiene permisos `600`.
