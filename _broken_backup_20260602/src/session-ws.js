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
import { TOOLS } from "./system-prompt.js";
import { ConversationLogger } from "./conversation-logger.js";

const OPENAI_WS_URL = "wss://api.openai.com/v1/realtime";

/**
 * Mở WebSocket session cho một call_id.
 * @param {string} callId
 * @param {object} callOps - { hangup(callId), refer(callId, targetUri) }
 * @returns {WebSocket}
 */
export function openSessionWebSocket(callId, callOps) {
  const url = `${OPENAI_WS_URL}?call_id=${callId}`;
  log.info(`[WS][${callId}] Kết nối WebSocket: ${url}`);

  // Khởi tạo logger cho cuộc gọi này
  const logger = new ConversationLogger(callId, callOps.tel);
  if (callOps.acceptParams) logger.setAcceptParams(callOps.acceptParams);
  if (callOps.asteriskData) logger.setAsteriskData(callOps.asteriskData);

  const ws = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
  });

  ws.on("open", () => {
    log.info(`[WS][${callId}] Kết nối WebSocket thành công`);

    // Với SIP calls, session.created KHÔNG được gửi (khác WebSocket thông thường).
    // Phải gửi session.update + response.create ngay khi open – giống Python example.

    // 1. Cập nhật session config (tools, voice, VAD)
    const sessionConfig = {
      type: "realtime",
      voice: process.env.OPENAI_VOICE || "alloy",
      tools: TOOLS,
      tool_choice: "auto",
      input_audio_transcription: { model: "whisper-1" },
      turn_detection: {
        type: "server_vad",
        threshold: 0.7,
        prefix_padding_ms: 500,
        silence_duration_ms: 1200,
      },
    };
    logger.setSessionUpdateParams(sessionConfig);
    ws.send(JSON.stringify({ type: "session.update", session: sessionConfig }));

    // ví dụ : Xin chào, hệ thống trợ lý 'ây ai' của Tổng đài Cấp Nước Trung An xin kính chào Quý khách...  
    // Bắt đầu bằng "Xin chào Quý khách đã gọi đến Tổng đài công ty cấp nước Trung An...
    // 2. Trigger AI nói câu chào ngay lập tức
    ws.send(JSON.stringify({
      type: "response.create",
      response: {
        instructions: `Đợi 1 giây, sau đó : Hãy nói câu chào theo system prompt. 
        ví dụ: Bắt đầu bằng "Xin chào, hệ thống trợ lý ảo 'ây ai' của Tổng đài Cấp Nước Trung An xin kính chào Quý khách. Quý khách cần hỗ trợ thông tin gì ạ!"`,
      },
    }));
  });

  ws.on("message", async (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Log tất cả events
    log.info(`[WS][${callId}] ← ${event.type}`);

    switch (event.type) {
      // ── Function call hoàn chỉnh → xử lý và trả kết quả ──────────────────
      case "response.function_call_arguments.done": {
        const { call_id: toolCallId, name, arguments: argsStr } = event;

        // DEBUG: log toàn bộ event để kiểm tra cấu trúc
        log.info(`[WS][${callId}] 🔧 TOOL CALL RECEIVED`);
        log.info(`[WS][${callId}]    name       : ${name}`);
        log.info(`[WS][${callId}]    toolCallId : ${toolCallId}`);
        log.info(`[WS][${callId}]    arguments  : ${argsStr}`);

        let args = {};
        try {
          args = JSON.parse(argsStr);
          log.info(`[WS][${callId}]    args parsed: ${JSON.stringify(args)}`);
        } catch (e) {
          log.error(`[WS][${callId}]    args parse ERROR: ${e.message}`);
        }

        // Gọi tool handler
        log.info(`[WS][${callId}] 🔧 Calling dispatchTool(${name})...`);
        const output = await dispatchTool(name, args);
        log.info(`[WS][${callId}] 🔧 Tool output: ${output}`);

        // Ghi tool call vào logger
        try { logger.addToolCall(name, args, JSON.parse(output)); } catch { /* ignore */ }

        // Gửi kết quả về OpenAI
        const itemCreate = {
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: toolCallId, output },
        };
        log.info(`[WS][${callId}] 🔧 Sending function_call_output: call_id=${toolCallId}`);
        ws.send(JSON.stringify(itemCreate));

        log.info(`[WS][${callId}] 🔧 Sending response.create to continue conversation`);
        ws.send(JSON.stringify({ type: "response.create" }));

        const result = JSON.parse(output);
        if (result.action === "transfer_to_agent") {
          logger.setOutcome("transferred");
          await _handleTransfer(callId, callOps, result.ly_do);
        } else if (result.action === "end_call") {
          logger.setOutcome("completed");
          setTimeout(() => callOps.hangup(callId), 4000);
        }
        break;
      }

      // ── Streaming function call arguments (debug xem AI đang build args) ──
      case "response.function_call_arguments.delta":
        log.info(`[WS][${callId}] 🔧 Tool args delta: ${event.delta}`);
        break;

      // ── Transcript khách hàng (whisper STT) ───────────────────────────────
      case "conversation.item.input_audio_transcription.completed": {
        const text = event.transcript?.trim();
        if (text) {
          log.info(`[WS][${callId}] [KH]: ${text}`);
          logger.addCustomerTurn(text);
        }
        break;
      }

      // ── Transcript AI – stream từng chunk ─────────────────────────────────
      // case "response.output_audio_transcript.delta":
      //   logger.appendAIDelta(event.delta || "");
      //   break;

      // ── Transcript AI – hoàn chỉnh 1 lượt nói ────────────────────────────
      case "response.output_audio_transcript.done": {
        const text = event.transcript?.trim();
        if (text) {
          log.info(`[WS][${callId}] [AI]: ${text}`);
          logger.flushAI(text); // dùng text done thay vì buffer để chính xác hơn
        } else {
          logger.flushAI(); // flush buffer nếu không có done text
        }
        break;
      }

      // ── Lỗi từ OpenAI ─────────────────────────────────────────────────────
      case "error":
        log.error(`[WS][${callId}] OpenAI error:`, event.error);
        break;

      case "session.created":
        log.info(`[WS][${callId}] session.created: ${event.session?.id}`);
        // Lưu toàn bộ session data vào logger
        logger.setSessionCreatedData(event.session ?? {});
        break;

      case "session.updated": {
        const s = event.session ?? {};
        log.info(`[WS][${callId}] session.updated OK | tools=${s.tools?.length ?? 0} | voice=${s.voice} | vad=${s.turn_detection?.type}`);
        break;
      }

      default:
        break;
    }
  });

  ws.on("close", async (code, reason) => {
    log.info(`[WS][${callId}] WebSocket đóng: ${code} ${reason?.toString()}`);
    // Lưu transcript + summary khi cuộc gọi kết thúc
    try {
      await logger.save();
    } catch (err) {
      log.error(`[WS][${callId}] Lỗi lưu conversation summary:`, err.message);
    }
  });

  ws.on("error", (err) => {
    log.error(`[WS][${callId}] WebSocket lỗi: ${err.message}`);
    // Nếu 404 → session chưa sẵn sàng → retry sau 2s (tối đa 3 lần)
    if (err.message.includes("404") && (callOps._wsRetry ?? 0) < 3) {
      callOps._wsRetry = (callOps._wsRetry ?? 0) + 1;
      const delay = callOps._wsRetry * 2000;
      log.info(`[WS][${callId}] Retry lần ${callOps._wsRetry} sau ${delay}ms...`);
      setTimeout(() => openSessionWebSocket(callId, callOps), delay);
    }
  });

  return ws;
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
