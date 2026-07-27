/**
 * session-ws.js
 * Mở WebSocket đến OpenAI Realtime API để monitor + điều khiển một cuộc gọi.
 *
 * Sau khi accept call, OpenAI xử lý audio SIP trực tiếp.
 * Node.js chỉ cần lắng nghe events và xử lý function calls.
 *
 * Tài liệu: https://developers.openai.com/api/docs/guides/realtime-sip
 */

import WebSocket from "ws";
import {
  dispatchTool,
  danhBoSpoken,
  noteDanhBoRejected,
  // [1.1/1.4/1.5 — 26/07/2026] Hai biến tích luỹ + luồng xác minh chạy nền.
  noteDanhBoTranscript,
  danhBoSessionDigits,
  ensureDanhBoSession,
  verifyDanhBoFromSession,
  danhBoDtmfInvitePrompt,
} from "./tools.js";
import { runWithApiTrace } from "./api-trace.js";
import { log } from "./logger.js";
import { ConversationLogger } from "./conversation-logger.js";
import { insertCallStub, insertTicket } from "./db.js";
// import { TOOLS } from "./system-prompt.js";

const OPENAI_WS_URL = "wss://api.openai.com/v1/realtime";

// ─── [0.1 — 26/07/2026] Registry phiên đang mở, phục vụ graceful shutdown ─────
// Cuộc gọi rtc_u2_E5eDfB96UnJE6iDWfPbRX (26/07 04:29–04:32) KHÔNG có file
// conversation_summary: tiến trình node thoát ngay sau khi WS đóng, `_saveOnce`
// (async) chưa kịp ghi xong. Cuộc gọi lỗi nặng nhất lại là cuộc không có log để
// phân tích. Registry này cho server.js flush toàn bộ trước khi thoát.
const _activeSessions = new Set(); // { callId, flush(reason) }

/** Số phiên đang mở (để log lúc tắt server). */
export function activeSessionCount() {
  return _activeSessions.size;
}

/**
 * Flush log của MỌI phiên đang mở. Không bao giờ throw — tắt server không được
 * phụ thuộc vào việc ghi file thành công.
 * @param {number} timeoutMs Hết hạn thì bỏ cuộc, trả về để tiến trình thoát.
 */
export async function flushAllSessions(timeoutMs = 5000) {
  const entries = [..._activeSessions];
  if (entries.length === 0) return 0;
  const all = Promise.allSettled(
    entries.map((e) => Promise.resolve().then(() => e.flush("process_exit")))
  );
  await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs))]);
  return entries.length;
}

/**
 * Mở WebSocket session cho một call_id.
 * @param {string} callId
 * @param {object} callOps - { hangup(callId), refer(callId, targetUri) }
 * @returns {WebSocket}
 */
export function openSessionWebSocket(callId, callOps) {
  // Theo docs SIP: chỉ cần Authorization header, KHÔNG dùng OpenAI-Beta
  // https://developers.openai.com/api/docs/guides/realtime-sip#monitor-call-events
  const url = `${OPENAI_WS_URL}?call_id=${callId}`;
  log.info(`[WS][${callId}] Kết nối WebSocket: ${url}`);

  // ── Khởi tạo logger cho cuộc gọi này ────────────────────────────────────────
  const logger = new ConversationLogger(callId, callOps.tel);
  if (callOps.acceptParams) logger.setAcceptParams(callOps.acceptParams);
  if (callOps.asteriskData) logger.setAsteriskData(callOps.asteriskData);
  logger.addEvent("ws_connecting", url);

  // Pha 1 — ghi dòng "mầm" vào DB ngay khi mở cuộc gọi (fire-and-forget, idempotent).
  // Lỗi DB không làm sập cuộc gọi (hàm tự nuốt lỗi).
  insertCallStub({
    callId,
    customerTel: callOps.asteriskData?.phoneNumber ?? callOps.tel,
    uniqueid: callOps.asteriskData?.uniqueid,
    recordPath: callOps.asteriskData?.recordPath,
    voiceModel: logger.model,
  });

  // Guard riêng cho từng hành động để tránh thực thi trùng (không chặn chéo nhau)
  let _hungUp = false;      // đã lên lịch cúp máy chưa
  let _transferred = false; // đã chuyển máy chưa

  // [14/07/2026] Theo dõi response đang chạy — để hủy response do NHIỄU kích
  // hoạt (prompt echo): cuộc E1NSYW1IIC4xom9HGSneG model tự nói "Dạ, em nghe
  // rõ rồi ạ..." khi khách im lặng vì VAD bắt nhiễu tạo response.
  let _responseActive = false;

  // [fix 18/07/2026] Cancel echo phải ĐÚNG response — cuộc E2ou4DurIiPbGRvrrggKr:
  // khách hỏi thủ tục (lượt THẬT), 7s sau transcript echo của lượt NHIỄU trước đó
  // mới về → code cancel nhầm response đang trả lời câu hỏi thật → bot "câm" 28s,
  // khách phải "A lô" mới được trả lời. Fix: gắn mỗi response với item audio đã
  // kích hoạt nó (qua input_audio_buffer.committed → response.created), chỉ cancel
  // khi item_id của transcript echo TRÙNG item đã kích hoạt response đang chạy.
  let _lastCommittedItemId = null;        // item audio vừa được VAD commit
  let _activeResponseTriggerItemId = null; // item đã kích hoạt response đang chạy (null = do code tạo)
  let _pendingCodeResponse = false;        // response.create sắp tới là do code gửi (greeting/tool result)

  // [fix 18/07/2026 v2] Cuộc E2tkwslo38l9Flut5ptF4: khớp item CHƯA ĐỦ.
  // Semantic VAD (interrupt_response: true) — nhiễu sau câu hỏi thật làm OpenAI
  // tự ngắt response cũ và tạo response MỚI gắn với item NHIỄU, nhưng model dùng
  // response đó để trả lời câu hỏi thật (context còn câu hỏi chưa đáp). Item
  // khớp → cancel → giết nhầm câu trả lời, bot câm 24s.
  // → Thêm guard: đang có lượt khách THẬT chưa được trả lời xong thì KHÔNG cancel,
  // bất kể item nào kích hoạt response.
  let _unansweredRealTurn = false; // true = có lượt khách thật chưa có response hoàn tất

  // [fix 18/07/2026] State theo CUỘC GỌI cho các tool handler (tools.js) — vd
  // guard "đã hỏi đối tượng chưa" của get_procedure_info (chống model tự đoán
  // doi_tuong ngay lượt đầu, cuộc E2u70cuT94h0rwpLAKOyA).
  // knownDanhBo: danh bộ hệ thống tra được theo SĐT — resolveDanhBo tin ngay,
  // không ép vòng xác nhận confirm_danh_bo (fix cuộc E2uhVdS9X4mVBoXs0uYMP).
  // _logger: cho tools.js ghi event (vd kết quả trọng tài danh bộ) vào timeline.
  const _toolCallState = { knownDanhBo: callOps.knownDanhBo || [], _logger: logger };

  // [fix 19/07/2026] Nhận diện lượt khách nói có vẻ đang đọc CHỮ SỐ (buffer cho
  // trọng tài danh bộ trong tools.js). Chỉ là bộ lọc thô — việc bóc chữ số thật
  // do model trọng tài làm. NGOẠI LỆ có chủ đích của quy ước "transcript chỉ để
  // debug": transcript chỉ dùng làm dữ liệu fallback, kết quả luôn phải qua
  // xác thực API + khách xác nhận lại từng số.
  // [fix 19/07/2026 v2] Cuộc E3IwDpl3qXKJ2hoRtHHRU: regex cũ chỉ khớp số đọc
  // TÁCH TỪNG CHỮ ("hai hai không..."), bỏ sót transcript ASR phiên âm thành
  // CHUỖI SỐ LIỀN ("232474431") — mỗi ký tự số phải theo sau bởi khoảng trắng/
  // cuối chuỗi mới tính, nên "232474431" chỉ khớp đúng 1 (chữ số cuối cùng),
  // dưới ngưỡng 3 → bị loại khỏi buffer, trọng tài mất mất 1 quan sát tốt.
  // Thêm nhánh đếm SỐ KÝ TỰ CHỮ SỐ trong chuỗi (không cần khoảng trắng ngăn).
  const _DIGIT_WORD_RE = /(?:không|một|mốt|hai|ba|bốn|tư|năm|lăm|sáu|bảy|tám|chín|mươi|mười)(?=\s|$|[,.!?])/gi;
  const _looksLikeDigitTurn = (t) => {
    const s = String(t);
    const digitChars = (s.match(/\d/g) || []).length; // vd "232474431" → 9
    if (digitChars >= 3) return true;
    return (s.match(_DIGIT_WORD_RE) || []).length >= 3; // vd "hai hai không..."
  };

  // [fix 19/07/2026] Cuộc E3JJPyzYujYdwQG048Bf7: sau khi TRỌNG TÀI đưa ra ứng
  // viên danh bộ, model bỏ qua hẳn việc đọc lại xác nhận, tự nói câu khác rồi
  // GỌI THẲNG tool tra cứu — không có lượt khách nào xác nhận ở giữa. Nếu
  // trọng tài đoán SAI (dù qua được xác thực API vì trùng số của khách khác),
  // hệ thống sẽ đọc thông tin người khác cho người gọi nghe. Vì model không
  // đáng tin ở bước này, danh bộ do trọng tài đưa ra (callState._danhBoNeedsVerbalYes)
  // CHỈ được coi là đã xác nhận khi có MỘT LƯỢT KHÁCH THẬT chứa từ khẳng định —
  // resolveDanhBo (tools.js) chặn tra cứu tới khi cờ này được gỡ ở đây.
  const _KHANG_DINH_RE = /(đúng|chính xác|chuẩn|phải rồi|vâng|dạ đúng|\bừ\b|\bừm\b|\bờ\b|\bok\b|\boke\b|\bđược\b|yes)/i;
  const _PHU_DINH_RE = /(không đúng|chưa đúng|sai rồi|\bsai\b|chưa phải|không phải)/i;
  // [fix 27/07/2026] Khách xin nghe LẠI câu bot vừa nói (không phải đổi chủ đề).
  const _XIN_NHAC_LAI_RE = /((đọc|nói|nhắc)\s+lại|chưa nghe rõ|nghe không rõ|không nghe rõ|nói gì)/i;
  const _isAffirmative = (t) => {
    const s = String(t);
    if (_PHU_DINH_RE.test(s)) return false;
    return _KHANG_DINH_RE.test(s);
  };

  // [fix 18/07/2026 v5] Cuộc E2yXyLXpaZz66DmCfxQBi: hủy response do prompt echo
  // để lại câu nói DỞ của bot trong context ("...đọc giúp em nguyên văn: Hai
  // hai") → model tưởng "Hai hai" là số khách vừa đọc, rồi tự bịa hội thoại 4
  // lượt liền, KHÔNG gọi confirm_danh_bo nữa, khách cúp máy.
  // → Sau khi hủy, nếu đang giữa luồng lấy mã danh bộ theo nhóm thì code tự
  // đọc lại ĐÚNG câu của bước hiện tại, kéo cuộc gọi về đúng nhịp state machine.
  const _reAssertDanhBoStep = (lyDo) => {
    const _prompt = _toolCallState._danhBoLastPrompt;
    if (!_prompt) return;
    if (_hungUp || _transferred) return;
    setTimeout(() => {
      if (_hungUp || _transferred || _responseActive) return;
      if (!_toolCallState._danhBoLastPrompt) return; // đã chốt danh bộ trong lúc chờ
      try {
        _pendingCodeResponse = true;
        let instructions = "Đọc CHÍNH XÁC từng từ đoạn sau cho khách, không thêm bớt, không diễn giải lại, " +
          "KHÔNG nhắc lại bất kỳ chữ số nào ngoài đoạn này: \"" + _prompt + "\"";
        console.log("[_reAssertDanhBoStep]: lydo=", lyDo);
        console.log("[_reAssertDanhBoStep]: instructions=", instructions);
        ws.send(JSON.stringify({
          type: "response.create",
          response: {
            instructions: instructions,
          },
        }));
        logger.addEvent("danh_bo_step_reasserted", `${lyDo} — đọc lại bước đang chờ`);
        console.log(`[${callId}]:`, "danh_bo_step_reasserted", lyDo);
      } catch (e) {
        log.warn(`[WS][${callId}] không gửi được response.create kéo lại bước danh bộ: `, e.message);
      }
    }, 900); // chờ cancel hoàn tất (response.done về) rồi mới tạo response mới
  };

  // [fix 19/07/2026 v2] Ép bot đọc NGUYÊN VĂN một câu do code tạo (dùng cho
  // xác nhận danh bộ bấm phím DTMF). Khách bấm phím trong lúc bot còn đang nói
  // (response active) → gửi response.create ngay sẽ lỗi
  // conversation_already_has_active_response → retry chờ response.done.
  // ── Helper chữ số dùng chung (kiểm chứng câu bot đọc + phát hiện số lạ) ───
  const _VI_DIGIT_W = {
    khong: "0", linh: "0", le: "0", mot: "1", hai: "2", ba: "3", bon: "4", tu: "4",
    nam: "5", lam: "5", sau: "6", bay: "7", tam: "8", chin: "9",
  };
  const _deAccent = (s) => String(s ?? "").normalize("NFD")
    .replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();

  /** Bóc các cụm chữ số (dạng số hoặc dạng chữ) dài ≥ 4 trong lời bot. */
  const _extractDigitRuns = (text) => {
    const runs = [];
    for (const m of String(text).matchAll(/\d[\d\s.\-]*\d/g)) {
      const d = m[0].replace(/\D/g, "");
      if (d.length >= 4) runs.push(d);
    }
    // Dạng đọc thành chữ: "Hai - Hai - Không - ..." (danhBoSpoken)
    let cur = "";
    for (const tok of _deAccent(text).split(/[^a-z]+/)) {
      if (tok && tok in _VI_DIGIT_W) cur += _VI_DIGIT_W[tok];
      else { if (cur.length >= 4) runs.push(cur); cur = ""; }
    }
    if (cur.length >= 4) runs.push(cur);
    return runs;
  };

  const _normTxt = (x) => String(x ?? "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

  // [fix 26/07/2026 đợt 4] KIỂM CHỨNG bot có THẬT SỰ đọc câu code yêu cầu không.
  // Cuộc rtc_u2_E5i8v8eJhYoeHOlPEIgiW: hệ thống chốt đúng mã chỉ trong 5 giây
  // (trọng tài 0.88 + API OK), code gửi câu "…Hai-Hai-Không-Hai-Ba-Hai-Năm-Một-
  // Bảy-Bảy-Năm. Đúng không ạ?" — nhưng bot lại LẶP LẠI câu cũ "Dạ, em ghi nhận
  // rồi ạ, chờ em một chút." Khách không bao giờ nghe được câu xác nhận, bối rối
  // rồi cúp máy. Nguyên nhân: `function_call_output` còn nằm trong hội thoại kèm
  // chỉ dẫn 'Đọc NGUYÊN VĂN "doc_cho_khach"', model mini bám vào đó thay vì
  // `instructions` của response mới.
  // Không thể tin model tuân thủ → CODE tự kiểm và gửi lại.
  let _expectedSpeak = null; // { text, core, tag, at, retries }

  /** Dấu hiệu nhận dạng một câu: ưu tiên dãy chữ số, không có thì lấy phần đầu. */
  const _speakCore = (text) => {
    const runs = _extractDigitRuns(text);
    if (runs.length) return runs.join("|");
    return _normTxt(text).slice(0, 24);
  };
  const _spokenMatchesCore = (spoken, core) => {
    if (/^[\d|]+$/.test(core)) {
      const runs = _extractDigitRuns(spoken).join("|");
      return runs.length > 0 && (runs.includes(core) || core.includes(runs));
    }
    return _normTxt(spoken).includes(core);
  };

  const _speakVerbatim = (text, tag, attempt = 0, opts = {}) => {
    if (_hungUp || _transferred) return;
    if (ws.readyState !== WebSocket.OPEN) return; // cuộc gọi đã kết thúc
    if (_responseActive) {
      if (attempt < 8) setTimeout(() => _speakVerbatim(text, tag, attempt + 1, opts), 1200);
      else logger.addEvent("speak_verbatim_dropped", `${tag} — response active quá lâu`);
      return;
    }
    try {
      _pendingCodeResponse = true;
      // "BỎ QUA mọi hướng dẫn trước đó" để câu này thắng chỉ dẫn tồn dư của tool output.
      // [fix 27/07/2026 đợt 7] Câu KHÔNG chứa chữ số → cấm hẳn model đọc số trong
      // response này. Cuộc rtc_u1_E66uZSbb8P6ZJF6VVLKr6: response tạo ra để đọc câu
      // chờ ("Dạ, em ghi nhận rồi ạ") lại bị model dùng để đọc "220223251" ra loa.
      const _cauCoSo = /^[\d|]+$/.test(_speakCore(text));
      const instructions =
        "BỎ QUA mọi hướng dẫn đọc trước đó trong hội thoại. NGAY BÂY GIỜ chỉ đọc CHÍNH XÁC " +
        "từng từ đoạn sau cho khách, không thêm bớt, không diễn giải lại, rồi DỪNG: \"" + text + "\"" +
        (_cauCoSo ? "" : " TUYỆT ĐỐI không đọc thêm bất kỳ chữ số nào ngoài đoạn trên.");
      log.debug(`[WS][${callId}] _speakVerbatim(${tag}, lần ${attempt}): ${text}`);
      ws.send(JSON.stringify({
        type: "response.create",
        // [fix 27/07/2026] `tool_choice: "none"`: đây là câu code ép đọc nguyên
        // văn, model TUYỆT ĐỐI không được nhân dịp này gọi tool (cuộc
        // rtc_u2_E66X1bhQIrBrwtqeHkOau: response đọc câu chờ lại sinh ra 2 lần
        // gọi get_bill với số bịa → vỡ cả cuộc gọi).
        response: { instructions, tool_choice: "none" },
      }));
      logger.addEvent("response_create_sent", tag);
      // Câu quan trọng → theo dõi xem bot có đọc đúng không (xử lý ở conversation.item.done).
      if (opts.verify) {
        _expectedSpeak = {
          text, tag, core: _speakCore(text), at: Date.now(),
          retries: _expectedSpeak?.tag === tag ? (_expectedSpeak.retries || 0) : 0,
        };
      }
    } catch (e) {
      log.warn(`[WS][${callId}] không gửi được response.create (${tag}): `, e.message);
    }
  };

  // ── [1.4 — 26/07/2026] ĐƯỜNG NỀN thu mã danh bộ (MỨC B) ───────────────────
  // Đường này bị TẮT ngày 25/07 ("trọng tài chạy on-demand trong resolveDanhBo")
  // và đó là lỗi chí mạng của cuộc rtc_u2_E5eDfB96UnJE6iDWfPbRX: toàn bộ xử lý
  // danh bộ chỉ còn chạy khi MODEL chịu gọi tool. Lúc 04:32:06 khách đọc đúng
  // trọn vẹn "22023251775" nhưng không có tool nào đang chạy → transcript vàng
  // rơi vào hư không, bot vẫn lải nhải số rác, khách cúp máy.
  //
  // Giờ CODE làm chủ: khách ngưng đọc một nhịp → tự xác minh (API + gpt-5.1
  // song song) → tự đọc lại xác nhận. Không phụ thuộc model.
  // [fix 26/07/2026 đợt 3] HAI MỨC CHỜ. Cuộc rtc_u2_E5hhmAHqS8cDGvUnCph0x: khách
  // đọc theo nhịp tự nhiên 3 hơi "2202" → "3251" → "7755" (= 22023251775), nhưng
  // debounce một mức làm verify nổ khi mới có 4/11 số → trọng tài đương nhiên bó
  // tay → code reset phiên GIỮA LÚC khách đang đọc dở → mảnh cuối rơi sang phiên
  // mới, không mảnh nào ghép được với mảnh nào.
  //   - ĐỦ 11 số  → chờ ngắn, xác minh ngay (khách đã đọc xong, đừng bắt đợi).
  //   - CHƯA đủ   → chờ LÂU (khách nhiều khả năng còn đang đọc tiếp), hết giờ thì
  //                 chỉ NHẮC ĐỌC TIẾP, tuyệt đối không reset phiên.
  const _DANHBO_DEBOUNCE_DU_MS = Number(process.env.DANH_BO_DEBOUNCE_DU_MS || 1500);
  const _DANHBO_DEBOUNCE_THIEU_MS = Number(process.env.DANH_BO_DEBOUNCE_THIEU_MS || 9000);

  const _maybeVerifyDanhBo = () => {
    clearTimeout(_toolCallState._danhBoVerifyTimer);
    const _du = danhBoSessionDigits(_toolCallState) >= 11;

    _toolCallState._danhBoVerifyTimer = setTimeout(async () => {
      if (_hungUp || _transferred) return;
      // Guard: đã có ứng viên đang chờ / đã chốt (model, DTMF, lượt trước) → không chen.
      if (_toolCallState.danhBo) return;
      // Đang chạy → ghi nhận để chạy LẠI ngay sau khi xong. Trước đây return thẳng
      // nên lượt transcript đến giữa chừng bị bỏ rơi hoàn toàn.
      if (_toolCallState._danhBoVerifyRunning) {
        _toolCallState._danhBoVerifyPending = true;
        return;
      }

      const soDaCo = danhBoSessionDigits(_toolCallState);

      // Khách đã ngưng đọc (hết hạn chờ). Dù thiếu số vẫn cho trọng tài thử ghép —
      // nó có BIẾN 1 chứa mọi lần đọc trước để đối chiếu. Không ra thì mời khách
      // đọc lại TRỌN VẸN mã (không bao giờ hỏi "đọc tiếp từ số nào" — khách không
      // biết hệ thống nghe tới đâu, mà chỗ nối chính là chỗ ASR hay sai nhất).
      _toolCallState._danhBoVerifyRunning = true;
      _toolCallState._danhBoVerifyLastAt = Date.now();
      try {
        // Đủ số rồi mới lấp khoảng lặng — khách vừa đọc xong 11 số mà im lặng
        // chờ gpt-5.1 thì rất khó chịu. Chưa đủ số thì im, để khách đọc tiếp.
        if (soDaCo >= 11 && !_responseActive) {
          _speakVerbatim("Dạ, em ghi nhận rồi ạ, Quý Khách chờ em một chút.", "danh_bo_verify_filler");
        }
        const r = await verifyDanhBoFromSession(_toolCallState, { chapNhanThieuSo: true });
        if (_hungUp || _transferred) return;
        if (r.action === "none" || !r.prompt) return;
        _toolCallState._danhBoLastPrompt = r.prompt;
        logger.addEvent(`danh_bo_${r.action}`, r.value ? `${r.by}: ${r.value}` : r.prompt);
        log.info(`[WS][${callId}] danh_bo_${r.action}${r.value ? ` → ${r.value} (${r.by})` : ""}`);
        _speakVerbatim(r.prompt, `danh_bo_${r.action}`, 0, { verify: true });
      } catch (e) {
        log.warn(`[WS][${callId}] verifyDanhBoFromSession lỗi: `, e.message);
      } finally {
        _toolCallState._danhBoVerifyRunning = false;
        // Có transcript mới đến trong lúc đang chạy → xử lý ngay, đừng bỏ rơi.
        if (_toolCallState._danhBoVerifyPending) {
          _toolCallState._danhBoVerifyPending = false;
          _maybeVerifyDanhBo();
        }
      }
    }, _du ? _DANHBO_DEBOUNCE_DU_MS : _DANHBO_DEBOUNCE_THIEU_MS);
  };

  // ── [2.4 — 26/07/2026] Phát hiện bot ĐỌC SỐ LẠ ra loa ─────────────────────
  // classifyModelArg (tools.js) chặn số bịa ở THAM SỐ TOOL, nhưng không ngăn bot
  // đọc số bịa ra loa — thứ trực tiếp làm khách hoang mang trong cuộc gọi mẫu
  // ("Quý Khách vừa cho em số danh bộ 725625 đúng rồi phải không ạ?" khi khách
  // chưa hề đọc số nào). Mức B đã xử lý phần lớn nguyên nhân (model không còn bị
  // bỏ đói 21 giây); lớp này là lưới an toàn + số liệu đo lường.
  /**
   * [MỨC C — đợt 5] Nhờ model tự trả lời một lượt (KHÔNG ép đọc nguyên văn).
   *
   * Bắt buộc phải có: ở chế độ `digits`, `create_response: false` nên model sẽ
   * KHÔNG tự đáp bất cứ điều gì. Mỗi khi khách nói một câu mà model cần trả lời
   * (hỏi chuyện khác, xác nhận xong...) thì CODE phải chủ động tạo response,
   * nếu không bot sẽ im lặng — lỗi nặng hơn cả việc trả lời sai.
   */
  const _requestModelReply = (lyDo, instructions = null, attempt = 0) => {
    if (_hungUp || _transferred) return;
    if (ws.readyState !== WebSocket.OPEN) return;
    if (_responseActive) {
      // Đang nói dở → chờ xong rồi tạo, đừng để câu của khách rơi vào im lặng.
      if (attempt < 5) setTimeout(() => _requestModelReply(lyDo, instructions, attempt + 1), 1200);
      else logger.addEvent("model_reply_dropped", `${lyDo} — response active quá lâu`);
      return;
    }
    try {
      _pendingCodeResponse = true;
      ws.send(JSON.stringify({
        type: "response.create",
        response: instructions ? { instructions } : {},
      }));
      logger.addEvent("response_create_sent", `model_reply: ${lyDo}`);
      log.info(`[WS][${callId}] Nhờ model trả lời — ${lyDo}`);
    } catch (e) {
      log.warn(`[WS][${callId}] không gửi được response.create (model_reply ${lyDo}): `, e.message);
    }
  };

  /**
   * [đợt 4] Đối chiếu lời bot vừa nói với câu code đã yêu cầu đọc. Lệch → gửi lại
   * (tối đa 2 lần). Đây là lớp bảo đảm KHÔNG phụ thuộc việc model tuân thủ prompt.
   */
  const _checkExpectedSpeak = (spoken) => {
    const exp = _expectedSpeak;
    if (!exp) return;
    // Quá hạn (câu đã trôi qua vài lượt) → thôi theo dõi.
    if (Date.now() - exp.at > 20000) { _expectedSpeak = null; return; }

    if (_spokenMatchesCore(spoken, exp.core)) {
      _expectedSpeak = null; // bot đã đọc đúng
      return;
    }
    if (exp.retries >= 2) {
      logger.addEvent("speak_verbatim_mismatch_giveup", `${exp.tag} — bot nói khác 3 lần`);
      log.error(`[WS][${callId}] Bot KHÔNG đọc được câu "${exp.tag}" sau 3 lần — bỏ cuộc.`);
      _expectedSpeak = null;
      return;
    }
    exp.retries += 1;
    logger.addEvent("speak_verbatim_mismatch", `${exp.tag} — bot nói "${spoken.slice(0, 60)}", gửi lại lần ${exp.retries}`);
    log.warn(`[WS][${callId}] Bot nói KHÁC câu yêu cầu (${exp.tag}) → gửi lại lần ${exp.retries}.`);
    const { text, tag } = exp;
    setTimeout(() => _speakVerbatim(text, tag, 0, { verify: true }), 600);
  };

  // ── [2.4 — 26/07/2026] Phát hiện bot ĐỌC SỐ LẠ ra loa ─────────────────────
  const _checkBotSpokenDigits = (text) => {
    // [fix 26/07/2026] CHỈ giám sát trong giai đoạn còn đang lấy mã danh bộ.
    // Chốt xong rồi thì bot đọc kỳ/năm/số tiền/sản lượng là hoàn toàn hợp lệ —
    // cuộc rtc_u1_E5hSj6j báo nhầm "bot đọc số lạ 2026" khi nó đang đọc "kỳ 7
    // năm 2026" đúng theo dữ liệu tra cứu được.
    if (_toolCallState.danhBo?.confirmed) return;

    const runs = _extractDigitRuns(text)
      // Năm (19xx/20xx) không phải mã danh bộ — tránh dương tính giả.
      .filter((d) => !(d.length === 4 && /^(19|20)\d\d$/.test(d)));
    if (runs.length === 0) return;

    // Tập số bot ĐƯỢC PHÉP nói: số đang chờ/đã chốt + số nằm trong câu code vừa
    // yêu cầu bot đọc nguyên văn.
    const allowed = [];
    if (_toolCallState.danhBo?.value) allowed.push(_toolCallState.danhBo.value);
    for (const p of [_toolCallState._danhBoLastPrompt, _toolCallState._dtmfBuffer]) {
      if (!p) continue;
      for (const r of _extractDigitRuns(p)) allowed.push(r);
    }

    for (const run of runs) {
      if (allowed.some((a) => a.includes(run) || run.includes(a))) continue;
      _toolCallState._hallucinationCount = (_toolCallState._hallucinationCount || 0) + 1;
      logger.addEvent("bot_hallucinated_digits",
        `bot đọc "${run}" — không thuộc tập được phép [${allowed.join(", ") || "rỗng"}]`);
      log.warn(`[WS][${callId}] Bot đọc số LẠ "${run}" (lần ${_toolCallState._hallucinationCount}).`);
      // KHÔNG cancel response đang chạy — repo đã trả giá 2 lần cho việc này
      // (bot câm 24s ở fix_echo_cancel_nham_response_20260718, 28s ở cuộc
      // E2ou4DurIiPbGRvrrggKr). Số đã phát ra loa rồi, cancel không rút lại được.
      // Thay vào đó: nói đè bằng đúng câu của bước đang chờ.
      _reAssertDanhBoStep("bot đọc số không được phép");
      break; // mỗi lượt nói chỉ tính 1 lần
    }
  };

  // ── [3.1 — 26/07/2026] NỚI VAD cho giai đoạn đọc số ───────────────────────
  // `semantic_vad` quyết định "khách nói xong chưa" theo NGỮ NGHĨA. Khi khách đọc
  // số tách nhiều hơi ("hai hai không hai..." — ngừng — "ba hai năm..."), mỗi hơi
  // trông như một lượt hoàn chỉnh → OpenAI chốt lượt sớm và tạo response ngay.
  // Đó là lý do cuộc rtc_u2_E5eDfB96UnJE6iDWfPbRX có 6 lượt transcript rời rạc
  // cho CÙNG một mã danh bộ.
  //
  // `server_vad` với ngưỡng im lặng dài thì dễ đoán hơn hẳn cho việc đọc số, và
  // rủi ro thấp hơn nhiều so với phương án khoá hẳn `create_response` (bot có thể
  // câm vĩnh viễn nếu quên bật lại).
  const _VAD_DIGITS_SILENCE_MS = Number(process.env.DANH_BO_VAD_SILENCE_MS || 2000);
  const _VAD_DIGITS_THRESHOLD = Number(process.env.DANH_BO_VAD_THRESHOLD || 0.6);
  const _VAD_RESTORE_MS = Number(process.env.DANH_BO_VAD_RESTORE_MS || 90000);
  let _vadMode = "normal";
  let _vadRestoreTimer = null;

  const _setVadMode = (mode) => {
    if (_vadMode === mode) return;
    if (_hungUp || _transferred) return;
    const turn_detection = mode === "digits"
      ? {
        type: "server_vad",
        threshold: _VAD_DIGITS_THRESHOLD, // giữ giá trị đã hiệu chỉnh ở fix 08/07
        prefix_padding_ms: 500,           // không mất các chữ số đầu
        silence_duration_ms: _VAD_DIGITS_SILENCE_MS, // cho khách ngừng giữa các hơi
        // ── MỨC C (26/07/2026 đợt 5) ────────────────────────────────────────
        // Model KHÔNG được tự sinh response trong lúc khách đọc số. Audio vẫn
        // được commit và transcribe bình thường, chỉ là model không nói.
        // Toàn bộ lời thoại giai đoạn này do CODE phát qua `_speakVerbatim`.
        //
        // Vì sao cần: 4 đợt sửa trước, lỗi cứ dịch dần về cuối chuỗi và đợt 4 dừng
        // ở chỗ "code chốt đúng mã trong 5 giây nhưng bot đọc nhầm câu cũ". Chừng
        // nào model còn được tự nói giữa lúc thu số thì còn phải đi kiểm chứng và
        // gửi lại. Khoá hẳn thì vấn đề biến mất — đổi lại code phải chịu trách
        // nhiệm phát MỌI câu (xem các lối thoát bên dưới).
        // Lợi ích phụ: nhiễu/tạp âm không còn kích hoạt model trong giai đoạn này.
        create_response: false,
        interrupt_response: true,
      }
      : {
        type: "semantic_vad",
        eagerness: "low",
        create_response: true,
        interrupt_response: true,
      };
    try {
      ws.send(JSON.stringify({
        type: "session.update",
        session: { type: "realtime", audio: { input: { turn_detection } } },
      }));
      _vadMode = mode;
      logger.addEvent("vad_mode", mode);
      log.info(`[WS][${callId}] VAD → ${mode} (${turn_detection.type})`);
    } catch (e) {
      log.warn(`[WS][${callId}] không đổi được VAD mode (${mode}): `, e.message);
      return;
    }

    clearTimeout(_vadRestoreTimer);
    _vadRestoreTimer = null;
    if (mode === "digits") {
      // Lưới an toàn cuối cùng: quên trả về `semantic_vad` ở một nhánh thoát nào
      // đó thì sau _VAD_RESTORE_MS tự khôi phục.
      _vadRestoreTimer = setTimeout(() => {
        log.warn(`[WS][${callId}] VAD watchdog: tự trả về semantic_vad sau ${_VAD_RESTORE_MS}ms.`);
        _setVadMode("normal");
      }, _VAD_RESTORE_MS);
    }
  };

  // ── [MỨC C — đợt 5] LƯỚI AN TOÀN CHỐNG BOT CÂM ────────────────────────────
  // Rủi ro lớn nhất của mức C: model bị khoá mà code lại quên phát lời ở một
  // nhánh nào đó → khách nói xong rồi ngồi nghe im lặng tới lúc cúp máy.
  // Lưới này không thay thế các lối thoát cụ thể, nó chỉ bắt trường hợp lọt lưới.
  const _MUTE_WATCHDOG_MS = Number(process.env.DANH_BO_MUTE_WATCHDOG_MS || 15000);
  let _lastCustomerTurnAt = 0;
  let _lastBotSpeakAt = 0;
  let _muteWatchdogTimer = null;

  const _armMuteWatchdog = () => {
    clearTimeout(_muteWatchdogTimer);
    _muteWatchdogTimer = setTimeout(() => {
      if (_hungUp || _transferred) return;
      if (ws.readyState !== WebSocket.OPEN) return;
      if (_vadMode !== "digits") return;          // model không bị khoá → không lo
      if (_responseActive) return;                // bot đang nói
      if (_lastBotSpeakAt >= _lastCustomerTurnAt) return; // bot đã đáp lượt này rồi
      // Đang xác minh (API + gpt-5.1) → câu trả lời sắp tới, gia hạn thêm một nhịp.
      if (_toolCallState._danhBoVerifyRunning || _expectedSpeak) { _armMuteWatchdog(); return; }

      log.error(`[WS][${callId}] LƯỚI AN TOÀN: bot im lặng > ${_MUTE_WATCHDOG_MS}ms sau khi khách nói — mở khoá model.`);
      logger.addEvent("mute_watchdog", `bot im lặng > ${_MUTE_WATCHDOG_MS}ms — mở khoá model`);
      _setVadMode("normal");
      _requestModelReply("lưới an toàn: bot im lặng quá lâu sau khi khách nói");
    }, _MUTE_WATCHDOG_MS);
  };

  // ── [1.8] Watchdog tổng cho bước lấy danh bộ ──────────────────────────────
  // Cuộc gọi mẫu mắc ở bước này 3 phút 32 giây qua 6 lượt đọc mà CHƯA MỘT LẦN
  // khách được mời bấm phím — hai bộ đếm cũ đều đếm theo nhánh code nội bộ nên
  // không bao giờ chạm ngưỡng. Watchdog là lưới an toàn cuối cùng.
  const _DANHBO_WATCHDOG_MS = Number(process.env.DANH_BO_WATCHDOG_MS || 90000);
  const _clearDanhBoWatchdog = () => {
    clearTimeout(_toolCallState._danhBoWatchdogTimer);
    _toolCallState._danhBoWatchdogTimer = null;
  };
  const _armDanhBoWatchdog = () => {
    // [3.2] Khách bắt đầu đọc số → nới VAD ngay (điểm vào của giai đoạn đọc số).
    if (!_toolCallState._danhBoDtmfInvited) _setVadMode("digits");
    if (_toolCallState._danhBoWatchdogTimer) return; // đã đặt rồi, không gia hạn
    _toolCallState._danhBoWatchdogTimer = setTimeout(() => {
      if (_hungUp || _transferred) return;
      if (_toolCallState.danhBo?.confirmed) return;
      if (_toolCallState._danhBoDtmfInvited) return;
      const prompt = danhBoDtmfInvitePrompt(_toolCallState);
      if (!prompt) return;
      _toolCallState._danhBoLastPrompt = prompt;
      _setVadMode("normal"); // [3.2] chuyển sang bấm phím — hết giai đoạn đọc số
      logger.addEvent("danh_bo_watchdog_dtmf", `quá ${_DANHBO_WATCHDOG_MS}ms chưa chốt được mã`);
      log.warn(`[WS][${callId}] Watchdog danh bộ: quá ${_DANHBO_WATCHDOG_MS}ms → mời bấm phím.`);
      _speakVerbatim(prompt, "danh_bo_watchdog_dtmf", 0, { verify: true });
    }, _DANHBO_WATCHDOG_MS);
  };

  // Tránh save() 2 lần (close + error retry)
  let _saved = false;
  // [0.1] Đăng ký phiên vào registry để graceful shutdown flush được (xem đầu file).
  const _sessionEntry = { callId, flush: null };
  _activeSessions.add(_sessionEntry);
  const _saveOnce = async (reason) => {
    if (_saved) return;
    _saved = true;
    logger.addEvent("saving_log", reason);
    try {
      await logger.save();
    } catch (err) {
      log.error(`[WS][${callId}] Lỗi lưu conversation summary:`, err.message);
    } finally {
      _activeSessions.delete(_sessionEntry);
    }
  };
  _sessionEntry.flush = _saveOnce;

  const ws = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
  });

  // [debug 19/07/2026] WS handshake bị từ chối (vd 404) — bắt STATUS + BODY của
  // response để biết lý do thật từ OpenAI (call not found / already attached /
  // config invalid...). Trước đây chỉ log "Unexpected server response: 404".
  ws.on("unexpected-response", (_req, res) => {
    let body = "";
    res.on("data", (c) => { body += c; });
    res.on("end", () => {
      const msg = `HTTP ${res.statusCode} | headers=${JSON.stringify({
        "x-request-id": res.headers["x-request-id"],
        "openai-project": res.headers["openai-project"],
      })} | body=${body.slice(0, 500)}`;
      log.error(`[WS][${callId}] Handshake bị từ chối: ${msg}`);
      logger.addError("ws_handshake_rejected", msg);
    });
  });

  ws.on("open", () => {
    log.info(`[WS][${callId}] Kết nối WebSocket thành công`);
    logger.addEvent("ws_open", "WebSocket đã kết nối");

    // Với SIP calls, session.created KHÔNG được gửi (khác WebSocket thông thường).
    // Phải gửi session.update + response.create ngay khi open – giống Python example.

    // 1. Cập nhật session config (tools, voice, VAD)
    // session.type: "realtime" là bắt buộc cho SIP sessions
    // ws.send(JSON.stringify({
    //   type: "session.update",
    //   session: {
    //     type: "realtime",                         // ← bắt buộc, fix lỗi "Missing session.type"
    //     voice: process.env.OPENAI_VOICE || "alloy",
    //     tools: TOOLS,
    //     tool_choice: "auto",
    //     input_audio_transcription: { model: "whisper-1" },
    //     turn_detection: {
    //       type: "server_vad",
    //       // Tăng threshold & silence_duration để tránh AI bị interrupt liên tục:
    //       // - threshold 0.7: chỉ kích hoạt khi giọng nói đủ to, tránh noise/echo SIP
    //       // - silence_duration_ms 1200: chờ 1.2s im lặng mới coi là hết lượt nói
    //       // - prefix_padding_ms 500: đệm 500ms trước khi bắt đầu nghe để tránh echo AI
    //       threshold: 0.7,
    //       prefix_padding_ms: 500,
    //       silence_duration_ms: 1200,
    //     },
    //   },
    // }));

    // Fix: thêm type: "realtime" – bắt buộc cho SIP sessions, tránh lỗi "Missing session.type"
    ws.send(JSON.stringify({
      type: "session.update",
      session: {
        type: "realtime",
        // GA Realtime: turn_detection nằm trong audio.input, KHÔNG để phẳng ở session
        // (đặt sai chỗ gây lỗi "Unknown parameter: 'session.turn_detection'" → VAD bị bỏ qua,
        //  cắt mất các chữ số đầu khi khách đọc danh bộ).
        audio: {
          input: {
            // turn_detection: {
            //   type: "server_vad",
            //   // [fix 08/07/2026] 0.5 → 0.6: cuộc gọi 0967777637_DzAjQz4pTwd1aorzn7nHb
            //   // có phantom turn (VAD bắt noise/echo → AI tự nói 4 lượt liên tiếp).
            //   // Theo dõi vadTurnCount/emptyTranscriptCount trong stats; còn phantom
            //   // thì lên 0.7, khách phàn nàn "bot không nghe thấy" thì hạ về 0.5.
            //   threshold: 0.6,
            //   prefix_padding_ms: 500,  // giữ ~0.5s audio trước khi VAD kích hoạt → không mất số đầu
            //   silence_duration_ms: 1200
            // }
            "turn_detection": {
              "type": "semantic_vad",
              "eagerness": "low",//"auto",
              "create_response": true,
              "interrupt_response": true
            }
          }
        }
      }
    }));
    // 2. Trigger AI nói câu chào ngay lập tức
    // Nếu có customerContext → AI xác nhận danh bộ luôn; nếu không → chào thông thường
    // const greetingInstruction = callOps.customerContext
    //   ? "Chào khách hàng ngắn gọn rồi đọc danh bộ tìm thấy để xác nhận, theo đúng hướng dẫn trong system instructions."
    //   : 'nói "Xin chào Quý Khách, Cảm ơn Quý Khách đã gọi đến Tổng đài Công ty Cổ phần Cấp nước Trung An. Em là Trợ lý Ảo Ây Ai, Quý khách cần em hỗ trợ gì ạ?"';

    // [fix 08/07/2026 đợt 6] Bỏ "đợi 1 giây rồi nói" — code đã setTimeout 1s
    // sẵn, và model mini từng đọc nguyên văn cả phần chỉ dẫn ra loa
    // (cuộc gọi DzIgZD3y: "Đợi 1 giây rồi nói: ... Alo ...").
    // [fix 08/07/2026 đợt 7] Siết chặt hơn — cuộc gọi DzLM04 model diễn giải
    // lại thành "Chào anh/chị..." (sai persona). Câu chào chuẩn cũng đã được
    // thêm vào SYSTEM_PROMPT (section Phong cách) làm lớp dự phòng.
    const greetingInstruction = 'Đọc CHÍNH XÁC từng từ câu sau, không thêm bớt, không diễn giải lại: " Alo! Hello! Xin chào Quý Khách, Cảm ơn Quý Khách đã gọi đến Tổng đài Công ty Cổ phần Cấp nước Trung An. Em là Trợ lý Ảo Ây Ai, Quý khách cần em hỗ trợ gì ạ?"';

    setTimeout(() => {
      _pendingCodeResponse = true; // [fix 18/07/2026] đánh dấu response do code tạo
      ws.send(JSON.stringify({
        type: "response.create",
        response: { instructions: greetingInstruction },
      }));
      logger.addEvent("greeting_sent", callOps.customerContext ? "greeting chuẩn (có context danh bộ)" : "greeting chuẩn");
    }, 1000);

  });

  ws.on("message", async (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Log tất cả events để debug (dùng LOG_LEVEL=debug để xem đầy đủ)
    // log.info(`[WS][${callId}] ← ${event.type}`);

    switch (event.type) {
      // Mỗi response được tạo (do VAD hoặc do code) — đối chiếu với
      // response_create_sent/greeting_sent để biết nguồn gốc từng response
      case "response.created":
        console.log("....response.created....: AI bắt đầu sinh phản hồi, do VAD kích hoạt hoặc do code yêu cầu");
        _responseActive = true;
        // [fix 18/07/2026] Gắn response với nguồn kích hoạt:
        // - code vừa gửi response.create (greeting/tool result) → trigger = null
        // - còn lại là do VAD → trigger = item audio vừa commit
        if (_pendingCodeResponse) {
          _activeResponseTriggerItemId = null;
          _pendingCodeResponse = false;
        } else {
          _activeResponseTriggerItemId = _lastCommittedItemId;
        }
        logger.addEvent("response_created",
          `${event.response?.id ?? null} (trigger: ${_activeResponseTriggerItemId ?? "code"})`);
        break;

      // ── Response hoàn chỉnh → kiểm tra có function_call không ─────────────
      // Theo pattern của openai_nestle_step3.js: bắt function call qua
      // response.done → response.output[], lọc item.type === "function_call".

      case "response.done": {
        console.log("....response.done....: AI đã nói xong trọn vẹn câu thoại hoặc bị ngắt/hủy");
        if (_pendingCodeResponse) {
          console.log("[response.done]: Response do code tạo, đánh dấu đã hoàn thành ");
        } else {
          console.log("[response.done]: Response do VAD kích hoạt, đánh dấu đã hoàn thành ");
        }
        _responseActive = false;
        _activeResponseTriggerItemId = null; // [fix 18/07/2026] response xong → hết gắn với item nào
        // [fix 18/07/2026 v2] Response HOÀN TẤT (không bị cancel/interrupt) →
        // lượt khách gần nhất coi như đã được trả lời. Response dở dang
        // (cancelled/incomplete) KHÔNG tính — câu hỏi vẫn chưa được đáp.
        if (event?.response?.status === "completed") _unansweredRealTurn = false;
        // [debug 08/07/2026] Response không hoàn tất (bị khách ngắt lời / hủy / lỗi)
        // → ghi lại để phân tích các câu AI nói dở (vd "Dạ, cảm ơn Qu...")
        const _respStatus = event?.response?.status;
        if (_respStatus && _respStatus !== "completed") {
          logger.addEvent(`response_${_respStatus}`, _safeJson(event.response?.status_details ?? null));
        }

        const usage = event?.response?.usage;
        if (usage) {
          // Tích lũy token để tính cost cuối cuộc gọi
          logger.addUsage(usage);
          // Log tóm tắt nhanh để debug
          const totalIn = usage.input_tokens ?? 0;
          const totalOut = usage.output_tokens ?? 0;
          const audioIn = usage.input_token_details?.audio_tokens ?? 0;
          const audioOut = usage.output_token_details?.audio_tokens ?? 0;
          log.debug(`[WS][${callId}] response.done usage: in=${totalIn}(audio=${audioIn}) out=${totalOut}(audio=${audioOut})`);
        }

        const output = event?.response?.output;
        if (!Array.isArray(output) || output.length === 0) break;

        // [fix 27/07/2026] Một response.done có thể chứa NHIỀU function_call.
        // Gom kết quả tool cuối cùng, chỉ tạo ĐÚNG MỘT response sau vòng lặp.
        let _ketQuaToolCuoi = null;

        for (const item of output) {
          if (item?.type !== "function_call") continue;

          const toolCallId = item.call_id;
          const name = item.name;
          const argsStr = item.arguments;
          console.log("function name = ", name);
          console.log("function args = ", argsStr);
          log.info(`[WS][${callId}] Tool call: ${name}(${argsStr})`);

          let args = {};
          try { args = JSON.parse(argsStr); } catch { /* ignore */ }

          // Gọi handler trong context trace API (gom request/response backend
          // phát sinh trong tool call này) và gửi kết quả tool về cho OpenAI.
          const _t0 = Date.now();
          const { result: toolOutput, trace: apiCalls } =
            await runWithApiTrace(() => dispatchTool(name, args, _toolCallState));
          const _durationMs = Date.now() - _t0;
          log.debug(`[WS][${callId}] Tool output (${_durationMs}ms): ${toolOutput}`);

          // Ghi đầu vào / đầu ra của function tool + trace API vào log
          try {
            logger.addToolCall(name, args, _tryParseJson(toolOutput), _durationMs, apiCalls);
          } catch { /* ignore */ }

          let result = {};
          try { result = JSON.parse(toolOutput); } catch { /* ignore */ }
          const action = result.action;

          // Lưu phiếu ticket nội bộ mỗi khi tạo phiếu (đối soát với remote).
          // Fire-and-forget, lỗi DB không ảnh hưởng luồng cuộc gọi.
          if (name === "create_ticket") {
            insertTicket({
              callId,
              customerTel: callOps.asteriskData?.phoneNumber ?? callOps.tel,
              args,
              output: result,
            });
          }

          console.log({ name, toolOutput: JSON.parse(toolOutput), callId });
          // Luôn gửi function_call_output về OpenAI (mỗi call_id cần đúng 1 output)
          ws.send(
            JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: toolCallId,
                output: toolOutput,
              },
            })
          );

          // [3.2] Mọi nhánh KẾT THÚC đều phải trả VAD về mặc định.
          if (action === "end_call" || action === "transfer_to_agent") _setVadMode("normal");

          if (action === "end_call") {
            // KHÔNG gửi response.create khi model ĐÃ nói lời tạm biệt trong cùng
            // response chứa end_call → gửi thêm sẽ gây lỗi
            // conversation_already_has_active_response.
            logger.setOutcome("completed");
            logger.addEvent("end_call", result.ly_do || null);
            if (!_hungUp) {
              _hungUp = true;
              // [fix 18/07/2026] Cuộc E2tY3rg44dIiQOsBGYFsi: model gọi end_call
              // mà KHÔNG nói lời tạm biệt (response chỉ có function_call, không
              // có output audio) → khách nghe 5s im lặng rồi bị cúp máy.
              // Response.done đã về nên lúc này KHÔNG còn active response →
              // gửi response.create câu tạm biệt cố định là an toàn (cùng cơ
              // chế ép đọc nguyên văn như câu chào), và lùi hangup cho kịp nói.
              const _hasGoodbyeAudio = output.some((it) =>
                it?.type === "message" &&
                Array.isArray(it.content) &&
                it.content.some((c) => c?.type === "output_audio"));
              let _hangupDelay = 5000;
              if (!_hasGoodbyeAudio) {
                const _goodbyeInstruction =
                  'Đọc CHÍNH XÁC từng từ câu sau, không thêm bớt, không diễn giải lại: ' +
                  '"Dạ, em cảm ơn Quý Khách đã gọi đến Tổng đài Công ty Cổ phần Cấp nước Trung An. Kính chào Quý Khách ạ."';
                _pendingCodeResponse = true;
                ws.send(JSON.stringify({
                  type: "response.create",
                  response: { instructions: _goodbyeInstruction },
                }));
                logger.addEvent("goodbye_forced", "end_call không kèm audio — code tự tạo câu tạm biệt");
                console.log(`[${callId}]:`, "goodbye_forced", "end_call không kèm audio — code tự tạo câu tạm biệt");
                _hangupDelay = 8000; // câu tạm biệt ~5-6s + latency tạo response
              }
              // Delay để AI kịp nói lời tạm biệt trước khi cúp máy
              setTimeout(() => callOps.hangup(callId), _hangupDelay);
            } else {
              logger.addEvent("end_call_duplicate_ignored", "đã lên lịch cúp máy");
            }
          } else if (action === "transfer_to_agent") {
            // Tương tự: không gửi response.create (model đã thông báo chuyển máy)
            logger.setOutcome("transferred");
            logger.addEvent("transfer_to_agent", result.ly_do || null);
            if (!_transferred) {
              _transferred = true;
              await _handleTransfer(callId, callOps, result.ly_do);
            } else {
              logger.addEvent("transfer_duplicate_ignored", null);
            }
          } else {
            // Tool dữ liệu thông thường → yêu cầu AI đọc kết quả cho khách
            // [debug 08/07/2026] ghi event để phân biệt response do code chủ động
            // tạo (tool_result/greeting) với response do VAD kích hoạt
            // [14/07/2026] Kết quả có "doc_cho_khach" → ép đọc NGUYÊN VĂN bằng
            // instructions của response (cùng cơ chế với câu chào — cách duy nhất
            // mini tuân thủ 100%). Cuộc E1Nof3VRCX1u0hVwBoueJ: dù luu_y ghi "CẤM
            // tóm tắt", model vẫn tự tóm tắt làm sai logic + rơi 2 địa chỉ.
            // [3.2] Điểm vào/ra của giai đoạn đọc số theo nội dung tool trả về.
            if (result?.moi_bam_phim || result?.da_sai_nhieu_lan) _setVadMode("normal");
            else if (result?.invalid_danh_bo || result?.dang_gom_so || result?.dang_xac_minh) _armDanhBoWatchdog();

            // [fix 27/07/2026] KHÔNG gửi response.create ngay trong vòng lặp —
            // xem giải thích ở khối "MỘT response.create cho CẢ response.done".
            _ketQuaToolCuoi = { name, result };
          }
        }

        // ── [fix 27/07/2026] MỘT response.create cho CẢ response.done ────────
        // Cuộc rtc_u2_E66X1bhQIrBrwtqeHkOau: model phát ra HAI function_call
        // get_bill trong CÙNG một response. Vòng lặp gửi 2 `response.create` →
        // cái thứ hai lỗi `conversation_already_has_active_response`, và cả cuộc
        // gọi trượt dài từ đó (bot nói lung tung 3 lượt liền rồi khách cúp máy).
        // Mỗi `response.done` chỉ được sinh ra ĐÚNG MỘT response mới.
        if (_ketQuaToolCuoi && !_hungUp && !_transferred) {
          const { name: _tenTool, result: _kq } = _ketQuaToolCuoi;
          const _instructions = _kq?.doc_cho_khach
            ? "Đọc CHÍNH XÁC từng từ đoạn sau cho khách, không thêm bớt, " +
            "không tóm tắt, không diễn giải lại: \"" + _kq.doc_cho_khach + "\""
            : "Phản hồi lại khách hàng dựa trên kết quả vừa nhận được.";

          // [fix 27/07/2026] Câu thoại CỐ ĐỊNH của luồng danh bộ → CẤM model gọi
          // tool trong response này. Cùng cuộc gọi trên: response do code tạo để
          // đọc câu chờ lại bị model dùng để gọi get_bill tiếp (với số bịa), tạo
          // vòng xoáy tool-call. `tool_choice: "none"` cắt hẳn vòng xoáy đó.
          const _camGoiTool = !!(_kq?.doc_cho_khach && (
            _kq.dang_gom_so || _kq.dang_xac_minh || _kq.invalid_danh_bo ||
            _kq.moi_bam_phim || _kq.cho_khach_xac_nhan || _kq.da_sai_nhieu_lan
          ));

          const _guiCauTool = () => {
            if (_hungUp || _transferred) return;
            if (ws.readyState !== WebSocket.OPEN) return;
            logger.addEvent("response_create_sent",
              `tool_result: ${_tenTool}${_camGoiTool ? " (tool_choice=none)" : ""}`);
            log.debug(`[WS][${callId}] response.create sau tool: ${_instructions}`);
            _pendingCodeResponse = true; // [fix 18/07/2026] đánh dấu response do code tạo
            ws.send(JSON.stringify({
              type: "response.create",
              response: _camGoiTool
                ? { instructions: _instructions, tool_choice: "none" }
                : { instructions: _instructions },
            }));
          };

          if (_camGoiTool) {
            // [fix 27/07/2026 đợt 7] Hoãn một nhịp rồi KIỂM TRA LẠI trước khi phát.
            // Model gọi tool NGAY khi nghe audio, còn transcript về trễ ~0,2s. Cuộc
            // rtc_u2_E66xM4TYW8qxz07ijdLzB: tool trả "cho em xin mã danh bộ" lúc
            // 11:10:51,3 — đúng 0,2 giây sau khách đã đọc XONG cả 11 số, vậy mà
            // 11:10:53,2 bot vẫn đọc câu xin số. Câu đã lỗi thời thì bỏ, đừng nói.
            setTimeout(() => {
              const _soDaCo = danhBoSessionDigits(_toolCallState);
              const _daCoUngVien = !!_toolCallState.danhBo;
              const _loiThoi = _daCoUngVien
                || (_kq.invalid_danh_bo && _soDaCo > 0)
                || (_kq.dang_gom_so && _soDaCo >= 11);
              if (_loiThoi) {
                logger.addEvent("tool_prompt_bo_qua",
                  `${_tenTool}: câu đã lỗi thời (đã nghe ${_soDaCo}/11, ứng viên=${_daCoUngVien})`);
                log.info(`[WS][${callId}] Bỏ câu tool đã lỗi thời — khách đã đọc ${_soDaCo}/11 số.`);
                return;
              }
              _guiCauTool();
            }, Number(process.env.DANH_BO_TOOL_PROMPT_DELAY_MS || 900));
          } else {
            _guiCauTool();
          }
        }
        break;
      }

      // ── [fix 19/07/2026 v2] Nhập mã danh bộ bằng BẤM PHÍM (DTMF) ─────────
      // Nhận phím BẤT KỲ LÚC NÀO trong cuộc gọi (không chờ tới lúc bot mời bấm):
      // khách sốt ruột bấm luôn cũng được. Đủ 11 số → code tự lưu vào callState
      // + ép bot đọc lại xác nhận. Phím số là dữ liệu CHÍNH XÁC tuyệt đối (không
      // qua "tai" model) nên KHÔNG cần gate xác nhận lời nói của trọng tài —
      // chỉ cần vòng xác nhận thường.
      case "input_audio_buffer.dtmf_event_received": {
        console.log("....input_audio_buffer.dtmf_event_received....");
        const digit = String(event.event ?? "").trim();
        console.log("DTMF received:", digit);
        logger.addEvent("dtmf_received", digit);

        const _now = Date.now();
        // Phím cách nhau quá lâu → coi như khách bắt đầu nhập dãy mới.
        if (_toolCallState._dtmfLastAt && _now - _toolCallState._dtmfLastAt > 15000) {
          _toolCallState._dtmfBuffer = "";
        }
        _toolCallState._dtmfLastAt = _now;

        if (digit === "*") {
          // Bấm sao → xoá nhập lại từ đầu.
          _toolCallState._dtmfBuffer = "";
          logger.addEvent("dtmf_buffer_cleared", "khách bấm *");
          break;
        }
        if (!/^\d$/.test(digit)) break; // '#' và phím khác: bỏ qua

        _toolCallState._dtmfBuffer = (_toolCallState._dtmfBuffer || "") + digit;
        if (_toolCallState._dtmfBuffer.length < 11) break;

        const _dtmfValue = _toolCallState._dtmfBuffer.slice(0, 11);
        _toolCallState._dtmfBuffer = "";
        _toolCallState.danhBo = { value: _dtmfValue, confirmed: false };
        _toolCallState._danhBoNeedsVerbalYes = false;
        _toolCallState._danhBoCustomerSaidNo = false;
        _toolCallState._danhBoResolvedBy = "dtmf";
        // [1.4/1.8] Phím bấm là dữ liệu chính xác tuyệt đối — dừng mọi việc gom
        // số bằng giọng nói đang treo để không chen ngang câu xác nhận DTMF.
        clearTimeout(_toolCallState._danhBoVerifyTimer);
        _clearDanhBoWatchdog();
        _setVadMode("normal"); // [3.2] đã có số từ bàn phím — không cần nới VAD nữa
        const _dtmfPrompt =
          `Dạ, em nhận được mã danh bộ Quý Khách vừa bấm là: ${danhBoSpoken(_dtmfValue)}. ` +
          `Quý Khách xác nhận giúp em có đúng không ạ?`;
        _toolCallState._danhBoLastPrompt = _dtmfPrompt;
        logger.addEvent("dtmf_danh_bo_complete", _dtmfValue);
        console.log(`[${callId}]:`, "dtmf_danh_bo_complete", _dtmfValue);
        _speakVerbatim(_dtmfPrompt, "dtmf_danh_bo_confirm", 0, { verify: true });
        break;
      }
      // ── Transcription để log cuộc hội thoại ───────────────────────────────
      case "conversation.item.input_audio_transcription.completed": {
        console.log("....conversation.item.input_audio_transcription.completed....");
        console.log("[conversation.item.input_audio_transcription.completed]: input_text_customer.transcript=", event.transcript?.trim());

        const khText = event.transcript?.trim();
        // Tích lũy transcription token usage (tính phí riêng cho model transcription)
        if (event.usage) {
          const txModel = callOps.acceptParams?.audio?.input?.transcription?.model ?? "gpt-4o-mini-transcribe";
          logger.addTranscriptionUsage(event.usage, txModel);
          const audioIn = event.usage.input_token_details?.audio_tokens ?? event.usage.input_tokens ?? 0;
          const textOut = event.usage.output_token_details?.text_tokens ?? event.usage.output_tokens ?? 0;
          log.debug(`[WS][${callId}] transcription usage: audio_in=${audioIn} text_out=${textOut}`);
        }
        // [fix 08/07/2026 đợt 3] gpt-4o-mini-transcribe gặp audio im lặng/nhiễu
        // có thể "dội" lại chính transcription prompt làm lượt khách giả
        // (thấy 2 lần trong cuộc gọi 0967777637_DzDbH1Hqkye3aPZefQmlz).
        // Transcript trùng prompt → ghi event riêng, KHÔNG tính là lượt khách.
        // [fix 13/07/2026] So khớp SAU KHI chuẩn hoá (bỏ dấu câu, thường hoá,
        // gộp khoảng trắng): cuộc gọi E16o8RrrNDst0VHNClIwO echo bị lệch vài
        // dấu chấm/phẩy so với prompt gốc → exact match trượt, echo lọt vào
        // lượt khách. Thêm so khớp "chữ ký" 40 ký tự đầu của prompt.
        const _txPrompt = callOps.acceptParams?.audio?.input?.transcription?.prompt?.trim();
        const _norm = (s) => String(s ?? "")
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\s]/gu, "")
          .replace(/\s+/g, " ")
          .trim();
        const _nk = _norm(khText);
        const _np = _norm(_txPrompt);
        const _sig = _np.slice(0, 40); // "chữ ký" mở đầu prompt
        const _isPromptEcho = !!(_nk && _np && (
          _nk === _np ||
          (_nk.length >= 20 && _np.includes(_nk)) ||   // transcript là 1 đoạn của prompt
          (_sig.length >= 20 && _nk.includes(_sig))    // transcript chứa phần mở đầu prompt
        ));

        // Chỉ log + ghi khi khách thực sự nói (bỏ qua transcript rỗng do im lặng/nhiễu)
        if (khText && !_isPromptEcho) {
          log.info(`[WS][${callId}] [KH nói]: ${khText}`);
          logger.addCustomerTurn(khText);
          _lastCustomerTurnAt = Date.now();
          _armMuteWatchdog(); // [MỨC C] mọi lượt khách nói đều phải có hồi đáp
          _unansweredRealTurn = true; // [fix 18/07/2026 v2] khách vừa nói thật — chưa được trả lời

          // [1.1 — 26/07/2026] Ghi lượt có chữ số vào CẢ HAI biến tích luỹ
          // (biến 1 = kho quan sát toàn cuộc gọi cho trọng tài; biến 2 = phiên
          // đọc hiện tại, dùng để đếm đủ/thiếu) rồi kích hoạt ĐƯỜNG NỀN.
          // [MỨC C — đợt 5] Xác định trước lượt này SẼ được xử lý bằng cách nào.
          // Ở chế độ digits model bị khoá, nên mọi lượt khách nói phải rơi vào
          // ĐÚNG MỘT nhánh có phát lời — nếu không, bot im lặng.
          // Từ khẳng định/phủ định chỉ có nghĩa khi ĐANG có ứng viên chờ xác nhận;
          // ngoài ngữ cảnh đó ("vâng", "ừ") thì coi như khách nói chuyện bình thường.
          const _dangChoXacNhan = !!(_toolCallState.danhBo && !_toolCallState.danhBo.confirmed);
          const _seXuLyXacNhan = _dangChoXacNhan && _isAffirmative(khText);
          const _seXuLyPhuDinh = _dangChoXacNhan && _PHU_DINH_RE.test(khText);
          // Câu xác nhận/phủ định KHÔNG được tính là lượt đọc số, dù lẫn từ nghe
          // giống chữ số ("Dạ không, không phải, không đúng" → 3 chữ "không").
          const _laLuotDocSo = !_seXuLyXacNhan && !_seXuLyPhuDinh && _looksLikeDigitTurn(khText);

          if (_laLuotDocSo) {
            const _s = noteDanhBoTranscript(_toolCallState, khText);
            log.info(`[WS][${callId}] [danh_bo] phiên #${_s.requestNo}: ${_s.digits.length}/11 số (+"${khText}")`);
            _armDanhBoWatchdog();
            _maybeVerifyDanhBo();
          } else if (!_seXuLyXacNhan && !_seXuLyPhuDinh &&
            _XIN_NHAC_LAI_RE.test(khText) && _toolCallState._danhBoLastPrompt) {
            // [fix 27/07/2026] "Đọc lại đi", "nhắc lại giúp em", "chưa nghe rõ"…
            // → khách muốn nghe LẠI đúng câu đang chờ, không phải đổi chủ đề.
            // Cuộc rtc_u2_E66X1bhQIrBrwtqeHkOau: câu này bị xếp vào "đổi chủ đề"
            // nên code nhờ model tự trả lời, model lại nói câu chờ cũ → bế tắc.
            // Code có sẵn câu cần đọc, cứ đọc lại — không phải hỏi model.
            logger.addEvent("danh_bo_doc_lai_theo_yeu_cau", khText.slice(0, 60));
            log.info(`[WS][${callId}] Khách xin nhắc lại → đọc lại câu đang chờ.`);
            _speakVerbatim(_toolCallState._danhBoLastPrompt, "danh_bo_nhac_lai", 0, { verify: true });
          } else if (!_seXuLyXacNhan && !_seXuLyPhuDinh && _vadMode === "digits") {
            // [MỨC C — đợt 5] Khách nói chuyện KHÁC giữa lúc đang thu số (cuộc
            // rtc_u1_E5iAEYIr6WXOZvgtds2e5: đang đọc dở thì hỏi "cho tôi hỏi về
            // thủ tục sang tên đồng hồ nước").
            //
            // Ở chế độ digits model bị KHOÁ (`create_response: false`) nên nếu code
            // không làm gì thì bot IM LẶNG hoàn toàn — tệ hơn cả trả lời sai. Phải:
            //   1. hoãn đường nền (đừng chen ngang bằng "đọc lại 11 số"),
            //   2. MỞ LẠI cho model nói,
            //   3. chủ động tạo response để model trả lời đúng câu khách vừa hỏi.
            // KHÔNG xoá số đã gom — khách quay lại đọc số thì gom tiếp bình thường.
            clearTimeout(_toolCallState._danhBoVerifyTimer);
            _toolCallState._danhBoVerifyTimer = null;
            logger.addEvent("danh_bo_hoan_vi_doi_chu_de", khText.slice(0, 80));
            log.info(`[WS][${callId}] Hoãn thu danh bộ — khách nói chuyện khác: "${khText.slice(0, 60)}"`);
            _setVadMode("normal");
            _requestModelReply("khách hỏi chuyện khác giữa lúc thu danh bộ");
          }

          // [fix 23/07/2026] XÁC NHẬN LỜI NÓI universal: bất kỳ ứng viên danh bộ
          // đang CHỜ (do đường nền / DTMF đọc lại) mà khách nói từ khẳng định →
          // chốt confirmed=true. Đây là DẤU HIỆU DUY NHẤT cho phép tra cứu
          // (không tin việc model tự gọi tool). Xóa buffer transcript để lần đọc
          // số MỚI sau (đổi danh bộ) không bị dính số cũ.
          if (_seXuLyXacNhan) {
            _toolCallState._danhBoNeedsVerbalYes = false;
            _toolCallState.danhBo.confirmed = true;
            // [1.1] KHÔNG xoá biến 1 nữa. Trước đây phải xoá vì mọi thứ đều ghép
            // mù từ nó, giữ lại sẽ dính số cũ. Giờ việc đếm do biến 2 lo và prompt
            // trọng tài đã tách "lần đọc mới nhất" riêng, nên giữ kho quan sát là
            // AN TOÀN và còn cần thiết: khi tra cứu chết ở CUSTOMER_NOT_FOUND,
            // danhBoNotFoundSelfCorrect cần chính kho này để tìm ứng viên thay thế.
            // [1.1] Phiên đọc đã xong nhiệm vụ — dọn để lần đổi danh bộ sau đếm lại từ 0.
            const _s = ensureDanhBoSession(_toolCallState);
            _s.turns = [];
            _s.digits = "";
            // [1.8] Chốt được số → tắt watchdog + hẹn giờ xác minh đang treo.
            _clearDanhBoWatchdog();
            _setVadMode("normal"); // [3.2] xong bước danh bộ → trả VAD về mặc định
            clearTimeout(_toolCallState._danhBoVerifyTimer);
            // [0.3] Ghi nhận nguồn nào giải được mã (đo lường giữa các đợt sửa).
            logger.markDanhBoResolved(_toolCallState._danhBoResolvedBy || "unknown", _toolCallState.danhBo.value);
            logger.addEvent("danh_bo_verbal_confirm", khText);
            log.info(`[WS][${callId}] danh_bo_verbal_confirm: ${khText} → ${_toolCallState.danhBo.value}`);
            // [MỨC C — đợt 5] Lượt "đúng rồi" này được commit khi model còn đang bị
            // khoá → sẽ KHÔNG có response nào được sinh ra. Không tự tạo thì bot câm
            // ngay sau khi khách xác nhận. Nhờ model đi tra cứu luôn.
            _requestModelReply("khách đã xác nhận mã danh bộ",
              "Quý Khách vừa xác nhận mã danh bộ là ĐÚNG. Gọi NGAY tool tra cứu mà Quý Khách cần " +
              "(get_bill / get_payment_status / get_water_usage / get_outages / create_ticket...). " +
              "KHÔNG hỏi lại số, KHÔNG đọc lại số, KHÔNG truyền ma_danh_bo — hệ thống tự dùng số đã xác nhận.");
          }

          // [fix 23/07/2026] Khách PHỦ ĐỊNH số đang chờ xác nhận → BÁC ngay ứng
          // viên (mọi ứng viên chưa confirmed, không chỉ ứng viên trọng tài) để
          // đường nền được đề xuất dãy KHÁC ở lượt kế (danh bộ cũ vào
          // _danhBoRejected, trọng tài né).
          if (_seXuLyPhuDinh) {
            _toolCallState._danhBoCustomerSaidNo = true;
            logger.addEvent("danh_bo_customer_said_no", khText);
            log.info(`[WS][${callId}] danh_bo_customer_said_no: ${khText}`);
            noteDanhBoRejected(_toolCallState);
            logger.addEvent("danh_bo_rejected_proactive", "khách phủ định số đang chờ xác nhận");
            // [1.4] Chạy lại đường nền ngay: trọng tài sẽ né dãy vừa bị bác và
            // đề xuất phương án khác; không ra thì mời đọc lại / bấm phím.
            _toolCallState._danhBoVerifyLastAt = 0; // bỏ khoảng nghỉ tối thiểu cho lượt này
            _maybeVerifyDanhBo();
          }
        } else if (_isPromptEcho) {
          log.info(`[WS][${callId}] [KH nói - prompt echo, bỏ qua] || ${JSON.stringify({ khText, _isPromptEcho, _nk, _np, _sig })}`);

          logger.addEvent("transcript_prompt_echo", "transcript trùng transcription prompt (audio im lặng/nhiễu) — không tính lượt khách");
          // [14/07/2026] Nhiễu cũng kích hoạt VAD → OpenAI đã tự tạo response
          // cho "lượt khách" giả này → model tự nói câu thừa ("Dạ, em nghe rõ
          // rồi ạ..." — cuộc E1NSYW1IIC4xom9HGSneG). HỦY response đang chạy
          // bằng code, không trông chờ rule prompt.
          // [fix 18/07/2026] CHỈ hủy khi response đang chạy đúng là do LƯỢT ECHO
          // này kích hoạt (item_id trùng). Transcript echo có thể về TRỄ vài giây
          // — lúc đó response đang chạy có thể là câu trả lời cho lượt THẬT của
          // khách (cuộc E2ou4DurIiPbGRvrrggKr: cancel nhầm → bot câm 28s).
          const _echoItemId = event.item_id ?? null;
          if (_responseActive && !_hungUp && !_transferred) {
            // [fix 18/07/2026 v2] Chỉ cancel khi ĐỦ 2 điều kiện:
            // 1. item echo trùng item đã kích hoạt response đang chạy;
            // 2. KHÔNG còn lượt khách thật nào chưa được trả lời — nếu còn,
            //    response đang chạy (dù do item nhiễu kích hoạt, semantic VAD
            //    interrupt) nhiều khả năng đang TRẢ LỜI câu hỏi thật đó
            //    (cuộc E2tkwslo38l9Flut5ptF4: cancel nhầm → bot câm 24s).
            const _itemMatch = !!_echoItemId && _activeResponseTriggerItemId === _echoItemId;
            if (_itemMatch && !_unansweredRealTurn) {
              try {
                ws.send(JSON.stringify({ type: "response.cancel" }));
                logger.addEvent("response_cancel_sent", `hủy response do prompt echo (nhiễu) kích hoạt (item ${_echoItemId})`);
                console.log(`[${callId}]:`, "response_cancel_sent", `hủy response do prompt echo (item ${_echoItemId})`);
                _reAssertDanhBoStep("sau khi hủy response do prompt echo");
              } catch (e) {
                log.warn(`[WS][${callId}]không gửi được response.cancel: `, e.message);
                console.log(`[WS][${callId}]không gửi được response.cancel: `, e.message);
              }
            } else {
              // Giữ nguyên response đang chạy — đang trả lời lượt thật của
              // khách, hoặc do code tạo, hoặc thuộc item khác.
              const _reason = !_itemMatch
                ? `echo item ${_echoItemId} ≠ trigger item ${_activeResponseTriggerItemId}`
                : `item trùng nhưng còn lượt khách thật chưa được trả lời (_unansweredRealTurn)`;
              logger.addEvent("response_cancel_skipped", `${_reason} — không hủy response đang chạy`);
              console.log(`[${callId}]:`, "response_cancel_skipped", _reason);
            }
          }
        } else {
          log.info(`[WS][${callId}][KH nói]: `, { khText });
          // [debug 08/07/2026] VAD kích hoạt nhưng transcript rỗng = phantom turn
          // (noise/echo SIP). Ghi vào timeline để đối chiếu transcription_count.
          logger.addEvent("empty_transcript", "VAD kích hoạt nhưng transcript rỗng (noise/echo?)");
        }
        break;
      }

      // conversation.item.done: bắt lời AI (output_audio transcript) để ghi log đủ 2 chiều
      case "conversation.item.done": {
        console.log("....conversation.item.done....");
        const content = event?.item?.content;
        if (Array.isArray(content)) {
          const aiPart = content.find((c) => c?.type === "output_audio" && c?.transcript);
          if (aiPart?.transcript?.trim()) {
            const txt = aiPart.transcript.trim();
            log.info(`[WS][${callId}][AI nói]: ${txt}`);
            logger.flushAI(txt);
            _lastBotSpeakAt = Date.now(); // [MỨC C] mốc cho lưới an toàn chống câm
            _checkBotSpokenDigits(txt);   // [2.4] bot có đọc số lạ ra loa không
            _checkExpectedSpeak(txt);     // [đợt 4] bot có đọc ĐÚNG câu code yêu cầu không
          }
        }
        break;
      }

      case "response.audio_transcript.done": {
        console.log("....response.audio_transcript.done....");
        const aiText = event.transcript?.trim();
        log.info(`[WS][${callId}][AI nói]: ${aiText}`);
        if (aiText) logger.flushAI(aiText);
        break;
      }



      // ── [debug 08/07/2026] VAD & response lifecycle ───────────────────────
      // Phục vụ chẩn đoán phantom turn (VAD bắt nhầm noise/echo) và AI lặp lời.
      // Cuộc gọi "khỏe": số vad_speech_started ≈ số lượt khách nói thật.

      case "input_audio_buffer.speech_started":
        console.log("....input_audio_buffer.speech_started....");
        logger.addEvent("vad_speech_started", null);
        break;

      case "input_audio_buffer.speech_stopped":
        console.log("....input_audio_buffer.speech_stopped....");
        logger.addEvent("vad_speech_stopped", null);
        break;

      // [fix 18/07/2026] VAD commit audio thành conversation item → nhớ item_id.
      // Response do VAD tạo ngay sau đó sẽ được gắn với item này (response.created).
      case "input_audio_buffer.committed":
        console.log("....input_audio_buffer.committed....");
        _lastCommittedItemId = event.item_id ?? null;
        logger.addEvent("audio_committed", _lastCommittedItemId);
        break;



      // Transcription thất bại (trước đây rơi vào default, mất dấu vết)
      case "conversation.item.input_audio_transcription.failed":
        console.log("....conversation.item.input_audio_transcription.failed....");
        logger.addError("transcription_failed", event.error?.message || _safeJson(event.error));
        break;

      // ── Lỗi từ OpenAI ─────────────────────────────────────────────────────
      case "error":
        console.log("....error....");
        log.error(`[WS][${callId}]OpenAI error: `, event.error);
        logger.addError("openai_event", event.error?.message || _safeJson(event.error));
        break;

      case "session.created":
        console.log("....session.created....");
        log.info(`[WS][${callId}]session.created: ${event.session?.id}`);
        logger.setSessionCreatedData(event.session ?? {});
        logger.addEvent("session_created", event.session?.id || null);
        break;

      case "session.updated": {
        console.log("....session.updated....");
        // [fix 27/07/2026] Log cấu hình VAD OpenAI THẬT SỰ đang áp dụng. Cuộc
        // rtc_u2_E66X1bhQIrBrwtqeHkOau: code báo "VAD → digits" nhưng model vẫn
        // tự nói và tự gọi tool — không có cách nào biết `create_response: false`
        // có hiệu lực hay bị bỏ qua, vì ta chỉ log "session.updated OK".
        const _td = event.session?.audio?.input?.turn_detection ?? null;
        const _tom = _td
          ? `${_td.type} create_response=${_td.create_response} silence=${_td.silence_duration_ms ?? "-"} eagerness=${_td.eagerness ?? "-"}`
          : "(không có turn_detection trong phản hồi)";
        log.info(`[WS][${callId}]session.updated OK — VAD đang áp dụng: ${_tom}`);
        logger.addEvent("session_updated", _tom);
        break;
      }

      default:
        break;
    }
  });

  ws.on("close", async (code, reason) => {
    log.info(`[WS][${callId}]WebSocket đóng: ${code} ${reason?.toString()}`);
    // [fix 26/07/2026 đợt 3] Dọn hẹn giờ — nếu không, watchdog danh bộ / VAD vẫn
    // nổ hàng chục giây sau khi khách đã cúp máy và cố phát câu vào hư không
    // (cuộc rtc_u2_E5hhmAHqS8cDGvUnCph0x: watchdog nổ 43 giây sau khi WS đóng).
    clearTimeout(_toolCallState._danhBoVerifyTimer);
    clearTimeout(_vadRestoreTimer);
    clearTimeout(_muteWatchdogTimer);
    _clearDanhBoWatchdog();
    logger.addEvent("ws_close", `${code} ${reason?.toString() || ""}`.trim());
    await _saveOnce(`ws_close ${code} `);
  });

  ws.on("error", (err) => {
    log.error(`[WS][${callId}] WebSocket lỗi: ${err.message} `);
    logger.addError("ws_error", err.message);
    // Nếu 404 → session chưa sẵn sàng → retry sau 2s (tối đa 3 lần)
    if (err.message.includes("404") && (callOps._wsRetry ?? 0) < 3) {
      callOps._wsRetry = (callOps._wsRetry ?? 0) + 1;
      const delay = callOps._wsRetry * 2000;
      log.info(`[WS][${callId}] Retry lần ${callOps._wsRetry} sau ${delay}ms...`);
      // Lần này không lưu log (sẽ mở lại session mới); session retry sẽ tự lưu khi đóng
      _saved = true;
      _activeSessions.delete(_sessionEntry); // [0.1] phiên này bỏ đi, không flush lúc tắt
      setTimeout(() => openSessionWebSocket(callId, callOps), delay);
    }
  });

  return ws;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _safeJson(obj) {
  try { return JSON.stringify(obj); } catch { return String(obj); }
}

function _tryParseJson(s) {
  try { return JSON.parse(s); } catch { return s; }
}

// ─── Chuyển máy sang tổng đài viên ──────────────────────────────────────────

async function _handleTransfer(callId, callOps, lyDo) {
  const agentUri = process.env.AGENT_QUEUE_URI;
  if (!agentUri) {
    log.warn(`[WS][${callId}]AGENT_QUEUE_URI chưa cấu hình, không thể chuyển máy`);
    return;
  }

  log.info(`[WS][${callId}]Chuyển máy → ${agentUri}(lý do: ${lyDo})`);

  // Delay nhỏ để AI nói xong câu thông báo chuyển máy
  await new Promise((r) => setTimeout(r, 2000));

  try {
    await callOps.refer(callId, agentUri);
    log.info(`[WS][${callId}] Refer thành công`);
  } catch (err) {
    log.error(`[WS][${callId}] Refer thất bại: `, err.message);
  }
}
