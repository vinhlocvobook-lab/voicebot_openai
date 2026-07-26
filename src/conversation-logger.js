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
import { calcRealtimeCost, calcChatCost, calcTranscribeCost } from "./pricing.js";
import { finalizeCallLog } from "./db.js";

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
    this.toolCalls  = []; // { time, seq, name, args, output, durationMs, apiCalls }

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

    // ── Token usage & cost ──────────────────────────────────────────────────
    // Tổng hợp usage từ tất cả response.done events trong cuộc gọi
    this._realtimeTotals = {
      input_tokens: 0,
      output_tokens: 0,
      text_input_tokens: 0,
      audio_input_tokens: 0,
      cached_text_input_tokens: 0,
      cached_audio_input_tokens: 0,
      text_output_tokens: 0,
      audio_output_tokens: 0,
      response_count: 0,        // số lần response.done nhận được
    };
    // Tổng hợp usage từ tất cả input_audio_transcription.completed events
    this._transcriptionTotals = {
      audio_input_tokens: 0,   // audio tokens từ tiếng khách nói
      text_output_tokens: 0,   // text tokens của transcript text
      transcription_count: 0,  // số lần khách nói
    };
    this._transcriptionModel = null;  // model transcription thực tế (từ acceptParams)
    this._summaryUsage = null;        // usage từ gpt-4o-mini summary call

    // ── [0.3 — 26/07/2026] Đo lường bước lấy mã danh bộ ─────────────────────
    // Mọi fix danh bộ từ 18/07 đến nay đều dựa trên MỘT cuộc gọi mẫu, không ai
    // biết tỉ lệ thành công thật là bao nhiêu và fix mới có làm hồi quy fix cũ
    // không. Các trường dưới đây là số nền để đối chiếu giữa các đợt sửa.
    this._danhBo = {
      resolvedBy:   null,  // transcript_11 | dtmf | arbiter | known_tel | history_tel | null
      value:        null,  // dãy đã chốt (nếu có)
      requestCount: 0,     // số lần YÊU CẦU khách đọc (= _danhBoSession.requestNo)
      startedAt:    null,  // ms — lần đầu bot xin mã danh bộ
      confirmedAt:  null,  // ms — lúc khách xác nhận xong
    };
  }

  // ── [0.3] Đo lường bước danh bộ ─────────────────────────────────────────────

  /** Đánh dấu mốc bắt đầu bước lấy danh bộ (chỉ ghi nhận lần đầu). */
  markDanhBoStarted() {
    if (this._danhBo.startedAt == null) this._danhBo.startedAt = Date.now();
  }

  /** Ghi số lượt đã yêu cầu khách đọc lại (lấy từ _danhBoSession.requestNo). */
  setDanhBoRequestCount(n) {
    this._danhBo.requestCount = Number(n) || 0;
  }

  /** Chốt: danh bộ đã được xác nhận, ghi lại nguồn nào giải được. */
  markDanhBoResolved(resolvedBy, value) {
    this._danhBo.resolvedBy  = resolvedBy || null;
    this._danhBo.value       = value || null;
    this._danhBo.confirmedAt = Date.now();
    this.addEvent("danh_bo_resolved", `${resolvedBy} → ${value}`);
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

  /**
   * Ghi nhận một tool call + kết quả (đầu vào / đầu ra của function tool).
   * @param {Array} [apiCalls] - trace request/response backend API phát sinh
   *                             trong tool call này (từ api-trace.js)
   */
  addToolCall(name, args, output, durationMs = null, apiCalls = []) {
    const entry = {
      time: _now(),
      seq:  this.toolCalls.length + 1, // thứ tự trong cuộc gọi — khớp voicebot_toolcall.seq
      name, args, output, durationMs,
      apiCalls: Array.isArray(apiCalls) ? apiCalls : [],
    };
    this.toolCalls.push(entry);
    this.addEvent("tool_call", `${name}(${_safeJson(args)})`);
    return entry;
  }

  // ── Token usage ─────────────────────────────────────────────────────────────

  /**
   * Tích lũy usage từ mỗi response.done event của Realtime API.
   * Gọi nhiều lần trong 1 cuộc gọi (mỗi lần AI trả lời là 1 response.done).
   *
   * @param {object} usage - event.response.usage từ response.done
   */
  addUsage(usage) {
    if (!usage) return;
    const d  = usage.input_token_details  ?? {};
    const od = usage.output_token_details ?? {};

    this._realtimeTotals.input_tokens              += usage.input_tokens  ?? 0;
    this._realtimeTotals.output_tokens             += usage.output_tokens ?? 0;
    this._realtimeTotals.text_input_tokens         += d.text_tokens            ?? 0;
    this._realtimeTotals.audio_input_tokens        += d.audio_tokens           ?? 0;
    this._realtimeTotals.cached_text_input_tokens  += d.cached_text_tokens     ?? 0;
    this._realtimeTotals.cached_audio_input_tokens += d.cached_audio_tokens    ?? 0;
    this._realtimeTotals.text_output_tokens        += od.text_tokens           ?? 0;
    this._realtimeTotals.audio_output_tokens       += od.audio_tokens          ?? 0;
    this._realtimeTotals.response_count            += 1;
  }

  /**
   * Tích lũy usage từ mỗi input_audio_transcription.completed event.
   * Gọi mỗi lần khách hàng nói xong 1 lượt.
   *
   * @param {object} usage        - event.usage từ input_audio_transcription.completed
   * @param {string} [modelName]  - model đang dùng (vd: "gpt-4o-mini-transcribe")
   */
  addTranscriptionUsage(usage, modelName = null) {
    if (!usage) return;
    if (modelName && !this._transcriptionModel) this._transcriptionModel = modelName;

    const d  = usage.input_token_details  ?? {};
    const od = usage.output_token_details ?? {};

    this._transcriptionTotals.audio_input_tokens  += d.audio_tokens  ?? usage.input_tokens  ?? 0;
    this._transcriptionTotals.text_output_tokens  += od.text_tokens  ?? usage.output_tokens ?? 0;
    this._transcriptionTotals.transcription_count += 1;
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
    // Tự detect transcription model từ accept params
    const txModel = params?.audio?.input?.transcription?.model;
    if (txModel && !this._transcriptionModel) this._transcriptionModel = txModel;
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
    const { summary: aiSummary, usage: summaryUsage } =
      await _generateSummary(this.transcript, this.toolCalls, this.outcome);
    this._summaryUsage = summaryUsage ?? null;

    // Timeline gộp (diễn tiến cuộc gọi theo thời gian): hội thoại + tool + sự kiện
    const timeline = _buildTimeline(this.transcript, this.toolCalls, this.events);

    // Hội thoại liên tục KH ↔ AI (kèm tool gọi/kết quả) – dễ đọc khi debug
    const conversation = _buildConversation(this.transcript, this.toolCalls);

    // ── Tính chi phí ──────────────────────────────────────────────────────────
    const realtimeModel      = this.model ?? process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-mini";
    const summaryModel       = "gpt-4o-mini";
    const transcriptionModel = this._transcriptionModel ?? process.env.OPENAI_TRANSCRIPTION_MODEL ?? "gpt-4o-mini-transcribe";

    // Tổng hợp usage dạng mà calcRealtimeCost mong đợi
    const realtimeUsageObj = {
      input_tokens:  this._realtimeTotals.input_tokens,
      output_tokens: this._realtimeTotals.output_tokens,
      input_token_details: {
        text_tokens:         this._realtimeTotals.text_input_tokens,
        audio_tokens:        this._realtimeTotals.audio_input_tokens,
        cached_text_tokens:  this._realtimeTotals.cached_text_input_tokens,
        cached_audio_tokens: this._realtimeTotals.cached_audio_input_tokens,
      },
      output_token_details: {
        text_tokens:  this._realtimeTotals.text_output_tokens,
        audio_tokens: this._realtimeTotals.audio_output_tokens,
      },
    };

    // Tổng hợp transcription usage
    const transcriptionUsageObj = {
      input_token_details:  { audio_tokens: this._transcriptionTotals.audio_input_tokens },
      output_token_details: { text_tokens:  this._transcriptionTotals.text_output_tokens },
    };

    const realtimeCostInfo      = calcRealtimeCost(realtimeUsageObj, realtimeModel);
    const transcriptionCostInfo = this._transcriptionTotals.transcription_count > 0
      ? calcTranscribeCost(transcriptionUsageObj, transcriptionModel)
      : null;
    const summaryCostInfo       = this._summaryUsage ? calcChatCost(this._summaryUsage, summaryModel) : null;

    const totalCostUsd = +(
      (realtimeCostInfo?.cost_usd      ?? 0) +
      (transcriptionCostInfo?.cost_usd ?? 0) +
      (summaryCostInfo?.cost_usd       ?? 0)
    ).toFixed(6);

    const document = {
      // ── 1. Thông tin định danh cuộc gọi ───────────────────────────────────
      meta: {
        callId:      this.callId,
        tel:         this.tel,
        startTime:   _toGmt7(this.startTime),
        endTime:     _toGmt7(this.endTime),
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
        // [debug 08/07/2026] Chỉ số chẩn đoán VAD/lặp lời — đếm từ events.
        // Cuộc gọi "khỏe": vadTurnCount ≈ customerTurns, emptyTranscriptCount ≈ 0.
        // Lệch lớn = VAD bắt nhầm noise/echo (phantom turn) → xem lại threshold.
        vadTurnCount:           this.events.filter((e) => e.stage === "vad_speech_started").length,
        emptyTranscriptCount:   this.events.filter((e) => e.stage === "empty_transcript").length,
        cancelledResponseCount: this.events.filter((e) => /^response_(cancelled|failed|incomplete)$/.test(e.stage)).length,
        promptEchoCount:        this.events.filter((e) => e.stage === "transcript_prompt_echo").length,

        // [0.3 — 26/07/2026] Chỉ số bước lấy mã danh bộ. Dùng để so sánh giữa
        // các đợt sửa: danh_bo_resolved_by = null nghĩa là cuộc gọi KẾT THÚC mà
        // chưa lấy được mã (chính là ca hỏng cần đếm).
        danh_bo_resolved_by:   this._danhBo.resolvedBy,
        danh_bo_value:         this._danhBo.value,
        danh_bo_request_count: this._danhBo.requestCount,
        danh_bo_seconds:       (this._danhBo.startedAt && this._danhBo.confirmedAt)
          ? Math.round((this._danhBo.confirmedAt - this._danhBo.startedAt) / 1000)
          : null,
        // Số lần model bịa số: ở tham số tool (§4.1) + số bot đọc ra loa (§4.4).
        hallucination_count:
          this.events.filter((e) => e.stage === "danh_bo_arg_hallucinated").length +
          this.events.filter((e) => e.stage === "bot_hallucinated_digits").length,
      },

      // ── 3. Token usage & chi phí cuộc gọi ─────────────────────────────────
      token_usage: {
        realtime: {
          model:           realtimeModel,
          response_count:  this._realtimeTotals.response_count,
          input_tokens:    this._realtimeTotals.input_tokens,
          output_tokens:   this._realtimeTotals.output_tokens,
          input_details: {
            text_tokens:         this._realtimeTotals.text_input_tokens,
            audio_tokens:        this._realtimeTotals.audio_input_tokens,
            cached_text_tokens:  this._realtimeTotals.cached_text_input_tokens,
            cached_audio_tokens: this._realtimeTotals.cached_audio_input_tokens,
          },
          output_details: {
            text_tokens:  this._realtimeTotals.text_output_tokens,
            audio_tokens: this._realtimeTotals.audio_output_tokens,
          },
        },
        transcription: this._transcriptionTotals.transcription_count > 0 ? {
          model:               transcriptionModel,
          transcription_count: this._transcriptionTotals.transcription_count,
          audio_input_tokens:  this._transcriptionTotals.audio_input_tokens,
          text_output_tokens:  this._transcriptionTotals.text_output_tokens,
        } : null,
        summary: this._summaryUsage ? {
          model:             summaryModel,
          prompt_tokens:     this._summaryUsage.prompt_tokens     ?? 0,
          completion_tokens: this._summaryUsage.completion_tokens ?? 0,
          total_tokens:      this._summaryUsage.total_tokens      ?? 0,
        } : null,
      },

      cost_usd: {
        total:         totalCostUsd,
        realtime:      realtimeCostInfo      ? { cost: realtimeCostInfo.cost_usd,      breakdown: realtimeCostInfo.breakdown      } : null,
        transcription: transcriptionCostInfo ? { cost: transcriptionCostInfo.cost_usd, breakdown: transcriptionCostInfo.breakdown } : null,
        summary:       summaryCostInfo       ? { cost: summaryCostInfo.cost_usd,       breakdown: summaryCostInfo.breakdown       } : null,
        note:          `Models: ${realtimeModel} (realtime) + ${transcriptionModel} (transcription) + ${summaryModel} (summary)`,
      },

      // ── 4. Tóm tắt do AI tạo ra (đánh giá chất lượng cuộc gọi) ──────────────
      summary: aiSummary,

      // ── 5. Hội thoại liên tục KH ↔ AI (đọc nhanh diễn biến) ────────────────
      conversation,

      // ── 6. Diễn tiến cuộc gọi theo thời gian (debug tổng quan) ──────────────
      timeline,

      // ── 7. Hội thoại đầy đủ KH ↔ AI ────────────────────────────────────────
      transcript: this.transcript,

      // ── 8. Đầu vào / đầu ra của các function tool ──────────────────────────
      toolCalls: this.toolCalls,

      // ── 9. Lỗi phát sinh trong cuộc gọi ────────────────────────────────────
      errors: this.errors,

      // ── 10. Sự kiện kỹ thuật chi tiết ──────────────────────────────────────
      events: this.events,

      // ── 11. Params kỹ thuật để phân tích/điều chỉnh prompt ─────────────────
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

    // Pha 2 — upsert đầy đủ vào DB (single writer = bot). File JSON vẫn là nguồn đầy đủ.
    // Lỗi DB không làm hỏng việc lưu file (hàm tự nuốt lỗi).
    await finalizeCallLog(document, filePath);

    return filePath;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Múi giờ Việt Nam (GMT+7)
const TZ_OFFSET_MS = 7 * 60 * 60 * 1000;

/** Định dạng thời gian theo GMT+7, dạng ISO có offset (vẫn parse/sort được). */
function _toGmt7(date) {
  const d = date instanceof Date ? date : new Date(date);
  return new Date(d.getTime() + TZ_OFFSET_MS).toISOString().replace("Z", "+07:00");
}

function _now() {
  return _toGmt7(new Date());
}

/** Lấy HH:mm:ss từ chuỗi thời gian GMT+7 (để hiển thị trong hội thoại). */
function _hms(t) {
  return typeof t === "string" && t.length >= 19 ? t.slice(11, 19) : "";
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
 * Tạo hội thoại liên tục KH ↔ AI dạng dòng dễ đọc, gồm cả lượt gọi tool & kết quả.
 * Ví dụ:
 *   [10:08:05] 🧑 Khách: Cho tôi hỏi tiền nước tháng này
 *   [10:08:06] 🤖 AI: Quý khách cho em xin mã danh bộ ạ
 *   [10:08:55] 🔧 AI gọi tool: get_bill({"ma_danh_bo":"15122890724"})
 *   [10:08:55] 🌐 API: GET .../tien-nuoc?danhba=15122890724 → 200 (412ms)
 *   [10:08:56] 📋 Kết quả tool get_bill: {"success":true,...}
 *   [10:08:57] 🤖 AI: Số tiền của Quý khách là ...
 */
function _buildConversation(transcript, toolCalls) {
  const items = [];

  for (const t of transcript) {
    const icon = t.speaker === "AI" ? "🤖 AI" : "🧑 Khách";
    items.push({ time: t.time, order: 1, line: `[${_hms(t.time)}] ${icon}: ${t.text}` });
  }

  for (const tc of toolCalls) {
    const argsStr = _safeJson(tc.args ?? {});
    items.push({
      time: tc.time, order: 2,
      line: `[${_hms(tc.time)}] 🔧 AI gọi tool: ${tc.name}(${argsStr})`,
    });
    // Request backend API phát sinh trong tool call (nếu có)
    for (const ac of tc.apiCalls ?? []) {
      const status = ac.error_code ?? ac.http_status ?? "?";
      items.push({
        time: tc.time, order: 3,
        line: `[${_hms(ac.time || tc.time)}] 🌐 API: ${ac.method} ${ac.url} → ${status} (${ac.duration_ms}ms)`,
      });
    }
    const out = typeof tc.output === "string" ? tc.output : _safeJson(tc.output);
    items.push({
      time: tc.time, order: 4,
      line: `[${_hms(tc.time)}] 📋 Kết quả tool ${tc.name}: ${out}`,
    });
  }

  items.sort((a, b) => {
    const d = new Date(a.time) - new Date(b.time);
    return d !== 0 ? d : a.order - b.order;
  });

  return items.map((i) => i.line);
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
    return { summary: { luu_y: "Cuộc gọi không có transcript (khách hàng cúp máy sớm hoặc im lặng)." }, usage: null };
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
      return { summary: { loi: `Không thể tạo summary: ${res.status}` }, usage: null };
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    const summary = content ? JSON.parse(content) : { loi: "Không có nội dung từ API" };
    return { summary, usage: data.usage ?? null };

  } catch (err) {
    log.warn(`[Logger] Lỗi tạo AI summary: ${err.message}`);
    return { summary: { loi: err.message }, usage: null };
  }
}
