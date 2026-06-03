/**
 * conversation-logger.js
 * Thu thập transcript và tóm tắt nội dung cuộc gọi, lưu file JSON.
 *
 * Cấu trúc thư mục: conversation_summary/yyyy/mm/dd/{tel}_{callId_short}.json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Lưu trong thư mục gốc của project, cùng cấp với server.js
const SUMMARY_ROOT = path.join(__dirname, "..", "conversation_summary");

// ─── ConversationLogger ───────────────────────────────────────────────────────

export class ConversationLogger {
  /**
   * @param {string} callId  - OpenAI call ID (rtc_u0_...)
   * @param {string} tel     - Số điện thoại khách hàng (trích từ SIP From header)
   */
  constructor(callId, tel) {
    this.callId     = callId;
    this.tel        = tel || "unknown";
    this.startTime  = new Date();
    this.endTime    = null;

    // Transcript: mảng các lượt thoại theo thứ tự thời gian
    this.transcript = []; // { time, speaker: "AI" | "KH", text }

    // Tool calls trong cuộc gọi
    this.toolCalls  = []; // { time, name, args, output, durationMs }

    // Timeline sự kiện kỹ thuật (diễn tiến cuộc gọi) để debug
    this.events     = []; // { time, stage, detail }

    // Lỗi phát sinh trong cuộc gọi
    this.errors     = []; // { time, where, message }

    // Kết quả cuộc gọi
    this.outcome    = "disconnected"; // "completed" | "transferred" | "after_hours" | "disconnected"

    // Thông tin kỹ thuật phiên
    this.model      = process.env.OPENAI_REALTIME_MODEL || null;
    this.voice      = process.env.OPENAI_VOICE || null;

    // Params kỹ thuật để debug/phân tích prompt
    this.acceptParams        = null;  // body gửi lúc POST /accept (gồm instructions đầy đủ)
    this.sessionUpdateParams = null;  // body gửi lúc session.update qua WS
    this.sessionCreatedData  = null;  // data nhận từ session.created event (gồm instructions OpenAI xác nhận)

    // Thông tin từ Asterisk SIP headers
    this.asteriskData = null;  // { uniqueid, recordPath, phoneNumber }

    // Buffer tạm cho AI response đang stream
    this._aiBuffer  = "";
  }

  // ── Transcript ──────────────────────────────────────────────────────────────

  /** Thêm 1 chunk transcript AI đang stream */
  appendAIDelta(delta) {
    this._aiBuffer += delta;
  }

  /**
   * Flush transcript AI.
   * @param {string} [doneText] - Nếu có, dùng text done thay vì buffer (chính xác hơn)
   */
  flushAI(doneText) {
    const text = (doneText ?? this._aiBuffer).trim();
    this._aiBuffer = "";
    if (!text) return;
    // Chống ghi trùng: nhiều event có thể trả về cùng 1 câu AI
    const last = this.transcript[this.transcript.length - 1];
    if (last && last.speaker === "AI" && last.text === text) return;
    this.transcript.push({ time: _now(), speaker: "AI", text });
  }

  /** Thêm lượt nói của khách hàng (từ input_audio_transcription.completed) */
  addCustomerTurn(text) {
    if (text?.trim()) {
      this.transcript.push({ time: _now(), speaker: "KH", text: text.trim() });
    }
  }

  // ── Tool calls ──────────────────────────────────────────────────────────────

  /** Ghi nhận một tool call + kết quả (đầu vào / đầu ra của function tool) */
  addToolCall(name, args, output, durationMs = null) {
    const entry = { time: _now(), name, args, output, durationMs };
    this.toolCalls.push(entry);
    this.addEvent("tool_call", `${name}(${_safeJson(args)})`);
    return entry;
  }

  // ── Timeline sự kiện & lỗi ────────────────────────────────────────────────────

  /** Ghi một mốc sự kiện kỹ thuật vào timeline (call accepted, ws open, greeting...) */
  addEvent(stage, detail = null) {
    this.events.push({ time: _now(), stage, detail });
  }

  /** Ghi nhận một lỗi phát sinh trong cuộc gọi */
  addError(where, message) {
    this.errors.push({ time: _now(), where, message: String(message ?? "") });
    this.addEvent("error", `${where}: ${message}`);
  }

  // ── Outcome ─────────────────────────────────────────────────────────────────

  setOutcome(outcome) {
    this.outcome = outcome;
  }

  /** Lưu params đã gửi lúc POST /accept — giữ nguyên instructions đầy đủ để so sánh prompt */
  setAcceptParams(params) {
    this.acceptParams = params;
  }

  /** Lưu params session.update — giữ tools names để biết tools nào được kích hoạt */
  setSessionUpdateParams(params) {
    this.sessionUpdateParams = {
      ...params,
      // Lưu tên tools thay vì full schema (schema dài, không cần trong log)
      tools: (params.tools ?? []).map((t) => t.name),
    };
  }

  /** Lưu toàn bộ session.created data — bao gồm instructions OpenAI đã nhận và xác nhận */
  setSessionCreatedData(data) {
    this.sessionCreatedData = data;
  }

  /** Lưu thông tin Asterisk: uniqueid, recordPath, phoneNumber */
  setAsteriskData(data) {
    this.asteriskData = data;
  }

  // ── Save ────────────────────────────────────────────────────────────────────

  /** Lưu full transcript + AI summary ra file JSON. Gọi khi cuộc gọi kết thúc. */
  async save() {
    this.endTime = new Date();
    this.flushAI(); // flush buffer nếu còn
    this.addEvent("call_ended", `outcome=${this.outcome}`);

    const durationSec = Math.round((this.endTime - this.startTime) / 1000);

    // Tạo AI summary từ transcript
    const aiSummary = await _generateSummary(this.transcript, this.toolCalls, this.outcome);

    // Timeline gộp (diễn tiến cuộc gọi theo thời gian): hội thoại + tool + sự kiện
    const timeline = _buildTimeline(this.transcript, this.toolCalls, this.events);

    const document = {
      // ── 1. Thông tin định danh cuộc gọi ───────────────────────────────────
      meta: {
        callId:      this.callId,
        tel:         this.tel,
        startTime:   this.startTime.toISOString(),
        endTime:     this.endTime.toISOString(),
        durationSec,
        outcome:     this.outcome,
        model:       this.model,
        voice:       this.voice,
        // Thông tin từ Asterisk (phục vụ debug + đối chiếu file ghi âm)
        asterisk: {
          uniqueid:    this.asteriskData?.uniqueid   ?? null,
          recordPath:  this.asteriskData?.recordPath ?? null,
          phoneNumber: this.asteriskData?.phoneNumber ?? this.tel,
        },
      },

      // ── 2. Thống kê nhanh ──────────────────────────────────────────────────
      stats: {
        totalTurns:    this.transcript.length,
        aiTurns:       this.transcript.filter((t) => t.speaker === "AI").length,
        customerTurns: this.transcript.filter((t) => t.speaker === "KH").length,
        toolCallCount: this.toolCalls.length,
        errorCount:    this.errors.length,
      },

      // ── 3. Tóm tắt do AI tạo ra (đánh giá chất lượng cuộc gọi) ──────────────
      summary: aiSummary,

      // ── 4. Diễn tiến cuộc gọi theo thời gian (debug tổng quan) ──────────────
      timeline,

      // ── 5. Hội thoại đầy đủ KH ↔ AI ────────────────────────────────────────
      transcript: this.transcript,

      // ── 6. Đầu vào / đầu ra của các function tool ──────────────────────────
      toolCalls: this.toolCalls,

      // ── 7. Lỗi phát sinh trong cuộc gọi ────────────────────────────────────
      errors: this.errors,

      // ── 8. Sự kiện kỹ thuật chi tiết ───────────────────────────────────────
      events: this.events,

      // ── 9. Params kỹ thuật để phân tích/điều chỉnh prompt ──────────────────
      call_params: {
        accept: this.acceptParams ? { ...this.acceptParams } : null,
        session_update: this.sessionUpdateParams,
        // session_created phản ánh cấu hình OpenAI thực sự nhận — so với accept để phát hiện sai lệch
        session_created: this.sessionCreatedData,
      },
    };

    const filePath = _buildFilePath(this.startTime, this.tel, this.callId);
    _ensureDir(path.dirname(filePath));

    fs.writeFileSync(filePath, JSON.stringify(document, null, 2), "utf-8");
    log.info(`[Logger] Đã lưu: ${filePath}`);
    return filePath;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _now() {
  return new Date().toISOString();
}

function _safeJson(obj) {
  try { return JSON.stringify(obj); } catch { return String(obj); }
}

/**
 * Gộp transcript + tool calls + events thành 1 timeline thống nhất, sắp xếp theo thời gian.
 * Giúp đọc nhanh diễn tiến cuộc gọi từ trên xuống.
 */
function _buildTimeline(transcript, toolCalls, events) {
  const items = [];

  for (const t of transcript) {
    items.push({ time: t.time, kind: t.speaker === "AI" ? "ai" : "customer", text: t.text });
  }
  for (const tc of toolCalls) {
    items.push({
      time: tc.time,
      kind: "tool",
      tool: tc.name,
      args: tc.args,
      output: _tryParse(tc.output),
    });
  }
  for (const e of events) {
    // Bỏ qua tool_call trong events (đã có dòng "tool" chi tiết hơn) để tránh trùng
    if (e.stage === "tool_call") continue;
    items.push({ time: e.time, kind: "event", stage: e.stage, detail: e.detail });
  }

  items.sort((a, b) => new Date(a.time) - new Date(b.time));
  return items;
}

function _tryParse(s) {
  if (typeof s !== "string") return s;
  try { return JSON.parse(s); } catch { return s; }
}

/**
 * Tạo đường dẫn file:
 *   conversation_summary/yyyy/mm/dd/{tel}_{callId_short}.json
 */
function _buildFilePath(date, tel, callId) {
  const yyyy = date.getFullYear().toString();
  const mm   = String(date.getMonth() + 1).padStart(2, "0");
  const dd   = String(date.getDate()).padStart(2, "0");

  // Lấy phần cuối của callId làm unique suffix (vd: rtc_u0_AbCdEfGh → AbCdEfGh)
  const shortId = callId.split("_").pop() || callId.slice(-8);

  // Chuẩn hóa số điện thoại (bỏ ký tự đặc biệt)
  const safeTel = String(tel).replace(/[^0-9+]/g, "") || "unknown";

  const filename = `${safeTel}_${shortId}.json`;
  return path.join(SUMMARY_ROOT, yyyy, mm, dd, filename);
}

function _ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// ─── AI Summary Generator ─────────────────────────────────────────────────────

/**
 * Gọi OpenAI Chat API để tóm tắt nội dung cuộc gọi.
 * Dùng gpt-4o-mini để tiết kiệm chi phí (chỉ text, không cần realtime).
 *
 * @param {Array} transcript  - Mảng { speaker, text, time }
 * @param {Array} toolCalls   - Mảng { name, args, output }
 * @param {string} outcome    - Kết quả cuộc gọi
 * @returns {Promise<object>} - { ngonNgu, yeuCauChinh, ketQua, hanhDongTiepTheo, diemCaiThien }
 */
async function _generateSummary(transcript, toolCalls, outcome) {
  if (!transcript.length) {
    return { luu_y: "Cuộc gọi không có transcript (khách hàng cúp máy sớm hoặc im lặng)." };
  }

  // Chuẩn bị nội dung hội thoại để gửi cho AI
  const dialogText = transcript
    .map((t) => `[${t.speaker}] ${t.text}`)
    .join("\n");

  const toolSummary = toolCalls.length
    ? toolCalls.map((t) => `- ${t.name}(${JSON.stringify(t.args)})`).join("\n")
    : "Không có tool nào được gọi.";

  const prompt = `Bạn là trợ lý phân tích cuộc gọi tổng đài. Đọc đoạn hội thoại dưới đây và tóm tắt theo cấu trúc JSON yêu cầu.

=== HỘI THOẠI ===
${dialogText}

=== TOOL CALLS ===
${toolSummary}

=== KẾT QUẢ CUỘC GỌI ===
${outcome}

Hãy trả về JSON với các trường sau (viết bằng tiếng Việt):
{
  "yeu_cau_chinh": "Yêu cầu chính của khách hàng trong cuộc gọi này là gì?",
  "da_xu_ly": "Những gì đã được xử lý/cung cấp thông tin cho khách?",
  "chua_xu_ly": "Những vấn đề chưa giải quyết được (nếu có)?",
  "hanh_dong_tiep_theo": "Hành động tiếp theo cần làm (nếu có ticket, nếu cần follow-up...)?",
  "diem_noi_bat": "Điểm đáng chú ý trong cuộc gọi (thái độ KH, lỗi AI, thông tin bất thường...)?",
  "danh_gia_cuoc_goi": "Đánh giá ngắn: cuộc gọi được xử lý tốt / trung bình / kém và lý do"
}

Chỉ trả về JSON, không thêm text khác.`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        temperature: 0.3,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      log.warn(`[Logger] Summary API lỗi ${res.status}: ${err}`);
      return { loi: `Không thể tạo summary: ${res.status}` };
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    return content ? JSON.parse(content) : { loi: "Không có nội dung từ API" };

  } catch (err) {
    log.warn(`[Logger] Lỗi tạo AI summary: ${err.message}`);
    return { loi: err.message };
  }
}
