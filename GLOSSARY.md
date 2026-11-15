# Roffice

Router entre aplicaciones cliente y un pool de OnlyOffice: abre documentos de los tenants en un editor y devuelve los cambios a su storage.

## Lenguaje

**Tenant**:
Aplicación cliente integrada con Roffice, identificada por su `client_id` en el realm `roffice`.
_Evitar_: cliente (a secas), app

**Documento**:
Archivo de un tenant, identificado por el tenant y su `docId`; dos tenants pueden usar el mismo `docId` sin colisión.
_Evitar_: archivo, filename

**Sesión de edición**:
Edición en curso de un documento en una instancia, compartida por todos los usuarios que lo tienen abierto; termina cuando el último lo cierra.
_Evitar_: sesión de OnlyOffice, documento abierto

**Documento relacionado**:
PDF que el tenant adjunta a la apertura de un documento para que el usuario lo consulte mientras redacta; el editor lo muestra desde «Extensiones» y no se edita ni se guarda.
_Evitar_: documento de soporte, documento de referencia, adjunto, anexo, documento (a secas)

**Instancia**:
Un OnlyOffice Document Server del pool; todas las pestañas de una sesión de edición usan la misma.
_Evitar_: servidor, nodo

**Pestaña**:
Ventana del navegador de un usuario que muestra el editor de una sesión de edición.
_Evitar_: tab, ventana del editor

**Enlace de un solo uso**:
URL de vida corta que el tenant entrega al usuario para abrir su pestaña; se invalida al primer uso.
_Evitar_: editorUrl (es el campo, no el concepto), link de acceso

**Límite de documentos abiertos**:
Cuántos documentos puede tener abiertos un mismo usuario a la vez; abrir uno más lo desconecta del más antiguo.
_Evitar_: límite de instancias, límite de pestañas
