# OnlyOffice Test - Editor de documentos

Integración de OnlyOffice Document Server con Node.js/Express.

## Requisitos

- Node.js 18+
- Docker

## Inicio rápido

```bash
# 1. Instalar dependencias
npm install

# 2. Levantar OnlyOffice Document Server
docker compose up -d

# 3. Esperar ~1 minuto a que OnlyOffice inicie completamente
# Verificar: http://localhost:8080 debe mostrar "Document Server is running"

# 4. Iniciar el backend
npm run dev
```

Abrir http://localhost:3000 en el navegador.

## Estructura

```
├── server.js          # Backend Express (JWT, callback, API)
├── public/index.html  # Frontend (lista docs, editor)
├── files/             # Documentos almacenados
├── docker-compose.yml # OnlyOffice Document Server
└── .env               # Configuración
```

## API

| Endpoint | Método | Descripción |
|---|---|---|
| `/api/documents` | GET | Lista documentos disponibles |
| `/api/editor-config/:filename` | GET | Config del editor (con JWT firmado) |
| `/api/callback` | POST | Callback de OnlyOffice (guarda cambios) |
| `/api/upload` | POST | Subir documento (multipart/form-data) |
| `/api/forcesave/:filename` | POST | Forzar guardado |

## Puntos clave

- **`host.docker.internal`**: Las URLs de documentos y callback usan `host.docker.internal` para que el contenedor Docker de OnlyOffice pueda alcanzar el backend que corre en el host.
- **`document.key`**: Se genera basado en el nombre + mtime del archivo, garantizando que cambie al actualizar el documento.
- **JWT**: Se firma TODO el objeto de configuración del editor. El secret debe coincidir entre `.env` y `docker-compose.yml`.
