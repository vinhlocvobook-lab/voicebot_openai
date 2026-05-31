/**
 * logger.js – Minimal logger với level filtering.
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[process.env.LOG_LEVEL || "info"] ?? 1;

function format(level, args) {
  const ts = new Date().toISOString();
  return [`[${ts}] [${level.toUpperCase()}]`, ...args];
}

export const log = {
  debug: (...a) => currentLevel <= 0 && console.debug(...format("debug", a)),
  info:  (...a) => currentLevel <= 1 && console.info(...format("info",  a)),
  warn:  (...a) => currentLevel <= 2 && console.warn(...format("warn",  a)),
  error: (...a) => currentLevel <= 3 && console.error(...format("error", a)),
};
