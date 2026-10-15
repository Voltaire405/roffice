// Flujo HTTP completo en proceso: rutas reales, Redis real (DB 15) y adapters HTTP reales contra
// un IdP, un storage de tenant y un CommandService de OnlyOffice falsos. Los callbacks se firman aquí.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const http = require("http");
const jwt = require("jsonwebtoken");
const { createApp } = require("../app");
const { createPool } = require("../pool");
const { createOidc } = require("../oidc");
const { createEditSessions } = require("../edit-session");
const { createCommandSender } = require("../onlyoffice");
const { createSaveToTenant } = require("../tenants");
const { createTestRedis } = require("./redis");

const JWT_SECRET = "s3";
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", use: "sig" };
const servers = [];
const puts = [];
const grants = [];
const commands = [];
let redis, ISS, STORE, RO;

function listen(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise((resolve) => server.listen(0, () => resolve(`http://localhost:${server.address().port}`)));
}

const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c)).on("end", () => resolve(Buffer.concat(chunks)));
});

const svc = (aud = "roffice") => jwt.sign({ azp: "cliente-backend", aud }, privateKey, { algorithm: "RS256", keyid: "k1", issuer: ISS, expiresIn: 60 });
const post = (path, body, token) =>
  fetch(RO + path, { method: "POST", headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) });
const callback = (payload, secret = JWT_SECRET) => post("/api/callback", { ...payload, token: jwt.sign(payload, secret) });
const configOf = (html) => JSON.parse(html.match(/DocEditor\("editor", (.*)\);<\/script>/)[1]);

/** Pide la sesión, canjea el enlace y devuelve la pestaña con su cookie. */
async function openTab(body) {
  const { editorUrl } = await (await post("/api/sessions", body, svc())).json();
  const launch = await fetch(local(editorUrl), { redirect: "manual" });
  const tab = { url: RO + launch.headers.get("location"), cookie: launch.headers.get("set-cookie").split(";")[0] };
  const page = await fetch(tab.url, { headers: { Cookie: tab.cookie } });
  return { ...tab, page, config: page.ok ? configOf(await page.text()) : null };
}

before(async () => {
  redis = await createTestRedis();

  ISS = await listen((req, res) => {
    const routes = {
      "/.well-known/openid-configuration": { jwks_uri: `${ISS}/certs`, token_endpoint: `${ISS}/token` },
      "/certs": { keys: [jwk] },
      "/token": { access_token: jwt.sign({ azp: "roffice", aud: "cliente-backend" }, privateKey, { algorithm: "RS256", keyid: "k1" }), expires_in: 300 },
    };
    res.end(JSON.stringify(routes[req.url]));
  });

  STORE = await listen(async (req, res) => {
    const body = await readBody(req);
    if (req.url === "/doc.docx") return res.end("CONTENIDO-ORIGINAL");
    if (req.url === "/edited") return res.end("CONTENIDO-EDITADO");
    if (req.url === "/save-url") return grants.push({ auth: req.headers.authorization, body: JSON.parse(body) }), res.end(JSON.stringify({ putUrl: `${STORE}/put` }));
    if (req.url === "/put") return puts.push({ ct: req.headers["content-type"], body: body.toString() }), res.end();
    res.statusCode = 404;
    res.end();
  });

  const onlyoffice = await listen(async (req, res) => {
    if (req.url !== "/coauthoring/CommandService.ashx") return res.end("true");
    commands.push(jwt.verify(JSON.parse(await readBody(req)).token, JWT_SECRET));
    res.end(JSON.stringify({ error: 0 }));
  });

  req.getUrl = `${STORE}/doc.docx`;
  const tenants = { "cliente-backend": { saveUrl: `${STORE}/save-url` } };
  const oidc = createOidc({ issuer: ISS, audience: "roffice", clientId: "roffice", clientSecret: "x" });
  const pool = createPool({ redis, instances: `${onlyoffice}|http://publico-a` });
  const sessions = createEditSessions({
    redis,
    pool,
    sendCommand: createCommandSender(JWT_SECRET),
    saveToTenant: createSaveToTenant({ tenants, oidc }),
    jwtSecret: JWT_SECRET,
    backendUrl: "http://roffice-interno",
    maxDocsPerUser: 1,
  });
  const app = createApp({ tenants, oidc, sessions, pool, jwtSecret: JWT_SECRET, publicUrl: "http://roffice-publico" });
  RO = await listen(app);
});

after(async () => {
  servers.forEach((server) => server.close());
  await redis.quit();
});

// El editorUrl usa publicUrl; en el test se reescribe al puerto local de la app.
const local = (url) => url.replace("http://roffice-publico", RO);
const localFile = (url) => url.replace("http://roffice-interno", RO);

const docId = "contratos/123.docx";
const req = { docId, version: "v1", fileType: "docx", getUrl: "", user: { id: "u1", name: "Ana" }, permissions: { edit: true } };

test("POST /api/sessions exige token de servicio con audience roffice y datos válidos", async () => {
  assert.strictEqual((await post("/api/sessions", req)).status, 401, "sin token → 401");
  assert.strictEqual((await post("/api/sessions", req, svc("otro"))).status, 401, "audience incorrecta → 401");
  assert.strictEqual((await post("/api/sessions", { ...req, fileType: "exe" }, svc())).status, 400, "fileType inválido → 400");
});

test("ciclo de sesión: pestaña, proxy, callbacks, guardado en el tenant y rotación de key", async () => {
  const { editorUrl } = await (await post("/api/sessions", { ...req, returnUrl: "http://app/docs" }, svc())).json();
  const launch = await fetch(local(editorUrl), { redirect: "manual" });
  const cookie = launch.headers.get("set-cookie").split(";")[0];
  const tabUrl = RO + launch.headers.get("location");
  assert.ok(launch.status === 303 && /HttpOnly/i.test(launch.headers.get("set-cookie")), "el enlace redirige y deja cookie HttpOnly");
  assert.strictEqual((await fetch(local(editorUrl), { redirect: "manual" })).status, 410, "el enlace es de un solo uso");
  assert.strictEqual((await fetch(tabUrl)).status, 403, "sin cookie la pestaña no abre");

  const page = await (await fetch(tabUrl, { headers: { Cookie: cookie } })).text();
  assert.match(page, /src="http:\/\/publico-a\/web-apps\/apps\/api\/documents\/api.js"/, "la página carga api.js de la URL pública");
  const config = configOf(page);
  assert.strictEqual(config.editorConfig.customization.goback.url, "http://app/docs", "goback apunta a la app cliente");

  const key = config.document.key;
  assert.strictEqual(jwt.verify(config.token, JWT_SECRET).document.key, key, "config firmado con el secreto de OnlyOffice");
  assert.ok(!page.includes("doc.docx"), "getUrl no viaja al navegador");
  assert.strictEqual(await (await fetch(localFile(config.document.url))).text(), "CONTENIDO-ORIGINAL", "proxy /files sirve el getUrl");

  assert.strictEqual((await callback({ status: 6, key, url: `${STORE}/edited` }, "malo")).status, 403, "callback con firma falsa → 403");
  assert.strictEqual((await (await callback({ status: 6, key, url: `${STORE}/edited` })).json()).error, 0, "forcesave guarda");

  const joined = await openTab({ ...req, version: "v2", user: { id: "u2", name: "Beto" } });
  assert.strictEqual(joined.config.document.key, key, "quien se une tras un forcesave recibe la misma key");
  const renewed = await openTab({ ...req, getUrl: `${STORE}/edited`, user: { id: "u3", name: "Caro" } });
  assert.strictEqual(await (await fetch(localFile(renewed.config.document.url))).text(), "CONTENIDO-EDITADO", "unirse renueva la getUrl");

  assert.strictEqual((await callback({ status: 2, key, url: `${STORE}/missing` })).status, 500, "descarga 404 de OnlyOffice → 500, no se sube basura");
  assert.strictEqual((await (await callback({ status: 2, key, url: `${STORE}/edited` })).json()).error, 0, "status 2 guarda");
  assert.ok(puts.length === 2 && puts.every((p) => p.body === "CONTENIDO-EDITADO" && p.ct.includes("wordprocessingml")), "PUT con el archivo editado y Content-Type correcto");
  assert.ok(grants.every((g) => g.auth.startsWith("Bearer ") && g.body.docId === docId), "saveUrl recibe token de servicio y docId");

  const reopened = await openTab({ ...req, version: "v3" });
  assert.notStrictEqual(reopened.config.document.key, key, "tras status 2 la key rota");
});

test("un usuario con otro documento abierto queda desconectado del anterior", async () => {
  const user = { id: "limite", name: "Lía" };
  const drops = () => commands.filter((c) => c.c === "drop");
  const a = await openTab({ ...req, docId: "A.docx", user });
  await openTab({ ...req, docId: "A.docx", user });
  assert.strictEqual(drops().length, 0, "reabrir el mismo documento no desconecta al usuario");

  const b = await openTab({ ...req, docId: "B.docx", user });
  assert.deepStrictEqual(drops().map((c) => c.users), [[user.id]], "abrir otro documento envía drop del anterior para ese usuario");
  assert.strictEqual((await fetch(a.url, { headers: { Cookie: a.cookie } })).status, 403, "la pestaña del documento anterior ya no recarga");
  assert.strictEqual(b.page.status, 200, "la pestaña nueva abre");

  await openTab({ ...req, docId: "B.docx", user: { id: "otro", name: "Otro" } });
  assert.strictEqual(drops().length, 1, "otro usuario en el mismo documento no desconecta a nadie");
});

test("POST /api/sessions/:docId/forcesave reenvía la respuesta del CommandService", async () => {
  assert.strictEqual((await post(`/api/sessions/${encodeURIComponent("nunca-abierto.docx")}/forcesave`, {}, svc())).status, 404);
  const response = await post(`/api/sessions/${encodeURIComponent("B.docx")}/forcesave`, {}, svc());
  assert.deepStrictEqual([response.status, await response.json()], [200, { error: 0 }]);
  assert.strictEqual(commands.at(-1).c, "forcesave");
});

test("un callback de una key con formato antiguo no tumba el servidor", async () => {
  await redis.set("key:legacy", "archivo-viejo.docx", "EX", 60);
  const legacy = await callback({ status: 4, key: "legacy" });
  assert.deepStrictEqual([legacy.status, (await legacy.json()).error], [200, 0]);
  assert.ok((await fetch(RO + "/api/instances/status")).ok, "el servidor sigue vivo");
});
