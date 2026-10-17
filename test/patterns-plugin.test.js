const test = require("node:test");
const assert = require("node:assert");
const { buildPatternMenu } = require("../plugins/patterns/patterns");

test("el menú de patrones descarta grupos vacíos y asocia cada id a su pattern", () => {
  const { items, patternById } = buildPatternMenu({
    patterns: ["asunto"],
    patternGroups: [
      { label: "", children: [{ label: "Sin grupo", pattern: "x" }] },
      { label: "vacío", children: [] },
      { label: "destinatario", children: [{ label: "Correo trabajo", pattern: "destinatario.propiedades.correotrabajo" }] },
    ],
  });

  assert.deepStrictEqual(items, [
    { id: "insert_pattern_static_0", text: "asunto" },
    { id: "insert_pattern_group_2", text: "destinatario", items: [{ id: "insert_pattern_group_2_0", text: "Correo trabajo" }] },
  ]);
  assert.deepStrictEqual(patternById, {
    insert_pattern_static_0: "asunto",
    insert_pattern_group_2_0: "destinatario.propiedades.correotrabajo",
  });
  assert.deepStrictEqual(buildPatternMenu(undefined).items, []);
});
