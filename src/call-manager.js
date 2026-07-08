/**
 * call-manager.js
 * Wrapper quanh OpenAI Realtime Calls REST API.
 * Tài liệu: https://developers.openai.com/api/docs/api-reference/realtime-calls
 */

import { SYSTEM_PROMPT, TOOLS } from "./system-prompt.js";
import { log } from "./logger.js";
// import { TOOLS } from "./system-prompt.js";
const BASE = "https://api.openai.com/v1/realtime/calls";

function authHeaders() {
  return {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    "Content-Type": "application/json",
  };
}

/**
 * Accept một incoming call và cấu hình Realtime session.
 * @param {string} callId
 * @returns {Promise<object>} - Response body từ OpenAI
 */
export async function acceptCall(callId, customerContext = "") {
  // Giữ body tối giản giống Python example trong docs OpenAI.
  // Các config nâng cao (tools, voice, VAD, transcription) sẽ được gửi
  // qua session.update sau khi WebSocket kết nối thành công.
  const instructions = customerContext
    ? `${SYSTEM_PROMPT}\n\n${customerContext}`
    : SYSTEM_PROMPT;

  const body = {
    type: "realtime",
    model: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2",
    instructions,
    tools: TOOLS,
    audio: {
      input: {
        transcription: {
          model: "gpt-4o-mini-transcribe",
          language: "vi",
          // [fix 08/07/2026] Gợi ý ngữ cảnh để giảm transcribe sai ngôn ngữ
          // (vd "bye bye" → "拜拜"). LƯU Ý: transcript chỉ dùng để log/debug,
          // KHÔNG dùng làm căn cứ xử lý nghiệp vụ (model nghe audio trực tiếp).
          prompt: "Cuộc gọi tổng đài chăm sóc khách hàng công ty cấp nước tại TP.HCM, "
                + "toàn bộ bằng tiếng Việt. Có thể chứa mã danh bộ 11 chữ số, số tiền, "
                + "tên thủ tục: định mức nước, lắp đặt đồng hồ, sang tên, nâng dời đồng hồ.",
        },
      },
    },
  };

  log.info(`[CallMgr] Accepting call ${callId}`);
  console.log("[acceptCall]", {
    BASE,
    callId,
    authHeaders,
    body: JSON.stringify(body)
  })
  const res = await fetch(`${BASE}/${callId}/accept`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Accept call failed ${res.status}: ${text}`);
  }

  log.info(`[CallMgr] Call ${callId} accepted`);
  // OpenAI trả 200 OK với body rỗng hoặc JSON – xử lý cả hai trường hợp
  const text = await res.text();
  console.log("[CallMgr] :text :", text);
  // Trả về body đã gửi để logger lưu lại (phân tích/điều chỉnh prompt)
  return body;
}

/**
 * Từ chối một incoming call.
 * @param {string} callId
 * @param {number} statusCode - SIP status code (mặc định 486 = busy)
 */
export async function rejectCall(callId, statusCode = 486) {
  log.info(`[CallMgr] Rejecting call ${callId} (${statusCode})`);
  const res = await fetch(`${BASE}/${callId}/reject`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ status_code: statusCode }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Reject call failed ${res.status}: ${text}`);
  }
}

/**
 * Chuyển máy (SIP REFER) sang URI khác.
 * @param {string} callId
 * @param {string} targetUri - VD: "sip:200@asterisk_host" hoặc "tel:+84901234567"
 */
export async function referCall(callId, targetUri) {
  log.info(`[CallMgr] Referring call ${callId} → ${targetUri}`);
  setTimeout(async () => {
    try {
      const res = await fetch(`${BASE}/${callId}/refer`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ target_uri: targetUri }),
      });
      if (!res.ok) {
        const text = await res.text();
        log.error(`[CallMgr] Refer ${callId} thất bại ${res.status}: ${text}`);
      } else {
        log.info(`[CallMgr] Refer ${callId} thành công`);
      }
    } catch (err) {
      log.error(`[CallMgr] Refer ${callId} lỗi mạng: ${err.message}`);
    }
  }, 2000);
}

/**
 * Cúp máy.
 * @param {string} callId
 */
export async function hangupCall(callId) {
  log.info(`[CallMgr] Hanging up call ${callId}`);
  setTimeout(async () => {
    try {
      const res = await fetch(`${BASE}/${callId}/hangup`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (!res.ok) {
        const text = await res.text();
        // 404/call_id_not_found = cuộc gọi đã kết thúc → coi như thành công, KHÔNG ném lỗi
        if (res.status === 404) {
          log.info(`[CallMgr] Hangup ${callId}: cuộc gọi đã kết thúc trước đó (404), bỏ qua.`);
        } else {
          log.error(`[CallMgr] Hangup ${callId} thất bại ${res.status}: ${text}`);
        }
      } else {
        log.info(`[CallMgr] Hangup ${callId} thành công`);
      }
    } catch (err) {
      // Bắt mọi lỗi mạng để không làm sập tiến trình
      log.error(`[CallMgr] Hangup ${callId} lỗi mạng: ${err.message}`);
    }
  }, 3000);
}
