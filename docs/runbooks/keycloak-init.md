# Runbook: Keycloak, configuración inicial

Deja el realm `roffice` con el client `roffice`, y las variables `OIDC_*` en `.env`. `init` es idempotente: re-ejecutarlo reutiliza lo existente.

1. Comprueba las credenciales de administración sin mostrar valores: `grep -oE '^[A-Z_]+=.' .env.admin`.
   **Hecho cuando** `KEYCLOAK_URL` tiene valor y además el par `KEYCLOAK_ADMIN_CLIENT_ID` + `KEYCLOAK_ADMIN_CLIENT_SECRET` o el par `KEYCLOAK_ADMIN_USER` + `KEYCLOAK_ADMIN_PASSWORD`.
   Si falta alguno, pide al humano que cree el client de administración (sección siguiente) y complete `.env.admin` partiendo de `.env.admin.example`.
2. Ejecuta `npm run keycloak -- init`.
   **Hecho cuando** la salida termina en `✔ OIDC_* escritos` y `grep -oE '^OIDC_[A-Z_]+=.' .env` lista `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_CLIENT_ID` y `OIDC_CLIENT_SECRET`.

## Client de administración (lo hace el humano en la consola de Keycloak)

En el realm `master`:

1. **Clientes** → **Crear cliente** → Client ID `roffice-admin`.
2. **Configuración de capacidades**: **Autenticación del cliente** activado, **Roles de cuentas de servicio** marcado; **Flujo estándar** y **Concesiones de acceso directo** desmarcados. Guardar.
3. **Roles de cuentas de servicio** → **Asignar rol** → `admin`. El rol `create-realm` solo crea el realm y luego recibe 403 al gestionar sus clients.
4. **Credenciales** → copiar el secreto a `KEYCLOAK_ADMIN_CLIENT_SECRET` y `roffice-admin` a `KEYCLOAK_ADMIN_CLIENT_ID` en `.env.admin`.
