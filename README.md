# Roffice -  Router Office

Router para OnlyOffice Community Edition. Permite escalar las instancias de edición y desacoplarlas de la arquitectura del consumidor para asegurar el cumplimiento del licenciamiento.

Runbooks de configuración y operación: [`docs/runbooks/`](docs/runbooks/).

Roffice no tiene storage propio: el documento vive en el Object Storage de la aplicación cliente. El cliente abre una sesión con una URL prefirmada de lectura y Roffice, al guardar, le pide una URL prefirmada de escritura.

## Requisitos

- Node.js 18+
- Docker
- Un realm OIDC (Keycloak) con los clients descritos en [Autenticación](#autenticación)

## Inicio rápido

```bash
# 1. Instalar dependencias
npm install

# 2. Configurar variables de entorno
cp .env.example .env
# Editar .env: OIDC_*, TENANTS

# 3. Levantar Redis + 3 instancias de OnlyOffice
docker compose up -d

# 4. Esperar ~1 minuto a que OnlyOffice inicie completamente
# Verificar: http://localhost:18080, :18081, :18082 deben mostrar "Document Server is running"

# 5. Iniciar el backend (el compose no lo incluye)
npm run dev

# Pruebas
npm test   # unitarios + flujo HTTP en proceso contra el Redis del compose (DB 15)
```

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
5. Al guardar (callback 2 o 6), Roffice descarga el archivo de OnlyOffice, llama `POST saveUrl` del cliente para obtener un PUT prefirmado y sube el archivo. Esa llamada le sirve al backend cliente de aviso de que el documento cambió.

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

- `returnUrl` (opcional): destino del botón «volver» del editor (`customization.goback`).

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

Credenciales de administración en `.env.admin` (ver `.env.admin.example`), separadas de `.env` para que Roffice no las tenga en runtime. Ambos comandos son idempotentes.

```bash
# Una vez: crea el realm y el client roffice, y escribe OIDC_* en .env
npm run keycloak -- init

# Por cada cliente: crea su client, agrega la audiencia de su gateway al token de roffice
# y lo suma a TENANTS en .env. Imprime el client_id y secret a entregar.
npm run keycloak -- add-tenant acme-backend https://gateway.acme/roffice/save-url acme-api
```

Después de `add-tenant`, reiniciar Roffice. El cliente publica la `saveUrl` **en su gateway** con una ruta que confíe en el issuer del realm de Roffice y acepte solo `azp=roffice` con su audiencia. El resto de sus rutas sigue validando el JWT de sus usuarios.

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
├── examples/            # Tenant de prueba (docs/runbooks/cliente-prueba.md)
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
| `/api/callback` | POST | JWT de OnlyOffice | Guarda en el storage del cliente (2, 6) y cierra la sesión (2, 4) |
| `/files/:fileToken` | GET | Token opaco | Proxy del `getUrl` del cliente (usado por OnlyOffice) |
| `/api/instances/status` | GET | — | Estado y carga actual de cada instancia del pool |

## Puntos clave

Las URLs de documento y callback usan `BACKEND_URL` (por defecto `http://host.docker.internal:13000`) para que los contenedores de OnlyOffice puedan alcanzar el backend que corre en el host.

El `document.key` es `sha256(azp:docId + version)`. Se conserva durante toda la sesión, incluidos los forcesave, y se libera con el status 2 o 4. La próxima apertura con la nueva versión genera una key nueva.

Un guardado fallido (descarga, `saveUrl` o PUT) responde `500` con `error: 1`, para que OnlyOffice no lo dé por persistido.

Se firma con JWT todo el objeto de configuración del editor así como los comandos al `CommandService` (forcesave, drop), y se verifica el JWT de cada callback. El secret debe coincidir entre `.env` (`JWT_SECRET`) y `docker-compose.yml` (`JWT_SECRET` de cada instancia).

El pool de instancias se configura en `ONLYOFFICE_INSTANCES` como lista separada por comas de `interna|pública`: Roffice usa la interna para health checks y forcesave, y el navegador carga el editor desde la pública. Sin `|`, ambas son la misma. `src/pool.js` asigna cada documento a la instancia sana con menos documentos, de forma sticky y atómica aunque lleguen aperturas simultáneas, y persiste el mapeo y la carga por instancia en Redis, de modo que todos los editores del mismo documento caen en la misma instancia (requisito de co-edición de OnlyOffice).

## Docker Build

```
# Build

docker build -t roffice:latest .

# Run

docker run --name roffice -d -p 13000:13000 --env-file .env roffice:latest
```

**Nota:** Debe actualizarse las variables de entorno si el backend corre en docker para que apunte a las instancias correctas de onlyoffice.
