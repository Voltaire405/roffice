# Roffice: Router Office

Router para OnlyOffice Community Edition. Permite escalar las instancias de edición y desacoplarlas de la arquitectura del consumidor para asegurar el cumplimiento del licenciamiento.

Runbooks de configuración y operación: [`docs/runbooks/`](docs/runbooks/).

Roffice no tiene storage propio: el documento vive en el Object Storage de la aplicación cliente. El cliente abre una sesión con una URL prefirmada de lectura y Roffice, al guardar, le pide una URL prefirmada de escritura.

## Requisitos

- Node.js 26 (LTS)
- Docker
- Un realm OIDC (Keycloak) con los clients descritos en [Autenticación](#autenticación)

## Ejecución local

Sigue los runbooks en este orden: [`keycloak-init`](docs/runbooks/keycloak-init.md) (realm y client `roffice`), [`alta-tenant`](docs/runbooks/alta-tenant.md) y [`entorno-local`](docs/runbooks/entorno-local.md), que levanta Redis y las 3 instancias de OnlyOffice con `docker compose`, arranca el backend (el compose no lo incluye) y ejecuta `npm test`.

## Flujo

```
Angular ──JWT usuario──▶ Backend cliente ──token servicio──▶ Roffice ──▶ OnlyOffice
                              ▲                                 │
                              └──── POST saveUrl (token Roffice)┘ → PUT prefirmado al storage
```

1. En el handler del click, Angular abre la pestaña **antes** de cualquier `await` (si no, el bloqueador de pop-ups la cierra): `const tab = window.open("about:blank")`.
2. Angular pide abrir el documento a su backend con el JWT de Keycloak del usuario. El backend decide si el usuario puede editar o solo ver.
3. El backend cliente llama `POST /api/sessions` con su token de servicio y recibe `{ editorUrl, expiresIn }`, que reenvía a Angular.
4. Angular navega la pestaña: `tab.location = editorUrl`. El enlace es de un solo uso y vence en 60 s; Roffice lo canjea por una cookie `HttpOnly` de esa pestaña y redirige a `/editor/:tabId`, que carga el editor desde la URL pública de la instancia.
5. Cuando la página del editor se va (cierre, recarga o el siguiente documento en la misma pestaña), envía al opener `postMessage({ type: "roffice:tab-closed" }, "*")` en `beforeunload`. El mensaje no lleva datos. Para distinguir un cierre real, Angular comprueba `tab.closed` unos cientos de ms después. No hace falta consultar `tab.closed` periódicamente. Si la pestaña se abre con `noopener`, no hay opener y el aviso no llega.
6. Al guardar (callback 2 o 6), Roffice descarga el archivo de OnlyOffice, llama `POST saveUrl` del cliente para obtener un PUT prefirmado y sube el archivo. Esa llamada le sirve al backend cliente de aviso de que el documento cambió.

```ts
async openEditor(docId: string) {
  const tab = window.open("about:blank");
  try {
    const { editorUrl } = await firstValueFrom(this.http.post<{ editorUrl: string }>(`/api/docs/${docId}/editor`, {}));
    tab!.location.href = editorUrl;
  } catch {
    tab?.close();
  }
}
```

### `POST /api/sessions` (backend cliente → Roffice)

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

- `permissions` define el modo de apertura: `edit: true` → Edición; sin `edit` y `review: true` (solo `docx`) → Revisión (solo sugerir cambios); el resto → Visualización.
- `returnUrl` (opcional): destino del botón «volver» del editor (`customization.goback`).
- `patterns` / `patternGroups` (opcionales): menú contextual «Insertar patrón» del editor de texto. Roffice sirve el plugin `plugins/patterns/` en `PUBLIC_URL/plugins` y le pasa los patrones en `editorConfig.plugins.options`; solo se carga en `docx` en edición, con o sin patrones. `patternGroups` es un árbol: cada nodo es una hoja `{ label, pattern }`, que inserta `${pattern}` tal cual, o un grupo `{ label, children }`, que abre un submenú; nunca ambos. Admite hasta 4 niveles y 500 nodos en total; si los supera, Roffice responde 400. Ese mismo plugin fija `es-CO` como idioma del texto por defecto (`editorConfig.lang` solo traduce la interfaz y el idioma del texto vive en el documento).
- `relatedDocuments` (opcional): hasta 50 `{ title, url }`, PDF que el usuario consulta para elaborar el documento, en cualquier editor y modo de apertura. Roffice carga el plugin `plugins/related-documents/` y el usuario lo abre desde la pestaña «Extensiones». Abre una ventana no modal que se arrastra, se redimensiona y se puede acoplar al panel lateral; acoplada tiene ancho fijo. Un desplegable elige el documento y lo muestra con el visor PDF del navegador. El plugin no recibe la `url`, sino `PUBLIC_URL/related/<token>`; ahí Roffice la descarga y responde 415 si no empieza por `%PDF-`, sea cual sea su `Content-Type`. Roffice la lee cada vez que el usuario elige el documento, así que debe seguir válida mientras dure la pestaña (hasta 24 h); un prefirmado de minutos dará 502.
- `getUrl`: GET prefirmado. Roffice lo sirve a OnlyOffice vía `/files/:fileToken`; nunca llega al navegador.
- `version`: cambia cuando el objeto cambia. Mientras haya una sesión abierta, quien se une recibe la misma `key` aunque la versión haya avanzado por un forcesave.
- `docId` se aísla por cliente (`azp:docId`), así dos clientes pueden usar el mismo id.
- Cada `azp:user.id` tiene hasta `MAX_DOCS_PER_USER` documentos abiertos (por defecto 1). Al abrir otro, Roffice desconecta al usuario del más antiguo con el comando `drop` y borra su pestaña. El tenant abre el editor en la pestaña con nombre `roffice`, así el nuevo documento reemplaza al anterior en la misma pestaña.

### `POST saveUrl` (Roffice → backend cliente)

Roffice envía `Authorization: Bearer <token de servicio de Roffice>` y `{ "docId", "version", "contentType" }`. `version` es la de apertura de la sesión, incluso después de un forcesave: no sirve como `If-Match`. El cliente responde `{ "putUrl": "<PUT prefirmado>" }` con vida de minutos y firmado con ese `Content-Type`.

## Autenticación

El JWT del usuario no llega a Roffice: la autorización es del backend cliente. Entre servicios se usa OIDC *client credentials* sobre un **realm propio de Roffice** (`OIDC_ISSUER`). El realm del cliente queda solo para sus usuarios; sumar un cliente es dar de alta un client, sin cambiar código.

| Client en el realm de Roffice | Uso | Configuración |
|---|---|---|
| `<cliente>-backend` (uno por cliente) | Llama a `/api/sessions` | Service account + audience mapper `roffice`; su `client_id` va en `TENANTS` |
| `roffice` | Llama a la `saveUrl` de cada cliente | Service account + audience mapper del backend cliente |

Roffice valida `iss`, `aud` (`OIDC_AUDIENCE`) y la firma con el JWKS del realm. El claim `azp` debe estar en `TENANTS`, que también fija la `saveUrl` de cada cliente.

### Configuración automática (`scripts/keycloak.js`)

`npm run keycloak -- init` crea el realm y el client `roffice` y escribe `OIDC_*` en `.env`; `npm run keycloak -- add-tenant` da de alta un cliente y lo suma a `TENANTS`. Ambos son idempotentes y sus pasos están en los runbooks [`keycloak-init`](docs/runbooks/keycloak-init.md) y [`alta-tenant`](docs/runbooks/alta-tenant.md). Las credenciales de administración van en `.env.admin`, separadas de `.env` para que Roffice no las tenga en runtime.

El cliente publica la `saveUrl` **en su gateway** con una ruta que confíe en el issuer del realm de Roffice y acepte solo `azp=roffice` con su audiencia. El resto de sus rutas sigue validando el JWT de sus usuarios.

## Estructura

```
├── src/
│   ├── main.js          # Arranque: lee .env, cablea Redis, pool, OIDC y adapters, escucha
│   ├── app.js           # createApp: traduce HTTP a la sesión de edición
│   ├── edit-session.js  # Sesión de edición: abrir, pestaña, proxy de archivo, callbacks, forcesave, límite por usuario
│   ├── pool.js          # Pool de instancias OnlyOffice: sticky routing y dueño de doc:
│   ├── onlyoffice.js    # Protocolo OnlyOffice: key, config firmado, callback y CommandService
│   ├── tenants.js       # Adapter HTTP: guarda en el storage del tenant vía su saveUrl
│   ├── oidc.js          # Validación de tokens de servicio (JWKS) y client credentials
│   └── logger.js        # Logger estructurado + middleware de request
├── test/                # node --test; los de sesión y HTTP usan Redis real (DB 15, se vacía)
├── scripts/keycloak.js  # Realm, client roffice y alta de tenants
├── plugins/             # Plugins de OnlyOffice servidos en PUBLIC_URL/plugins: patterns, related-documents
├── onlyoffice/          # Lista de plugins que cada instancia descarga al arrancar
├── examples/            # Tenant de prueba (docs/runbooks/cliente-prueba.md)
├── docs/runbooks/       # Procedimientos de configuración y operación
├── .github/workflows/   # Publicación de la imagen en ghcr.io
├── docker-compose.yml   # Redis + 3 instancias OnlyOffice Document Server
└── Dockerfile           # Imagen del backend
```

## API

| Endpoint | Método | Auth | Descripción |
|---|---|---|---|
| `/api/sessions` | POST | Token de servicio | Abre o se une a la sesión de edición; devuelve el enlace de un solo uso de la pestaña |
| `/editor/launch/:launchToken` | GET | Enlace de un solo uso | Canjea el enlace por la cookie de la pestaña y redirige |
| `/editor/:tabId` | GET | Cookie de la pestaña | Página del editor |
| `/api/sessions/:docId/forcesave` | POST | Token de servicio | Fuerza el guardado vía `CommandService` de la instancia asignada |
| `/api/callback` | POST | JWT de OnlyOffice | Guarda en el storage del cliente (2, 6), cierra la sesión (2) y libera la instancia del documento (4) |
| `/files/:fileToken` | GET | Token opaco | Proxy del `getUrl` del cliente (usado por OnlyOffice) |
| `/related/:token` | GET | Token opaco | Proxy de un `relatedDocuments[].url` (usado por el plugin) |
| `/plugins/*` | GET | — | Plugins de OnlyOffice (`plugins/`) |
| `/api/instances/status` | GET | — | Estado y carga actual de cada instancia del pool |

## Puntos clave

Las URLs de documento y callback usan `BACKEND_URL` (por defecto `http://host.docker.internal:13000`) para que los contenedores de OnlyOffice puedan alcanzar el backend que corre en el host.

El `document.key` es `sha256(azp:docId + version)`. Se conserva durante toda la sesión, incluidos los forcesave, y se libera con el status 2 (o a las 24 h). El status 4 no la libera: un editor que estuvo desconectado se reconecta con la misma key y envía luego su 2. La próxima apertura con la nueva versión genera una key nueva.

Un guardado fallido (descarga, `saveUrl` o PUT) responde `500` con `error: 1`, para que OnlyOffice no lo dé por persistido.

Se firma con JWT todo el objeto de configuración del editor así como los comandos al `CommandService` (forcesave, drop), y se verifica el JWT de cada callback. El secret debe coincidir entre `.env` (`JWT_SECRET`) y `docker-compose.yml` (`JWT_SECRET` de cada instancia).

El pool de instancias se configura en `ONLYOFFICE_INSTANCES` como lista separada por comas de `interna|pública`: Roffice usa la interna para health checks y forcesave, y el navegador carga el editor desde la pública. Sin `|`, ambas son la misma. `src/pool.js` asigna cada documento a la instancia sana con menos documentos, de forma sticky y atómica aunque lleguen aperturas simultáneas, y persiste el mapeo y la carga por instancia en Redis, de modo que todos los editores del mismo documento caen en la misma instancia (requisito de co-edición de OnlyOffice).

## Imagen Docker

Cada tag `v*` publica en `ghcr.io/voltaire405/roffice` una imagen `linux/amd64` y `linux/arm64` (`.github/workflows/docker.yml`).

```bash
# Construir en local
docker build -t roffice:latest .

# Ejecutar
docker run --name roffice -d -p 13000:13000 --env-file .env roffice:latest
```

Dentro del contenedor `localhost` es el propio contenedor: `REDIS_URL` y las URLs internas de `ONLYOFFICE_INSTANCES` deben apuntar a donde corren Redis y OnlyOffice (por ejemplo `host.docker.internal`).
