/**
 * Plugin «Insertar patrón»: lee los patrones que el tenant envió en la apertura
 * (editorConfig.plugins.options) y los ofrece en el menú contextual del editor de texto.
 */
(function (plugin) {
  const MENU_ID = "insertWords";

  /** @returns {{ items: Object[], patternById: Record<string, string> }} */
  function buildPatternMenu({ patterns = [], patternGroups = [] } = {}) {
    const patternById = {};
    const item = (id, text, pattern) => ((patternById[id] = pattern), { id, text });

    const items = patterns.map((pattern, i) => item(`insert_pattern_static_${i}`, pattern, pattern));
    patternGroups.forEach((group, g) => {
      if (!group.label || !group.children?.length) return;
      items.push({
        id: `insert_pattern_group_${g}`,
        text: group.label,
        items: group.children.map((child, c) => item(`insert_pattern_group_${g}_${c}`, child.label, child.pattern)),
      });
    });
    return { items, patternById };
  }

  if (typeof module !== "undefined") module.exports = { buildPatternMenu };
  if (!plugin) return;

  function insertPattern(pattern, hasSelection) {
    const text = "${" + pattern + "}";
    if (!hasSelection) return plugin.executeMethod("PasteText", [text]);

    window.Asc.scope.text = text;
    plugin.callCommand(() => Api.GetDocument().GetRangeBySelect().AddText(Asc.scope.text, "before"), false);
  }

  // Idioma del texto (el del selector de la barra de estado): vive en el documento, no en editorConfig.
  // Se fija en el texto por defecto: lo que tenga idioma explícito lo conserva. No se puede condicionar a que el
  // documento «no traiga idioma»: GetLanguage() devuelve en-US en ambos casos. El literal va inline porque
  // callCommand serializa la función.
  plugin.init = function () {
    plugin.callCommand(() => {
      const textPr = Api.GetDocument().GetDefaultTextPr();
      textPr.SetLanguage("es-CO");
    }, false);
  };

  plugin.attachEvent("onContextMenuShow", function (options) {
    // Sin guid, AddContextMenuItem lanza dentro del SDK y el editor muestra un error del documento.
    const menu = { guid: plugin.guid, items: [] };
    // El editor espera la respuesta de cada plugin para pintar el menú: responder siempre, aunque sea vacío.
    try {
      if (options.type !== "Target" && options.type !== "Selection") return;
      const { items, patternById } = buildPatternMenu(plugin.info.options);
      if (items.length === 0) return;

      const hasSelection = options.type === "Selection";
      // El SDK pisa attachEvent("onContextMenuClick") con su propio despacho por id.
      for (const [id, pattern] of Object.entries(patternById)) {
        plugin.attachContextMenuClickEvent(id, () => insertPattern(pattern, hasSelection));
      }
      menu.items.push({ id: MENU_ID, text: "Insertar patrón", items });
    } finally {
      plugin.executeMethod("AddContextMenuItem", [menu]);
    }
  });
})(typeof window === "undefined" ? undefined : window.Asc.plugin);
