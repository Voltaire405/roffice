const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const http = require("http");
const path = require("path");
const jwt = require(path.join(__dirname, "../../node_modules/jsonwebtoken"));

test("saveUrl entrega PUTs solo a Roffice y solo dentro del prefijo sandbox", async (t) => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", use: "sig" };
  const idp = http.createServer((req, res) => {
    const issuer = `http://localhost:${idp.address().port}`;
    res.end(JSON.stringify(req.url === "/certs" ? { keys: [jwk] } : { jwks_uri: `${issuer}/certs` }));
  });
  await new Promise((resolve) => idp.listen(0, resolve));
  t.after(() => idp.close());
  const issuer = `http://localhost:${idp.address().port}`;

  Object.assign(process.env, {
    ROFFICE_URL: "http://roffice", ROFFICE_ISSUER: issuer, ROFFICE_SAVE_AUDIENCE: "sandbox-api",
    S3_ENDPOINT: "https://s3.example", S3_BUCKET: "bucket", S3_PREFIX: "roffice-sandbox/", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s",
  });
  const { app, sandboxKey } = require("./server");
  const server = app.listen(0);
  t.after(() => server.close());

  const token = (azp, aud = "sandbox-api") => jwt.sign({ azp, aud }, privateKey, { algorithm: "RS256", keyid: "k1", issuer, expiresIn: 60 });
  const saveUrl = (auth, body) => fetch(`http://localhost:${server.address().port}/roffice/save-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth && { Authorization: `Bearer ${auth}` }) },
    body: JSON.stringify(body),
  });
  const doc = { docId: "informe.docx", version: "v1", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };

  assert.strictEqual((await saveUrl(undefined, doc)).status, 401);
  assert.strictEqual((await saveUrl(token("roffice", "otra"), doc)).status, 401);
  assert.strictEqual((await saveUrl(token("otro-tenant"), doc)).status, 403);
  assert.strictEqual((await saveUrl(token("roffice"), { ...doc, docId: "../fuera.docx" })).status, 400);

  const ok = await saveUrl(token("roffice"), doc);
  assert.strictEqual(ok.status, 200);
  const putUrl = new URL((await ok.json()).putUrl);
  assert.strictEqual(putUrl.pathname, "/bucket/roffice-sandbox/informe.docx");
  assert.ok(![...putUrl.searchParams.keys()].some((k) => /checksum/i.test(k)), "el PUT no exige checksum");
  assert.ok(Number(putUrl.searchParams.get("X-Amz-Expires")) <= 300);

  assert.strictEqual(sandboxKey("a/b.docx"), null);
  assert.strictEqual(sandboxKey("x.pdf"), "roffice-sandbox/x.pdf");
  assert.strictEqual(sandboxKey("x.exe"), null);
});
