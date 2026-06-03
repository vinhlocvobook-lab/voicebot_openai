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

    // 2. Trigger AI nói câu chào ngay lập tức
    ws.send(JSON.stringify({
      type: "response.create",
      response: {
        instructions: 'im lặng 5 giây, rồi nói "Xin chào Quý Khách, Cảm ơn Quý Khách đã gọi đến Tổng đài Công ty Cổ phần Cấp nước Trung An. Em là Trợ lý Ảo "Ây Ai ", Quý khách cần em hỗ trợ gì ạ?"',
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

    // Log tất cả events để debug (dùng LOG_LEVEL=debug để xem đầy đủ)
    // log.info(`[WS][${callId}] ← ${event.type}`);

    switch (event.type) {
      // ── Response hoàn chỉnh → kiểm tra có function_call không ─────────────
      // Theo pattern của openai_nestle_step3.js: bắt function call qua
      // response.done → response.output[], lọc item.type === "function_call".
      case "response.done": {
        const usage = event?.response?.usage;
        if (usage) log.debug(`[WS][${callId}] response.done usage:`, usage);

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

          // Gọi handler và gửi kết quả tool về cho OpenAI
          const toolOutput = await dispatchTool(name, args);
          log.debug(`[WS][${callId}] Tool output: ${toolOutput}`);

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

          // Xử lý side effects và xác định instructions cho phản hồi tiếp theo
          let nextInstructions = "Phản hồi lại khách hàng dựa trên kết quả vừa nhận được.";
          let result = {};
          try { result = JSON.parse(toolOutput); } catch { /* ignore */ }

          if (result.action === "transfer_to_agent") {
            nextInstructions = "Thông báo lịch sự rằng đang chuyển máy cho tổng đài viên.";
          } else if (result.action === "end_call") {
            nextInstructions = "Nói lời chào tạm biệt lịch sự và kết thúc cuộc gọi.";
          }

          // Yêu cầu AI tiếp tục phản hồi dựa trên kết quả tool
          ws.send(JSON.stringify({
            type: "response.create",
            response: { instructions: nextInstructions },
          }));

          if (result.action === "transfer_to_agent") {
            await _handleTransfer(callId, callOps, result.ly_do);
          } else if (result.action === "end_call") {
            // Delay để AI kịp nói lời tạm biệt trước khi cúp máy
            setTimeout(() => callOps.hangup(callId), 4000);
          }
        }
        break;
      }

      // ── Transcription để log cuộc hội thoại ───────────────────────────────
      case "conversation.item.input_audio_transcription.completed":
        log.info(`[WS][${callId}] [KH nói]: ${event.transcript}`);
        break;

      case "response.audio_transcript.done":
        log.info(`[WS][${callId}] [AI nói]: ${event.transcript}`);
        break;

      // ── Lỗi từ OpenAI ─────────────────────────────────────────────────────
      case "error":
        log.error(`[WS][${callId}] OpenAI error:`, event.error);
        break;

      case "session.created":
        log.info(`[WS][${callId}] session.created: ${event.session?.id}`);
        break;

      case "session.updated":
        log.info(`[WS][${callId}] session.updated OK`);
        break;

      default:
        break;
    }
  });

  ws.on("close", (code, reason) => {
    log.info(`[WS][${callId}] WebSocket đóng: ${code} ${reason?.toString()}`);
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
