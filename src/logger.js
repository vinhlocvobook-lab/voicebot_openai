/**
 * logger.js – Minimal logger với level filtering.
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[process.env.LOG_LEVEL || "info"] ?? 1;

// Múi giờ Việt Nam (GMT+7) – hiển thị log console theo giờ địa phương
const TZ_OFFSET_MS = 7 * 60 * 60 * 1000;
function _nowGmt7() {
  return new Date(Date.now() + TZ_OFFSET_MS).toISOString().replace("Z", "+07:00");
}

function format(level, args) {
  const ts = _nowGmt7();
  return [`[${ts}] [${level.toUpperCase()}]`, ...args];
}

export const log = {
  debug: (...a) => currentLevel <= 0 && console.debug(...format("debug", a)),
  info:  (...a) => currentLevel <= 1 && console.info(...format("info",  a)),
  warn:  (...a) => currentLevel <= 2 && console.warn(...format("warn",  a)),
  error: (...a) => currentLevel <= 3 && console.error(...format("error", a)),
};
