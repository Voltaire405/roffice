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
  assert.match(html, /onRequestClose: finishEditing/);
  assert.match(html, /window\.close\(\)/);
});

test("el plugin de Roffice solo se carga en el editor de texto en edición, con o sin patrones del tenant", () => {
  const open = ({ fileType = "docx", edit = true, ...patterns }) =>
    buildEditorConfig({ key: "k", title: "t", fileType, fileUrl: "u", callbackUrl: "c", user: { id: "u", name: "U" }, permissions: { edit }, pluginsUrl: "https://roffice/plugins", secret: "s", ...patterns });
  const patterns = ["asunto"];

  const { plugins } = open({ patterns }).editorConfig;
  const [guid] = plugins.autostart;
  assert.deepStrictEqual(plugins.pluginsData, ["https://roffice/plugins/patterns/config.json"]);
  assert.deepStrictEqual(plugins.options[guid], { patterns, patternGroups: [] });

  assert.ok(open({ patternGroups: [{ label: "g", children: [] }] }).editorConfig.plugins);
  const sinPatrones = open({}).editorConfig.plugins;
  assert.deepStrictEqual(sinPatrones.options[sinPatrones.autostart[0]], { patterns: [], patternGroups: [] });
  assert.strictEqual(open({ patterns, edit: false }).editorConfig.plugins, undefined);
  assert.strictEqual(open({ patterns, fileType: "xlsx" }).editorConfig.plugins, undefined);
});

/** Ejecuta el script de la página del editor con un navegador simulado; los timers no corren hasta `fire()`. */
function runEditorPage({ reloadsSoFar = 0 } = {}) {
  const vm = require("node:vm");
  const config = buildEditorConfig({ key: "k", title: "t", fileType: "docx", fileUrl: "u", callbackUrl: "c", user: { id: "u", name: "U" }, permissions: { edit: true }, secret: "s" });
  const html = renderEditorPage({ config, publicUrl: "http://oo" });
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];

  const storage = new Map(reloadsSoFar ? [["roffice-reloads:/editor/t", String(reloadsSoFar)]] : []);
  const timers = new Map();
  const page = { reloads: 0, body: { textContent: "" }, events: null, storage, timers };
  vm.runInNewContext(script, {
    DocsAPI: { DocEditor: class { constructor(_id, options) { page.events = options.events; } destroyEditor() {} } },
    sessionStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) },
    location: { pathname: "/editor/t", reload: () => page.reloads++ },
    document: { body: page.body },
    window: { close() {} },
    setTimeout: (fn, ms) => (timers.set(timers.size + 1, { fn, ms }), timers.size),
    clearTimeout: (id) => timers.delete(id),
  });
  page.fire = () => [...timers.values()].forEach((t) => t.fn());
  return page;
}

test("la página del editor se recarga sola si el editor no arranca (primera carga sin caché)", () => {
  const page = runEditorPage();
  page.fire();
  assert.strictEqual(page.reloads, 1, "sin onAppReady a tiempo, recarga");
  assert.strictEqual(page.storage.get("roffice-reloads:/editor/t"), "1");
});

test("la página del editor no se recarga si el editor arranca a tiempo, y olvida los reintentos", () => {
  const page = runEditorPage({ reloadsSoFar: 1 });
  page.events.onAppReady();
  page.fire();
  assert.strictEqual(page.reloads, 0);
  assert.strictEqual(page.storage.has("roffice-reloads:/editor/t"), false);
});

test("tras agotar los reintentos la página avisa en vez de quedarse en blanco ni recargar sin fin", () => {
  const page = runEditorPage({ reloadsSoFar: 2 });
  page.fire();
  assert.strictEqual(page.reloads, 0);
  assert.match(page.body.textContent, /No se pudo cargar el editor/);
});
