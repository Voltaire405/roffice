# Runbook: producción

Comprueba que la configuración está lista para desplegar. Verifica cada ítem con su comando y reporta al humano la lista de ítems que fallan con el valor esperado.

| Ítem | Comprobación | Esperado |
|---|---|---|
| `JWT_SECRET` propio | `.env` y cada `JWT_SECRET` de `docker-compose.yml` | Iguales entre sí y distintos de `my-secret-key-change-me` |
| `PUBLIC_URL` con TLS | `.env` | Empieza por `https://`; activa la cookie `Secure` de la pestaña |
| URLs públicas de OnlyOffice | `ONLYOFFICE_INSTANCES` en `.env` | Cada entrada `interna\|pública`, con la pública en `https://` detrás de un reverse proxy |
| Callback alcanzable | `docker exec onlyoffice-ds-1 curl -s -o /dev/null -w '%{http_code}' <BACKEND_URL>/api/instances/status` | `200` desde cada instancia |
| Permisos de `.env` | `stat -f %Lp .env` (macOS) o `stat -c %a .env` (Linux) | `600` |

**Hecho cuando** los 5 ítems están verificados y el reporte lista los que fallan, o confirma que ninguno falla.
