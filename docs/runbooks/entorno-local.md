# Runbook: entorno local

Deja Roffice escuchando en `:13000` con las 3 instancias de OnlyOffice sanas. Requiere `keycloak-init.md` hecho y al menos un tenant en `TENANTS` (`alta-tenant.md`).

1. Ejecuta `docker compose up -d`.
   **Hecho cuando** `docker compose ps` muestra `onlyoffice-ds-1`, `-2` y `-3` como `healthy` (tarda ~1 min tras arrancar).
2. Ejecuta `npm install`.
   **Hecho cuando** termina sin errores.
3. Arranca `npm run dev` en segundo plano; si algún tenant local usa `https://*.tenant.test` (certificados de mkcert), arranca `npm run start:local`, que hace que Node confíe en la CA de mkcert para llegar a su saveUrl. El compose levanta solo Redis y OnlyOffice: este paso es el que abre `:13000`.
   **Hecho cuando** el log muestra `🔑 Clientes autorizados:` seguido de los tenants esperados.
4. Consulta `http://localhost:13000/api/instances/status`.
   **Hecho cuando** las 3 instancias tienen `"healthy": true`.
5. Ejecuta `npm test`. Usa la DB 15 del Redis del compose y la vacía: no guardes nada ahí.
   **Hecho cuando** reporta `fail 0`.
