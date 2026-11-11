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

test("el menú de patrones anida grupos y descarta los que quedan vacíos", () => {
  const { items, patternById } = buildPatternMenu({
    patternGroups: [
      {
        label: "Revisores",
        children: [
          {
            label: "Revisor 1",
            children: [
              { label: "Nombre", pattern: "revisores[0].nombre" },
              { label: "Secciones", children: [{ label: "Jurídica (primaria)", pattern: "revisores[0].secciones[1]" }] },
              { label: "Vacío", children: [{ label: "Sin hojas", children: [] }] },
            ],
          },
        ],
      },
      { label: "Asunto", pattern: "asunto" },
    ],
  });

  assert.deepStrictEqual(items, [
    {
      id: "insert_pattern_group_0",
      text: "Revisores",
      items: [
        {
          id: "insert_pattern_group_0_0",
          text: "Revisor 1",
          items: [
            { id: "insert_pattern_group_0_0_0", text: "Nombre" },
            { id: "insert_pattern_group_0_0_1", text: "Secciones", items: [{ id: "insert_pattern_group_0_0_1_0", text: "Jurídica (primaria)" }] },
          ],
        },
      ],
    },
    { id: "insert_pattern_group_1", text: "Asunto" },
  ]);
  assert.deepStrictEqual(patternById, {
    insert_pattern_group_0_0_0: "revisores[0].nombre",
    insert_pattern_group_0_0_1_0: "revisores[0].secciones[1]",
    insert_pattern_group_1: "asunto",
  });
});
