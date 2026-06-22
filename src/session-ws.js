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
import { dispatchTool } from "./tools.js";
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
    uniqueid:    callOps.asteriskData?.uniqueid,
    recordPath:  callOps.asteriskData?.recordPath,
    voiceModel:  logger.model,
  });

  // Guard riêng cho từng hành động để tránh thực thi trùng (không chặn chéo nhau)
  let _hungUp = false;      // đã lên lịch cúp máy chưa
  let _transferred = false; // đã chuyển máy chưa

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
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,          // tránh noise/echo kích hoạt VAD giả
              prefix_padding_ms: 500,  // giữ ~0.5s audio trước khi VAD kích hoạt → không mất số đầu
              silence_duration_ms: 1200
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

    const greetingInstruction = 'đợi 1 giây rồi nói "... Alo ... Xin chào Quý Khách, Cảm ơn Quý Khách đã gọi đến Tổng đài Công ty Cổ phần Cấp nước Trung An. Em là Trợ lý Ảo Ây Ai, Quý khách cần em hỗ trợ gì ạ?"';

    setTimeout(() => {
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
      // ── Response hoàn chỉnh → kiểm tra có function_call không ─────────────
      // Theo pattern của openai_nestle_step3.js: bắt function call qua
      // response.done → response.output[], lọc item.type === "function_call".

      case "response.done": {
        const usage = event?.response?.usage;
        if (usage) {
          // Tích lũy token để tính cost cuối cuộc gọi
          logger.addUsage(usage);
          // Log tóm tắt nhanh để debug
          const totalIn  = usage.input_tokens  ?? 0;
          const totalOut = usage.output_tokens ?? 0;
          const audioIn  = usage.input_token_details?.audio_tokens  ?? 0;
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
          log.info(`[WS][${callId}] Tool call: ${name}(${argsStr})`);

          let args = {};
          try { args = JSON.parse(argsStr); } catch { /* ignore */ }

          // Gọi handler và gửi kết quả tool về cho OpenAI (đo thời gian xử lý)
          const _t0 = Date.now();
          const toolOutput = await dispatchTool(name, args);
          const _durationMs = Date.now() - _t0;
          log.debug(`[WS][${callId}] Tool output (${_durationMs}ms): ${toolOutput}`);

          // Ghi đầu vào / đầu ra của function tool vào log
          try {
            logger.addToolCall(name, args, _tryParseJson(toolOutput), _durationMs);
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
            // KHÔNG gửi response.create: model đã nói lời tạm biệt ngay trong response
            // chứa end_call → gửi thêm sẽ gây lỗi conversation_already_has_active_response.
            logger.setOutcome("completed");
            logger.addEvent("end_call", result.ly_do || null);
            if (!_hungUp) {
              _hungUp = true;
              // Delay để AI kịp nói lời tạm biệt trước khi cúp máy
              setTimeout(() => callOps.hangup(callId), 5000);
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
            ws.send(JSON.stringify({
              type: "response.create",
              response: { instructions: "Phản hồi lại khách hàng dựa trên kết quả vừa nhận được." },
            }));
          }
        }
        break;
      }

      // ── Transcription để log cuộc hội thoại ───────────────────────────────
      case "conversation.item.input_audio_transcription.completed": {
        const khText = event.transcript?.trim();
        // Tích lũy transcription token usage (tính phí riêng cho model transcription)
        if (event.usage) {
          const txModel = callOps.acceptParams?.audio?.input?.transcription?.model ?? "gpt-4o-mini-transcribe";
          logger.addTranscriptionUsage(event.usage, txModel);
          const audioIn = event.usage.input_token_details?.audio_tokens  ?? event.usage.input_tokens  ?? 0;
          const textOut = event.usage.output_token_details?.text_tokens  ?? event.usage.output_tokens ?? 0;
          log.debug(`[WS][${callId}] transcription usage: audio_in=${audioIn} text_out=${textOut}`);
        }
        // Chỉ log + ghi khi khách thực sự nói (bỏ qua transcript rỗng do im lặng/nhiễu)
        if (khText) {
          log.info(`[WS][${callId}] [KH nói]: ${khText}`);
          logger.addCustomerTurn(khText);
        } else {
          log.info(`[WS][${callId}] [KH nói]: `, { khText });
        }
        break;
      }

      // conversation.item.done: bắt lời AI (output_audio transcript) để ghi log đủ 2 chiều
      case "conversation.item.done": {
        const content = event?.item?.content;
        if (Array.isArray(content)) {
          const aiPart = content.find((c) => c?.type === "output_audio" && c?.transcript);
          if (aiPart?.transcript?.trim()) {
            const txt = aiPart.transcript.trim();
            log.info(`[WS][${callId}] [AI nói]: ${txt}`);
            logger.flushAI(txt);
          }
        }
        break;
      }

      case "response.audio_transcript.done": {
        const aiText = event.transcript?.trim();
        log.info(`[WS][${callId}] [AI nói]: ${aiText}`);
        if (aiText) logger.flushAI(aiText);
        break;
      }



      // ── Lỗi từ OpenAI ─────────────────────────────────────────────────────
      case "error":
        log.error(`[WS][${callId}] OpenAI error:`, event.error);
        logger.addError("openai_event", event.error?.message || _safeJson(event.error));
        break;

      case "session.created":
        log.info(`[WS][${callId}] session.created: ${event.session?.id}`);
        logger.setSessionCreatedData(event.session ?? {});
        logger.addEvent("session_created", event.session?.id || null);
        break;

      case "session.updated":
        log.info(`[WS][${callId}] session.updated OK`);
        logger.addEvent("session_updated", null);
        break;

      default:
        break;
    }
  });

  ws.on("close", async (code, reason) => {
    log.info(`[WS][${callId}] WebSocket đóng: ${code} ${reason?.toString()}`);
    logger.addEvent("ws_close", `${code} ${reason?.toString() || ""}`.trim());
    await _saveOnce(`ws_close ${code}`);
  });

  ws.on("error", (err) => {
    log.error(`[WS][${callId}] WebSocket lỗi: ${err.message}`);
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
    log.warn(`[WS][${callId}] AGENT_QUEUE_URI chưa cấu hình, không thể chuyển máy`);
    return;
  }

  log.info(`[WS][${callId}] Chuyển máy → ${agentUri} (lý do: ${lyDo})`);

  // Delay nhỏ để AI nói xong câu thông báo chuyển máy
  await new Promise((r) => setTimeout(r, 2000));

  try {
    await callOps.refer(callId, agentUri);
    log.info(`[WS][${callId}] Refer thành công`);
  } catch (err) {
    log.error(`[WS][${callId}] Refer thất bại:`, err.message);
  }
}
