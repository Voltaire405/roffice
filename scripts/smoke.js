// Smoke E2E: IdP, storage del cliente y CommandService de OnlyOffice falsos + Roffice real contra el Redis de docker compose.
// Los callbacks de OnlyOffice se simulan firmados. Uso: npm run smoke
const crypto = require("crypto");
const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const jwt = require("jsonwebtoken");

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", use: "sig" };
const ISS = "http://localhost:19001";
const STORE = "http://localhost:19002";
const RO = "http://localhost:19003";
const puts = [];
const grants = [];

http.createServer((req, res) => {
  const r = { "/.well-known/openid-configuration": { jwks_uri: `${ISS}/certs`, token_endpoint: `${ISS}/token` }, "/certs": { keys: [jwk] },
    "/token": { access_token: jwt.sign({ azp: "roffice", aud: "cliente-backend" }, privateKey, { algorithm: "RS256", keyid: "k1" }), expires_in: 300 } }[req.url];
  res.end(JSON.stringify(r));
}).listen(19001);

http.createServer((req, res) => {
  let body = [];
  req.on("data", (c) => body.push(c)).on("end", () => {
    body = Buffer.concat(body);
    if (req.url === "/doc.docx" && req.method === "GET") return res.end("CONTENIDO-ORIGINAL");
    if (req.url === "/edited" ) return res.end("CONTENIDO-EDITADO");
    if (req.url === "/save-url") { grants.push({ auth: req.headers.authorization, body: JSON.parse(body) }); return res.end(JSON.stringify({ putUrl: `${STORE}/put` })); }
    if (req.url === "/put") { puts.push({ ct: req.headers["content-type"], body: body.toString() }); return res.end(); }
    res.statusCode = 404; res.end();
  });
}).listen(19002);

const commands = [];
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c)).on("end", () => {
    if (req.url.startsWith("/coauthoring/CommandService.ashx")) { commands.push(jwt.verify(JSON.parse(body).token, "s3")); return res.end(JSON.stringify({ error: 0 })); }
    res.end("true");
  });
}).listen(19004);

const svc = (aud = "roffice") => jwt.sign({ azp: "cliente-backend", aud }, privateKey, { algorithm: "RS256", keyid: "k1", issuer: ISS, expiresIn: 60 });
const post = (path, body, token) => fetch(RO + path, { method: "POST", headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) });
const openTab = async (body) => {
  const { editorUrl } = await (await post("/api/sessions", body, svc())).json();
  const l = await fetch(editorUrl, { redirect: "manual" });
  const html = await (await fetch(RO + l.headers.get("location"), { headers: { Cookie: l.headers.get("set-cookie").split(";")[0] } })).text();
  return { config: JSON.parse(html.match(/DocEditor\("editor", (.*)\);<\/script>/)[1]) };
};
const ok = (cond, msg) => { if (!cond) { console.log("FALLA:", msg); process.exitCode = 1; } else console.log("ok:", msg); };

const server = spawn("node", ["server.js"], { cwd: path.join(__dirname, ".."), env: { ...process.env, PORT: "19003", BACKEND_URL: RO, PUBLIC_URL: RO, JWT_SECRET: "s3", OIDC_ISSUER: ISS, OIDC_AUDIENCE: "roffice",
  OIDC_CLIENT_ID: "roffice", OIDC_CLIENT_SECRET: "x", TENANTS: JSON.stringify({ "cliente-backend": { saveUrl: `${STORE}/save-url` } }), LOG_LEVEL: "error", ONLYOFFICE_INSTANCES: "http://localhost:19004|http://publico-a" }, stdio: ["ignore", "ignore", "inherit"] });

setTimeout(async () => {
  try {
    const docId = `smoke-${Date.now()}`;
    const req = { docId, version: "v1", fileType: "docx", getUrl: `${STORE}/doc.docx`, user: { id: "u1", name: "Ana" }, permissions: { edit: true } };

    ok((await post("/api/sessions", req)).status === 401, "sin token → 401");
    ok((await post("/api/sessions", req, svc("otro"))).status === 401, "audience incorrecta → 401");
    ok((await post("/api/sessions", { ...req, fileType: "exe" }, svc())).status === 400, "fileType inválido → 400");

    const { editorUrl } = await (await post("/api/sessions", { ...req, returnUrl: "http://app/docs" }, svc())).json();
    const launch = await fetch(editorUrl, { redirect: "manual" });
    const cookie = launch.headers.get("set-cookie").split(";")[0];
    const tabUrl = RO + launch.headers.get("location");
    ok(launch.status === 303 && /HttpOnly/i.test(launch.headers.get("set-cookie")), "el enlace redirige y deja cookie HttpOnly");
    ok((await fetch(editorUrl, { redirect: "manual" })).status === 410, "el enlace es de un solo uso");
    ok((await fetch(tabUrl)).status === 403, "sin cookie la pestaña no abre");
    const page = await (await fetch(tabUrl, { headers: { Cookie: cookie } })).text();
    ok(/src="http:\/\/publico-[ab]\/web-apps\/apps\/api\/documents\/api.js"/.test(page), "la página carga api.js de la URL pública");
    const a = { config: JSON.parse(page.match(/DocEditor\("editor", (.*)\);<\/script>/)[1]) };
    ok(a.config.editorConfig.customization.goback.url === "http://app/docs", "goback apunta a la app cliente");

    const key = a.config.document.key;
    ok(jwt.verify(a.config.token, "s3").document.key === key, "config firmado con el secreto de OnlyOffice");
    ok(!page.includes("doc.docx"), "getUrl no viaja al navegador");
    ok((await (await fetch(a.config.document.url)).text()) === "CONTENIDO-ORIGINAL", "proxy /files sirve el getUrl");

    const cb = (payload, secret = "s3") => post("/api/callback", { ...payload, token: jwt.sign(payload, secret) });
    ok((await cb({ status: 6, key, url: `${STORE}/edited` }, "malo")).status === 403, "callback con firma falsa → 403");
    ok((await (await cb({ status: 6, key, url: `${STORE}/edited` })).json()).error === 0, "forcesave guarda");

    const b = await openTab({ ...req, version: "v2", user: { id: "u2", name: "Beto" } });
    ok(b.config.document.key === key, "quien se une tras un forcesave recibe la misma key");
    const b2 = await openTab({ ...req, getUrl: `${STORE}/edited` });
    ok((await (await fetch(b2.config.document.url)).text()) === "CONTENIDO-EDITADO", "unirse renueva la getUrl");

    ok((await cb({ status: 2, key, url: `${STORE}/missing` })).status === 500, "descarga 404 de OnlyOffice → 500, no se sube basura");
    ok((await (await cb({ status: 2, key, url: `${STORE}/edited` })).json()).error === 0, "status 2 guarda");
    ok(puts.length === 2 && puts.every((p) => p.body === "CONTENIDO-EDITADO" && p.ct.includes("wordprocessingml")), "PUT con el archivo editado y Content-Type correcto");
    ok(grants.every((g) => g.auth.startsWith("Bearer ") && g.body.docId === docId), "saveUrl recibe token de servicio y docId");

    const c = await openTab({ ...req, version: "v3" });
    ok(c.config.document.key !== key, "tras status 2 la key rota");

    const redisCli = (cmd) => require("child_process").execSync(`docker exec onlyoffice-redis redis-cli ${cmd}`).toString().trim();
    const user = { id: `limite-${Date.now()}`, name: "Lía" };
    const openWithTab = async (body) => {
      const { editorUrl } = await (await post("/api/sessions", body, svc())).json();
      const l = await fetch(editorUrl, { redirect: "manual" });
      return { url: RO + l.headers.get("location"), cookie: l.headers.get("set-cookie").split(";")[0] };
    };
    const drops = () => commands.filter((c) => c.users?.includes(user.id) || c.users?.includes(`otro-${user.id}`));
    const tabA = await openWithTab({ ...req, docId: `${docId}-A`, user });
    await openWithTab({ ...req, docId: `${docId}-A`, user });
    ok(drops().length === 0, "reabrir el mismo documento no desconecta al usuario");
    const tabB = await openWithTab({ ...req, docId: `${docId}-B`, user });
    await new Promise((r) => setTimeout(r, 200));
    const keyA = JSON.parse(redisCli(`get doc:cliente-backend:${docId}-A`)).documentKey;
    ok(drops().length === 1 && drops()[0].c === "drop" && drops()[0].key === keyA, "abrir otro documento envía drop del anterior para ese usuario");
    ok((await fetch(tabA.url, { headers: { Cookie: tabA.cookie } })).status === 403, "la pestaña del documento anterior ya no recarga");
    ok((await fetch(tabB.url, { headers: { Cookie: tabB.cookie } })).status === 200, "la pestaña nueva abre");
    ok(JSON.parse(redisCli(`get user:cliente-backend:${user.id}`)).map((d) => d.docRef).join() === `cliente-backend:${docId}-B`, "el índice del usuario solo tiene el documento nuevo");
    await openWithTab({ ...req, docId: `${docId}-B`, user: { id: `otro-${user.id}`, name: "Otro" } });
    ok(drops().length === 1, "otro usuario en el mismo documento no desconecta a nadie");

    require("child_process").execSync(`docker exec onlyoffice-redis redis-cli set key:legacy-smoke archivo-viejo.docx EX 60`);
    const legacy = await cb({ status: 4, key: "legacy-smoke" });
    ok(legacy.status === 200 && (await legacy.json()).error === 0, "callback de una key con formato antiguo no tumba el servidor");
    ok((await fetch(RO + "/api/instances/status")).ok, "el servidor sigue vivo");
  } catch (err) { console.log("EXCEPCIÓN:", err); process.exitCode = 1;
  } finally {
    server.kill(); process.exit();
  }
}, 1500);
