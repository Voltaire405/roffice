const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const http = require("http");
const jwt = require("jsonwebtoken");
const { documentKey, verifyCallback, renderEditorPage, buildEditorConfig } = require("./onlyoffice");
const { createOidc } = require("./oidc");
const { trackOpenDocument } = require("./open-documents");

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
  const embedded = html.match(/DocEditor\("editor", (.*)\);<\/script>/)[1];
  assert.deepStrictEqual(JSON.parse(embedded), config);
});

test("oidc valida tokens de servicio con el JWKS y cachea el token propio", async (t) => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", use: "sig" };
  let tokenRequests = 0;

  const idp = http.createServer((req, res) => {
    const issuer = `http://localhost:${idp.address().port}`;
    const routes = {
      "/.well-known/openid-configuration": () => ({ jwks_uri: `${issuer}/certs`, token_endpoint: `${issuer}/token` }),
      "/certs": () => ({ keys: [jwk] }),
      "/token": () => (tokenRequests++, { access_token: "propio", expires_in: 300 }),
    };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(routes[req.url]()));
  });
  await new Promise((resolve) => idp.listen(0, resolve));
  t.after(() => idp.close());

  const issuer = `http://localhost:${idp.address().port}`;
  const oidc = createOidc({ issuer, audience: "roffice", clientId: "roffice", clientSecret: "s" });
  const sign = (claims) => jwt.sign(claims, privateKey, { algorithm: "RS256", keyid: "k1", issuer, expiresIn: 60 });

  assert.strictEqual((await oidc.verifyServiceToken(sign({ azp: "cliente", aud: "roffice" }))).azp, "cliente");
  await assert.rejects(oidc.verifyServiceToken(sign({ azp: "cliente", aud: "otro" })));
  await assert.rejects(oidc.verifyServiceToken(jwt.sign({ aud: "roffice" }, "hmac", { keyid: "k1", issuer })));

  assert.strictEqual(await oidc.getServiceToken(), "propio");
  await oidc.getServiceToken();
  assert.strictEqual(tokenRequests, 1);
});

test("trackOpenDocument cede el documento más antiguo al superar el límite por usuario", () => {
  const a = { docRef: "t:a", tabId: "1" };
  const b = { docRef: "t:b", tabId: "2" };
  const c = { docRef: "t:c", tabId: "3" };

  assert.deepStrictEqual(trackOpenDocument([a], b, 1), { open: [b], evicted: [a] });
  assert.deepStrictEqual(trackOpenDocument([b, a], c, 2), { open: [c, b], evicted: [a] });
  assert.deepStrictEqual(trackOpenDocument([], a, 1), { open: [a], evicted: [] });

  const reopenedA = { docRef: "t:a", tabId: "9" };
  assert.deepStrictEqual(trackOpenDocument([b, a], reopenedA, 2), { open: [reopenedA, b], evicted: [] });
});
