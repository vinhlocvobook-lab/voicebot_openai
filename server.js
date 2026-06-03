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
import { acceptCall, rejectCall, referCall, hangupCall } from "./src/call-manager.js";
import { openSessionWebSocket } from "./src/session-ws.js";
import { verifyWebhookSignature } from "./src/webhook-verify.js";
import { log } from "./src/logger.js";

const app = express();
const PORT = process.env.PORT || 8000;
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || "/webhook";

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
    return res.status(400).json({ error: "Invalid signature" });
  }

  const event = req.body;
  log.info(`[Webhook] 1.Nhận event: ${event.type} (id: ${event.id})`);
  // log.info(`[Webhook] 2.Nhận event: ${JSON.stringify(event)}`);

  // 2. Chỉ xử lý realtime.call.incoming
  if (event.type !== "realtime.call.incoming") {
    return res.status(200).end(); // Ack các event khác
  }

  // Trả 200 ngay để OpenAI không retry
  // res.status(200).end();

  // 3. Xử lý cuộc gọi async
  const { call_id: callId, sip_headers: sipHeaders } = event.data;
  const fromHeader = sipHeaders?.find((h) => h.name === "From")?.value || "unknown";
  log.info(`[Webhook] 3.Incoming call ${callId} from ${fromHeader}`);

  // Trích thông tin Asterisk (uniqueid, recordPath, phoneNumber) để log/debug
  const asteriskData = extractAsteriskHeaders(event);
  log.info(`[Webhook] Asterisk: uniqueid=${asteriskData.uniqueid} recordPath=${asteriskData.recordPath} phone=${asteriskData.phoneNumber}`);

  let tel = "Unknown";
  if (fromHeader) {
    const regex = /sip:([^@]+)@/;
    const match = fromHeader.match(regex);
    // Nếu match thành công, kết quả sẽ nằm ở index 1 của mảng
    tel = match ? match[1] : null;
  }
  // Ưu tiên số điện thoại từ Asterisk nếu có
  tel = asteriskData.phoneNumber || tel;

  res.sendStatus(200);
  try {
    await _handleIncomingCall(callId, fromHeader, tel, asteriskData);
  } catch (err) {
    log.error(`[Webhook] Lỗi xử lý call ${callId}: `, err.message);
  }
});

// ─── Xử lý cuộc gọi đến ──────────────────────────────────────────────────────

async function _handleIncomingCall(callId, fromHeader, tel, asteriskData = null) {
  // Kiểm tra xem đang ngoài giờ hành chính không (để điều chỉnh behavior nếu cần)
  const hour = new Date().getHours();
  let isAfterHours = hour >= 22 || hour < 6;
  isAfterHours = false;
  console.log({ isAfterHours });

  if (isAfterHours) {
    log.info(`[Call][${callId}]Cuộc gọi ngoài giờ(${hour}h) – chỉ tiếp nhận sự cố`);
  }

  // Accept cuộc gọi (cấu hình session được set trong call-manager.js)
  // acceptCall trả về body đã gửi (instructions + tools) để logger lưu lại
  const acceptParams = await acceptCall(callId);

  // Tạo callOps object để session-ws gọi lại khi cần
  const callOps = {
    hangup: (id) => hangupCall(id).catch((e) => log.error(`Hangup lỗi: `, e.message)),
    refer: (id, uri) => referCall(id, uri),
    fromHeader, tel,
    asteriskData,
    acceptParams,
  };

  // Mở WebSocket để điều khiển session
  openSessionWebSocket(callId, callOps);
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

// ─── Lưới an toàn: không để lỗi async sót lại làm sập server giữa cuộc gọi ──────
process.on("unhandledRejection", (reason) => {
  log.error("[Server] unhandledRejection:", reason?.message || reason);
});
process.on("uncaughtException", (err) => {
  log.error("[Server] uncaughtException:", err?.message || err);
});
