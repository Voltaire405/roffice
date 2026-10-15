# Runbook: alta de un tenant

Deja un tenant operativo: su client en el realm `roffice`, la audiencia de su gateway en el token de `roffice` y su entrada en `TENANTS`. `add-tenant` es idempotente: re-ejecutarlo con el mismo `clientId` actualiza su `saveUrl`.

**Entradas** (pide al humano las que falten):

| Entrada | Regla | Ejemplo |
|---|---|---|
| `clientId` | `^[a-z0-9][a-z0-9-]*$` | `acme-backend` |
| `saveUrl` | URL http(s) publicada en el gateway del tenant | `https://gateway.acme/roffice/save-url` |
| audiencia | la que exige el gateway del tenant | `acme-api` |

1. Ejecuta `npm run keycloak -- add-tenant <clientId> <saveUrl> <audiencia>`.
   **Hecho cuando** la salida incluye `✔ <clientId> agregado a TENANTS`.
2. Verifica los claims con un token real: pide un token `client_credentials` al `token_endpoint` de la salida con el `client_id` y `client_secret` impresos, decodifica el payload e imprime solo `iss`, `aud` y `azp`.
   **Hecho cuando** `aud` incluye `roffice` y `azp` es el `clientId`.
3. Reinicia Roffice: lee `TENANTS` al arrancar.
   **Hecho cuando** el log muestra el `clientId` en `🔑 Clientes autorizados:`.
4. Reporta al humano, para entregar al tenant por un canal seguro:
   - `token_endpoint` y `client_id`;
   - que el `client_secret` está en la salida del paso 1;
   - lo que su gateway debe aceptar en la `saveUrl`: `iss` del realm `roffice`, `azp=roffice`, `aud=<audiencia>`;
   - `docs/HANDOFF.md` con la tabla «Valores de tu tenant» completada (sin el secret), como especificación de lo que el tenant construye.

   **Hecho cuando** el reporte contiene los 4 elementos.
