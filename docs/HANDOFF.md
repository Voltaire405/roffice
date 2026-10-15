# HANDOFF: integrar tu aplicación con Roffice

Documento para el proyecto cliente. Cópialo a la raíz de ese proyecto. El operador de Roffice completa la tabla «Valores de tu tenant» antes de entregarlo.

## Qué es Roffice

Roffice es un servicio externo que abre documentos de Office (docx, xlsx, pptx…) en un editor OnlyOffice, en una **pestaña independiente** del navegador, y guarda los cambios **en tu Object Storage**. Tu aplicación es un **tenant** de Roffice.

- Roffice no guarda documentos: los lee con una URL prefirmada de GET que tú le das y los escribe con una URL prefirmada de PUT que le das al guardar.
- Roffice no conoce a tus usuarios ni tu Keycloak: tu backend autoriza y le dice quién es el usuario y qué puede hacer.
- Tu aplicación no habla con OnlyOffice: solo recibe un enlace y lo abre en una pestaña.

```
Angular ──JWT usuario──▶ Tu backend ──token servicio──▶ Roffice ──▶ OnlyOffice (pestaña)
   │                        ▲                              │
   └─ abre editorUrl        └── POST saveUrl (token de Roffice) → PUT prefirmado a tu storage
```

## Valores de tu tenant

| Variable (en tu backend) | Valor | Uso |
|---|---|---|
| `ROFFICE_URL` | `https://<roffice>` | Base de la API de Roffice |
| `ROFFICE_TOKEN_ENDPOINT` | `https://<keycloak>/realms/roffice/protocol/openid-connect/token` | Pedir tu token de servicio |
| `ROFFICE_CLIENT_ID` | `<tu-client-id>` | Tu identidad ante Roffice |
| `ROFFICE_CLIENT_SECRET` | Entregado por canal seguro | Solo en el backend, en tu gestor de secretos |
| `ROFFICE_ISSUER` | `https://<keycloak>/realms/roffice` | Validar llamadas a tu `saveUrl` (JWKS en `<issuer>/.well-known/openid-configuration`) |
| `ROFFICE_SAVE_AUDIENCE` | `<tu-audiencia>` | Validar llamadas a tu `saveUrl` |
| Tu `saveUrl` (registrada en Roffice) | `https://<tu-gateway>/roffice/save-url` | Donde Roffice pide el PUT |

## Autenticación

Dos credenciales de servicio, ambas OIDC *client credentials* emitidas por el realm `roffice`. El JWT de tus usuarios se queda en tu sistema.

| Dirección | Token | Claims |
|---|---|---|
| Tu backend → Roffice | Pides uno con `ROFFICE_CLIENT_ID` / `ROFFICE_CLIENT_SECRET` | `azp=<tu-client-id>`, `aud` incluye `roffice` |
| Roffice → tu `saveUrl` | Lo trae Roffice en `Authorization: Bearer` | `iss`=issuer de Roffice, `azp=roffice`, `aud` incluye tu audiencia; firma verificable con el JWKS del issuer |

## Contrato HTTP

### `POST {ROFFICE_URL}/api/sessions` — abrir el editor

Header `Authorization: Bearer <tu token de servicio>`. Body JSON:

| Campo | Tipo | Regla |
|---|---|---|
| `docId` | string | Identificador estable del documento en tu sistema. Mismo `docId` = misma sesión de co-edición |
| `version` | string | ETag o versión del objeto. Cambia cuando cambia el archivo |
| `fileType` | string | Extensión real del archivo; ver [Formatos](#formatos) |
| `title` | string, opcional | Nombre visible; por defecto `<docId>.<fileType>` |
| `getUrl` | URL | GET prefirmado del objeto, vida de minutos. Roffice lo descarga en servidor; nunca llega al navegador |
| `user` | `{ id, name }` | `id` = `sub` del JWT del usuario |
| `permissions` | objeto, opcional | `edit` (`false` abre en solo lectura; solo aplica a `docx`/`xlsx`/`pptx`), `comment`, `review`, `download`, `print`, `chat`, `protect` (`true` muestra «Proteger documento»; oculto si no lo envías) |
| `returnUrl` | URL, opcional | Destino del botón «Abrir ubicación del archivo» del editor |

#### Formatos

`fileType` decide qué editor se abre. OnlyOffice confía en él: lee el archivo con ese formato sin inspeccionar el contenido, así que debe ser la extensión real del objeto (un xlsx declarado como `docx` falla al abrir).

| Editor | `fileType` |
|---|---|
| Texto | `docx` `doc` `odt` `rtf` `txt` |
| Hoja de cálculo | `xlsx` `xls` `ods` `csv` |
| Presentación | `pptx` `ppt` `odp` |

Cualquier otro valor (`pdf`, `md`…) recibe `400 {"error":"fileType no soportado"}`.

`docx`, `xlsx` y `pptx` están verificados de punta a punta: se guardan en su mismo formato.

**El resto se abre siempre en solo lectura**, aunque envíes `permissions.edit: true`: OnlyOffice guarda esos formatos convertidos a OOXML (verificado con `doc`, que vuelve como DOCX) y Roffice los protege para que el original nunca se sobrescriba con otro formato. Para editarlos, conviértelos a `docx`/`xlsx`/`pptx` en tu sistema antes de abrirlos.

Respuestas:

| Código | Body | Significado |
|---|---|---|
| `200` | `{ "editorUrl": "...", "expiresIn": 60 }` | Enlace de **un solo uso**, válido 60 s |
| `400` | `{ "error": "..." }` | Campo inválido o `fileType` no soportado; el mensaje lo nombra |
| `401` | `{ "error": "..." }` | Token ausente, vencido o sin `aud=roffice` |
| `403` | `{ "error": "Cliente no autorizado" }` | Tu `client_id` no está registrado en Roffice |
| `503` | `{ "error": "..." }` | Sin instancias de OnlyOffice disponibles |

#### Un documento abierto por usuario

Cada usuario (`user.id`) tiene **un documento abierto a la vez**. Al abrir otro, Roffice lo desconecta del anterior: ese editor queda sin poder editar y su pestaña ya no recarga. El trabajo hecho se conserva: OnlyOffice guarda al desconectarlo. El paso 6 abre el nuevo documento en la misma pestaña.

Si el operador de Roffice sube el límite (`MAX_DOCS_PER_USER`), el más antiguo cede su lugar al superarlo; en ese caso abre cada documento en una pestaña nueva con `window.open("about:blank")`.

### `POST {ROFFICE_URL}/api/sessions/{docId}/forcesave` — forzar guardado (opcional)

Mismo header. `docId` codificado con `encodeURIComponent`. `404` si el documento no tiene sesión abierta.

### `POST {tu saveUrl}` — Roffice pide dónde guardar

Roffice llama con `Authorization: Bearer <token de Roffice>` y body:

```json
{ "docId": "contratos/123.docx", "version": "<version de apertura>", "contentType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }
```

Responde `200` con `{ "putUrl": "<PUT prefirmado>" }`, vida de minutos y firmado con ese `Content-Type`. Roffice sube el archivo con ese PUT.

- Llega una vez por guardado: al pulsar Guardar en el editor y ~10 s después de que el último editor cierra la pestaña. Úsala como aviso de que el documento cambió.
- `version` es la de apertura de la sesión, también tras guardados intermedios: la concurrencia optimista usa tu propio dato.
- Cualquier respuesta distinta de `200` con `putUrl` hace que Roffice marque el guardado como fallido.

## Pasos de implementación

Cumple cada paso hasta su criterio de **Hecho cuando**.

1. **Configuración.** Carga las 6 variables `ROFFICE_*` en tu backend; el secret desde tu gestor de secretos.
   **Hecho cuando** el backend arranca con las 6 presentes.
2. **Token de servicio.** Implementa un cliente `client_credentials` contra `ROFFICE_TOKEN_ENDPOINT` que reutiliza el token hasta ~30 s antes de su `expires_in`.
   **Hecho cuando** un test decodifica el token y ve `azp=<tu-client-id>` y `aud` con `roffice`, y dos llamadas seguidas hacen una sola petición al endpoint.
3. **Endpoint «abrir editor».** Ruta en tu backend, protegida con el JWT de tus usuarios: autoriza al usuario sobre el documento, decide `permissions`, genera el GET prefirmado y llama `POST /api/sessions`. Devuelve `{ editorUrl }` solo a ese usuario.
   **Hecho cuando** la ruta devuelve un `editorUrl` y abrirlo en el navegador muestra el documento en el editor.
4. **`saveUrl`.** Endpoint que valida el token de Roffice (issuer, firma con JWKS, `azp=roffice`, tu audiencia), comprueba que `docId` es de tu sistema y responde `{ putUrl }`.
   **Hecho cuando** un test con un token válido recibe `putUrl`, y uno con `azp` distinto o sin token recibe `401`/`403`.
5. **Gateway.** Publica la `saveUrl` en la ruta registrada, aceptando tokens del issuer de Roffice con `azp=roffice` y tu audiencia. Tus demás rutas conservan su validación actual.
   **Hecho cuando** una llamada con un token real de Roffice atraviesa el gateway hasta el paso 4.
6. **Angular.** En el handler del click toma la pestaña del editor como primera instrucción, antes de cualquier `await`, para que el bloqueador de pop-ups la permita. El nombre fijo `roffice` con URL vacía devuelve la pestaña del editor ya abierta sin navegarla, o abre una nueva en blanco:
   ```ts
   async openEditor(docId: string) {
     const tab = window.open("", "roffice");
     const isNewTab = isBlank(tab);
     try {
       const { editorUrl } = await firstValueFrom(this.http.post<{ editorUrl: string }>(`/api/documents/${encodeURIComponent(docId)}/editor`, {}));
       tab!.location.href = editorUrl;
     } catch {
       if (isNewTab) tab!.close(); // una pestaña reutilizada conserva el documento anterior
     }
   }

   // La pestaña del editor es de otro origen: leer su location lanza excepción.
   function isBlank(tab: Window | null): boolean {
     try {
       return tab!.location.href === "about:blank";
     } catch {
       return false;
     }
   }
   ```
   **Hecho cuando** el primer click abre una pestaña con el editor sin aviso de pop-up bloqueado, y el click en otro documento lo carga en esa misma pestaña.
7. **Verificación de punta a punta.** Abre un documento, edítalo, cierra la pestaña.
   **Hecho cuando** la versión editada aparece en tu storage ~10 s después del cierre y tu `saveUrl` registró la llamada.

## Problemas frecuentes

| Síntoma | Causa | Solución |
|---|---|---|
| `401` en `/api/sessions` | Token vencido o sin `aud=roffice` | Paso 2; pedir al operador de Roffice que revise el audience mapper |
| `403` en `/api/sessions` | Tenant no registrado o Roffice sin reiniciar | Contactar al operador de Roffice |
| Pestaña con «El enlace expiró o ya se usó» | `editorUrl` usado dos veces o tras 60 s | Pedir un `editorUrl` nuevo en cada apertura |
| La pestaña no aparece | `window.open` después de un `await` | Paso 6 |
| Cada documento abre una pestaña nueva | `window.open` sin el nombre `roffice` | Paso 6 |
| Un editor abierto deja de permitir editar | El mismo usuario abrió otro documento ([límite](#un-documento-abierto-por-usuario)) | Reabrir el documento desde tu aplicación |
| El editor no carga el documento | `getUrl` vencido o inaccesible desde Roffice | GET prefirmado con vida de minutos y alcanzable desde internet |
| El editor muestra error al abrir | `fileType` distinto del formato real del archivo | Enviar la extensión real del objeto |
| `400 fileType no soportado` | Formato fuera de la lista | Ofrecer solo los formatos de [Formatos](#formatos) |
| Un `.doc`, `.xls`, `.odt`… abre en solo lectura | Roffice solo permite editar `docx`, `xlsx` y `pptx` ([Formatos](#formatos)) | Convertir el archivo a OOXML antes de abrirlo |
| El editor avisa «se ha abierto a partir de una copia de seguridad del servidor» | Un guardado anterior falló; OnlyOffice conserva los cambios en su copia | Seguir editando y cerrar: el siguiente guardado los lleva al storage |
| Los cambios no llegan al storage | `saveUrl` rechaza el token o el PUT falla | Logs de tu `saveUrl`; `Content-Type` del PUT igual al firmado |

## Contacto

Cambios en tu `saveUrl` o audiencia, rotación del secret o errores `403`: operador de Roffice.
