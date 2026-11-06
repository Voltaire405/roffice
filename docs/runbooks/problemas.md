# Runbook: problemas conocidos

Busca el síntoma, aplica la solución y repite el paso que falló. Si el síntoma no está en la tabla, reporta al humano el comando, la salida y el log de Roffice del momento.

| Síntoma | Causa | Solución |
|---|---|---|
| `:13000` sin respuesta | El compose levanta solo Redis y OnlyOffice | `entorno-local.md`, paso 3 |
| `Falta la variable de entorno ...` al arrancar | `.env` sin `OIDC_*` o `TENANTS` | `keycloak-init.md` y `alta-tenant.md` |
| `init` → `403` en `/clients` | Token de admin emitido antes de existir el realm, o rol insuficiente | Re-ejecutar `init`; si persiste, confirmar el rol `admin` (`keycloak-init.md`) |
| `/api/sessions` → `401` | Token sin `aud=roffice`, de otro realm o vencido | `alta-tenant.md`, paso 2 |
| `/api/sessions` → `403` | `azp` ausente en `TENANTS` o Roffice sin reiniciar | `alta-tenant.md`, paso 3 |
| Pestaña del editor → `403` al recargar, o el editor pasa a solo lectura | El mismo usuario abrió otro documento: `MAX_DOCS_PER_USER` (por defecto 1) lo desconectó del anterior | Reabrir el documento desde la aplicación del tenant |
| El editor queda en blanco ~10 s y luego carga, o muestra «No se pudo cargar el editor» | En la primera carga sin caché un módulo de OnlyOffice se ejecuta antes que su dependencia (`Common.UI.Window.extend is not a function`, `Cannot read properties of undefined (reading 'extend')`); la página del editor se recarga sola hasta 2 veces si `onAppReady` no llega en 10 s | Con el aviso final, recarga la pestaña (mantiene su cookie). Si es frecuente, mira los errores de consola del iframe del editor |
| Pestaña con `410` «El enlace expiró o ya se usó» | `editorUrl` dura 60 s y es de un solo uso | El tenant pide un `editorUrl` nuevo en cada apertura |
| La pestaña del editor no aparece | El tenant llama `window.open` después de un `await` | Abrir la pestaña antes del `await` |
| El editor avisa «copia de seguridad del servidor» | Un guardado falló (ej. Roffice caído) y la key quedó en Redis | Reabrir y cerrar: el siguiente guardado persiste los cambios (verificado) |
| El documento editado no llega al storage | `saveUrl` rechaza el token de `roffice` o el PUT falla | Leer los logs con tag `Callback`: nombran el paso que respondió error |
