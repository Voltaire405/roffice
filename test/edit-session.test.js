const test = require("node:test");
const assert = require("node:assert");
const { createEditSessions, SessionError } = require("../src/edit-session");
const { createPool } = require("../src/pool");
const { createTestRedis } = require("./redis");

const TENANT = "tenant-a";

async function setup(t, { maxDocsPerUser = 1 } = {}) {
  const redis = await createTestRedis();
  t.after(() => redis.quit());
  const commands = [];
  const saves = [];
  const failSaves = { value: false };
  const pool = createPool({ redis, instances: "http://oo-1|http://publico-1" });
  const sessions = createEditSessions({
    redis,
    pool,
    sendCommand: async (instanceUrl, command) => (commands.push({ instanceUrl, ...command }), { status: 200, body: '{"error":0}' }),
    saveToTenant: async (session, url) => {
      if (failSaves.value) throw new Error("PUT respondió 500");
      saves.push({ docId: session.docId, url });
    },
    jwtSecret: "s",
    backendUrl: "http://roffice",
    relatedUrl: "http://roffice-publico/related",
    maxDocsPerUser,
  });
  return { sessions, commands, saves, failSaves };
}

const request = (docId, user = { id: "u1", name: "Ana" }, version = "v1") => ({
  docId, version, fileType: "docx", getUrl: `http://storage/${docId}`, user, permissions: { edit: true },
});

async function openTab(sessions, req) {
  const { launchToken } = await sessions.open(TENANT, req);
  const { tabId, cookieSecret } = await sessions.redeemLaunch(launchToken);
  return { tabId, cookieSecret, ...(await sessions.getTab(tabId, cookieSecret)) };
}

const rejectsWith = (promise, code) => assert.rejects(promise, (err) => err instanceof SessionError && err.code === code);

test("open rechaza pedidos inválidos con invalid_request", async (t) => {
  const { sessions } = await setup(t);
  await rejectsWith(sessions.open(TENANT, { ...request("a.docx"), fileType: "exe" }), "invalid_request");
  await rejectsWith(sessions.open(TENANT, { ...request("a.docx"), getUrl: "ftp://x" }), "invalid_request");
  await rejectsWith(sessions.open(TENANT, { ...request("a.docx"), patterns: "asunto" }), "invalid_request");
  await rejectsWith(sessions.open(TENANT, { ...request("a.docx"), patternGroups: [{ label: "g", children: [{ label: "x" }] }] }), "invalid_request");
});

test("open acepta patternGroups anidados hasta 4 niveles y 500 nodos", async (t) => {
  const { sessions } = await setup(t);
  const nest = (depth) => (depth === 1 ? { label: "hoja", pattern: "p" } : { label: `n${depth}`, children: [nest(depth - 1)] });
  const leaves = (count) => Array.from({ length: count }, () => ({ label: "x", pattern: "x" }));
  const openWith = (patternGroups) => sessions.open(TENANT, { ...request("a.docx"), patternGroups });

  await openWith([nest(4)]);
  await openWith(leaves(500));
  await rejectsWith(openWith([nest(5)]), "invalid_request");
  await rejectsWith(openWith(leaves(501)), "invalid_request");
  await rejectsWith(openWith([{ label: "ambos", pattern: "p", children: [] }]), "invalid_request");
  await rejectsWith(openWith([{ label: "ninguno" }]), "invalid_request");
});

test("open valida los documentos relacionados y entrega al plugin un token por documento, no su URL", async (t) => {
  const { sessions } = await setup(t);
  const openWith = (relatedDocuments) => openTab(sessions, { ...request("a.docx"), relatedDocuments });
  const relatedLinks = (tab) => Object.values(tab.config.editorConfig.plugins?.options ?? {}).find((o) => o.relatedDocuments)?.relatedDocuments;
  const docs = Array.from({ length: 50 }, (_, i) => ({ title: `Referencia ${i}`, url: `https://storage/ref-${i}.pdf` }));

  await rejectsWith(openWith({ title: "x", url: "https://x" }), "invalid_request");
  await rejectsWith(openWith([{ title: "", url: "https://x" }]), "invalid_request");
  await rejectsWith(openWith([{ title: "x", url: "javascript:alert(1)" }]), "invalid_request");
  await rejectsWith(openWith([{ title: "x".repeat(201), url: "https://x" }]), "invalid_request");
  await rejectsWith(openWith([...docs, docs[0]]), "invalid_request");

  const links = relatedLinks(await openWith(docs));
  assert.deepStrictEqual(links.map((link) => link.title), docs.map((doc) => doc.title));
  assert.ok(links.every((link) => link.url.startsWith("http://roffice-publico/related/")), "el plugin recibe URLs de Roffice");
  const tokenOf = (link) => link.url.split("/related/")[1];
  assert.strictEqual(await sessions.relatedDocumentSource(tokenOf(links[49])), "https://storage/ref-49.pdf");
  await rejectsWith(sessions.relatedDocumentSource("inventado"), "file_not_found");
  assert.strictEqual(relatedLinks(await openTab(sessions, request("b.docx"))), undefined);
});

test("el enlace de un solo uso abre la pestaña con el config del editor", async (t) => {
  const { sessions } = await setup(t);
  const { launchToken } = await sessions.open(TENANT, request("a.docx"));
  const { tabId, cookieSecret } = await sessions.redeemLaunch(launchToken);

  await rejectsWith(sessions.redeemLaunch(launchToken), "link_expired");
  await rejectsWith(sessions.getTab(tabId, "otra-cookie"), "tab_forbidden");
  await rejectsWith(sessions.getTab(tabId, undefined), "tab_forbidden");

  const tab = await sessions.getTab(tabId, cookieSecret);
  assert.strictEqual(tab.publicUrl, "http://publico-1");
  assert.strictEqual(tab.config.editorConfig.callbackUrl, "http://roffice/api/callback");
  assert.strictEqual(await sessions.fileSource(tab.config.document.url.split("/files/")[1]), "http://storage/a.docx");
});

test("quien se une recibe la misma key y la key rota al cerrar la sesión", async (t) => {
  const { sessions, saves } = await setup(t);
  const first = await openTab(sessions, request("a.docx"));
  const key = first.config.document.key;

  const joined = await openTab(sessions, request("a.docx", { id: "u2", name: "Beto" }, "v2"));
  assert.strictEqual(joined.config.document.key, key);

  await sessions.handleCallback({ status: 6, key, url: "http://oo/forcesave" });
  await sessions.handleCallback({ status: 2, key, url: "http://oo/final" });
  assert.deepStrictEqual(saves.map((s) => s.url), ["http://oo/forcesave", "http://oo/final"]);
  await rejectsWith(sessions.fileSource(first.config.document.url.split("/files/")[1]), "file_not_found");

  const reopened = await openTab(sessions, request("a.docx", undefined, "v3"));
  assert.notStrictEqual(reopened.config.document.key, key);
});

test("un editor que se reconecta tras el status 4 guarda sus cambios", async (t) => {
  const { sessions, saves } = await setup(t);
  const { config } = await openTab(sessions, request("a.xlsx"));
  const key = config.document.key;

  await sessions.handleCallback({ status: 1, key, users: ["u1"] });
  await sessions.handleCallback({ status: 4, key });
  await sessions.handleCallback({ status: 1, key, users: ["u1"] });
  await sessions.handleCallback({ status: 2, key, url: "http://oo/final" });

  assert.deepStrictEqual(saves, [{ docId: "a.xlsx", url: "http://oo/final" }]);
});

test("un guardado fallido lanza save_failed y conserva la sesión", async (t) => {
  const { sessions, failSaves } = await setup(t);
  const { config } = await openTab(sessions, request("a.docx"));
  failSaves.value = true;

  await rejectsWith(sessions.handleCallback({ status: 2, key: config.document.key, url: "http://oo/final" }), "save_failed");
  assert.ok(await sessions.fileSource(config.document.url.split("/files/")[1]));
});

test("abrir otro documento desconecta al usuario del anterior y revoca su pestaña", async (t) => {
  const { sessions, commands } = await setup(t);
  const a = await openTab(sessions, request("a.docx"));
  const aAgain = await openTab(sessions, request("a.docx"));
  assert.strictEqual(commands.length, 0);
  await rejectsWith(sessions.getTab(a.tabId, a.cookieSecret), "tab_forbidden");

  await openTab(sessions, request("b.docx"));
  assert.deepStrictEqual(commands, [{ instanceUrl: "http://oo-1", c: "drop", key: a.config.document.key, users: ["u1"] }]);
  await rejectsWith(sessions.getTab(aAgain.tabId, aAgain.cookieSecret), "tab_forbidden");

  await openTab(sessions, request("b.docx", { id: "u2", name: "Beto" }));
  assert.strictEqual(commands.length, 1);
});

test("con límite 2 cede el documento más antiguo y no cuenta sesiones ya cerradas", async (t) => {
  const { sessions, commands } = await setup(t, { maxDocsPerUser: 2 });
  const a = await openTab(sessions, request("a.docx"));
  await openTab(sessions, request("b.docx"));
  await sessions.handleCallback({ status: 4, key: a.config.document.key });

  await openTab(sessions, request("c.docx"));
  assert.strictEqual(commands.length, 0);
  await openTab(sessions, request("d.docx"));
  assert.deepStrictEqual(commands.map((c) => c.c), ["drop"]);
});

test("forcesave exige sesión abierta y devuelve la respuesta del CommandService", async (t) => {
  const { sessions, commands } = await setup(t);
  await rejectsWith(sessions.forcesave(TENANT, "a.docx"), "not_open");

  const { config } = await openTab(sessions, request("a.docx"));
  assert.deepStrictEqual(await sessions.forcesave(TENANT, "a.docx"), { status: 200, body: '{"error":0}' });
  assert.deepStrictEqual(commands.at(-1), { instanceUrl: "http://oo-1", c: "forcesave", key: config.document.key });
});
