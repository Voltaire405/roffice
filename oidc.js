const crypto = require("crypto");
const jwt = require("jsonwebtoken");

// Un kid desconocido dispara la recarga del JWKS; el intervalo evita que tokens con kid inventado la amplifiquen.
const JWKS_REFRESH_MIN_INTERVAL = 60_000;
const TOKEN_EXPIRY_MARGIN = 30_000;

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${init?.method || "GET"} ${url} respondió ${res.status}`);
  return res.json();
}

/**
 * Cliente OIDC genérico: valida tokens de servicio entrantes contra el JWKS del
 * issuer y obtiene el token de servicio propio con client_credentials.
 */
function createOidc({ issuer, audience, clientId, clientSecret }) {
  let discovery = null;
  let publicKeys = new Map();
  let jwksFetchedAt = 0;
  let serviceToken = null;

  async function getDiscovery() {
    discovery ??= await fetchJson(`${issuer}/.well-known/openid-configuration`);
    return discovery;
  }

  async function refreshJwks() {
    if (Date.now() - jwksFetchedAt < JWKS_REFRESH_MIN_INTERVAL) return;
    jwksFetchedAt = Date.now();
    const { keys } = await fetchJson((await getDiscovery()).jwks_uri);
    publicKeys = new Map(
      keys
        .filter((jwk) => jwk.use !== "enc")
        .map((jwk) => [jwk.kid, crypto.createPublicKey({ key: jwk, format: "jwk" })])
    );
  }

  async function verifyServiceToken(token) {
    const kid = jwt.decode(token, { complete: true })?.header?.kid;
    if (!kid) throw new Error("Token sin kid");
    if (!publicKeys.has(kid)) await refreshJwks();

    const publicKey = publicKeys.get(kid);
    if (!publicKey) throw new Error(`kid desconocido: ${kid}`);
    return jwt.verify(token, publicKey, { algorithms: ["RS256"], issuer, audience });
  }

  async function getServiceToken() {
    if (serviceToken && serviceToken.expiresAt > Date.now()) return serviceToken.value;

    const { access_token, expires_in } = await fetchJson((await getDiscovery()).token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
    });
    serviceToken = { value: access_token, expiresAt: Date.now() + expires_in * 1000 - TOKEN_EXPIRY_MARGIN };
    return access_token;
  }

  return { verifyServiceToken, getServiceToken };
}

module.exports = { createOidc };
