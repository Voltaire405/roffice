const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const http = require("http");
const jwt = require("jsonwebtoken");
const { documentKey, verifyCallback } = require("./onlyoffice");
const { createOidc } = require("./oidc");

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
