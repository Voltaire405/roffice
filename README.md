# OnlyOffice Test - Editor de documentos

Integración de OnlyOffice Document Server con Node.js/Express, almacenamiento en Cloudflare R2, state en Redis y pool de múltiples instancias de OnlyOffice con enrutado sticky por documento.

## Requisitos

- Node.js 18+
- Docker
- Credenciales de Cloudflare R2

## Inicio rápido

```bash
# 1. Instalar dependencias
npm install

# 2. Configurar variables de entorno
cp .env.example .env
# Editar .env y rellenar R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY

# 3. Levantar Redis + 3 instancias de OnlyOffice
docker compose up -d

# 4. Esperar ~1 minuto a que OnlyOffice inicie completamente
# Verificar: http://localhost:8080, :8081, :8082 deben mostrar "Document Server is running"

# 5. Iniciar el backend
npm run dev
```

Abrir http://localhost:3000 en el navegador.

## Estructura

```
├── server.js            # Backend Express (JWT, callback, API, proxy R2)
├── instance-manager.js  # Pool de instancias OnlyOffice + sticky routing
├── redis-store.js       # Mapeos documento ↔ instancia ↔ key en Redis
├── logger.js            # Logger estructurado + middleware de request
├── public/index.html    # Frontend (lista docs, editor)
├── docker-compose.yml   # Redis + 3 instancias OnlyOffice Document Server
├── Dockerfile           # Imagen del backend
└── .env                 # Configuración (JWT, R2, instancias, Redis)
```

## API

| Endpoint | Método | Descripción |
|---|---|---|
| `/api/documents` | GET | Lista documentos en `R2_PREFIX` del bucket |
| `/api/editor-config/:filename` | GET | Config del editor firmada con JWT + instancia asignada |
| `/api/callback` | POST | Callback de OnlyOffice (descarga cambios y sube a R2) |
| `/api/upload` | POST | Sube documento a R2 (multipart/form-data) |
| `/api/forcesave/:filename` | POST | Forzar guardado vía `CommandService` de la instancia asignada |
| `/api/instances/status` | GET | Estado y carga actual de cada instancia del pool |
| `/files/:filename` | GET | Proxy de archivos desde R2 (usado por OnlyOffice) |

## Puntos clave

El almacenamiento vive en Cloudflare R2 bajo el prefijo configurado en `R2_PREFIX` (por defecto `borradores/`). El backend expone un proxy en `/files/:filename` que descarga desde R2 y lo sirve a OnlyOffice, de modo que las instancias Docker nunca necesitan credenciales de R2.

Las URLs de documento y callback usan `BACKEND_URL` (por defecto `http://host.docker.internal:3000`) para que los contenedores de OnlyOffice puedan alcanzar el backend que corre en el host.

El `document.key` se genera a partir del nombre del archivo y el `LastModified` del objeto en R2, garantizando que cambie al actualizar el documento e invalide la caché de OnlyOffice. En el callback (status 2 o 6) el backend descarga el archivo desde la URL que provee OnlyOffice, lo sube a R2 y actualiza el mapeo de `key` en Redis.

Se firma con JWT todo el objeto de configuración del editor así como los comandos al `CommandService` (forcesave). El secret debe coincidir entre `.env` (`JWT_SECRET`) y `docker-compose.yml` (`JWT_SECRET` de cada instancia).

El pool de instancias se configura en `ONLYOFFICE_INSTANCES` como lista separada por comas. `instance-manager.js` asigna una instancia por documento de forma sticky y persiste el mapeo en Redis, de modo que todos los editores del mismo documento caen en la misma instancia (requisito de co-edición de OnlyOffice). Redis también guarda el mapeo `key → filename` que usa el callback para resolver el archivo destino.
