/**
 * db.js
 * Ghi log cuộc gọi vào MariaDB/MySQL (bảng voicebot_calllog).
 *
 * Nguyên tắc thiết kế (xem docs/thietke_db.md):
 *   - Voice bot là NGƯỜI GHI DUY NHẤT cho voicebot_calllog (single writer).
 *   - Ghi 2 pha, đều trong bot:
 *       1) insertCallStub()   — lúc mở cuộc gọi: ghi dòng "mầm" với data đã có.
 *       2) finalizeCallLog()  — lúc kết thúc: upsert đầy đủ (cost, transcript, eval...).
 *     Idempotent nhờ UNIQUE(voicebot_callid) + INSERT ... ON DUPLICATE KEY UPDATE.
 *   - LỖI DB KHÔNG ĐƯỢC LÀM SẬP CUỘC GỌI: mọi hàm tự nuốt lỗi, chỉ log cảnh báo.
 *
 * Bật/tắt: cần DB_HOST trong .env (và DB_ENABLED != "false").
 */

import crypto from "crypto";
import mysql from "mysql2/promise";
import { log } from "./logger.js";

// ─── Cấu hình & pool ──────────────────────────────────────────────────────────

const DB_ENABLED =
  !!process.env.DB_HOST && process.env.DB_ENABLED !== "false";

let _pool = null;
let _warnedDisabled = false;

/** Lấy pool kết nối (lazy). Trả null nếu DB bị tắt/chưa cấu hình. */
function getPool() {
  if (!DB_ENABLED) {
    if (!_warnedDisabled) {
      log.info("[DB] DB_HOST trống hoặc DB_ENABLED=false → bỏ qua ghi DB (chỉ lưu file JSON).");
      _warnedDisabled = true;
    }
    return null;
  }
  if (_pool) return _pool;
  _pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 5),
    queueLimit: 0,
    charset: "utf8mb4",
    // Giờ lưu là wall-clock GMT+7 (đã format sẵn dạng "YYYY-MM-DD HH:MM:SS")
    dateStrings: true,
    timezone: "Z",
  });
  log.info(`[DB] Đã tạo pool tới ${process.env.DB_HOST}:${process.env.DB_PORT || 3306}/${process.env.DB_NAME}`);
  return _pool;
}

export function isDbEnabled() {
  return DB_ENABLED;
}

/** Đóng pool (gọi khi tắt server, nếu cần). */
export async function closeDb() {
  if (_pool) {
    try { await _pool.end(); } catch { /* ignore */ }
    _pool = null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Đổi chuỗi ISO có offset (vd "2026-06-05T18:33:00.914+07:00") sang
 * DATETIME MySQL theo đúng wall-clock đó: "2026-06-05 18:33:00".
 * Cắt thẳng phần local để không bị lệch khi qua UTC.
 */
function toMysqlDatetime(iso) {
  if (!iso) return null;
  const s = String(iso);
  // "YYYY-MM-DDTHH:MM:SS..." → "YYYY-MM-DD HH:MM:SS"
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
  if (m) return `${m[1]} ${m[2]}`;
  // fallback: dùng Date (giờ máy)
  const d = new Date(s);
  if (isNaN(d)) return null;
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function nowMysqlGmt7() {
  const TZ = 7 * 60 * 60 * 1000;
  return new Date(Date.now() + TZ).toISOString().slice(0, 19).replace("T", " ");
}

/** Cắt chuỗi cho vừa độ dài cột (tránh lỗi "Data too long"). */
function clip(v, max) {
  if (v == null) return null;
  const s = String(v);
  return s.length > max ? s.slice(0, max) : s;
}

// ─── API: prompt_logs ─────────────────────────────────────────────────────────

/**
 * Upsert một phiên bản system prompt. Dedupe bằng SHA-256 của nội dung.
 * @param {string} instructions  - Toàn bộ system instructions
 * @param {string} [version]     - Nhãn phiên bản (tùy chọn)
 * @returns {Promise<number|null>} prompt_logs.id (null nếu DB tắt/lỗi)
 */
export async function upsertPromptLog(instructions, version = null) {
  const pool = getPool();
  if (!pool || !instructions) return null;
  try {
    const hash = crypto.createHash("sha256").update(String(instructions), "utf8").digest("hex");
    // Tìm trước (đa số trường hợp prompt đã tồn tại)
    const [rows] = await pool.query(
      "SELECT id FROM prompt_logs WHERE prompt_hash = ? LIMIT 1",
      [hash]
    );
    if (rows.length) return rows[0].id;

    const [res] = await pool.query(
      `INSERT INTO prompt_logs (prompt_hash, version, noi_dung)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
      [hash, version, String(instructions)]
    );
    return res.insertId;
  } catch (err) {
    log.warn(`[DB] upsertPromptLog lỗi: ${err.message}`);
    return null;
  }
}

// ─── API: llm_price ───────────────────────────────────────────────────────────

const _priceCache = new Map(); // model_key → id (giá hiện hành ít đổi)

/**
 * Lấy id bản giá ĐANG hiệu lực của một model (is_current = 1).
 * @param {string} modelKey
 * @returns {Promise<number|null>}
 */
export async function getCurrentPriceId(modelKey) {
  const pool = getPool();
  if (!pool || !modelKey) return null;
  if (_priceCache.has(modelKey)) return _priceCache.get(modelKey);
  try {
    const [rows] = await pool.query(
      "SELECT id FROM llm_price WHERE model_key = ? AND is_current = 1 ORDER BY effective_from DESC LIMIT 1",
      [modelKey]
    );
    const id = rows.length ? rows[0].id : null;
    if (id) _priceCache.set(modelKey, id);
    return id;
  } catch (err) {
    log.warn(`[DB] getCurrentPriceId(${modelKey}) lỗi: ${err.message}`);
    return null;
  }
}

// ─── API: voicebot_calllog ────────────────────────────────────────────────────

/**
 * Pha 1 — ghi dòng "mầm" ngay khi mở cuộc gọi.
 * An toàn gọi nhiều lần (idempotent theo voicebot_callid).
 *
 * @param {object} p
 * @param {string} p.callId
 * @param {string} [p.customerTel]
 * @param {string} [p.uniqueid]
 * @param {string} [p.recordPath]
 * @param {string} [p.voiceModel]
 * @param {string} [p.startTime]   - ISO; mặc định now (GMT+7)
 */
export async function insertCallStub(p = {}) {
  const pool = getPool();
  if (!pool || !p.callId) return;
  try {
    const startTime = p.startTime ? toMysqlDatetime(p.startTime) : nowMysqlGmt7();
    await pool.query(
      `INSERT INTO voicebot_calllog
         (voicebot_callid, customer_tel, uniqueid, recordpath, voice_model_name, start_time, outcome)
       VALUES (?, ?, ?, ?, ?, ?, 'disconnected')
       ON DUPLICATE KEY UPDATE
         customer_tel     = COALESCE(VALUES(customer_tel), customer_tel),
         uniqueid         = COALESCE(VALUES(uniqueid), uniqueid),
         recordpath       = COALESCE(VALUES(recordpath), recordpath),
         voice_model_name = COALESCE(VALUES(voice_model_name), voice_model_name),
         start_time       = COALESCE(VALUES(start_time), start_time)`,
      [
        clip(p.callId, 128),
        clip(p.customerTel, 32),
        clip(p.uniqueid, 64),
        clip(p.recordPath, 512),
        clip(p.voiceModel, 100),
        startTime,
      ]
    );
    log.debug(`[DB] stub call ${p.callId} OK`);
  } catch (err) {
    log.warn(`[DB] insertCallStub(${p.callId}) lỗi: ${err.message}`);
  }
}

/**
 * Trích ma_danh_bo từ danh sách tool calls (vd get_bill({ ma_danh_bo })).
 */
function _extractMaDanhBo(toolCalls = []) {
  for (const tc of toolCalls) {
    const v = tc?.args?.ma_danh_bo ?? tc?.args?.maDanhBo ?? tc?.args?.danhba ?? tc?.args?.danh_bo;
    if (v) return String(v).replace(/\D/g, "") || null;
  }
  return null;
}

/**
 * Pha 2 — upsert đầy đủ khi cuộc gọi kết thúc, từ `document` mà ConversationLogger
 * dựng ra (cùng object đã ghi ra file JSON) + đường dẫn file.
 *
 * @param {object} document  - object log đầy đủ (meta/stats/token_usage/cost_usd/summary/...)
 * @param {string} jsonFilePath - đường dẫn file JSON gốc
 */
export async function finalizeCallLog(document, jsonFilePath = null) {
  const pool = getPool();
  if (!pool || !document?.meta?.callId) return;

  try {
    const meta  = document.meta  ?? {};
    const stats = document.stats ?? {};
    const tu    = document.token_usage ?? {};
    const cost  = document.cost_usd    ?? {};
    const summ  = document.summary     ?? {};
    const ast   = meta.asterisk        ?? {};

    // Model names
    const voiceModel      = meta.model ?? tu.realtime?.model ?? null;
    const summaryModel    = tu.summary?.model ?? null;
    const transcriptModel = tu.transcription?.model ?? null;

    // prompt version + price ids (song song)
    const instructions = document.call_params?.accept?.instructions ?? null;
    const [promptId, priceRtId, priceSumId, priceTrId] = await Promise.all([
      upsertPromptLog(instructions),
      getCurrentPriceId(voiceModel),
      getCurrentPriceId(summaryModel),
      getCurrentPriceId(transcriptModel),
    ]);

    // transcript đọc nhanh: ưu tiên mảng conversation (đã format dễ đọc)
    const transcriptText = Array.isArray(document.conversation)
      ? document.conversation.join("\n")
      : Array.isArray(document.transcript)
        ? document.transcript.map((t) => `[${t.speaker}] ${t.text}`).join("\n")
        : null;

    const row = {
      voicebot_callid:       clip(meta.callId, 128),
      customer_tel:          clip(ast.phoneNumber ?? meta.tel, 32),
      ma_danh_bo:            clip(_extractMaDanhBo(document.toolCalls), 20),
      prompt_logs_id:        promptId,

      start_time:            toMysqlDatetime(meta.startTime),
      end_time:              toMysqlDatetime(meta.endTime),
      call_duration:         meta.durationSec ?? null,
      outcome:               meta.outcome ?? null,

      uniqueid:              clip(ast.uniqueid, 64),
      recordpath:            clip(ast.recordPath, 512),

      voice_model_name:      clip(voiceModel, 100),
      summary_model_name:    clip(summaryModel, 100),
      transcript_model_name: clip(transcriptModel, 100),

      cost_realtime:         cost.realtime?.cost      ?? null,
      cost_summary:          cost.summary?.cost       ?? null,
      cost_transcript:       cost.transcription?.cost ?? null,
      cost_total:            cost.total               ?? null,

      price_realtime_id:     priceRtId,
      price_summary_id:      priceSumId,
      price_transcript_id:   priceTrId,

      danh_gia_cuoc_goi:     summ.danh_gia_cuoc_goi ?? null,

      transcript:            transcriptText,
      total_turns:           stats.totalTurns    ?? null,
      tool_call_count:       stats.toolCallCount ?? null,
      error_count:           stats.errorCount    ?? null,

      json_log_filepath:     clip(jsonFilePath, 512),
    };

    const cols = Object.keys(row);
    const placeholders = cols.map(() => "?").join(", ");
    // Upsert: cập nhật mọi cột trừ khóa unique
    const updates = cols
      .filter((c) => c !== "voicebot_callid")
      .map((c) => `${c} = VALUES(${c})`)
      .join(", ");

    await pool.query(
      `INSERT INTO voicebot_calllog (${cols.join(", ")})
       VALUES (${placeholders})
       ON DUPLICATE KEY UPDATE ${updates}`,
      cols.map((c) => row[c])
    );

    log.info(`[DB] Đã ghi voicebot_calllog: ${meta.callId} (cost=${row.cost_total})`);
  } catch (err) {
    log.warn(`[DB] finalizeCallLog(${document?.meta?.callId}) lỗi: ${err.message}`);
  }
}

// ─── API: ticket ──────────────────────────────────────────────────────────────

/** Sinh mã phiếu nội bộ: TK-yyyymmddHHMMSS-xxx */
function _genTicketCode() {
  const t = new Date(Date.now() + 7 * 60 * 60 * 1000)
    .toISOString().slice(0, 19).replace(/[-:T]/g, "");
  const rnd = Math.random().toString(36).slice(2, 5).toUpperCase();
  return `TK-${t}-${rnd}`;
}

/**
 * Ghi 1 phiếu ticket nội bộ mỗi khi tool create_ticket chạy (dù remote thành công
 * hay thất bại — đây chính là mục đích lưu nội bộ để đối soát).
 * Link voicebot_calllog_id qua subselect theo voicebot_callid (dòng stub đã có sẵn).
 *
 * @param {object} p
 * @param {string}  p.callId       - OpenAI call ID
 * @param {string} [p.customerTel] - SĐT khách
 * @param {object}  p.args         - args của create_ticket { ma_danh_bo, loai, mo_ta }
 * @param {object}  p.output       - kết quả tool (đã parse) { success, message, data }
 */
export async function insertTicket(p = {}) {
  const pool = getPool();
  if (!pool || !p.callId) return;
  try {
    const args = p.args   ?? {};
    const out  = p.output ?? {};
    const loai = args.loai ?? null;
    const moTa = args.mo_ta ?? null;
    const maDanhBo = args.ma_danh_bo ? String(args.ma_danh_bo).replace(/\D/g, "") : null;
    // Nội dung thực gửi remote: ưu tiên cái remote trả về, fallback dựng lại "[loai] mo_ta"
    const noiDungGui = out?.data?.[0]?.noidungbao ?? (loai ? `[${loai}] ${moTa ?? ""}` : moTa);
    const success = out?.success ? 1 : 0;

    await pool.query(
      `INSERT INTO ticket
         (ticket_code, voicebot_calllog_id, voicebot_callid, ma_danh_bo, customer_tel,
          loai, mo_ta, noi_dung_gui, remote_success, remote_message, remote_raw, trang_thai)
       VALUES
         (?, (SELECT id FROM voicebot_calllog WHERE voicebot_callid = ? LIMIT 1), ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?)`,
      [
        _genTicketCode(),
        clip(p.callId, 128),
        clip(p.callId, 128),
        clip(maDanhBo, 20),
        clip(p.customerTel, 32),
        clip(loai, 64),
        moTa,
        noiDungGui,
        success,
        out?.message ?? null,
        JSON.stringify(out ?? null),
        success ? "da_gui" : "gui_loi",
      ]
    );
    log.info(`[DB] Đã ghi ticket cho call ${p.callId} (remote_success=${success})`);
  } catch (err) {
    log.warn(`[DB] insertTicket(${p.callId}) lỗi: ${err.message}`);
  }
}
