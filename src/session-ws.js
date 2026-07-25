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
import { dispatchTool, danhBoSpoken, proactiveAssembleDanhBo, noteDanhBoRejected } from "./tools.js";
import { runWithApiTrace } from "./api-trace.js";
import { log } from "./logger.js";
import { ConversationLogger } from "./conversation-logger.js";
import { insertCallStub, insertTicket } from "./db.js";
// import { TOOLS } from "./system-prompt.js";

const OPENAI_WS_URL = "wss://api.openai.com/v1/realtime";

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
  const _speakVerbatim = (text, tag, attempt = 0) => {
    if (_hungUp || _transferred) return;
    if (_responseActive) {
      if (attempt < 8) setTimeout(() => _speakVerbatim(text, tag, attempt + 1), 1200);
      else logger.addEvent("speak_verbatim_dropped", `${tag} — response active quá lâu`);
      return;
    }
    try {
      _pendingCodeResponse = true;
      let instructions = "Đọc CHÍNH XÁC từng từ đoạn sau cho khách, không thêm bớt, không diễn giải lại: \"" + text + "\"";
      console.log("[_speakVerbatim]: text=", text);
      console.log("[_speakVerbatim]: tag=", tag);
      console.log("[_speakVerbatim]: attempt=", attempt);
      console.log("[_speakVerbatim]: instructions=", instructions);
      ws.send(JSON.stringify({
        type: "response.create",
        response: {
          instructions: instructions,
        },
      }));
      logger.addEvent("response_create_sent", tag);
    } catch (e) {
      log.warn(`[WS][${callId}] không gửi được response.create (${tag}): `, e.message);
    }
  };

  // [fix 19/07/2026 v3] CO-PILOT tự gom số từ transcript khi model mini KHÔNG
  // gom được số khách đọc qua nhiều hơi (semantic VAD tạo response mỗi hơi →
  // model đáp "chưa đủ" ngay, không gọi confirm_danh_bo → mọi logic tools.js
  // không chạy). Sau khi khách NGƯNG đọc số ~3s, nhờ gpt-5.1 ghép các hơi
  // transcript đã buffer thành 11 số rồi tự đọc lại xác nhận. Debounce reset
  // mỗi hơi số mới → chỉ chạy sau khi khách thật sự dừng. Có khoảng nghỉ tối
  // thiểu giữa 2 lần chạy để không spam gpt-5.1.
  const _DANHBO_ASSEMBLE_DEBOUNCE_MS = 3000;
  const _DANHBO_ASSEMBLE_MIN_GAP_MS = 6000;
  const _maybeAssembleDanhBo = () => {
    clearTimeout(_toolCallState._danhBoAssembleTimer);
    _toolCallState._danhBoAssembleTimer = setTimeout(async () => {
      if (_hungUp || _transferred) return;
      // Đã có ứng viên (model/DTMF/trọng tài) đang chờ hoặc đã xác nhận → không chen.
      if (_toolCallState.danhBo) return;
      if (_toolCallState._danhBoAssembleRunning) return;
      const _now = Date.now();
      if (_toolCallState._danhBoAssembleLastAt && _now - _toolCallState._danhBoAssembleLastAt < _DANHBO_ASSEMBLE_MIN_GAP_MS) return;
      _toolCallState._danhBoAssembleRunning = true;
      _toolCallState._danhBoAssembleLastAt = _now;
      try {
        const prompt = await proactiveAssembleDanhBo(_toolCallState);
        if (prompt && !_toolCallState.danhBo?.confirmed) {
          _toolCallState._danhBoLastPrompt = prompt;
          logger.addEvent("danh_bo_proactive_assemble", prompt);
          console.log(`[${callId}]:`, "danh_bo_proactive_assemble", prompt);
          _speakVerbatim(prompt, "danh_bo_proactive_assemble");
        }
      } catch (e) {
        log.warn(`[WS][${callId}] proactiveAssembleDanhBo lỗi: `, e.message);
      } finally {
        _toolCallState._danhBoAssembleRunning = false;
      }
    }, _DANHBO_ASSEMBLE_DEBOUNCE_MS);
  };

  // Tránh save() 2 lần (close + error retry)
  let _saved = false;
  const _saveOnce = async (reason) => {
    if (_saved) return;
    _saved = true;
    logger.addEvent("saving_log", reason);
    try {
      await logger.save();
    } catch (err) {
      log.error(`[WS][${callId}] Lỗi lưu conversation summary:`, err.message);
    }
  };

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
            const _instructions = result?.doc_cho_khach
              ? "Đọc CHÍNH XÁC từng từ đoạn sau cho khách, không thêm bớt, " +
              "không tóm tắt, không diễn giải lại: \"" + result.doc_cho_khach + "\""
              : "Phản hồi lại khách hàng dựa trên kết quả vừa nhận được.";
            logger.addEvent("response_create_sent", `tool_result: ${name}`);
            console.log({ _instructions });
            _pendingCodeResponse = true; // [fix 18/07/2026] đánh dấu response do code tạo
            ws.send(JSON.stringify({
              type: "response.create",
              response: { instructions: _instructions },
            }));
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
        const _dtmfPrompt =
          `Dạ, em nhận được mã danh bộ Quý Khách vừa bấm là: ${danhBoSpoken(_dtmfValue)}. ` +
          `Quý Khách xác nhận giúp em có đúng không ạ?`;
        _toolCallState._danhBoLastPrompt = _dtmfPrompt;
        logger.addEvent("dtmf_danh_bo_complete", _dtmfValue);
        console.log(`[${callId}]:`, "dtmf_danh_bo_complete", _dtmfValue);
        _speakVerbatim(_dtmfPrompt, "dtmf_danh_bo_confirm");
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
          _unansweredRealTurn = true; // [fix 18/07/2026 v2] khách vừa nói thật — chưa được trả lời

          // [fix 19/07/2026] Buffer transcript các lượt có chữ số cho trọng tài
          // danh bộ (tools.js đọc callState._danhBoTranscripts khi 2 lần đọc fail).
          if (_looksLikeDigitTurn(khText)) {
            (_toolCallState._danhBoTranscripts ??= []).push({ at: Date.now(), text: khText });
            if (_toolCallState._danhBoTranscripts.length > 10) _toolCallState._danhBoTranscripts.shift();
            console.log("[WS]", callId, "_danhBoTranscripts : ", _toolCallState._danhBoTranscripts);
            // [fix 25/07/2026] TẮT gom nền theo debounce — trọng tài gpt-5.1 giờ
            // chạy ON-DEMAND trong resolveDanhBo (khi hàm tra cứu cần số), tránh
            // lệch pha giữa câu tool và câu đọc-lại nền. Vẫn buffer transcript ở
            // trên để arbiter on-demand dùng.
            // _maybeAssembleDanhBo();
          }

          // [fix 23/07/2026] XÁC NHẬN LỜI NÓI universal: bất kỳ ứng viên danh bộ
          // đang CHỜ (do proactiveAssemble/resolveDanhBo/DTMF đọc lại) mà khách nói
          // từ khẳng định → chốt confirmed=true. Đây là DẤU HIỆU DUY NHẤT cho phép
          // tra cứu (không tin việc model tự gọi tool). Xóa buffer transcript để
          // lần đọc số MỚI sau (đổi danh bộ) không bị dính số cũ.
          if (_toolCallState.danhBo && !_toolCallState.danhBo.confirmed && _isAffirmative(khText)) {
            _toolCallState._danhBoNeedsVerbalYes = false;
            _toolCallState.danhBo.confirmed = true;
            _toolCallState._danhBoTranscripts = [];
            logger.addEvent("danh_bo_verbal_confirm", khText);
            console.log(`[${callId}]:`, "danh_bo_verbal_confirm", khText);
          }

          // [fix 23/07/2026] Khách PHỦ ĐỊNH số đang chờ xác nhận → BÁC ngay ứng
          // viên (mọi ứng viên chưa confirmed, không chỉ ứng viên trọng tài) để
          // proactiveAssembleDanhBo được đề xuất dãy KHÁC ở lượt đọc/ngưng kế
          // (danh bộ cũ vào _danhBoRejected, trọng tài né). Không còn confirm_danh_bo.
          if (_toolCallState.danhBo && !_toolCallState.danhBo.confirmed && _PHU_DINH_RE.test(khText)) {
            _toolCallState._danhBoCustomerSaidNo = true;
            logger.addEvent("danh_bo_customer_said_no", khText);
            console.log(`[${callId}]:`, "danh_bo_customer_said_no", khText);
            noteDanhBoRejected(_toolCallState);
            logger.addEvent("danh_bo_rejected_proactive", "khách phủ định số đang chờ xác nhận");
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

      case "session.updated":
        console.log("....session.updated....");
        log.info(`[WS][${callId}]session.updated OK`);
        logger.addEvent("session_updated", null);
        break;

      default:
        break;
    }
  });

  ws.on("close", async (code, reason) => {
    log.info(`[WS][${callId}]WebSocket đóng: ${code} ${reason?.toString()}`);
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
