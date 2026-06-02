/**
 * call-manager.js
 * Wrapper quanh OpenAI Realtime Calls REST API.
 * Tài liệu: https://developers.openai.com/api/docs/api-reference/realtime-calls
 */

import { SYSTEM_PROMPT, TOOLS } from "./system-prompt.js";
import { log } from "./logger.js";

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

let acceptCall_intructions = `Bạn đóng vai trò là nhân viên hỗ trợ khách hàng của công ty cấp nước Trung An. Nhiệm vụ của bạn là hỗ trợ khách hàng trả lời các câu hỏi của khách hàng một cách nhiệt tình và chu đáo.`
const getLuuLuong_tool = {
  "type": "function",
  "function": {
    "name": "getLuuLuong",
    "description": "Cung cấp thông tin về lượng nước tiêu thụ. Khi cần hỏi số danh bộ, bạn cần đọc lại số danh bộ (sodanhbo) mã khách hàng đã cung cấp, đọc từng số một, chậm rãi và rõ ràng để khách hàng xác nhận lại số danh bộ trước khi gọi tool này",
    "parameters": {
      "type": "object",
      "properties": {
        "sodanhbo": {
          "type": "string",
          "description": "Số danh bộ"
        }
      },
      "required": ["sodanhbo"]
    }
  }
}
const getCupNuoc_tool = {
  "type": "function",
  "function": {
    "name": "getCupNuoc",
    "description": "Lấy chỉ số tiêu thụ nước. Khi cần hỏi số danh bộ, bạn cần đọc lại số danh bộ (sodanhbo) mã khách hàng đã cung cấp, đọc từng số một, chậm rãi và rõ ràng để khách hàng xác nhận lại số danh bộ trước khi gọi tool này",
    "parameters": {
      "type": "object",
      "properties": {
        "sodanhbo": {
          "type": "string",
          "description": "Số danh bộ"
        }
      },
      "required": ["sodanhbo"]
    }
  }
}


export async function acceptCall(callId) {
  // Giữ body tối giản giống Python example trong docs OpenAI.
  // Các config nâng cao (tools, voice, VAD, transcription) sẽ được gửi
  // qua session.update sau khi WebSocket kết nối thành công.
  const body = {
    type: "realtime",
    model: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2",
    instructions: acceptCall_intructions,//SYSTEM_PROMPT,
    tools: [getLuuLuong_tool, getCupNuoc_tool],

    "audio": { "input": { "transcription": { "model": "gpt-4o-mini-transcribe", "language": "vi" } } }
  };

  log.info(`[CallMgr] Accepting call ${callId} | model=${body.model}`);
  const res = await fetch(`${BASE}/${callId}/accept`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Accept call failed ${res.status}: ${errText}`);
  }

  log.info(`[CallMgr] Call ${callId} accepted`);
  const text = await res.text();
  const responseBody = text ? JSON.parse(text) : {};

  // Trả về cả params đã gửi để logger có thể ghi lại
  return { acceptParams: body, acceptResponse: responseBody };
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
  const res = await fetch(`${BASE}/${callId}/refer`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ target_uri: targetUri }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Refer call failed ${res.status}: ${text}`);
  }
}

/**
 * Cúp máy.
 * @param {string} callId
 */
export async function hangupCall(callId) {
  log.info(`[CallMgr] Hanging up call ${callId}`);
  const res = await fetch(`${BASE}/${callId}/hangup`, {
    method: "POST",
    headers: authHeaders(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Hangup call failed ${res.status}: ${text}`);
  }
}
