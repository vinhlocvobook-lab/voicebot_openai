/**
 * log-api.js
 * Client REST cho voicebot-log-api.php — thay cho db.js (kết nối MariaDB trực
 * tiếp). Endpoint mới nằm ở cntaapi1/voicebot-log-api.php (repo voice_chat_bot,
 * tách riêng khỏi api.php — file đó là gateway tra cứu khách hàng, không liên
 * quan tới log nội bộ).
 *
 * Giữ NGUYÊN chữ ký hàm của db.js (insertCallStub, finalizeCallLog, insertTicket,
 * closeDb) để chỉ cần đổi đường import ở nơi gọi (session-ws.js,
 * conversation-logger.js, server.js), không phải sửa logic gọi.
 *
 * Nguyên tắc giữ nguyên như db.js: LỖI GHI LOG KHÔNG ĐƯỢC LÀM SẬP CUỘC GỌI.
 * insertCallStub/insertTicket được gọi fire-and-forget (KHÔNG await) ở
 * session-ws.js — nên các hàm ở đây tuyệt đối không được throw / reject ra
 * ngoài, mọi lỗi tự nuốt + chỉ log cảnh báo (giống api.js).
 *
 * Bật/tắt: cần LOG_API_BASE trong .env. Trống thì bỏ qua ghi log (bot vẫn chạy
 * bình thường, chỉ lưu file JSON như cũ) — khớp hành vi DB_HOST trống của db.js.
 */

import { log as logger } from "./logger.js";

const LOG_API_BASE = (process.env.LOG_API_BASE || "").replace(/\/$/, "");
const LOG_API_TIMEOUT_MS = parseInt(process.env.LOG_API_TIMEOUT_MS || "15000", 10);
const ENABLED = !!LOG_API_BASE;

let _warnedDisabled = false;

/** Có đang bật ghi log qua REST API không (LOG_API_BASE đã cấu hình). */
export function isLogApiEnabled() {
  return ENABLED;
}

/**
 * Gọi 1 endpoint của voicebot-log-api.php. KHÔNG BAO GIỜ throw — mọi lỗi
 * (mạng, timeout, JSON hỏng, HTTP lỗi) đều trả về object {success:false,...}
 * để hàm gọi tự quyết có log cảnh báo hay bỏ qua.
 */
async function callApi(path, { method = "GET", body = null } = {}) {
  if (!ENABLED) {
    if (!_warnedDisabled) {
      logger.info("[LogAPI] LOG_API_BASE trống → bỏ qua ghi log qua API (chỉ lưu file JSON).");
      _warnedDisabled = true;
    }
    return { success: false, error_code: "DISABLED" };
  }

  const url = LOG_API_BASE + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOG_API_TIMEOUT_MS);
  const t0 = Date.now();

  try {
    const opts = { method, signal: controller.signal, headers: { Accept: "application/json" } };
    if (body) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }

    logger.debug(`[LogAPI] → ${method} ${url}`);
    const res = await fetch(url, opts);
    const text = await res.text();
    const durationMs = Date.now() - t0;

    let outer;
    try {
      outer = JSON.parse(text);
    } catch {
      logger.warn(`[LogAPI] ${method} ${path} → ${res.status} (${durationMs}ms) phản hồi không phải JSON hợp lệ`);
      return { success: false, error_code: "INVALID_RESPONSE" };
    }

    if (outer.success) {
      logger.debug(`[LogAPI] ${method} ${path} → ${res.status} (${durationMs}ms) OK`);
    } else {
      logger.warn(`[LogAPI] ${method} ${path} → ${res.status} (${durationMs}ms) lỗi: ${outer.error || "?"}`);
    }
    return outer;
  } catch (err) {
    const aborted = err.name === "AbortError";
    const durationMs = Date.now() - t0;
    logger.warn(
      `[LogAPI] Lỗi gọi ${url}: ${err.message} (${durationMs}ms)${aborted ? " [TIMEOUT]" : ""}`
    );
    return { success: false, error_code: aborted ? "TIMEOUT" : "CONNECTION_ERROR" };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Pha 1 — insertCallStub (thay INSERT ... ON DUPLICATE KEY UPDATE trực tiếp) ──

/**
 * Ghi dòng "mầm" ngay khi mở cuộc gọi. An toàn gọi nhiều lần (idempotent theo
 * callId — server upsert). Fire-and-forget ở nơi gọi, không throw.
 *
 * @param {object} p
 * @param {string} p.callId
 * @param {string} [p.customerTel]
 * @param {string} [p.uniqueid]
 * @param {string} [p.recordPath]
 * @param {string} [p.voiceModel]
 * @param {string} [p.startTime] - ISO; bỏ trống thì server tự lấy giờ hiện tại
 */
export async function insertCallStub(p = {}) {
  if (!p.callId) return;
  try {
    await callApi("/calls", {
      method: "POST",
      body: {
        callId: p.callId,
        customerTel: p.customerTel ?? null,
        uniqueid: p.uniqueid ?? null,
        recordPath: p.recordPath ?? null,
        voiceModel: p.voiceModel ?? null,
        startTime: p.startTime ?? null,
      },
    });
  } catch (err) {
    // Lưới an toàn cuối — callApi() ở trên đã tự nuốt mọi lỗi mạng rồi.
    logger.warn(`[LogAPI] insertCallStub(${p.callId}) lỗi bất ngờ: ${err.message}`);
  }
}

// ─── Pha 2 — finalizeCallLog (thay upsert đầy đủ + insertToolCalls) ──────────

/**
 * Upsert đầy đủ khi cuộc gọi kết thúc — gửi thẳng `document` mà
 * ConversationLogger dựng ra (cùng object đã ghi ra file JSON) kèm đường dẫn
 * file. Server (voicebot-log-api.php) tự lo phần dedupe prompt_logs, tra
 * llm_price hiện hành, và ghi từng dòng voicebot_toolcall.
 *
 * @param {object} document      - object log đầy đủ (meta/stats/token_usage/cost_usd/summary/...)
 * @param {string} [jsonFilePath] - đường dẫn file JSON gốc
 */
export async function finalizeCallLog(document, jsonFilePath = null) {
  const callId = document?.meta?.callId;
  if (!callId) return;
  try {
    const r = await callApi(`/calls/${encodeURIComponent(callId)}`, {
      method: "PUT",
      body: { ...document, json_log_filepath: jsonFilePath },
    });
    if (r.success) {
      const d = r.data || {};
      logger.info(
        `[LogAPI] Đã ghi voicebot_calllog: ${callId} (tool_calls ${d.tool_calls_written ?? "?"}/${d.tool_calls_total ?? "?"})`
      );
      if (Array.isArray(d.tool_call_errors) && d.tool_call_errors.length) {
        logger.warn(`[LogAPI] finalizeCallLog(${callId}) có ${d.tool_call_errors.length} tool call lỗi ghi (xem server log).`);
      }
    }
  } catch (err) {
    logger.warn(`[LogAPI] finalizeCallLog(${callId}) lỗi bất ngờ: ${err.message}`);
  }
}

// ─── ticket ───────────────────────────────────────────────────────────────

/**
 * Ghi 1 phiếu ticket nội bộ (create_ticket / leave_callback_message).
 * Fire-and-forget ở nơi gọi, không throw. Server tự sinh ticket_code.
 *
 * @param {object} p
 * @param {string}  p.callId
 * @param {string} [p.customerTel]
 * @param {object}  p.args   - { ma_danh_bo, loai, mo_ta }
 * @param {object}  p.output - kết quả tool (đã parse) { success, message, data }
 */
export async function insertTicket(p = {}) {
  if (!p.callId) return;
  try {
    await callApi("/tickets", {
      method: "POST",
      body: {
        callId: p.callId,
        customerTel: p.customerTel ?? null,
        args: p.args ?? {},
        output: p.output ?? {},
      },
    });
  } catch (err) {
    logger.warn(`[LogAPI] insertTicket(${p.callId}) lỗi bất ngờ: ${err.message}`);
  }
}

// ─── danh-bo history (fallback khi tra khách hàng theo SĐT thất bại/rỗng) ───

/**
 * [fix 10/08/2026] Lấy mã danh bộ ĐÃ XÁC NHẬN gần nhất theo SĐT, từ lịch sử
 * cuộc gọi TRƯỚC (voicebot_calllog.ma_danh_bo — endpoint GET /danh-bo bên
 * voicebot-log-api.php). Dùng làm fallback khi api.js#getThongTinKhachHang tra
 * theo SĐT lỗi mạng hoặc không ra hợp đồng nào.
 *
 * CHỈ trả về GỢI Ý — không phải bằng chứng đã xác minh cho lần gọi này (SĐT có
 * thể đổi chủ, hợp đồng có thể đã đổi/khoá từ lần gọi trước). Nơi gọi phải đưa
 * qua gate xác nhận lời nói thật trước khi dùng để tra cứu (xem resolveDanhBo
 * trong tools.js, nguồn "history_tel").
 *
 * KHÔNG BAO GIỜ throw — lỗi mạng/timeout/JSON hỏng đều trả về mảng rỗng, giống
 * nguyên tắc "lỗi ghi/đọc log không được làm sập cuộc gọi" của cả file này.
 *
 * @param {string} tel
 * @param {object} [opts]
 * @param {number} [opts.limit] - số ứng viên tối đa (mặc định 5, khớp server)
 * @param {number} [opts.days]  - chỉ lấy trong N ngày gần nhất (mặc định 180, khớp server)
 * @returns {Promise<Array<{ma_danh_bo:string, last_confirmed_at:string, voicebot_callid:string, outcome:string}>>}
 */
export async function getDanhBoHistory(tel, { limit = 5, days = 180 } = {}) {
  if (!tel) return [];
  try {
    const qs = new URLSearchParams({ tel: String(tel), limit: String(limit), days: String(days) });
    const r = await callApi(`/danh-bo?${qs.toString()}`, { method: "GET" });
    if (!r.success) return [];
    return Array.isArray(r.data?.candidates) ? r.data.candidates : [];
  } catch (err) {
    // Lưới an toàn cuối — callApi() ở trên đã tự nuốt mọi lỗi mạng rồi.
    logger.warn(`[LogAPI] getDanhBoHistory(${tel}) lỗi bất ngờ: ${err.message}`);
    return [];
  }
}

// ─── tương thích chữ ký cũ ────────────────────────────────────────────────

/**
 * server.js gọi lúc SIGINT/SIGTERM để đóng pool DB. Bản REST không giữ pool/
 * connection nào — no-op, giữ lại để khỏi phải sửa server.js.
 */
export async function closeDb() {
  /* no-op: REST client không có pool cần đóng */
}
