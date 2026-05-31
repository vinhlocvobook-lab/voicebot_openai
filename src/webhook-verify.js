/**
 * webhook-verify.js
 * Xác minh chữ ký webhook từ OpenAI để đảm bảo request hợp lệ.
 * Tài liệu: https://developers.openai.com/api/docs/guides/webhooks
 *
 * Header OpenAI gửi kèm:
 *   webhook-id        – unique ID của delivery attempt
 *   webhook-timestamp – Unix timestamp
 *   webhook-signature – "v1,<base64_hmac_sha256>"
 */

import crypto from "crypto";

/**
 * Verify webhook signature.
 * @param {Buffer|string} rawBody - Raw request body (phải là Buffer để tính hash chính xác)
 * @param {object} headers        - Request headers
 * @returns {boolean}
 */
export function verifyWebhookSignature(rawBody, headers) {
  const secret = process.env.OPENAI_WEBHOOK_SECRET;
  if (!secret) {
    console.warn("[Webhook] OPENAI_WEBHOOK_SECRET chưa cấu hình – bỏ qua xác minh chữ ký!");
    return true; // Cho qua trong môi trường dev
  }

  const msgId        = headers["webhook-id"];
  const msgTimestamp = headers["webhook-timestamp"];
  const msgSig       = headers["webhook-signature"];

  if (!msgId || !msgTimestamp || !msgSig) return false;

  // Kiểm tra timestamp không quá 5 phút cũ (chống replay attack)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(msgTimestamp, 10)) > 300) return false;

  // OpenAI dùng Svix: secret có dạng "whsec_<base64>" → phải base64-decode phần sau prefix
  const secretBase64 = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const secretBytes = Buffer.from(secretBase64, "base64");

  // Signing string theo chuẩn Svix: "{msg_id}.{msg_timestamp}.{body}"
  const toSign = `${msgId}.${msgTimestamp}.${rawBody.toString()}`;
  const expectedSig =
    "v1," + crypto.createHmac("sha256", secretBytes).update(toSign).digest("base64");

  // So sánh với từng signature trong header (có thể có nhiều, ngăn cách bằng space)
  return msgSig.split(" ").some((sig) => {
    try {
      const a = Buffer.from(sig);
      const b = Buffer.from(expectedSig);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  });
}
