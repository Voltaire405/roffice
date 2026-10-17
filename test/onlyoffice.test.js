const test = require("node:test");
const assert = require("node:assert");
const jwt = require("jsonwebtoken");
const { documentKey, verifyCallback, renderEditorPage, buildEditorConfig } = require("../src/onlyoffice");

test("documentKey cambia con la versión y no colisiona por prefijo", () => {
  const key = documentKey("cliente:Lista_Asistencia-1775597639936.docx", "v1");
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.strictEqual(key, documentKey("cliente:Lista_Asistencia-1775597639936.docx", "v1"));
  assert.notStrictEqual(key, documentKey("cliente:Lista_Asistencia-1775597639936.docx", "v2"));
  assert.notStrictEqual(
    documentKey("cliente:informe_trimestral_A.docx", "v1"),
    documentKey("cliente:informe_trimestral_B.docx", "v1")
  );
});

test("verifyCallback acepta solo callbacks firmados con el secreto de OnlyOffice", () => {
  const body = { status: 2, key: "k", url: "http://oo/file" };

  assert.deepStrictEqual(verifyCallback({ token: jwt.sign(body, "secreto") }, undefined, "secreto").key, "k");
  assert.strictEqual(verifyCallback({}, `Bearer ${jwt.sign({ payload: body }, "secreto")}`, "secreto").url, body.url);
  assert.throws(() => verifyCallback({ ...body, token: jwt.sign(body, "otro") }, undefined, "secreto"));
  assert.throws(() => verifyCallback(body, undefined, "secreto"));
});

test("solo docx, xlsx y pptx se abren en edición aunque el tenant pida editar", () => {
  const open = (fileType) =>
    buildEditorConfig({ key: "k", title: "t", fileType, fileUrl: "u", callbackUrl: "c", user: { id: "u", name: "U" }, permissions: { edit: true }, secret: "s" });

  for (const fileType of ["docx", "xlsx", "pptx"]) assert.strictEqual(open(fileType).editorConfig.mode, "edit");
  for (const fileType of ["doc", "xls", "ppt", "odt", "csv"]) {
    const config = open(fileType);
    assert.strictEqual(config.editorConfig.mode, "view");
    assert.strictEqual(config.document.permissions.edit, false);
  }
});

test("renderEditorPage no permite que datos del cliente inyecten HTML", () => {
  const title = `</script><script>alert(1)</script>`;
  const config = { document: { title }, editorConfig: { user: { name: title } } };
  const html = renderEditorPage({ config, publicUrl: "http://oo" });

  assert.strictEqual(html.match(/<script/g).length, 2);
  const embedded = html.match(/const config = (.*);\n/)[1];
  assert.deepStrictEqual(JSON.parse(embedded), config);
});

test("la protección del documento solo aparece si el tenant la pide", () => {
  const open = (permissions) =>
    buildEditorConfig({ key: "k", title: "t", fileType: "docx", fileUrl: "u", callbackUrl: "c", user: { id: "u", name: "U" }, permissions, secret: "s" });

  assert.strictEqual(open({ edit: true }).document.permissions.protect, false);
  assert.strictEqual(open({ edit: true, protect: "true" }).document.permissions.protect, false);
  assert.strictEqual(open({ edit: true, protect: true }).document.permissions.protect, true);
});

test("el editor ofrece terminar la edición y la página cierra la pestaña al pedirlo", () => {
  const config = buildEditorConfig({ key: "k", title: "t", fileType: "docx", fileUrl: "u", callbackUrl: "c", user: { id: "u", name: "U" }, permissions: { edit: true }, secret: "s" });
  assert.strictEqual(config.editorConfig.customization.close.visible, true);

  const html = renderEditorPage({ config, publicUrl: "http://oo" });
  assert.match(html, /events: \{ onRequestClose: finishEditing \}/);
  assert.match(html, /window\.close\(\)/);
});

test("el plugin de patrones solo se carga en el editor de texto en edición y con patrones del tenant", () => {
  const open = ({ fileType = "docx", edit = true, ...patterns }) =>
    buildEditorConfig({ key: "k", title: "t", fileType, fileUrl: "u", callbackUrl: "c", user: { id: "u", name: "U" }, permissions: { edit }, pluginsUrl: "https://roffice/plugins", secret: "s", ...patterns });
  const patterns = ["asunto"];

  const { plugins } = open({ patterns }).editorConfig;
  const [guid] = plugins.autostart;
  assert.deepStrictEqual(plugins.pluginsData, ["https://roffice/plugins/patterns/config.json"]);
  assert.deepStrictEqual(plugins.options[guid], { patterns, patternGroups: [] });

  assert.ok(open({ patternGroups: [{ label: "g", children: [] }] }).editorConfig.plugins);
  assert.strictEqual(open({}).editorConfig.plugins, undefined);
  assert.strictEqual(open({ patterns, edit: false }).editorConfig.plugins, undefined);
  assert.strictEqual(open({ patterns, fileType: "xlsx" }).editorConfig.plugins, undefined);
});
