# Runbook: tenant de prueba

`examples/cliente-prueba/` es un tenant de referencia que implementa el contrato HTTP del `README.md` contra un prefijo sandbox del Object Storage. Sirve para validar Roffice de punta a punta antes de integrar un tenant real. Escucha solo en `127.0.0.1:13100` y toca únicamente objetos bajo `S3_PREFIX`.

Requiere `entorno-local.md` hecho.

1. Registra el tenant (una vez): `npm run keycloak -- add-tenant sandbox-backend http://localhost:13100/roffice/save-url sandbox-api` desde la raíz, y reinicia Roffice.
   **Hecho cuando** el log de Roffice muestra `sandbox-backend` en `🔑 Clientes autorizados:`.
2. Comprueba `examples/cliente-prueba/.env` sin mostrar valores: `grep -oE '^[A-Z0-9_]+=.' examples/cliente-prueba/.env`.
   **Hecho cuando** tienen valor todas las claves de `.env.example` salvo `PORT` y `PUBLIC_URL`. Las `S3_*` las aporta el humano: pídele credenciales limitadas a un bucket de pruebas. `ROFFICE_CLIENT_SECRET` sale de la salida del paso 1.
3. En `examples/cliente-prueba/`: `npm install`, `npm test` y arranca `npm start` en segundo plano.
   **Hecho cuando** `npm test` reporta `fail 0` y el log muestra `Cliente de prueba en http://localhost:13100`.
4. En el navegador, abre `http://localhost:13100`, sube un archivo por formato a validar, ábrelo, edítalo y cierra la pestaña del editor.
   **Hecho cuando** «Guardados solicitados por Roffice» registra el documento y el objeto en el storage cambió de fecha. Para confirmar el formato guardado, lee sus primeros bytes: OOXML empieza por `PK`; `doc`/`xls`/`ppt` binarios por `D0 CF 11 E0`.
