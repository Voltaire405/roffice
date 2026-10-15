const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[LOG_LEVEL] ?? LEVELS.info;

/**
 * Formatea un mensaje de log con timestamp, nivel y contexto.
 * @param {"debug"|"info"|"warn"|"error"} level
 * @param {string} tag - Módulo o contexto (ej: "Router", "Callback")
 * @param {string} message
 * @param {Object} [data] - Datos adicionales para el log
 */
function log(level, tag, message, data) {
  if (LEVELS[level] < currentLevel) return;

  const entry = {
    time: new Date().toISOString(),
    level: level.toUpperCase(),
    tag,
    msg: message,
  };

  if (data && Object.keys(data).length > 0) {
    entry.data = data;
  }

  const output = JSON.stringify(entry);

  switch (level) {
    case "error":
      console.error(output);
      break;
    case "warn":
      console.warn(output);
      break;
    default:
      console.log(output);
  }
}

const logger = {
  debug: (tag, msg, data) => log("debug", tag, msg, data),
  info:  (tag, msg, data) => log("info", tag, msg, data),
  warn:  (tag, msg, data) => log("warn", tag, msg, data),
  error: (tag, msg, data) => log("error", tag, msg, data),
};

/**
 * Middleware Express que loguea cada request con método, ruta, status y duración.
 */
function requestLogger(req, res, next) {
  const start = Date.now();

  res.on("finish", () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";

    // La ruta con patrón (/files/:fileToken) evita dejar tokens de acceso en los logs.
    logger[level]("HTTP", `${req.method} ${req.route?.path ?? req.path}`, {
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip,
    });
  });

  next();
}

module.exports = { logger, requestLogger };
