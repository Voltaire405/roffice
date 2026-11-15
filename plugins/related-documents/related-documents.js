(function (plugin) {
  plugin.init = function () {
    const { relatedDocuments = [] } = plugin.info.options ?? {};
    const select = document.querySelector("select");
    const frame = document.querySelector("iframe");

    relatedDocuments.forEach(({ title }, index) => select.add(new Option(title, index)));
    select.onchange = () => (frame.src = relatedDocuments[select.value].url);
    if (relatedDocuments.length) select.onchange();

    // OnlyOffice solo deja redimensionar la ventana de un plugin que declara mínimo y máximo; 0 es «sin máximo».
    // El tamaño inicial repite el `size` de config.json.
    plugin.resizeWindow(420, 560, 280, 200, 0, 0);
  };
})(window.Asc.plugin);
