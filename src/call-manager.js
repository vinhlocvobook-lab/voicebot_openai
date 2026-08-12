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
  //
  // [fix 10/08/2026] Trước đây context_chuacosodanhbo được nối vào MỌI trường
  // hợp, kể cả khi customerContext ĐÃ có mã (live API hoặc lịch sử cuộc gọi
  // trước) — hai đoạn mâu thuẫn nhau nằm cạnh nhau trong cùng 1 prompt: một bên
  // bảo "đã có mã X, đọc lại xin xác nhận", một bên bảo "khi CHƯA có thông tin,
  // hỏi câu Y". Model bị rối, bám theo đoạn gần cuối hơn và bỏ qua hẳn mã đã
  // biết (cuộc rtc_u2_EBHOI1DgBJmPL6Rn4HV8Z 10/08/2026: customerContext có mã
  // lịch sử 22073242112, nhưng model vẫn hỏi "cho em xin mã danh bộ... đọc liền
  // một mạch" y như chưa biết gì). Chỉ thêm câu "chưa có thông tin" khi THỰC SỰ
  // không có customerContext nào (không phải live, không phải lịch sử).
  const context_chuacosodanhbo = `
# Số Danh Bộ
 Lời thoại để hỏi số danh bộ (ma_danh_bo) khi chưa có thông tin : "Dạ, Quý Khách vui lòng cho em xin số danh bộ để kiểm tra ạ"`;

  const instructions = customerContext
    ? `${SYSTEM_PROMPT}\n\n${customerContext}`
    : `${SYSTEM_PROMPT}\n\n${context_chuacosodanhbo}`;

  log.info("[acceptCall]: instructions= ", instructions);
  const body = {
    type: "realtime",
    // [migrate 30/07/2026] gpt-realtime-1.5 → gpt-realtime-2.1-mini (xem
    // docs/fix/fix_migrate_gpt_realtime_21_20260730.md). Model reasoning-capable
    // mới đọc/hiểu tuân lệnh literal hơn hẳn — nhiều rule/workaround viết cho
    // bản 1.5 (không có reasoning) có thể cần điều chỉnh dần, xem CLAUDE.md.
    model: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2.1-mini",
    // [migrate 30/07/2026] Model 2.1.x hỗ trợ reasoning_effort điều chỉnh được.
    // "low" là mức khuyến nghị của OpenAI cho voice agent CSKH (đủ suy luận cho
    // tra cứu/điều phối tool, không cộng thêm độ trễ cảm nhận được). Tăng lên
    // "medium" nếu thấy model quyết định tool/leo thang ẩu; xem
    // docs/fix/fix_migrate_gpt_realtime_21_20260730.md.
    reasoning: { effort: process.env.OPENAI_REALTIME_REASONING_EFFORT || "low" },
    instructions,
    tools: TOOLS,
    audio: {
      input: {
        transcription: {
          // [fix 19/07/2026] KHÔNG dùng "gpt-realtime-whisper" ở đây: model đó chỉ
          // cho session transcription riêng (type: "transcription"), không hợp lệ
          // trong session realtime/SIP → accept vẫn 200 nhưng session không khởi
          // tạo được, WS connect 404 cả 4 lần retry (cuộc rtc_u2_E3ChapqNtmYn1YsIVbKOs).
          //model: "gpt-realtime-whisper",//
          // model: "gpt-4o-mini-transcribe",
          model: "gpt-4o-transcribe",
          language: "vi",
          // [fix 08/07/2026] Gợi ý ngữ cảnh để giảm transcribe sai ngôn ngữ
          // (vd "bye bye" → "拜拜"). LƯU Ý: transcript chỉ dùng để log/debug,
          // KHÔNG dùng làm căn cứ xử lý nghiệp vụ (model nghe audio trực tiếp).
          prompt: "Cuộc gọi tổng đài chăm sóc khách hàng công ty cấp nước tại TP.HCM, "
            + "toàn bộ bằng tiếng Việt. Có thể chứa mã danh bộ 11 chữ số, số tiền, "
            + "tên thủ tục: định mức nước, lắp đặt đồng hồ, sang tên, nâng dời đồng hồ.",
        },
      },
      // [migrate 30/07/2026] `voice` trước đây chỉ có mặt trong comment ở
      // session-ws.js (chưa từng thật sự gửi cho OpenAI) → OPENAI_VOICE trong
      // .env là config chết. Đường dẫn đúng theo API hiện hành:
      // session.audio.output.voice (không đổi được giữa chừng phiên sau khi
      // model đã phát audio ít nhất 1 lần).
      output: {
        voice: process.env.OPENAI_VOICE || "alloy",
      },
    },
  };

  log.info(`[CallMgr] Accepting call ${callId}`);
  // console.log("[acceptCall]", {
  //   BASE,
  //   callId,
  //   authHeaders,
  //   body: JSON.stringify(body)
  // })
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
