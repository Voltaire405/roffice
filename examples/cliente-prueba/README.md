# Cliente de prueba de Roffice

Simula una aplicación cliente para probar Roffice con un bucket de pruebas antes de integrar la real.

## Arrancar

1. Roffice corriendo en `http://localhost:13000` (`npm run dev` en la raíz).
2. `examples/cliente-prueba/.env` completo (copia de `.env.example`; las `ROFFICE_*` las genera `add-tenant`).
3. En esta carpeta: `npm install` y `npm start`.
4. Abrir `http://localhost:13100`.

## Qué puedes hacer

- **Subir** un archivo (docx, xlsx, pptx, doc, xls, ppt, odt, ods, odp, rtf, txt, csv, pdf; máx. 20 MB).
- **Abrir** un documento en el editor, en una pestaña nueva. Cambia «Usuario simulado» y ábrelo en otra pestaña para probar la co-edición; desmarca «Edición» para abrirlo en solo lectura.
- **Patrones**: el desplegable «Patrones del menú «Insertar patrón»» define en JSON los `patterns` y `patternGroups` que se envían en cada apertura (un nivel de grupo, como el contrato). El navegador recuerda lo que escribes; «Restaurar ejemplo» vuelve al ejemplo completo y un campo vacío abre sin patrones. Un JSON inválido no abre el editor, y una forma inválida llega como `Roffice: patterns…`.
- **Guardar**: botón Guardar del editor, o cerrar la pestaña (se guarda ~10 s después). Cada guardado aparece en «Guardados solicitados por Roffice».
- **Comprobar** el resultado: «Actualizar» refresca fecha y tamaño; «Formato real» indica si el archivo guardado es OOXML/ODF (zip) u Office binario (OLE); **Descargar** baja el archivo para abrirlo en tu equipo.

Solo trabaja con objetos bajo `S3_PREFIX` y solo escucha en `127.0.0.1`.
