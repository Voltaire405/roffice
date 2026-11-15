# Cliente de prueba de Roffice

Simula una aplicación cliente para probar Roffice con un bucket de pruebas antes de integrar la real.

## Arrancar

1. Roffice corriendo en `http://localhost:13000` (`npm run dev` en la raíz).
2. `examples/cliente-prueba/.env` completo (copia de `.env.example`; las `ROFFICE_*` las genera `add-tenant`).
3. En esta carpeta: `npm install` y `npm start`.
4. Abrir `http://localhost:13100`.

## Qué puedes hacer

- **Subir** un archivo (docx, xlsx, pptx, doc, xls, ppt, odt, ods, odp, rtf, txt, csv, pdf; máx. 20 MB).
- **Abrir** un documento en el editor, en una pestaña nueva. Cambia «Usuario simulado» y ábrelo en otra pestaña para probar la co-edición; elige el «Modo» (Edición, Revisión —solo docx— o Visualización).
- **Patrones**: el desplegable «Patrones del menú «Insertar patrón»» define en JSON los `patterns` y `patternGroups` que se envían en cada apertura (grupos anidados hasta 4 niveles, como el contrato). El navegador recuerda lo que escribes; «Restaurar ejemplo» vuelve al ejemplo completo y un campo vacío abre sin patrones. Un JSON inválido no abre el editor, y una forma inválida llega como `Roffice: patterns…`.
- **Documentos relacionados**: el desplegable «Documentos relacionados» recibe una línea `Nombre - URL` por documento y se envía como `relatedDocuments` en cada apertura. El último « - » separa el nombre de la URL. Roffice descarga la URL desde el servidor: para un PDF del sandbox usa `http://localhost:13100/api/documents/<nombre>.pdf/download`, que redirige a un prefirmado nuevo en cada lectura. En el editor se abre desde «Extensiones» → «Documentos relacionados». El navegador recuerda la lista; vacía el campo para no enviar documentos.
- **Guardar**: botón Guardar del editor, o cerrar la pestaña (se guarda ~10 s después). Cada guardado aparece en «Guardados solicitados por Roffice».
- **Comprobar** el resultado: «Actualizar» refresca fecha y tamaño; «Formato real» indica si el archivo guardado es OOXML/ODF (zip) u Office binario (OLE); **Descargar** baja el archivo para abrirlo en tu equipo.

Solo trabaja con objetos bajo `S3_PREFIX` y solo escucha en `127.0.0.1`.
