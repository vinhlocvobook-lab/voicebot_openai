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
  startDanhBoRequest,
  // [1.1/1.4/1.5 — 26/07/2026] Hai biến tích luỹ + luồng xác minh chạy nền.
  noteDanhBoTranscript,
  danhBoSessionDigits,
  ensureDanhBoSession,
  verifyDanhBoFromSession,
  danhBoDtmfInvitePrompt,
  // [migrate 30/07/2026 — DANH_BO_MODE=confirm_tool] mở lại "cửa sổ" cho phép
  // confirm_danh_bo báo trạng thái mới mỗi khi có một lượt khách THẬT.
  noteDanhBoConfirmNewTurn,

} from "./tools.js";
import { runWithApiTrace } from "./api-trace.js";
import { log } from "./logger.js";
import { ConversationLogger } from "./conversation-logger.js";
import { insertCallStub, insertTicket } from "./log-api.js";
import { getAvailableAgents } from "./api.js";
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
  // historyDanhBo: [fix 10/08/2026, revert sau kiểm chứng thật] mã danh bộ
  // khách ĐÃ XÁC NHẬN ở (các) cuộc gọi TRƯỚC theo cùng SĐT (chỉ có khi
  // knownDanhBo rỗng — xem server.js), đưa vào customerContext qua
  // buildCustomerContextFromHistory giống hệt luồng knownDanhBo. NHƯNG khác
  // knownDanhBo: resolveDanhBo KHÔNG tin ngay dù model echo đúng số — log thật
  // (cuộc rtc_u2_EBIRJxR2Jf366tXhIOZzU) cho thấy model bỏ qua bước hỏi khách,
  // gọi thẳng tool với mã lịch sử → nếu tin ngay sẽ lộ thông tin khách KHÁC nếu
  // SĐT đã đổi chủ. Bắt qua gate xác nhận lời nói thật như bình thường (nguồn
  // "history_tel").
  // _logger: cho tools.js ghi event (vd kết quả trọng tài danh bộ) vào timeline.
  // callerPhone: [fix 05/08/2026] SĐT THẬT của người gọi — KHÁC
  // `callOps.asteriskData.phoneNumber` (trường đó đang hardcode '0967777637' cho
  // mục đích test, xem server.js hàm extractAsteriskHeaders). Dùng cho
  // leave_callback_message (tools.js) — ghi nhận lời nhắn khi không có tổng đài
  // viên rảnh, không đi qua resolveDanhBo nên không cần mã danh bộ.
  const _toolCallState = {
    knownDanhBo: callOps.knownDanhBo || [],
    historyDanhBo: callOps.historyDanhBo || [],
    _logger: logger,
    callerPhone: callOps.asteriskData?.phoneNumber_real || callOps.tel || null,
  };

  // [fix 04/08/2026] Cuộc rtc_u1_E96OlQKSLxBoNCZ4pU8Dp: hai `response.done`
  // liên tiếp (38ms) cùng chứa MỘT function_call `get_bill` giống hệt nhau
  // (cùng tên, cùng args, cùng `call_id`) — dispatchTool chạy 2 lần thật (2 khối
  // resolveDanhBo riêng biệt trong log), gửi 2 `function_call_output` cho CÙNG
  // một `call_id` (vi phạm bất biến "mỗi call_id đúng 1 output" ở CLAUDE.md), và
  // bộ đếm "model bịa số" bị cộng 2 lần cho một sự kiện logic duy nhất → leo
  // thẳng lên mời bấm phím DTMF chỉ sau một lượt đọc dở dang thật sự đầu tiên.
  // Chưa rõ nguồn gốc (OpenAI gửi trùng response.done hay WS lớp dưới phát lại)
  // — vá phòng thủ bằng cách nhớ các `call_id` đã xử lý, bỏ qua nếu gặp lại.
  const _processedToolCallIds = new Set();

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
  const _KHANG_DINH_RE = /(đúng|chính xác|chuẩn|phải rồi|vâng|dạ đúng|\bok\b|\boke\b|\bđược\b|yes)/i;
  // [fix 30/07/2026] Các từ đệm 1 âm tiết "ừ"/"ừm"/"ờ" TỪNG nằm trong
  // _KHANG_DINH_RE bằng \b — nhưng \b của JS coi MỌI ký tự có dấu tiếng Việt là
  // non-word, nên \bờ\b khớp NGAY CẢ khi "ờ" nằm giữa hai chữ cái ASCII của một
  // từ khác hoàn toàn không liên quan (vd "dời" = d+ờ+i → \b khớp ở cả hai đầu
  // "ờ", vì JS coi biên "w→non-w" và "non-w→w" đều là boundary). Cuộc
  // rtc_u1_E7L7Y2XD6JGGx1oQkIjAj: khách nói "Mình muốn nâng dời đồng hồ." (xin
  // dời đồng hồ nước, không liên quan xác nhận) nhưng bị chốt confirmed=true vì
  // chữ "dời" chứa "ờ" — cùng rủi ro với "từ", "giờ", "chờ", "sợ", "gừng",
  // "mừng"... đều là từ cực kỳ phổ biến. Sửa: chỉ coi "ừ"/"ừm"/"ờ" là xác nhận
  // khi nó là CẢ MỘT TỪ riêng trong câu NGẮN (≤2 từ, bỏ dấu câu) — không phải
  // khi khớp \b lẫn bên trong từ khác.
  const _KHANG_DINH_TU_DON_RE = /^(ừ+|ừm|ờ+)$/i;
  const _PHU_DINH_RE = /(không đúng|chưa đúng|sai rồi|\bsai\b|chưa phải|không phải)/i;
  // [fix 27/07/2026] Khách xin nghe LẠI câu bot vừa nói (không phải đổi chủ đề).
  const _XIN_NHAC_LAI_RE = /((đọc|nói|nhắc)\s+lại|chưa nghe rõ|nghe không rõ|không nghe rõ|nói gì)/i;
  const _isAffirmative = (t) => {
    const s = String(t).trim();
    if (_PHU_DINH_RE.test(s)) return false;
    // [fix 31/07/2026 đợt 12] `_KHANG_DINH_RE` khớp "vâng"/"được"/"đúng"... Ở BẤT
    // KỲ ĐÂU trong câu, nên một câu DÀI đổi hẳn sang chuyện khác nhưng lỡ mở đầu
    // bằng "Vâng," (phép lịch sự thường gặp) hoặc có chữ "được" ở cuối vẫn bị
    // chốt nhầm là XÁC NHẬN. Cuộc rtc_u1_E7Z0LRZnTro02qMeeISyy: khách nói "Vâng,
    // cho mình hỏi giờ mình lên đăng ký định mức nước hai nhân khẩu được không
    // ạ?" (đang hỏi chuyện HOÀN TOÀN khác) bị ghi nhận thành
    // "danh_bo_verbal_confirm" chỉ vì có chữ "Vâng"/"được" — may mắn số đang chờ
    // xác nhận đúng nên không lộ dữ liệu sai, nhưng đúng lỗ hổng mà gate xác nhận
    // lời nói (CLAUDE.md) được dựng lên để chặn. Câu có dấu "?" gần như chắc chắn
    // KHÔNG PHẢI một câu xác nhận thuần — khách xác nhận và hỏi tiếp trong cùng
    // một câu là tình huống hiếm, còn coi nhầm câu hỏi thành xác nhận thì rủi ro
    // lộ dữ liệu người khác. Mặc định AN TOÀN: có "?" → KHÔNG tính là xác nhận.
    if (/\?/.test(s)) return false;
    if (_KHANG_DINH_RE.test(s)) return true;
    const _tokens = s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    return _tokens.length > 0 && _tokens.length <= 2 &&
      _tokens.some((tok) => _KHANG_DINH_TU_DON_RE.test(tok));
  };

  // [fix 18/07/2026 v5] Cuộc E2yXyLXpaZz66DmCfxQBi: hủy response do prompt echo
  // để lại câu nói DỞ của bot trong context ("...đọc giúp em nguyên văn: Hai
  // hai") → model tưởng "Hai hai" là số khách vừa đọc, rồi tự bịa hội thoại 4
  // lượt liền, KHÔNG gọi confirm_danh_bo nữa, khách cúp máy.
  // → Sau khi hủy, nếu đang giữa luồng lấy mã danh bộ theo nhóm thì code tự
  // đọc lại ĐÚNG câu của bước hiện tại, kéo cuộc gọi về đúng nhịp state machine.
  // [fix 27/07/2026 đợt 8] Đi qua `_speakVerbatim` thay vì tự gửi `response.create`.
  // Bản cũ gửi thẳng nên đụng response đang chạy → `conversation_already_has_active_response`
  // (cuộc rtc_u2_E67HNE1dTVDUT80s4XixB). `_speakVerbatim` có sẵn retry chờ
  // `response.done`, kiểm tra `ws.readyState` và cấm gọi tool.
  const _reAssertDanhBoStep = (lyDo) => {
    const _prompt = _toolCallState._danhBoLastPrompt;
    if (!_prompt) return;
    if (_hungUp || _transferred) return;
    // Đã có câu đang chờ kiểm chứng (vd câu đọc lại xác nhận vừa gửi) → ĐỪNG chen
    // thêm response nữa, để cơ chế kiểm chứng của _speakVerbatim tự lo.
    if (_expectedSpeak) {
      logger.addEvent("danh_bo_step_reassert_bo_qua", `${lyDo} — đã có câu đang chờ kiểm chứng`);
      return;
    }
    setTimeout(() => {
      if (_hungUp || _transferred) return;
      if (!_toolCallState._danhBoLastPrompt) return; // đã chốt danh bộ trong lúc chờ
      if (_expectedSpeak) return;
      logger.addEvent("danh_bo_step_reasserted", `${lyDo} — đọc lại bước đang chờ`);
      log.info(`[WS][${callId}] Đọc lại bước đang chờ — ${lyDo}`);
      _speakVerbatim(_toolCallState._danhBoLastPrompt, "danh_bo_reassert", 0, { verify: true });
    }, 900);
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
  let _expectedSpeak = null; // { text, core, tag, at, retries, lastSpokenCore }

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

  // [fix 05/08/2026 đợt 22] Cuộc rtc_u1_E9Ta33OZSQDxQb28eU2YB: câu xác nhận danh
  // bộ luôn có dạng "...đọc lại mã danh bộ ... Bốn - Ba - Một. Quý Khách xác
  // nhận giúp em có đúng không ạ?" — vì `_speakCore` ưu tiên chỉ lấy dãy số khi
  // text có số, `_spokenMatchesCore` CHỈ so đúng phần số, bỏ qua hẳn câu hỏi xác
  // nhận. Bot đọc đúng 11 số nhưng THAY hẳn câu hỏi bằng một câu mời hỗ trợ khác
  // ("Nếu Quý Khách muốn kiểm tra thêm...") vẫn được tính là "khớp" — khách
  // không hề được hỏi xác nhận, trả lời lạc đề ("Định mức em."). Nhánh "khách
  // trả lời không rõ khi đang chờ xác nhận" (đợt 19) tự cứu được cuộc gọi lần
  // này, nhưng gốc rễ (verify không kiểm câu hỏi) vẫn còn. Với các tag BẮT BUỘC
  // có câu hỏi xác nhận, số đúng thôi CHƯA ĐỦ — câu hỏi phải còn nguyên.
  const _CAN_CAU_HOI_XAC_NHAN = new Set(["danh_bo_confirm", "danh_bo_reassert", "dtmf_danh_bo_confirm"]);
  const _coCauHoiXacNhan = (text) => _normTxt(text).includes("đúngkhông");

  // [fix 30/07/2026 — cuộc rtc_u1_E7DdCo6xvc1ydygN5r0Ez] Race giữa HAI cơ chế gọi
  // lại độc lập của _speakVerbatim: (1) tự chờ `_responseActive` rảnh rồi gửi
  // (nhánh attempt+1 bên dưới), và (2) `_checkExpectedSpeak` phát hiện bot nói
  // sai rồi tự lên lịch gọi lại `_speakVerbatim(text, tag, 0, {verify:true})`.
  // Cả hai đều chỉ kiểm tra `_responseActive` (do server SET qua event
  // `response.created`, có độ trễ round-trip) — nếu cả hai timer cùng đến lượt
  // trong đúng khoảng trễ đó, CẢ HAI đều thấy `_responseActive === false` và
  // CÙNG gửi `response.create` → lỗi `conversation_already_has_active_response`.
  // Cuộc gọi trên lộ ra lỗi này vì DANH_BO_MODE=unlocked làm `_responseActive`
  // dao động liên tục (model tự tạo response từ tạp âm), nhưng race này tồn tại
  // ở CẢ HAI chế độ — chỉ là locked hiếm khi có đủ điều kiện để lộ ra.
  // Sửa: thêm cờ `_verbatimSending` phủ đúng khoảng trễ giữa lúc ta gọi
  // `ws.send` và lúc server xác nhận qua `response.created` — mọi lời gọi
  // `_speakVerbatim` (từ bất kỳ cơ chế nào) trong khoảng đó đều phải xếp hàng.
  let _verbatimSending = false;
  let _verbatimSendingTimer = null;

  // [fix 05/08/2026 đợt 28] Cuộc rtc_u2_E9VIg2a3Rt4vSKwsgKc39 (19:46:49–19:47:35):
  // câu chờ "danh_bo_verify_filler" (gửi lúc khách vừa đọc đủ 11 số, TRƯỚC khi
  // đợi trọng tài gpt-5.1 ~4.7s) và câu "danh_bo_confirm" (gửi NGAY sau khi
  // trọng tài chốt xong) là HAI lượt _speakVerbatim ĐỘC LẬP, chạy gần như cùng
  // lúc — filler còn đang tự retry (bot đọc sai câu chờ liên tục) trong khi
  // confirm đã sẵn sàng gửi. Cả hai đều chỉ gate qua `_responseActive`/
  // `_verbatimSending` (dùng chung, đúng chỗ) NHƯNG mỗi lượt retry (cả nhánh
  // "đang bận, đợi 1200ms rồi thử lại" ở dưới lẫn nhánh "nói sai, gửi lại 600ms"
  // trong `_checkExpectedSpeak`) đều là MỘT `setTimeout` giữ nguyên text/tag CŨ
  // qua closure — không biết luồng đã đi tiếp sang câu KHÁC (confirm) hay chưa.
  // Kết quả thật: sau khi confirm đã gửi và bot đọc ĐÚNG câu xác nhận (03.394),
  // một retry MỒ CÔI của filler (lên lịch từ trước, tag đã lỗi thời) vẫn bắn ra
  // ở 04.139, thấy response đang rảnh nên GỬI LUÔN, ghi đè `_expectedSpeak` về
  // câu chờ đã xong nhiệm vụ — đúng lúc lẽ ra phải lắng nghe khách trả lời câu
  // hỏi xác nhận. Từ đó bot cứ lặp lại việc tự sửa câu chờ vô nghĩa, không còn
  // gắn với trạng thái thật của cuộc gọi, tới khi khách im lặng 27s rồi rớt máy
  // (WebSocket đóng 1006 — dấu hiệu khách tự cúp vì chờ quá lâu không có phản hồi
  // đúng nghĩa). Đây đúng là "chạy đua" (race) chủ dự án nghi ngờ: hai lượt gọi
  // `_speakVerbatim` cho HAI Ý ĐỊNH khác nhau (chờ / xác nhận) giành nhau đúng
  // một biến `_expectedSpeak` dùng chung, không có cách nào phân biệt "lượt gọi
  // lại này còn ý nghĩa hay đã lỗi thời".
  //
  // Sửa: gắn mỗi Ý ĐỊNH nói (không phải mỗi LẦN gọi hàm) một số thế hệ tăng dần
  // `gen`. Lượt gọi MỚI (không mang sẵn `gen` trong opts — luôn đúng với mọi
  // lời gọi "tươi" từ nơi khác trong file) luôn được coi là ý định mới nhất,
  // cấp `gen` mới và chiếm quyền "đang hoạt động". Lượt RETRY (mang theo `gen`
  // cũ qua closure/opts) trước khi làm bất cứ gì phải so `gen` của mình với
  // `gen` đang hoạt động — lệch thì coi là mồ côi, tự huỷ ngay, không gửi và
  // không tự lên lịch lại nữa.
  let _verbatimGenSeq = 0;
  let _activeVerbatimGen = 0;

  const _speakVerbatim = (text, tag, attempt = 0, opts = {}) => {
    log.info("[_speakVerbatim]:text ", text);
    log.info("[_speakVerbatim]:tag ", tag);
    log.info("[_speakVerbatim]:attempt ", attempt);
    log.info("[_speakVerbatim]:opts ", opts);

    if (_hungUp || _transferred) return;
    if (ws.readyState !== WebSocket.OPEN) return; // cuộc gọi đã kết thúc

    if (opts.verify) {
      if (opts.gen === undefined) {
        // Lượt gọi TƯƠI (không phải retry mang gen cũ) → luôn là ý định mới
        // nhất, chiếm quyền hoạt động ngay (kể cả khi phải xếp hàng chờ vì bận
        // — xem nhánh busy bên dưới, opts đã có gen nên các lần rescheduled
        // của CHÍNH nó vẫn hợp lệ).
        opts.gen = ++_verbatimGenSeq;
        _activeVerbatimGen = opts.gen;
      } else if (opts.gen !== _activeVerbatimGen) {
        // Retry mồ côi — một ý định KHÁC (gen mới hơn) đã chiếm chỗ từ khi lượt
        // này được lên lịch. Huỷ hẳn, không gửi, không tự lên lịch lại nữa.
        log.warn(`[WS][${callId}] _speakVerbatim(${tag}) đã lỗi thời (gen ${opts.gen} ≠ ${_activeVerbatimGen} đang hoạt động) → bỏ, không gửi.`);
        logger.addEvent("speak_verbatim_stale_skip", `${tag} gen=${opts.gen} activeGen=${_activeVerbatimGen}`);
        return;
      }
    }

    if (_responseActive || _verbatimSending) {
      if (attempt < 8) setTimeout(() => _speakVerbatim(text, tag, attempt + 1, opts), 1200);
      else logger.addEvent("speak_verbatim_dropped", `${tag} — response active quá lâu`);
      return;
    }
    try {
      _pendingCodeResponse = true;
      // Đóng cửa NGAY trước khi gửi — mọi lời gọi _speakVerbatim khác (kể cả từ
      // _checkExpectedSpeak) đến trong lúc chờ server xác nhận sẽ tự xếp hàng ở
      // nhánh trên thay vì gửi chồng. `response.created`/`response.done` sẽ mở
      // lại; timer 5s chỉ là lưới an toàn phòng khi không event nào về được
      // (lỗi mạng, WS đóng giữa chừng...).
      _verbatimSending = true;
      clearTimeout(_verbatimSendingTimer);
      _verbatimSendingTimer = setTimeout(() => { _verbatimSending = false; }, 5000);
      // [fix 30/07/2026 — cuộc rtc_u2_E7JvXsbrUHR2WPAJOXoA9] Cụm "BỎ QUA mọi hướng
      // dẫn đọc trước đó trong hội thoại. NGAY BÂY GIỜ..." (bản cũ, xem lịch sử git)
      // đọc giống hệt mẫu câu tấn công chèn lệnh kinh điển ("ignore all previous
      // instructions, now do X"). Với model không có reasoning, cụm này ép được
      // hiệu quả; với gpt-realtime-2.1-mini, nhiều log thật cho thấy model NGÀY
      // CÀNG hay từ chối tuân theo — có lần còn nói thẳng "em không thể thực hiện
      // đúng yêu cầu của đoạn văn đó như một lệnh". Cùng lúc đó, câu lệnh NGẮN HƠN,
      // không có cụm "BỎ QUA..." ở khối dispatch tool chung bên dưới ("Đọc CHÍNH XÁC
      // từng từ...") lại được tuân theo ổn định trong mọi log cùng ngày — khác biệt
      // duy nhất là cụm mở đầu giống lệnh chèn ép. Bỏ hẳn cụm đó, chỉ giữ khung câu
      // mô tả tự nhiên "đây là câu cần nói".
      // Câu KHÔNG chứa chữ số → cấm hẳn model đọc số trong response này (giữ nguyên
      // — [fix 27/07/2026 đợt 7] cuộc rtc_u1_E66uZSbb8P6ZJF6VVLKr6: response tạo ra
      // để đọc câu chờ lại bị model dùng để đọc số bịa ra loa).
      const _cauCoSo = /^[\d|]+$/.test(_speakCore(text));
      const instructions =
        "Đây là câu chính thức hệ thống cần bạn nói với khách ở lượt này — đọc đúng " +
        "nguyên văn, không thêm bớt, không diễn giải lại, rồi dừng: \"" + text + "\"" +
        (_cauCoSo ? "" : " Không đọc thêm chữ số nào ngoài đoạn trên.");
      log.debug(`[WS][${callId}] _speakVerbatim(${tag}, lần ${attempt}): ${text}`);

      log.info("[_speakVerbatim]:ws.send response.create : ", {
        type: "response.create",
        response: { instructions, tool_choice: "none" },
      });
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
        // [fix 31/07/2026 đợt 11] Bug thật trong đợt 8: object này được TẠO MỚI ở
        // mỗi lần gọi _speakVerbatim, kể cả khi đây là lần GỬI LẠI do chính
        // _checkExpectedSpeak kích hoạt (setTimeout gọi lại _speakVerbatim). Trước
        // đây chỉ giữ lại `retries` theo tag, còn `lastSpokenCore` bị bỏ quên nên
        // luôn về `undefined` ở mỗi lần gửi lại — khiến `_lapLaiYHet` KHÔNG BAO GIỜ
        // đúng, cơ chế "bỏ cuộc sớm khi bot lặp lỗi y hệt" (đợt 8) vô tác dụng.
        // Cuộc rtc_u1_E7Z0LRZnTro02qMeeISyy: bot đọc "...Bảy-Bảy-Bảy-Năm" (thừa 7)
        // Y HỆT 2 lần liên tiếp nhưng vẫn phải đợi đủ 3 lần mới bỏ cuộc, thay vì
        // phát hiện lặp và bỏ cuộc ngay ở lần 2. Giữ nguyên `lastSpokenCore` theo
        // cùng điều kiện "cùng tag" như `retries`.
        const _tiepTucCungTag = _expectedSpeak?.tag === tag;
        _expectedSpeak = {
          text, tag, core: _speakCore(text), at: Date.now(),
          retries: _tiepTucCungTag ? (_expectedSpeak.retries || 0) : 0,
          lastSpokenCore: _tiepTucCungTag ? _expectedSpeak.lastSpokenCore : undefined,
          // [fix 05/08/2026 đợt 28] Giữ lại gen để `_checkExpectedSpeak` gửi kèm
          // khi tự lên lịch gọi lại — xem giải thích ở khai báo `_verbatimGenSeq`.
          gen: opts.gen,
        };
      }
    } catch (e) {
      // Gửi lỗi → mở lại cửa ngay, đừng bắt lượt gọi lại kế tiếp chờ hết 5s.
      _verbatimSending = false;
      clearTimeout(_verbatimSendingTimer);
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
    // [fix 31/07/2026 đợt 13] Đợt 9 chỉ tắt watchdog khi ĐÃ CÓ ứng viên
    // (action==="confirm", sau khi trọng tài chạy xong) — vẫn còn khoảng hở:
    // debounce `_DANHBO_DEBOUNCE_DU_MS` (1500ms) TRƯỚC khi verify thật sự chạy,
    // cộng thời gian gọi trọng tài, đều nằm NGOÀI phạm vi bảo vệ đó. Cuộc
    // rtc_u0_E7ZC4KI88GN0QNHZRjhjX: khách vừa đọc đủ 11/11 số sạch (phiên #3),
    // watchdog 90s (đếm từ rất lâu trước, không gia hạn) hết hạn CHỈ 719ms sau —
    // tức là NGAY TRONG lúc debounce đang chờ, trước cả khi verify/trọng tài kịp
    // chạy — mời bấm phím luôn, bỏ lỡ hẳn cơ hội xác nhận bằng giọng nói dù khách
    // vừa đọc đúng. Tắt watchdog ngay khi biết đã ĐỦ 11 số (trước debounce), coi
    // như "đang tích cực xử lý, không phải bế tắc". Re-arm lại ở nhánh "reread"
    // bên dưới nếu cuối cùng vẫn không chốt được (khi đó lại thật sự cần chờ
    // khách đọc lại, watchdog phải tiếp tục đếm).
    if (_du) _clearDanhBoWatchdog();

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
          _speakVerbatim("Dạ, em ghi nhận rồi ạ, Quý Khách chờ em một chút.", "danh_bo_verify_filler", 0, { verify: true });
        }
        const r = await verifyDanhBoFromSession(_toolCallState, { chapNhanThieuSo: true });
        if (_hungUp || _transferred) return;
        if (r.action === "none" || !r.prompt) {
          // [fix 31/07/2026 đợt 13] Nhánh thoát sớm — không có gì để nói. Nếu lúc
          // vào hàm này `_du` đã tắt watchdog (đủ 11 số) mà cuối cùng verify vẫn
          // không quyết định được gì (hiếm, nhưng không loại trừ), phải bật lại,
          // không được để mất hẳn lưới an toàn.
          if (_du) _armDanhBoWatchdog();
          return;
        }
        _toolCallState._danhBoLastPrompt = r.prompt;
        logger.addEvent(`danh_bo_${r.action}`, r.value ? `${r.by}: ${r.value}` : r.prompt);
        log.info(`[WS][${callId}] danh_bo_${r.action}${r.value ? ` → ${r.value} (${r.by})` : ""}`);
        // [fix 31/07/2026 đợt 9] Đã có ứng viên để đọc lại xác nhận → tắt watchdog
        // 90s NGAY, đừng đợi tới lúc khách xác nhận bằng lời. Watchdog này đếm từ
        // lần đầu _armDanhBoWatchdog() và KHÔNG tự gia hạn theo hoạt động sau đó
        // (xem _armDanhBoWatchdog) — cuộc rtc_u2_E7YQCdKECKBoFNKzFMRpe: khách vừa
        // đọc sạch 11 số, trọng tài vừa chốt xong (candidate_ready) thì ĐÚNG khoảnh
        // khắc đó watchdog 90s (đếm từ rất lâu trước) hết hạn → bot vừa mời BẤM
        // PHÍM xong lại quay ra đọc lại xác nhận bằng giọng nói, khách nghe rối.
        // Đã có ứng viên nghĩa là hết lý do "không tìm ra được số nào" — tắt watchdog
        // ở đây (CHỈ action==="confirm", KHÔNG áp cho "reread": mời đọc lại nghĩa
        // là VẪN chưa có ứng viên, watchdog phải tiếp tục đếm). Nếu khách phủ
        // định/đọc lại sau đó, lượt đọc số kế tiếp tự bật lại nó (_armDanhBoWatchdog
        // không gia hạn khi đang chạy nhưng vẫn tự set lại từ null).
        if (r.action === "confirm") {
          _clearDanhBoWatchdog();
        } else {
          // [fix 31/07/2026 đợt 13] Trọng tài không chốt được dù đã đủ số (hoặc
          // đang mời đọc lại) → thật sự vẫn bế tắc, bật lại watchdog đã tắt tạm ở
          // trên (khi vào hàm này với `_du===true`). Không có lượt khách nào chen
          // giữa để tự bật lại như bình thường — nếu không re-arm ở đây, cuộc gọi
          // mất hẳn lưới an toàn 90s cho tới lượt đọc số kế tiếp.
          _armDanhBoWatchdog();
        }
        // [migrate 30/07/2026] confirm_tool: CHỈ bước "đã có ứng viên, chờ xác
        // nhận" (action === "confirm") đổi cơ chế — mời đọc lại (action !==
        // "confirm", vẫn ở giai đoạn gom số thô) giữ nguyên `_speakVerbatim`.
        if (_DANHBO_CONFIRM_TOOL && r.action === "confirm") {
          _openDanhBoConfirmTurn("candidate_ready");
        } else {
          _speakVerbatim(r.prompt, `danh_bo_${r.action}`, 0, { verify: true });
        }
      } catch (e) {
        log.warn(`[WS][${callId}] verifyDanhBoFromSession lỗi: `, e.message);
        // [fix 31/07/2026 đợt 13] Lỗi giữa chừng → không chốt được gì, bật lại
        // watchdog nếu đã tắt tạm ở trên, cùng lý do với nhánh "none" phía trên.
        if (_du) _armDanhBoWatchdog();
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
  // [fix 10/08/2026] `shouldSkip` (tuỳ chọn): hàm trả true nếu điều kiện gọi lúc
  // ĐẶT LỊCH không còn đúng lúc THỰC SỰ gửi nữa — cần vì hàm này tự retry theo
  // setTimeout khi `_responseActive`, có thể tới lúc gửi được thì việc đã xong
  // rồi. Cuộc rtc_u0_EBIZRYDfQl3VhWK9fO3iw (10/08/2026): khách nói "Đúng rồi.",
  // response.created đã kích hoạt TỪ TRƯỚC (VAD bắt audio, không đợi transcript)
  // nên `_responseActive` đang true khi code gọi `_requestModelReply("khách đã
  // xác nhận mã danh bộ"...)` → retry dời sau 1.2s. Trong lúc chờ, chính response
  // đang chạy đó lại là lượt model TỰ gọi get_bill + đọc kết quả (đúng ý muốn),
  // nhưng hàm cứ retry mù tới khi `_responseActive` rảnh rồi VẪN gửi nudge — bot
  // đọc lại y hệt kết quả hóa đơn lần 2. `shouldSkip` cho phép huỷ nudge nếu mục
  // đích đã đạt được bởi một đường khác trong lúc chờ.
  const _requestModelReply = (lyDo, instructions = null, attempt = 0, shouldSkip = null) => {
    if (_hungUp || _transferred) return;
    if (ws.readyState !== WebSocket.OPEN) return;
    if (shouldSkip && shouldSkip()) {
      logger.addEvent("model_reply_skipped", `${lyDo} — mục đích đã đạt được bởi đường khác, huỷ nudge`);
      log.info(`[WS][${callId}] Bỏ nudge "${lyDo}" — đã có đường khác xử lý xong trong lúc chờ.`);
      return;
    }
    if (_responseActive) {
      // Đang nói dở → chờ xong rồi tạo, đừng để câu của khách rơi vào im lặng.
      if (attempt < 5) setTimeout(() => _requestModelReply(lyDo, instructions, attempt + 1, shouldSkip), 1200);
      else logger.addEvent("model_reply_dropped", `${lyDo} — response active quá lâu`);
      return;
    }
    try {
      _pendingCodeResponse = true;
      log.info("[_requestModelReply]:ws.send : ", {
        type: "response.create",
        response: instructions ? { instructions } : {},
      });

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
   * [fix 31/07/2026] Khi bỏ cuộc (mismatch giveup) ở đúng bước ĐỌC LẠI XÁC NHẬN
   * mã danh bộ, chủ động mời bấm phím NGAY thay vì để cuộc gọi treo chờ watchdog
   * 90s. Cuộc rtc_u1_E7Y8JfPoOL8KgiX7EOOtY: bỏ cuộc lúc 10:24:34 nhưng phải đợi
   * tới 10:25:43 (>1 phút chết) watchdog mới tự mời bấm phím — trong khi lúc đó
   * hệ thống ĐÃ có sẵn ứng viên đúng (API + trọng tài đồng thuận), chỉ là BOT
   * không đọc lại đúng được — không có lý do gì phải chờ thêm.
   */
  const _escalateDanhBoToDtmf = (lyDo) => {
    if (_hungUp || _transferred) return;
    if (_toolCallState.danhBo?.confirmed) return;
    if (_toolCallState._danhBoDtmfInvited) {
      // [fix 05/08/2026 đợt 20] Cuộc rtc_u1_E9LkfCNs3Zs6eNiIHxbXb: bot bỏ cuộc đọc
      // xác nhận giọng nói → mời bấm phím (đúng thiết kế, mở đầu bằng nhánh trên).
      // Khách bấm ĐÚNG 11 số qua DTMF, nhưng khi bot đọc lại xác nhận số đó
      // (`dtmf_danh_bo_confirm`) lại LIÊN TỤC rớt mất đúng chữ "Bảy" trong chuỗi
      // "Bốn - Bảy - Bốn" (lỗi phát âm TTS mang tính hệ thống, cùng loại đã ghi
      // ở đợt 31/07 — không phải do dữ liệu sai, DTMF vốn "chính xác tuyệt đối")
      // → bỏ cuộc LẦN HAI, rơi đúng vào nhánh này. Guard cũ chỉ `return` — không
      // còn kênh tự động nào khác để mời (đã dùng cả giọng nói lẫn DTMF), khách bị
      // bỏ mặc trong im lặng tuyệt đối cho tới khi tự cúp máy (17 giây im lặng
      // rồi WebSocket đóng). Đã có dữ liệu ĐÚNG (khách vừa bấm), hệ thống chỉ là
      // không tự đọc lại xác nhận được — chuyển máy cho tổng đài viên NGAY thay vì
      // im lặng, đúng tinh thần "Bot câm tệ hơn bot trả lời sai".
      if (_transferred) return;
      _transferred = true;
      logger.setOutcome("transferred");
      logger.addEvent("danh_bo_confirm_giveup_transfer", lyDo);
      log.warn(`[WS][${callId}] ${lyDo} — đã mời bấm phím rồi vẫn bỏ cuộc, không còn kênh tự động → chuyển máy tổng đài viên.`);
      _setVadMode("normal");
      _speakVerbatim(
        "Dạ, em xin lỗi Quý Khách vì sự bất tiện này ạ. Em xin phép chuyển máy cho tổng đài viên hỗ trợ Quý Khách ngay ạ.",
        "danh_bo_giveup_transfer", 0, { verify: false }
      );
      _handleTransfer(callId, callOps, lyDo).catch((e) =>
        log.warn(`[WS][${callId}] _handleTransfer lỗi (danh_bo_giveup_transfer): `, e.message));
      return;
    }
    const prompt = danhBoDtmfInvitePrompt(_toolCallState);
    if (!prompt) return;
    _toolCallState._danhBoLastPrompt = prompt;
    _setVadMode("normal");
    logger.addEvent("danh_bo_confirm_giveup_dtmf", lyDo);
    log.warn(`[WS][${callId}] ${lyDo} → mời bấm phím ngay, không chờ watchdog.`);
    _speakVerbatim(prompt, "danh_bo_watchdog_dtmf", 0, { verify: true });
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

    // [fix 05/08/2026 đợt 22] Số đúng thôi chưa đủ với tag cần câu hỏi xác nhận —
    // xem chú thích ở khai báo `_CAN_CAU_HOI_XAC_NHAN` phía trên.
    const _canHoi = _CAN_CAU_HOI_XAC_NHAN.has(exp.tag) && _coCauHoiXacNhan(exp.text);
    if (_spokenMatchesCore(spoken, exp.core) && (!_canHoi || _coCauHoiXacNhan(spoken))) {
      _expectedSpeak = null; // bot đã đọc đúng (giữ đủ câu hỏi xác nhận nếu tag cần)
      return;
    }

    // [fix 31/07/2026] Cuộc rtc_u1_E7Y8JfPoOL8KgiX7EOOtY: bot đọc SAI y hệt nhau
    // ("...Bảy - Bảy - Bảy - Năm" — thừa đúng một chữ "Bảy" so với câu yêu cầu)
    // ở CẢ 3 lần thử, kể cả sau khi gửi lại y nguyên instructions — cho thấy đây
    // là lỗi phát âm số lặp (hai chữ số giống nhau liền kề) mang tính hệ thống
    // của model cho đúng chuỗi này, không phải nhiễu ngẫu nhiên. Gửi lại y
    // nguyên một lần nữa gần như chắc chắn ra lại đúng lỗi cũ — lãng phí thời
    // gian của khách. Phát hiện: nếu lần lệch này GIỐNG HỆT lần lệch ngay trước
    // (cùng dãy số bot vừa đọc) thì bỏ cuộc SỚM thay vì đợi đủ 3 lần.
    const _spokenCoreNow = _speakCore(spoken);
    const _lapLaiYHet = exp.lastSpokenCore && exp.lastSpokenCore === _spokenCoreNow;

    if (exp.retries >= 2 || _lapLaiYHet) {
      const _lyDoGiveup = _lapLaiYHet
        ? `${exp.tag} — bot lặp lại y hệt lỗi cũ ("${spoken.slice(0, 60)}"), bỏ cuộc sớm`
        : `${exp.tag} — bot nói khác 3 lần`;
      logger.addEvent("speak_verbatim_mismatch_giveup", _lyDoGiveup);
      log.error(`[WS][${callId}] Bot KHÔNG đọc được câu "${exp.tag}" — bỏ cuộc (${_lyDoGiveup}).`);
      _expectedSpeak = null;
      // Chỉ leo thang DTMF khi bỏ cuộc đúng ở bước đọc lại xác nhận mã danh bộ —
      // các câu ép đọc khác (chào, tạm biệt, chờ...) không liên quan tới DTMF.
      // [fix 05/08/2026 đợt 23] Cuộc rtc_u0_E9TxnYZlW5VqDTcPRsxrt: sau khi
      // "danh_bo_reassert" bỏ cuộc, `_escalateDanhBoToDtmf` mời bấm phím (tag
      // "danh_bo_watchdog_dtmf") — nhưng CHÍNH câu mời đó cũng bị model đọc lạc
      // đề liên tục (chào lại từ đầu, cảm ơn chung chung...), 2 lần gửi lại đều
      // sai, khách cúp máy trước khi biết kết quả lần 3. Trước đây tag này
      // KHÔNG nằm trong whitelist gọi `_escalateDanhBoToDtmf`, nên khi chính câu
      // mời DTMF cũng đọc sai 3 lần, không escalate tiếp — cuộc gọi treo tới khi
      // khách tự cúp, không hề chuyển máy. Vì `danhBoDtmfInviteResponse` đã set
      // `_danhBoDtmfInvited=true` ngay từ lần mời đầu, gọi lại
      // `_escalateDanhBoToDtmf` cho tag này sẽ tự rơi vào guard đợt 20 (chuyển
      // máy tổng đài viên) thay vì mời DTMF lần nữa — đúng tinh thần "cả 2 kênh
      // tự động đã thất bại thì chuyển máy" đã áp dụng cho các tag khác.
      if (exp.tag === "danh_bo_confirm" || exp.tag === "dtmf_danh_bo_confirm" ||
        exp.tag === "danh_bo_reassert" || exp.tag === "danh_bo_watchdog_dtmf") {
        _escalateDanhBoToDtmf(_lyDoGiveup);
      }
      return;
    }
    exp.retries += 1;
    exp.lastSpokenCore = _spokenCoreNow;
    logger.addEvent("speak_verbatim_mismatch", `${exp.tag} — bot nói "${spoken.slice(0, 60)}", gửi lại lần ${exp.retries}`);
    log.warn(`[WS][${callId}] Bot nói KHÁC câu yêu cầu (${exp.tag}) → gửi lại lần ${exp.retries}.`);
    const { text, tag } = exp;
    // [fix 05/08/2026 đợt 28] Gửi kèm gen cũ — nếu một Ý ĐỊNH nói KHÁC đã chiếm
    // quyền hoạt động trong lúc chờ 600ms này, `_speakVerbatim` sẽ tự nhận ra
    // mồ côi và bỏ, không gửi đè lên câu đang thật sự cần nói.
    setTimeout(() => _speakVerbatim(text, tag, 0, { verify: true, gen: exp.gen }), 600);
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
  // [migrate 30/07/2026] MỨC C (create_response:false) là lưới an toàn ĐÃ KIỂM
  // CHỨNG cho model không có/yếu reasoning. Với gpt-realtime-2.1.x (cải thiện
  // "alphanumeric recognition, silence and noise handling, interruption
  // behavior" theo model card), DANH_BO_MODE=unlocked cho phép THỬ NGHIỆM để
  // model tự trả lời trong giai đoạn đọc số (dựa vào mục "Thu thập mã danh bộ"
  // trong system-prompt.js + tool wait_for_user), thay vì bị khoá cứng API-level.
  // Mọi lưới an toàn khác (phát hiện số bịa, kiểm chứng câu nói, watchdog) VẪN
  // hoạt động ở cả hai chế độ — chỉ khác ở chỗ model có được tự nói hay không
  // trong lúc khách đọc số. Mặc định "locked" (an toàn, đã kiểm chứng nhiều
  // cuộc gọi thật). Xem docs/fix/fix_migrate_gpt_realtime_21_20260730.md.
  const _DANHBO_UNLOCKED = String(process.env.DANH_BO_MODE || "locked").trim().toLowerCase() === "unlocked";
  // [migrate 30/07/2026] Thử nghiệm THỨ HAI, khác hẳn "unlocked": giai đoạn GOM
  // SỐ THÔ vẫn khoá y hệt "locked" (create_response:false, không đổi — đây không
  // phải chỗ xung đột và vẫn cần chặn model đọc số bịa ra loa). CHỈ mở khoá ở
  // giai đoạn XÁC NHẬN (đã có callState.danhBo.value) — model tự đọc câu xác
  // nhận qua tool `confirm_danh_bo` mới, thay vì bị code ép đọc nguyên văn qua
  // `_speakVerbatim`. Xem docs/fix/fix_migrate_gpt_realtime_21_20260730.md.
  const _DANHBO_CONFIRM_TOOL = String(process.env.DANH_BO_MODE || "locked").trim().toLowerCase() === "confirm_tool";
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
        // ── MỨC C (26/07/2026 đợt 5) — mặc định, DANH_BO_MODE=locked ─────────
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
        //
        // [migrate 30/07/2026] DANH_BO_MODE=unlocked → true: model được tự trả
        // lời mỗi lượt (kể cả khi khách đang đọc số dở dang) — THỬ NGHIỆM, cần
        // tự kiểm chứng bằng cuộc gọi thật trước khi coi là mặc định.
        // [FIX 30/07/2026 — phát hiện khi wire confirm_tool] Công thức cũ
        // `!_DANHBO_UNLOCKED` bị NGƯỢC dấu so với đúng chú thích ngay phía trên:
        // _DANHBO_UNLOCKED=false (locked, mặc định) → !false = TRUE → model
        // KHÔNG bị khoá trong giai đoạn gom số dù DANH_BO_MODE=locked; ngược lại
        // _DANHBO_UNLOCKED=true (unlocked) → !true = FALSE → model bị khoá đúng
        // lúc lẽ ra phải được thả. Sửa thành so trực tiếp — không phủ định.
        // "confirm_tool" (mode mới) cũng đi qua field này và cần y hệt "locked"
        // (gom số vẫn khoá cứng, chỉ khác ở giai đoạn xác nhận — xem
        // _openDanhBoConfirmTurn) nên _DANHBO_UNLOCKED=false cho cả hai là đúng.
        create_response: _DANHBO_UNLOCKED,
        interrupt_response: true,
      }
      : {
        type: "semantic_vad",
        eagerness: "low",
        create_response: true,
        interrupt_response: true,
      };
    try {
      log.info("[set_vad_mode]:ws.send : ", {
        type: "session.update",
        session: { type: "realtime", audio: { input: { turn_detection: JSON.stringify(turn_detection, null, 2) } } },
      });
      log.info("[set_vad_mode]: turn_detection : ", turn_detection);
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

  // ── [migrate 30/07/2026 — DANH_BO_MODE=confirm_tool] Mở lượt cho model tự gọi
  // confirm_danh_bo ──────────────────────────────────────────────────────────
  // KHÔNG có lượt audio nào của khách để bám vào ở đúng thời điểm này (khách đã
  // đọc xong 11 số rồi im chờ, hoặc vừa nói "đúng" — cả hai đều xảy ra GIỮA hai
  // lượt, không đồng bộ với VAD). Model chỉ được sinh phản hồi khi có lượt audio
  // thật HOẶC code tự gửi response.create — nên "trả quyền cho model" ở bước
  // này KHÔNG có nghĩa model tự quyết được KHI NÀO nói (code vẫn phải khơi mào),
  // chỉ khác ở chỗ code không còn ép NÓI CHÍNH XÁC CÂU GÌ — ép bằng `tool_choice`
  // gọi đúng hàm `confirm_danh_bo`, để model tự đọc kết quả theo giọng tự nhiên.
  //
  // Dùng LẠI đúng hàng đợi `_verbatimSending`/`_responseActive` của `_speakVerbatim`
  // (race đã vá 30/07) — đây là cùng một hành động "code chủ động gửi
  // response.create", không phải một đường gửi mới chưa qua kiểm chứng.
  // [fix 10/08/2026] `shouldSkip`: cùng lý do với _requestModelReply ở trên —
  // hàm này cũng tự retry theo setTimeout khi đang có response/verbatim chạy,
  // nên tới lúc gửi được có thể việc cần làm đã xong bởi model tự chủ động rồi.
  const _openDanhBoConfirmTurn = (lyDo, attempt = 0, shouldSkip = null) => {
    if (_hungUp || _transferred) return;
    if (ws.readyState !== WebSocket.OPEN) return;
    if (shouldSkip && shouldSkip()) {
      logger.addEvent("danh_bo_confirm_turn_skipped", `${lyDo} — mục đích đã đạt được bởi đường khác, huỷ`);
      log.info(`[WS][${callId}] Bỏ mở lượt confirm_danh_bo "${lyDo}" — đã có đường khác xử lý xong trong lúc chờ.`);
      return;
    }
    if (_responseActive || _verbatimSending) {
      if (attempt < 8) setTimeout(() => _openDanhBoConfirmTurn(lyDo, attempt + 1, shouldSkip), 1200);
      else logger.addEvent("danh_bo_confirm_turn_dropped", `${lyDo} — response active quá lâu`);
      return;
    }
    // Mở khoá CHỈ ở đây — giai đoạn gom số thô (`_armDanhBoWatchdog` gọi
    // `_setVadMode("digits")`) không đổi, vẫn create_response:false như "locked".
    _setVadMode("normal");
    try {
      _pendingCodeResponse = true;
      _verbatimSending = true;
      clearTimeout(_verbatimSendingTimer);
      _verbatimSendingTimer = setTimeout(() => { _verbatimSending = false; }, 5000);
      // [cần đối chiếu doc Realtime] Ép tool_choice gọi ĐÚNG một hàm cụ thể —
      // dùng cơ chế API ép cấu trúc, không phụ thuộc việc model có tuân thủ
      // hướng dẫn bằng lời hay không (bài học từ mọi lần mini "quên" chỉ dẫn cũ).
      const response = {
        instructions:
          "Gọi NGAY tool confirm_danh_bo để lấy trạng thái mã danh bộ hiện tại, " +
          "rồi xử lý đúng theo trường trang_thai_danh_bo trong kết quả trả về.",
        tool_choice: { type: "function", name: "confirm_danh_bo" },
      };
      log.info("[_openDanhBoConfirmTurn]:ws.send response.create : ", { type: "response.create", response });
      ws.send(JSON.stringify({ type: "response.create", response }));
      logger.addEvent("danh_bo_confirm_turn_opened", lyDo);
      log.info(`[WS][${callId}] Mở lượt confirm_danh_bo — ${lyDo}`);
    } catch (e) {
      _verbatimSending = false;
      clearTimeout(_verbatimSendingTimer);
      log.warn(`[WS][${callId}] không mở được lượt confirm_danh_bo (${lyDo}): `, e.message);
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
    log.info("[armMuteWatchdog]");
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
    log.info("[armDanhBoWatchdog]");
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
    const greetingInstruction = 'Đọc CHÍNH XÁC từng từ câu sau, không thêm bớt, không diễn giải lại: " Alo! Alo! Xin chào Quý Khách, Cảm ơn Quý Khách đã gọi đến Tổng đài Công ty Cổ phần Cấp nước Trung An. Em là Trợ lý Ảo Ây Ai, Quý khách cần em hỗ trợ gì ạ? Nếu Quý Khách muốn gặp trực tiếp tổng đài viên thì nói em chuyển máy cho tổng đài viên nhé!"';

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
        log.info("....response.created....: AI bắt đầu sinh phản hồi, do VAD kích hoạt hoặc do code yêu cầu");
        _responseActive = true;
        // [fix 30/07/2026] Server đã xác nhận có response đang chạy → đóng cửa
        // sổ race của _speakVerbatim (xem khai báo _verbatimSending) không cần
        // chờ hết 5s nữa; `_responseActive` từ đây sẽ tự gate các lượt gọi mới.
        _verbatimSending = false;
        clearTimeout(_verbatimSendingTimer);
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
        log.info("....response.created....: ", `trigger: ${_activeResponseTriggerItemId ?? "code"} ....................`);
        break;

      // ── Response hoàn chỉnh → kiểm tra có function_call không ─────────────
      // Theo pattern của openai_nestle_step3.js: bắt function call qua
      // response.done → response.output[], lọc item.type === "function_call".

      case "response.done": {
        log.info("....response.done....: AI đã nói xong trọn vẹn câu thoại hoặc bị ngắt/hủy");
        if (_pendingCodeResponse) {
          log.info("[response.done]: Response do code tạo, đánh dấu đã hoàn thành ");
        } else {
          log.info("[response.done]: Response do VAD kích hoạt, đánh dấu đã hoàn thành ");
        }
        _responseActive = false;
        _activeResponseTriggerItemId = null; // [fix 18/07/2026] response xong → hết gắn với item nào
        // [fix 18/07/2026 v2] Response HOÀN TẤT (không bị cancel/interrupt) →
        // lượt khách gần nhất coi như đã được trả lời. Response dở dang
        // (cancelled/incomplete) KHÔNG tính — câu hỏi vẫn chưa được đáp.
        console.log("...response.done....:event.response.status = ", { status: event?.response?.status });
        //completed : mô hình sinh xong văn bản, không bị gián đoạn
        //cancelled : Khách ngắt nói hoặc code gởi lệnh huỷ
        //incomplete : bị giới hạn token, bị kiểm duyệt, audio stream bị lỗi
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
        if (!Array.isArray(output) || output.length === 0) {
          // [fix 05/08/2026 đợt 26] Trước đây break im lặng — response hoàn
          // tất mà KHÔNG có output nào (bot không nói gì, không gọi tool) là
          // dấu hiệu "im lặng bí ẩn" khó phát hiện khi đọc log (không có dòng
          // nào khác biệt so với response bình thường ngoài việc thiếu hẳn
          // dòng "[AI nói]"). Log rõ ràng ra để debug các cuộc "ngáo" sau này.
          log.warn(`[WS][${callId}] response.done KHÔNG có output nào (bot không nói gì, không gọi tool) — status=${_respStatus}`);
          logger.addEvent("response_empty_output", `status=${_respStatus}`);
          break;
        }

        // [fix 27/07/2026] Một response.done có thể chứa NHIỀU function_call.
        // Gom kết quả tool cuối cùng, chỉ tạo ĐÚNG MỘT response sau vòng lặp.
        let _ketQuaToolCuoi = null;

        for (const item of output) {
          if (item?.type !== "function_call") continue;

          const toolCallId = item.call_id;
          // [fix 04/08/2026] Xem chú thích ở khai báo `_processedToolCallIds` —
          // cùng một call_id KHÔNG được xử lý (và gửi function_call_output) quá
          // một lần, bất kể do response.done trùng lặp hay bất kỳ nguyên nhân nào.
          if (toolCallId && _processedToolCallIds.has(toolCallId)) {
            log.warn(`[WS][${callId}] Bỏ qua function_call trùng call_id đã xử lý: ${toolCallId} (${item.name})`);
            logger.addEvent("tool_call_duplicate_ignored", `${item.name} call_id=${toolCallId}`);
            continue;
          }
          if (toolCallId) _processedToolCallIds.add(toolCallId);

          const name = item.name;
          const argsStr = item.arguments;
          log.info("----------------------Tool calling -------------------------------");
          log.info("function name = ", name);
          log.info("function args = ", argsStr);
          log.info(`[WS][${callId}] Tool call: ${name}(${argsStr})`);

          let args = {};
          try { args = JSON.parse(argsStr); } catch (e) {
            // [fix 07/08/2026] Cuộc rtc_u7_EABQDU5tpimk6LbvxKJrg: model
            // (leave_callback_message) trả `arguments` KHÔNG PHẢI JSON hợp lệ —
            // lẫn cả một đoạn văn bản tiếng Anh giống "chain of thought" bị rò rỉ
            // ("It's created? tool returned?...") và một khối khoảng trắng khổng
            // lồ, thay vì dừng ở dấu `}` đóng JSON. Trước đây lỗi này bị NUỐT ÂM
            // THẦM (falls back args={}), rất khó phát hiện nếu không đọc log thô
            // từng dòng như lần này. Bot vẫn gọi tool với args rỗng → tool báo
            // thiếu tham số → model TỰ gọi lại với args sạch ở lượt sau (tự phục
            // hồi, không cần code can thiệp) — nhưng nếu tool có tham số bắt buộc
            // mà thiếu validate rõ ràng, lỗi có thể trôi qua âm thầm hơn. Ghi WARN
            // + event để các cuộc glitch tương tự sau này dễ phát hiện qua log,
            // không cần đọc thủ công từng dòng.
            log.warn(`[WS][${callId}] arguments của "${name}" KHÔNG PHẢI JSON hợp lệ (${e.message}) — dùng args rỗng. Raw (200 ký tự đầu): ${String(argsStr).slice(0, 200)}`);
            logger.addEvent("tool_args_parse_error", `${name}: ${e.message} — raw_len=${String(argsStr).length}`);
          }

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
          // [fix 07/08/2026] leave_callback_message xử lý GIỐNG create_ticket ở
          // bước lưu local (theo yêu cầu chủ dự án) — args của nó không có
          // `loai`/`mo_ta` (chỉ `noi_dung` + `ma_danh_bo` không bắt buộc) nên map
          // sang đúng field insertTicket() đang đọc; customerTel dùng SĐT THẬT
          // của người gọi (_toolCallState.callerPhone) thay vì số hardcode test.
          if (name === "create_ticket" || name === "leave_callback_message") {
            insertTicket({
              callId,
              customerTel: name === "leave_callback_message"
                ? (_toolCallState.callerPhone || callOps.asteriskData?.phoneNumber || callOps.tel)
                : (callOps.asteriskData?.phoneNumber ?? callOps.tel),
              args: name === "leave_callback_message"
                ? { ma_danh_bo: args.ma_danh_bo, loai: "loi_nhan_goi_lai", mo_ta: args.noi_dung }
                : args,
              output: result,
            });
          }

          log.info("[function_call_output]:", { name, toolOutput: JSON.parse(toolOutput), callId });
          log.info("[ws.send : conversation.item.create]: item=", {
            type: "function_call_output",
            call_id: toolCallId,
            output: toolOutput,
          });
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
                log.info(`[${callId}]:`, "goodbye_forced", "end_call không kèm audio — code tự tạo câu tạm biệt");
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
            // [fix 05/08/2026] Cùng lỗ hổng với `end_call` trước khi có
            // `_hasGoodbyeAudio` (cuộc E2tY3rg44dIiQOsBGYFsi): nếu model gọi
            // transfer_to_agent mà KHÔNG nói câu thông báo nào trong CHÍNH response
            // chứa function_call này (response chỉ có function_call, không có audio),
            // khách sẽ bị chuyển máy trong im lặng, không biết chuyện gì đang xảy ra.
            // Giờ getAvailableAgents (tools.js) thêm một vòng gọi API trước khi tool
            // trả lời, model càng dễ chỉ gọi tool mà không kèm lời nói. Kiểm tra +
            // tự phát câu thông báo (dùng đúng "message" tool đã trả) nếu thiếu,
            // giống hệt cơ chế `goodbye_forced` của end_call.
            const _hasTransferAudio = output.some((it) =>
              it?.type === "message" &&
              Array.isArray(it.content) &&
              it.content.some((c) => c?.type === "output_audio"));
            let _transferDelayMs = 2000;
            if (!_hasTransferAudio) {
              const _transferInstruction =
                'Đọc CHÍNH XÁC từng từ câu sau, không thêm bớt, không diễn giải lại: "' +
                (result.message || "Dạ, em xin phép chuyển máy cho tổng đài viên hỗ trợ Quý Khách ngay ạ.") + '"';
              _pendingCodeResponse = true;
              ws.send(JSON.stringify({
                type: "response.create",
                response: { instructions: _transferInstruction },
              }));
              logger.addEvent("transfer_announce_forced", "transfer_to_agent không kèm audio — code tự tạo câu thông báo");
              log.info(`[WS][${callId}]:`, "transfer_announce_forced", "transfer_to_agent không kèm audio — code tự tạo câu thông báo");
              _transferDelayMs = 5000; // câu thông báo cần thời gian nói xong trước khi refer
            }
            if (!_transferred) {
              _transferred = true;
              await _handleTransfer(callId, callOps, result.ly_do, _transferDelayMs);
            } else {
              logger.addEvent("transfer_duplicate_ignored", null);
            }
          } else if (result?._danhBoConfirmSpamEscalate) {
            // [migrate 30/07/2026 — confirm_tool] Model (qua confirm_danh_bo HOẶC
            // qua một tool dữ liệu rơi vào nhánh "đang chờ xác nhận" của
            // resolveDanhBo) đã lặp lại CÙNG trạng thái quá ngưỡng, không có lượt
            // khách nào xen giữa — dấu hiệu kẹt vòng lặp. Đây là trục lỗi KHÁC với
            // requestNo/_danhBoProposeCount (những bộ đếm đó đếm "khách đọc lại
            // bao nhiêu lần", không bắt được "model tự kích hoạt lại tool bao
            // nhiêu lần"). KHÔNG để model tự do thêm — khoá lại và tự đọc câu xác
            // nhận MỘT lần bằng cơ chế cũ đã kiểm chứng (không phải DTMF: mã ĐÃ
            // ĐÚNG, chỉ là model cứ hỏi lại xác nhận — mời bấm phím ở đây sai
            // ngữ cảnh, gây khó hiểu cho khách).
            logger.addEvent("danh_bo_confirm_spam_escalate", `${name}`);
            log.warn(`[WS][${callId}] confirm_danh_bo/resolveDanhBo lặp lại quá ngưỡng → fallback _speakVerbatim.`);
            _setVadMode("digits");
            if (_toolCallState._danhBoLastPrompt) {
              _speakVerbatim(_toolCallState._danhBoLastPrompt, "danh_bo_confirm_spam_fallback", 0, { verify: true });
            }
          } else if (action === "no_reply") {
            // [migrate 30/07/2026] wait_for_user: model chủ động báo "không cần
            // trả lời lượt này" (im lặng/tạp âm/không hướng tới Trợ lý). Không
            // set _ketQuaToolCuoi → không có response.create nào được tạo ra
            // sau function_call_output này (khác mọi tool khác).
            logger.addEvent("wait_for_user", null);
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

            // [fix 30/07/2026 — cuộc rtc_u0_E7JGG7YLOPmJfNx4alnIn] "dang_xac_minh" đã
            // có nguồn nói RIÊNG, độc lập với khối "MỘT response.create cho CẢ
            // response.done" bên dưới: `_maybeVerifyDanhBo` (đường nền) tự gọi
            // `_speakVerbatim` để nói câu chờ + câu xác nhận khi xong, KHÔNG phụ
            // thuộc việc có tool call nào đang chạy hay không. Nếu đường dispatch
            // tool CHUNG này cũng tự tạo thêm MỘT response khác cho ĐÚNG trạng thái
            // đó, hai nguồn giành nhau đúng một response slot → lỗi
            // `conversation_already_has_active_response`, rồi hai tag khác nhau
            // (`danh_bo_verify_filler`/`danh_bo_confirm`) cùng retry qua nhiều vòng,
            // dội chỉ dẫn "BỎ QUA hết, chỉ nói đúng câu này" mâu thuẫn liên tiếp vào
            // model khiến nó bỏ tuân thủ, nói linh tinh (thấy rõ trong cuộc trên).
            // KHÔNG set _ketQuaToolCuoi cho trạng thái này — để _maybeVerifyDanhBo
            // là nguồn DUY NHẤT quyết định nói gì/khi nào.
            if (result?.dang_xac_minh) {
              logger.addEvent("danh_bo_dang_xac_minh_bo_qua_response_chung",
                "đã có _maybeVerifyDanhBo lo nói riêng ở đường nền, không tạo thêm response ở đây");
            } else {
              // [fix 27/07/2026] KHÔNG gửi response.create ngay trong vòng lặp —
              // xem giải thích ở khối "MỘT response.create cho CẢ response.done".
              _ketQuaToolCuoi = { name, result };
            }
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
          // [migrate 30/07/2026] confirm_tool: đây là điểm ép-verbatim THỨ HAI
          // trong file (khác `_speakVerbatim`) — MỌI tool có "doc_cho_khach" đều bị
          // ép đọc nguyên văn ở đây, bất kể `_camGoiTool`/`tool_choice` gì. Nếu bỏ
          // sót nhánh này thì việc loại trừ confirm_danh_bo khỏi `_camGoiTool` ở
          // trên vô nghĩa — model vẫn bị ép đọc từng chữ y hệt mọi tool khác, thiết
          // kế "để model tự đọc tự nhiên" coi như không có tác dụng gì.
          const _instructions = _tenTool === "confirm_danh_bo"
            ? "Xử lý đúng theo trường trang_thai_danh_bo trong kết quả tool vừa nhận. " +
            "Nếu có doc_cho_khach thì tự nhiên nói lại ý đó cho khách (không cần đọc từng chữ)."
            : _kq?.doc_cho_khach
              ? "Đọc CHÍNH XÁC từng từ đoạn sau cho khách, không thêm bớt, " +
              "không tóm tắt, không diễn giải lại: \"" + _kq.doc_cho_khach + "\""
              // [fix 05/08/2026 đợt 25] Chỉ dẫn "câu hỏi kết thúc cố định" trong
              // system-prompt.js (đợt 24) KHÔNG đủ mạnh — 3 cuộc test thật liên
              // tiếp SAU KHI đã restart server vẫn cho bot tự bịa câu gợi ý khác
              // (vd "em có thể giúp kiểm tra thêm so sánh lượng nước với kỳ
              // trước hoặc hướng dẫn các bước thanh toán luôn ạ" — đúng kiểu câu
              // muốn loại bỏ). Toàn bộ chỉ dẫn ép đọc nguyên văn khác trong file
              // này (`_speakVerbatim`, nhánh "Đọc CHÍNH XÁC..." ở trên) đều đặt
              // NGAY TRONG `instructions` của response.create — và đều tuân thủ
              // ổn định hơn hẳn so với chỉ dẫn nằm trong system-prompt.js (bị
              // loãng dần theo lịch sử hội thoại). Áp dụng cùng nguyên tắc: đưa
              // yêu cầu câu hỏi kết thúc cố định vào ngay đây thay vì chỉ dựa
              // vào system-prompt.js.
              // [fix 05/08/2026 đợt 27] Cuộc rtc_u0_E9V6kgXusmTSDgZJejLgs (19:35:56):
              // câu hỏi cố định ĐÃ xuất hiện đúng (đợt 25 có tác dụng), nhưng model
              // GIỮ LUÔN câu hỏi tự bịa của nó ngay trước đó, ra 2 câu hỏi liên tiếp
              // ("Quý Khách muốn em đọc thêm phần nào nữa không ạ? Quý Khách có cần
              // em hỗ trợ gì thêm không ạ?") — nghe thừa/lặp. Chỉ dẫn cũ mới cấm
              // "liệt kê gợi ý nghiệp vụ cụ thể", chưa cấm việc thêm CÂU HỎI khác
              // (không phải liệt kê gợi ý) trước/sau câu cố định. Thêm cấm rõ ràng.
              : "Phản hồi lại khách hàng dựa trên kết quả vừa nhận được. " +
              "Kết thúc bằng ĐÚNG MỘT câu hỏi duy nhất, không hơn không kém: " +
              "\"Quý Khách có cần em hỗ trợ gì thêm không ạ?\" " +
              "— không tự liệt kê gợi ý nghiệp vụ cụ thể nào khác (vd không nói " +
              "\"em có thể hỗ trợ kiểm tra thêm...\", \"hoặc tạo phiếu phản ánh nếu cần\"), " +
              "và TUYỆT ĐỐI không tự thêm bất kỳ câu hỏi nào khác trước hay sau câu " +
              "này (vd không nói thêm \"Quý Khách muốn em đọc thêm phần nào nữa " +
              "không ạ?\") — toàn bộ phản hồi chỉ được kết thúc bằng đúng một câu hỏi.";

          // [fix 27/07/2026] Câu thoại CỐ ĐỊNH của luồng danh bộ → CẤM model gọi
          // tool trong response này. Cùng cuộc gọi trên: response do code tạo để
          // đọc câu chờ lại bị model dùng để gọi get_bill tiếp (với số bịa), tạo
          // vòng xoáy tool-call. `tool_choice: "none"` cắt hẳn vòng xoáy đó.
          // [migrate 30/07/2026] confirm_tool: loại trừ TƯỜNG MINH kết quả của
          // chính confirm_danh_bo — nó không set các cờ cũ bên dưới nên vốn đã
          // không rơi vào nhánh này, nhưng thêm điều kiện theo TÊN TOOL ở đây làm
          // lưới phòng thủ, tránh một sửa đổi sau này vô tình tái lập đúng cổng ép
          // verbatim mà cả thiết kế "tool riêng cho model" này muốn tránh.
          const _camGoiTool = _tenTool !== "confirm_danh_bo" && !!(_kq?.doc_cho_khach && (
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

            log.info("[ws.send : response.create]: response=", {
              type: "response.create",
              response: _camGoiTool
                ? { instructions: _instructions, tool_choice: "none" }
                : { instructions: _instructions },
            });
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
              // [fix 05/08/2026 đợt 26] Cuộc rtc_u1_E9UumC5wzEbQaiWgbxwSu (19:23):
              // sau khi flow confirm/DTMF trước đó thất bại (TTS lặp số + model
              // lạc đề), khách hỏi lại "Bao nhiêu tiền?" 2 LẦN LIÊN TIẾP ở VAD
              // normal; model tự gọi get_bill cả 2 lần, tool ĐÚNG khi trả về
              // cho_khach_xac_nhan (vì danhBo.confirmed vẫn false) kèm câu hỏi
              // xác nhận — nhưng bị nhánh này bỏ qua CẢ HAI LẦN vì `_daCoUngVien`
              // áp dụng UNCONDITIONALLY cho MỌI kết quả tool, khiến khách nhận
              // im lặng tuyệt đối 2 lượt liền rồi cúp máy. Gốc rễ: `_daCoUngVien`
              // (đợt 7, 27/07) chỉ nhắm đúng 1 race cụ thể — model gọi tool NGAY
              // lúc câu trả lời còn là "xin mã danh bộ" (dang_gom_so) trong khi
              // thực ra khách đã có ứng viên rồi, nên câu "xin mã danh bộ" đó lỗi
              // thời. Nhưng `cho_khach_xac_nhan`/`da_sai_nhieu_lan` CHÍNH LÀ về
              // ứng viên đang có — có ứng viên (kể cả CHƯA xác nhận) không phải
              // dấu hiệu lỗi thời ở đây, mà là điều kiện BÌNH THƯỜNG để nói câu
              // xác nhận. Thu hẹp `_daCoUngVien` chỉ áp dụng cho nhánh
              // `dang_gom_so` (đúng phạm vi race gốc), không áp dụng chung nữa.
              const _loiThoi =
                (_kq.invalid_danh_bo && _soDaCo > 0)
                || (_kq.dang_gom_so && (_soDaCo >= 11 || _daCoUngVien));
              if (_loiThoi) {
                const _lyDo = _kq.invalid_danh_bo
                  ? `invalid_danh_bo nhưng đã nghe ${_soDaCo} số kể từ đó`
                  : `dang_gom_so nhưng đã đủ ${_soDaCo} số hoặc đã có ứng viên (${_toolCallState.danhBo?.value || "-"}, confirmed=${!!_toolCallState.danhBo?.confirmed})`;
                logger.addEvent("tool_prompt_bo_qua",
                  `${_tenTool}: câu đã lỗi thời (đã nghe ${_soDaCo}/11, ứng viên=${_daCoUngVien}) — ${_lyDo}. Câu bị bỏ: "${(_kq.doc_cho_khach || "").slice(0, 100)}"`);
                log.info(`[WS][${callId}] Bỏ câu tool đã lỗi thời — khách đã đọc ${_soDaCo}/11 số. Lý do: ${_lyDo}. Câu bị bỏ: "${(_kq.doc_cho_khach || "").slice(0, 100)}"`);
                return;
              }
              log.debug(`[WS][${callId}] Câu tool KHÔNG lỗi thời, sẽ phát: kq_keys=${Object.keys(_kq || {}).join(",")}, đã nghe=${_soDaCo}/11, ứng viên=${_daCoUngVien}`);
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
        log.info("....input_audio_buffer.dtmf_event_received....");
        const digit = String(event.event ?? "").trim();
        log.info("DTMF received:", digit);
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
        log.info(`[${callId}]:`, "dtmf_danh_bo_complete", _dtmfValue);
        _speakVerbatim(_dtmfPrompt, "dtmf_danh_bo_confirm", 0, { verify: true });
        break;
      }
      // ── Transcription để log cuộc hội thoại ───────────────────────────────
      case "conversation.item.input_audio_transcription.completed": {
        log.info("....conversation.item.input_audio_transcription.completed....");
        log.info("[conversation.item.input_audio_transcription.completed]: input_text_customer.transcript=", event.transcript?.trim());

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
          // [migrate 30/07/2026 — confirm_tool] Lượt khách THẬT nào cũng mở lại
          // "cửa sổ" cho confirm_danh_bo được báo trạng thái lần nữa — tránh gate
          // chống spam (xem tools.js) hiểu lầm lượt xác nhận/phủ định hợp lệ của
          // khách là "model tự gọi lại tool không có gì mới".
          noteDanhBoConfirmNewTurn(_toolCallState);

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
            // [fix 31/07/2026] Khách ĐỌC LẠI số trong lúc đang chờ xác nhận (có
            // ứng viên `danhBo` pending, chưa confirmed) mà KHÔNG nói "đúng/sai"
            // rõ ràng — chỉ tự đọc lại từ đầu (phản xạ tự nhiên khi thấy đọc lại
            // có vẻ sai). Trước đây lượt này vẫn cộng dồn vào `_danhBoSession`
            // CŨ (chưa được reset vì phiên chỉ reset khi "mời đọc lại" hoặc khi
            // XÁC NHẬN xong, không phải khi CHUYỂN sang chờ xác nhận) → tràn số
            // (cuộc rtc_u2_E7XpOB5fmY21Hm4L28mXW: 12 số cũ + 11 số mới = "23/11").
            // Tệ hơn: `_maybeVerifyDanhBo` có guard `if (_toolCallState.danhBo)
            // return` — vì ứng viên pending vẫn còn đó, guard này ÂM THẦM CHẶN
            // việc verify lại, bot im lặng tới khi mute watchdog (15s) cứu, lúc
            // đó model đã mất dấu ngữ cảnh và đọc bừa một số khác. Coi lượt đọc
            // lại này là PHỦ ĐỊNH NGẦM ứng viên cũ: reject candidate pending +
            // mở phiên đọc MỚI (reset sạch, không lẫn số cũ) trước khi ghi nhận.
            // [fix 04/08/2026 đợt 15] Trước khi coi là phủ định: nếu dãy số khách
            // VỪA đọc lại TRÙNG Y HỆT với ứng viên đang chờ xác nhận, đây là CỦNG
            // CỐ (khách khẳng định lại đúng số đó), KHÔNG PHẢI phủ định — coi là
            // phủ định sẽ đẩy số ĐÚNG vào danh sách "khách báo sai" của trọng tài
            // (mục "TUYỆT ĐỐI không trả lại y nguyên" trong prompt arbiter), khoá
            // chết mã ĐÚNG cho phần còn lại cuộc gọi. Cuộc rtc_u1_E95eWKZyqtfuuviHFm4lv:
            // model bị race lúc chuyển VAD nói nhầm "chưa đúng độ dài" ngay sau khi
            // khách đọc ĐÚNG lần đầu (xem đợt log trước) → khách đọc lại y hệt số cũ
            // theo hướng dẫn (sai) đó, không hề có ý phủ định — nhưng bị hiểu nhầm,
            // trọng tài sau đó luôn trả conf=0.05 vì số đúng đã bị liệt vào "đã bác
            // bỏ", cuộc gọi bế tắc dù khách đọc đúng ngay từ đầu.
            const _docLaiSo = khText.replace(/\D/g, "");
            const _trungKhopDangCho = !!(_toolCallState.danhBo && !_toolCallState.danhBo.confirmed &&
              _docLaiSo && _docLaiSo === _toolCallState.danhBo.value);
            if (_trungKhopDangCho) {
              logger.addEvent("danh_bo_doc_lai_trung_khop_cung_co",
                `${khText.slice(0, 60)} — trùng số đang chờ, coi là củng cố`);
              log.info(`[WS][${callId}] Khách đọc lại TRÙNG số đang chờ xác nhận → củng cố, nhắc lại câu xác nhận.`);
              _armDanhBoWatchdog();
              _reAssertDanhBoStep("khách đọc lại trùng số đang chờ xác nhận");
            } else {
              if (_toolCallState.danhBo && !_toolCallState.danhBo.confirmed) {
                logger.addEvent("danh_bo_doc_lai_ngam_dinh_phu_dinh",
                  `${khText.slice(0, 60)} — huỷ ứng viên pending, mở phiên đọc mới`);
                log.info(`[WS][${callId}] Khách đọc lại số giữa lúc chờ xác nhận → coi như phủ định ngầm, mở phiên mới.`);
                noteDanhBoRejected(_toolCallState);
                startDanhBoRequest(_toolCallState, "khách đọc lại trong lúc đang chờ xác nhận");
                _toolCallState._danhBoVerifyLastAt = 0; // bỏ khoảng nghỉ tối thiểu cho lượt này
              }
              const _s = noteDanhBoTranscript(_toolCallState, khText);
              log.info(`[WS][${callId}] [danh_bo] phiên #${_s.requestNo}: ${_s.digits.length}/11 số (+"${khText}")`);
              _armDanhBoWatchdog();
              _maybeVerifyDanhBo();
            }
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
          } else if (!_seXuLyXacNhan && !_seXuLyPhuDinh && _vadMode === "digits" &&
            (_toolCallState._danhBoVerifyRunning || _expectedSpeak ||
              (!_toolCallState.danhBo && danhBoSessionDigits(_toolCallState) >= 11))) {
            // [fix 27/07/2026 đợt 8] ĐANG XÁC MINH / SẮP ĐỌC CÂU XÁC NHẬN → GIỮ KHOÁ.
            // Cuộc rtc_u2_E67HNE1dTVDUT80s4XixB: khách vừa đọc xong 11 số, đường nền
            // đang chạy, thì lọt vào hai chữ "đồng hồ" (nhiều khả năng nhiễu). Code
            // xếp vào "đổi chủ đề" → MỞ KHOÁ model → đúng 2 giây sau trọng tài chốt
            // đúng mã, nhưng model đã được thả ra và nói "số danh bộ chưa rõ, ví dụ
            // 22082351" → hỏng cả cuộc gọi.
            // Không lo bot câm: đường nền chắc chắn sẽ phát câu xác nhận ngay sau đó.
            // [migrate 30/07/2026] Nhánh này chỉ THỰC SỰ ngăn được model nói khi
            // DANH_BO_MODE=locked (create_response:false — model vật lý không tự
            // tạo response). Ở chế độ "unlocked", việc "giữ khoá" ở đây chỉ là
            // log/bỏ qua — model vẫn có thể đã tự trả lời trước khi dòng này chạy
            // (đúng rủi ro đã ghi trong .env.example / docs/fix/fix_migrate_gpt_realtime_21_20260730.md).
            // [fix 04/08/2026 đợt 19] Thêm điều kiện `!_toolCallState.danhBo` — xem
            // giải thích đầy đủ ở nhánh MỚI ngay bên dưới (bug khách bị im lặng vô
            // thời hạn sau khi câu hỏi xác nhận đã được hỏi xong).
            logger.addEvent("danh_bo_giu_khoa_dang_xac_minh", khText.slice(0, 60));
            log.info(`[WS][${callId}] Giữ khoá — đang xác minh, bỏ qua lượt "${khText.slice(0, 40)}"`);
          } else if (!_seXuLyXacNhan && !_seXuLyPhuDinh && _vadMode === "digits" &&
            _toolCallState.danhBo && !_toolCallState.danhBo.confirmed && _toolCallState._danhBoLastPrompt) {
            // [fix 04/08/2026 đợt 19] BUG THẬT, khách cúp máy bực bội — cuộc
            // rtc_u0_E96ZWOOhKRYuhnpys7jYm: sau khi câu hỏi xác nhận đã được hỏi
            // xong (bot nói đúng câu, `_expectedSpeak` đã cleared), khách trả lời 5
            // lượt liền KHÔNG rõ ràng (ASR garbled: "Xin chào quý khách.", "Đọc đi
            // em.", "tôi", rồi bực bội "Trời ơi, cái thằng điên này nó làm cái gì
            // vậy?") — MỌI lượt đều rơi vào nhánh "Giữ khoá" ở trên vì điều kiện cũ
            // `danhBoSessionDigits(_toolCallState) >= 11` KHÔNG BAO GIỜ được reset
            // sau khi chuyển từ "gom số" sang "chờ xác nhận" (chỉ reset khi mở phiên
            // đọc MỚI) — nên mãi mãi đúng, khoá im lặng VÔ THỜI HẠN dù không còn gì
            // chạy nền cả. Khách chờ 41 giây trong im lặng rồi cúp máy.
            // Đã chặn đúng lỗi bằng cách thêm `!_toolCallState.danhBo` vào điều kiện
            // nhánh trên. Nhánh MỚI này xử lý đúng trạng thái thật: đã hỏi xác nhận
            // xong, khách trả lời không khớp đúng/sai/đọc lại số/xin nhắc lại → đọc
            // LẠI câu hỏi xác nhận (dùng `_reAssertDanhBoStep` có sẵn) thay vì im
            // lặng, cho khách cơ hội trả lời rõ hơn. Watchdog 90s vẫn là lưới an
            // toàn cuối nếu lặp lại nhiều lần không có tiến triển.
            logger.addEvent("danh_bo_khong_ro_nhac_lai_xac_nhan", khText.slice(0, 60));
            log.info(`[WS][${callId}] Khách trả lời không rõ khi đang chờ xác nhận → nhắc lại câu hỏi xác nhận.`);
            _armDanhBoWatchdog();
            _reAssertDanhBoStep("khách trả lời không rõ khi đang chờ xác nhận");
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
            // [migrate 30/07/2026] Chỉ cần TỰ tạo response khi model đang thật sự bị
            // khoá (locked). Ở chế độ "unlocked", create_response đã là true ngay
            // trong VAD "digits" → model rất có thể ĐÃ tự trả lời câu hỏi này rồi;
            // gọi thêm _requestModelReply ở đây có thể tạo ra 2 response cho cùng
            // một lượt khách. _requestModelReply tự bỏ qua nếu đã có response khác
            // đang chạy, nhưng để tránh chồng lượt không cần thiết, chỉ gọi khi locked.
            if (!_DANHBO_UNLOCKED) {
              _requestModelReply("khách hỏi chuyện khác giữa lúc thu danh bộ");
            }
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
            // [fix 10/08/2026] Reset trước khi lên lịch nudge bên dưới — cờ này do
            // tools.js#resolveDanhBo bật lên khi MỘT tool tra cứu nào đó đã thật sự
            // chạy bằng số vừa confirmed (xem shouldSkip truyền vào bên dưới).
            _toolCallState._danhBoPostConfirmActionDone = false;
            const _daTraCuuXongSauXacNhan = () => _toolCallState._danhBoPostConfirmActionDone === true;
            // [MỨC C — đợt 5] Lượt "đúng rồi" này được commit khi model còn đang bị
            // khoá → sẽ KHÔNG có response nào được sinh ra. Không tự tạo thì bot câm
            // ngay sau khi khách xác nhận. Nhờ model đi tra cứu luôn.
            // [migrate 30/07/2026] confirm_tool: nudge LẠI confirm_danh_bo (thay vì
            // response.create tự do) để model nhận TƯỜNG MINH trang_thai_danh_bo=
            // da_xac_nhan + ma_danh_bo trong context, không chỉ tự suy đoán từ việc
            // vừa nghe khách nói "đúng".
            if (_DANHBO_CONFIRM_TOOL) {
              _openDanhBoConfirmTurn("khach_da_xac_nhan", 0, _daTraCuuXongSauXacNhan);
            } else {
              // [fix 05/08/2026 đợt 27] Cuộc rtc_u0_E9V6kgXusmTSDgZJejLgs (19:35:53):
              // model nói câu dẫn "Chốt xong rồi, cho em xem thử thông tin tài khoản
              // của Quý Khách nhé." trước khi gọi tool — thừa, vì đây là tra cứu tức
              // thời (tool phản hồi nhanh) theo đúng định nghĩa "# Câu dẫn" trong
              // system-prompt.js (không cần nói gì trước). Chỉ dẫn cũ chỉ cấm hỏi
              // lại/đọc lại số, chưa cấm câu dẫn — thêm cấm rõ ràng.
              // [fix 05/08/2026 đợt 29] Cuộc rtc_u1_E9VXRWAY6Kpz9kQIZGAiO (20:02:36):
              // dù đã có chỉ dẫn "KHÔNG nói câu dẫn nào trước" của đợt 27, model vẫn
              // nói "Được rồi, em sẽ tra cứu rồi đọc phần Quý Khách cần nghe ạ." trước
              // khi gọi tool — chỉ dẫn chung chung chưa đủ mạnh với chỉ dẫn free-form
              // (khác `_speakVerbatim` ép đọc nguyên văn). Theo đúng cách đã hiệu quả
              // ở đợt 27 (thêm ví dụ câu SAI cụ thể model vừa nói ra), thêm luôn câu
              // này làm ví dụ cấm.
              _requestModelReply("khách đã xác nhận mã danh bộ",
                "Quý Khách vừa xác nhận mã danh bộ là ĐÚNG. Gọi NGAY tool tra cứu mà Quý Khách cần " +
                "(get_bill / compare_usage / get_outages / create_ticket...), KHÔNG nói câu dẫn nào " +
                "trước (đây là tra cứu tức thời, không cần thông báo trước khi gọi tool) — vd KHÔNG nói " +
                "\"Được rồi, em sẽ tra cứu rồi đọc phần Quý Khách cần nghe ạ.\" hay bất kỳ câu tương tự " +
                "nào khác, chỉ gọi tool ngay, im lặng cho tới khi có kết quả để đọc. " +
                "KHÔNG hỏi lại số, KHÔNG đọc lại số, KHÔNG truyền ma_danh_bo — hệ thống tự dùng số đã xác nhận.",
                0, _daTraCuuXongSauXacNhan);
            }
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
            // [migrate 30/07/2026] confirm_tool: đã mở khoá (create_response:true)
            // cho bước xác nhận vừa rồi — quay lại gom số thô thì phải khoá lại,
            // nếu không noise/tạp âm có thể tự kích hoạt response ngay giữa lúc
            // đường nền đang chạy lại (đúng rủi ro đã gặp ở phép thử "unlocked").
            if (_DANHBO_CONFIRM_TOOL) _setVadMode("digits");
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
                log.info("[_isPromptEcho]:ws.send response.cancel : ", {
                  type: "response.cancel",
                });
                ws.send(JSON.stringify({ type: "response.cancel" }));
                logger.addEvent("response_cancel_sent", `hủy response do prompt echo (nhiễu) kích hoạt (item ${_echoItemId})`);
                log.info(`[${callId}]:`, "response_cancel_sent", `hủy response do prompt echo (item ${_echoItemId})`);
                _reAssertDanhBoStep("sau khi hủy response do prompt echo");
              } catch (e) {
                log.warn(`[WS][${callId}]không gửi được response.cancel: `, e.message);
                log.info(`[WS][${callId}]không gửi được response.cancel: `, e.message);
              }
            } else {
              // Giữ nguyên response đang chạy — đang trả lời lượt thật của
              // khách, hoặc do code tạo, hoặc thuộc item khác.
              const _reason = !_itemMatch
                ? `echo item ${_echoItemId} ≠ trigger item ${_activeResponseTriggerItemId}`
                : `item trùng nhưng còn lượt khách thật chưa được trả lời (_unansweredRealTurn)`;
              logger.addEvent("response_cancel_skipped", `${_reason} — không hủy response đang chạy`);
              log.info(`[${callId}]:`, "response_cancel_skipped", _reason);
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
        log.info("....conversation.item.done....");
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
        log.info("....response.audio_transcript.done....");
        const aiText = event.transcript?.trim();
        log.info(`[WS][${callId}][AI nói]: ${aiText}`);
        if (aiText) logger.flushAI(aiText);
        break;
      }



      // ── [debug 08/07/2026] VAD & response lifecycle ───────────────────────
      // Phục vụ chẩn đoán phantom turn (VAD bắt nhầm noise/echo) và AI lặp lời.
      // Cuộc gọi "khỏe": số vad_speech_started ≈ số lượt khách nói thật.

      case "input_audio_buffer.speech_started":
        log.info("....input_audio_buffer.speech_started....");
        logger.addEvent("vad_speech_started", null);
        break;

      case "input_audio_buffer.speech_stopped":
        log.info("....input_audio_buffer.speech_stopped....");
        logger.addEvent("vad_speech_stopped", null);
        break;

      // [fix 18/07/2026] VAD commit audio thành conversation item → nhớ item_id.
      // Response do VAD tạo ngay sau đó sẽ được gắn với item này (response.created).
      case "input_audio_buffer.committed":
        log.info("....input_audio_buffer.committed....");
        _lastCommittedItemId = event.item_id ?? null;
        logger.addEvent("audio_committed", _lastCommittedItemId);
        break;



      // Transcription thất bại (trước đây rơi vào default, mất dấu vết)
      case "conversation.item.input_audio_transcription.failed":
        log.info("....conversation.item.input_audio_transcription.failed....");
        logger.addError("transcription_failed", event.error?.message || _safeJson(event.error));
        break;

      // ── Lỗi từ OpenAI ─────────────────────────────────────────────────────
      case "error":
        log.info("....error....");
        log.error(`[WS][${callId}]OpenAI error: `, event.error);
        logger.addError("openai_event", event.error?.message || _safeJson(event.error));
        break;

      case "session.created":
        log.info("....session.created....");
        log.info(`[WS][${callId}]session.created: ${event.session?.id}`);
        logger.setSessionCreatedData(event.session ?? {});
        logger.addEvent("session_created", event.session?.id || null);
        break;

      case "session.updated": {
        log.info("....session.updated....");
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

// [fix 05/08/2026] Thêm tham số delayMs (mặc định 2000, giữ nguyên hành vi cũ) —
// session-ws.js truyền delay dài hơn khi phải TỰ tạo câu thông báo chuyển máy
// (model không nói gì trong response chứa function_call), để refer không chạy
// trước khi câu thông báo vừa gửi kịp nói xong.
async function _handleTransfer(callId, callOps, lyDo, delayMs = 2000) {
  const agentUri = process.env.AGENT_QUEUE_URI;


  if (!agentUri) {
    log.warn(`[WS][${callId}]AGENT_QUEUE_URI chưa cấu hình, không thể chuyển máy`);
    return;
  }

  log.info(`[WS][${callId}]Chuyển máy → ${agentUri}(lý do: ${lyDo})`);

  // Delay để AI nói xong câu thông báo chuyển máy
  await new Promise((r) => setTimeout(r, delayMs));

  try {
    await callOps.refer(callId, agentUri);
    log.info(`[WS][${callId}] Refer thành công`);
  } catch (err) {
    log.error(`[WS][${callId}] Refer thất bại: `, err.message);
  }
}
