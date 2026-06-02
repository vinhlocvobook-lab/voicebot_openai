/**
 * server.js
 * Entry point – Express server nhận webhook từ OpenAI Realtime SIP.
 *
 * Luồng:
 *  1. Asterisk → SIP trunk → sip:{PROJECT_ID}@sip.api.openai.com
 *  2. OpenAI → POST /webhook → đây (realtime.call.incoming)
 *  3. Server → POST /v1/realtime/calls/{call_id}/accept
 *  4. Server → WebSocket wss://api.openai.com/v1/realtime?call_id={call_id}
 *  5. WebSocket xử lý function calls (tra cứu dữ liệu, tạo ticket, chuyển máy...)
 */

import "dotenv/config";
import express from "express";
import WebSocket from "ws";
import { acceptCall, rejectCall, referCall, hangupCall } from "./src/call-manager.js";
import { openSessionWebSocket } from "./src/session-ws.js";
import { verifyWebhookSignature } from "./src/webhook-verify.js";
import { log } from "./src/logger.js";

const app = express();
const PORT = process.env.PORT || 8000;
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || "/webhook";

const AUTH_HEADER = {
  'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
};


function extractAsteriskHeaders(payload) {
  try {
    // 1. Parse chuỗi JSON thành Object
    // const payload = JSON.parse(jsonString);

    // 2. Lấy mảng sip_headers
    const headers = payload?.data?.sip_headers || [];

    // 3. Chuyển mảng thành một object dạng key-value
    const headerMap = headers.reduce((acc, current) => {
      acc[current.name] = current.value;
      return acc;
    }, {});

    // 4. Trích xuất số điện thoại từ header 'From' bằng Regex
    let phoneNumber = null;
    if (headerMap['From']) {
      const match = headerMap['From'].match(/sip:([^@]+)@/);
      phoneNumber = match ? match[1] : null;
    }

    // 5. Trả về đầy đủ các trường dữ liệu
    return {
      uniqueid: headerMap['Uniqueid'] || null,
      recordPath: headerMap['RecordPath'] || null,
      phoneNumber: phoneNumber // <-- Đã bổ sung số điện thoại
    };

  } catch (error) {
    console.error("Lỗi khi parse chuỗi JSON:", error.message);
    return { uniqueid: null, recordPath: null, phoneNumber: null };
  }
}
// ─── Đọc raw body để verify signature ────────────────────────────────────────
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf; // Lưu raw buffer để verify HMAC
    },
  })
);

// ─── Webhook endpoint ─────────────────────────────────────────────────────────
app.post(WEBHOOK_PATH, async (req, res) => {
  // 1. Xác minh chữ ký
  if (!verifyWebhookSignature(req.rawBody, req.headers)) {
    log.warn("[Webhook] Chữ ký không hợp lệ – từ chối request");
    return res.status(400).json({ error: "Invalid signature" }); n
  }

  const event = req.body;
  log.info(`[Webhook] 1.Nhận event: ${event.type} (id: ${event.id})`);
  // log.info(`[Webhook] 2.Nhận event: ${JSON.stringify(event)}`);

  // 2. Chỉ xử lý realtime.call.incoming
  if (event.type !== "realtime.call.incoming") {
    return res.status(200).end();
  }

  // 3. Trích xuất thông tin Asterisk từ SIP headers
  const asteriskData = extractAsteriskHeaders(event);
  log.info(`[Webhook] Asterisk: uniqueid=${asteriskData.uniqueid} | tel=${asteriskData.phoneNumber} | record=${asteriskData.recordPath}`);

  // 4. Xử lý cuộc gọi
  const { call_id: callId, sip_headers: sipHeaders } = event.data;
  const fromHeader = sipHeaders?.find((h) => h.name === "From")?.value || "unknown";
  const tel = asteriskData.phoneNumber || fromHeader.match(/sip:([^@]+)@/)?.[1] || "unknown";
  log.info(`[Webhook] Incoming call ${callId} | from=${fromHeader}`);

  res.sendStatus(200);
  try {
    await _handleIncomingCall(callId, fromHeader, tel, asteriskData);
  } catch (err) {
    log.error(`[Webhook] Lỗi xử lý call ${callId}: `, err.message);
  }
});

// ─── Xử lý cuộc gọi đến ──────────────────────────────────────────────────────


async function _handleIncomingCall(callId, fromHeader, tel, asteriskData = {}) {
  // Kiểm tra xem đang ngoài giờ hành chính không (để điều chỉnh behavior nếu cần)
  const hour = new Date().getHours();
  let isAfterHours = hour >= 22 || hour < 6;
  isAfterHours = false;
  console.log({ isAfterHours });

  if (isAfterHours) {
    log.info(`[Call][${callId}]Cuộc gọi ngoài giờ(${hour}h) – chỉ tiếp nhận sự cố`);
  }

  // Accept cuộc gọi – trả về params đã gửi để logger ghi lại
  const { acceptParams } = await acceptCall(callId);

  // Tạo callOps object để session-ws gọi lại khi cần
  const callOps = {
    hangup: (id) => hangupCall(id).catch((e) => log.error(`Hangup lỗi: `, e.message)),
    refer: (id, uri) => referCall(id, uri),
    fromHeader,
    tel,
    acceptParams,   // params gửi lúc accept
    asteriskData,   // uniqueid, recordPath, phoneNumber từ Asterisk
    initialGreeting: `Đợi 1 giây, sau đó : Hãy nói câu chào theo system prompt. 
        ví dụ: Bắt đầu bằng "... ...  Xin chào, hệ thống trợ lý ảo 'ây ai' của Tổng đài Cấp Nước Trung An xin kính chào Quý khách. Quý khách cần hỗ trợ thông tin gì ạ!"`
  };

  // Mở WebSocket để điều khiển session
  openSessionWebSocket_my(callId, callOps);
}

const getLuuLuong = async ({ sodanhbo }) => {
  console.log("[getLuuLuong]:", sodanhbo)
  return `Lưu lượng nước tháng này của quý khách là 10 mét khối`
}
const getCupNuoc = async ({ sodanhbo }) => {
  console.log("[getCupNuoc]:", sodanhbo)
  return `Hiện tại khu vực của quý khách đang xãy ra sự cố, dự kiến khắc phục xong lúc 5h chiều nay. Chúng tôi sẽ thông báo cho quý khách khi có thông tin mới.`
}

async function openSessionWebSocket_my(callId, callOps) {
  console.log(`🔗 [${callId}] Bắt đầu kết nối WebSocket...`);
  const wsUrl = `wss://api.openai.com/v1/realtime?call_id=${callId}`;

  console.log({ wsUrl, AUTH_HEADER });
  const ws = new WebSocket(wsUrl, { headers: AUTH_HEADER });

  ws.on('open', () => {
    log.info(`✅ [${callId}] WebSocket connected`);
    callOps.ws = ws;
    // Gửi lời chào đầu tiên
    ws.send(JSON.stringify({
      "type": "response.create",
      "response": {
        "instructions": callOps.initialGreeting
      },
    }));

  });
  ws.on('message', async (message) => {
    const msg = JSON.parse(message.toString());
    const type = msg?.type;

    // Log các sự kiện quan trọng để debug
    if (type === "conversation.item.done") {
      console.log(`[OpenAi - ${type}] Câu trả lời đã được thêm vào conversation`);
      console.log(msg?.item?.content);
      if (msg?.item?.content === "undefined") {
        console.log(msg);
      }
    }
    if (type === "conversation.item.input_audio_transcription.completed") {
      console.log(`🎤 [USER]: ${msg.transcript}`);
    }

    if (type === "response.done") {
      const response_done_usage = msg?.response?.usage;
      console.log(`[${callId}] : response.done usage:`, response_done_usage);
      const output = msg?.response?.output;
      if (!output || output.length === 0) return;

      const item = output[0];

      if (item?.type === "function_call") {
        const call_id = item.call_id;
        const name = item.name;
        const argsStr = item.arguments;
        console.log(`🤖 [AI] Gọi hàm: ${name}`);

        try {
          const args = JSON.parse(argsStr);
          let functionResult = "";

          switch (name) {
            case "getLuuLuong":
              functionResult = await getLuuLuong(args);
              break;
            case "getCupNuoc":
              functionResult = await getCupNuoc(args);
              break;

            default:
              console.warn(`⚠️ Hàm ${name} chưa được xử lý!`);
              functionResult = "Function not implemented.";
              break;
          }

          // Gửi kết quả function về lại cho AI
          console.log(`📤 Gửi kết quả function ${name} về AI.`, { functionResult });
          ws.send(JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: call_id,
              output: functionResult
            }
          }));

          // Trigger AI tạo phản hồi tiếp theo dựa trên kết quả
          let nextInstructions = "Phản hồi lại khách hàng dựa trên kết quả vừa nhận được.";
          // if (isHangupRequested) {
          //   nextInstructions = "Nói lời chào tạm biệt lịch sự và kết thúc.";
          // }

          ws.send(JSON.stringify({
            type: "response.create",
            response: { instructions: nextInstructions }
          }));

        } catch (err) {
          console.error("❌ Lỗi xử lý function:", err);
        }
      }
    }

    if (type === "output_audio_buffer.stopped" && isHangupRequested) {
      console.log(`🔌 [${callId}] Thực hiện lệnh ngắt kết nối vật lý...`);
      await hangupCall(callId);
    }
  });

  ws.on('error', (err) => console.error(`❌ [${callId}] WS Error:`, err));
  ws.on('close', () => console.log(`🔒 [${callId}] WS Closed.`));

}
// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  log.info(`[Server] Voice Bot đang chạy tại port ${PORT}`);
  log.info(`[Server] Webhook endpoint: POST http://0.0.0.0:${PORT}${WEBHOOK_PATH}`);
  log.info(`[Server] SIP endpoint: sip:${process.env.OPENAI_PROJECT_ID || "<PROJECT_ID>"}@sip.api.openai.com;transport=tls`);
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
process.on("SIGTERM", () => {
  log.info("[Server] SIGTERM nhận – đang tắt...");
  process.exit(0);
});
