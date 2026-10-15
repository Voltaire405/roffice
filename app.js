const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const express = require("express");
const { verifyCallback, renderEditorPage } = require("./onlyoffice");
const { SessionError } = require("./edit-session");
const { logger, requestLogger } = require("./logger");

const HTTP_STATUS = {
  invalid_request: 400,
  tab_forbidden: 403,
  file_not_found: 404,
  not_open: 404,
  link_expired: 410,
  save_failed: 500,
  command_failed: 502,
  open_failed: 503,
};

function readTabCookie(req) {
  return req.get("Cookie")?.match(/(?:^|;\s*)roffice_tab=([^;]+)/)?.[1];
}

function sendEditorError(res, status, message) {
  res.status(status).type("html").send(`<!doctype html><meta charset="utf-8"><title>Roffice</title><p>${message}</p>`);
}

/** Traduce un SessionError a HTTP; cualquier otro error sigue al manejador de Express (500). */
function sessionErrorStatus(err) {
  if (!(err instanceof SessionError)) throw err;
  return HTTP_STATUS[err.code];
}

/**
 * Rutas HTTP de Roffice, sin efectos al importar: el cableado (env, Redis, timers, listen) vive en main.js.
 * @param {Object} deps
 * @param {Record<string, Object>} deps.tenants - client_id (azp) autorizados
 * @param {{ verifyServiceToken: (token: string) => Promise<{ azp: string }> }} deps.oidc
 * @param {ReturnType<typeof import("./edit-session").createEditSessions>} deps.sessions
 * @param {ReturnType<typeof import("./pool").createPool>} deps.pool
 * @param {string} deps.jwtSecret - secreto compartido con OnlyOffice
 * @param {string} deps.publicUrl - URL con la que el navegador abre la pestaña del editor
 */
function createApp({ tenants, oidc, sessions, pool, jwtSecret, publicUrl }) {
  const app = express();
  app.use(requestLogger);
  app.use(express.json());

  async function requireServiceToken(req, res, next) {
    const token = req.get("Authorization")?.replace(/^Bearer /, "");
    if (!token) return res.status(401).json({ error: "Falta token de servicio" });

    try {
      const claims = await oidc.verifyServiceToken(token);
      if (!Object.hasOwn(tenants, claims.azp)) {
        logger.warn("Auth", "Cliente no registrado en TENANTS", { azp: claims.azp });
        return res.status(403).json({ error: "Cliente no autorizado" });
      }
      req.tenant = claims.azp;
      next();
    } catch (err) {
      logger.warn("Auth", "Token de servicio rechazado", { error: err.message });
      res.status(401).json({ error: "Token de servicio inválido" });
    }
  }

  // Abre (o se une a) la sesión de edición de un documento del cliente.
  app.post("/api/sessions", requireServiceToken, async (req, res) => {
    try {
      const { launchToken, expiresIn } = await sessions.open(req.tenant, req.body);
      res.json({ editorUrl: `${publicUrl}/editor/launch/${launchToken}`, expiresIn });
    } catch (err) {
      res.status(sessionErrorStatus(err)).json({ error: err.message });
    }
  });

  // Canjea el enlace de un solo uso por una cookie de la pestaña y redirige a una URL sin el token.
  app.get("/editor/launch/:launchToken", async (req, res) => {
    try {
      const { tabId, cookieSecret, expiresIn } = await sessions.redeemLaunch(req.params.launchToken);
      res.cookie("roffice_tab", cookieSecret, {
        path: `/editor/${tabId}`,
        httpOnly: true,
        sameSite: "lax",
        secure: publicUrl.startsWith("https:"),
        maxAge: expiresIn * 1000,
      });
      res.set("Referrer-Policy", "no-referrer");
      res.redirect(303, `/editor/${tabId}`);
    } catch (err) {
      sendEditorError(res, sessionErrorStatus(err), err.message);
    }
  });

  app.get("/editor/:tabId", async (req, res) => {
    try {
      const tab = await sessions.getTab(req.params.tabId, readTabCookie(req));
      res.set("Cache-Control", "no-store");
      res.set("Referrer-Policy", "no-referrer");
      res.type("html").send(renderEditorPage(tab));
    } catch (err) {
      sendEditorError(res, sessionErrorStatus(err), err.message);
    }
  });

  // Proxy de lectura: OnlyOffice no maneja bien las URLs prefirmadas virtual-hosted (ver APRENDIZAJES.md §2)
  // y así la getUrl del cliente nunca viaja en el config que llega al navegador.
  app.get("/files/:fileToken", async (req, res) => {
    let getUrl;
    try {
      getUrl = await sessions.fileSource(req.params.fileToken);
    } catch (err) {
      return res.status(sessionErrorStatus(err)).json({ error: err.message });
    }

    try {
      const source = await fetch(getUrl);
      if (!source.ok) {
        logger.warn("Proxy", "El storage del cliente rechazó la lectura", { status: source.status });
        return res.status(502).json({ error: "No se pudo leer el documento del cliente" });
      }
      res.set("Content-Type", source.headers.get("content-type") || "application/octet-stream");
      res.set("Cache-Control", "no-store");
      await pipeline(Readable.fromWeb(source.body), res);
    } catch (err) {
      logger.error("Proxy", "Error leyendo el documento del cliente", { error: err.message });
      if (res.headersSent) return res.destroy();
      res.status(502).json({ error: "No se pudo leer el documento del cliente" });
    }
  });

  // Un guardado fallido responde 500 + error ≠ 0 para que OnlyOffice no lo dé por persistido.
  app.post("/api/callback", async (req, res) => {
    let payload;
    try {
      payload = verifyCallback(req.body, req.get("Authorization"), jwtSecret);
    } catch (err) {
      logger.warn("Callback", "Callback con firma inválida", { error: err.message });
      return res.status(403).json({ error: 1 });
    }

    try {
      await sessions.handleCallback(payload);
      res.json({ error: 0 });
    } catch (err) {
      res.status(sessionErrorStatus(err)).json({ error: 1 });
    }
  });

  app.post("/api/sessions/:docId/forcesave", requireServiceToken, async (req, res) => {
    try {
      const { status, body } = await sessions.forcesave(req.tenant, req.params.docId);
      res.status(status).type("json").send(body);
    } catch (err) {
      res.status(sessionErrorStatus(err)).json({ error: err.message });
    }
  });

  app.get("/api/instances/status", async (req, res) => {
    try {
      res.json({ instances: await pool.status() });
    } catch (err) {
      logger.error("Status", "Error obteniendo estado", { error: err.message });
      res.status(500).json({ error: "Error obteniendo estado de instancias" });
    }
  });

  return app;
}

module.exports = { createApp };
