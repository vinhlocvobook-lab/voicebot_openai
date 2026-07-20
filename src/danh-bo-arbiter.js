/**
 * danh-bo-arbiter.js — [fix 19/07/2026]
 * TRỌNG TÀI mã danh bộ: gom mọi quan sát nhiễu về CÙNG một mã danh bộ rồi nhờ
 * model mạnh (mặc định gpt-5.1) suy ra dãy 11 số khả dĩ nhất.
 * [fix 19/07/2026 v2] Chạy như CO-PILOT NGẦM ngay từ lượt đọc ĐẦU TIÊN (song
 * song lúc bot đọc lại số cho khách) — xem handleConfirmDanhBo trong tools.js.
 *
 * Nguồn quan sát (mỗi lần khách đọc có tới 2 "tai" nghe độc lập):
 *   1. reads       — dãy số model realtime (mini) nghe được, truyền vào confirm_danh_bo.
 *   2. transcripts — transcript các lượt khách đọc số (gpt-4o-mini-transcribe),
 *                    do session-ws.js buffer vào callState._danhBoTranscripts.
 *   3. knownDanhBo — danh bộ đã đăng ký theo SĐT gọi đến (gợi ý mạnh, không ép).
 *   4. rejected    — các dãy bot ĐÃ đọc lại và bị khách BÁO SAI (đáp án đúng
 *                    chắc chắn khác các dãy này ở ít nhất một vị trí).
 *
 * LƯU Ý: đây là ngoại lệ CÓ CHỦ ĐÍCH của quy ước "transcript chỉ để debug" —
 * chỉ dùng làm dữ liệu cho trọng tài ở bước fallback, kết quả LUÔN phải qua
 * 2 lớp kiểm tra: xác thực API (verifyCustomer) + khách xác nhận lại từng số.
 */

import { log } from "./logger.js";

const ARBITER_MODEL = process.env.DANH_BO_ARBITER_MODEL || "gpt-5.1";
// [fix 19/07/2026 v3] 12s → 20s: gpt-5.1 reasoning với nhiều transcript có thể
// >12s (đã timeout 2 lần cuộc E3KbgngzfpyMMwworgeXs). An toàn vì trọng tài giờ
// LUÔN chạy NỀN (không chặn bot đọc lại) — xem handleConfirmDanhBo/proactiveAssembleDanhBo.
const ARBITER_TIMEOUT_MS = Number(process.env.DANH_BO_ARBITER_TIMEOUT_MS || 20000);
// [fix 19/07/2026] gpt-5.1 là reasoning model — mặc định có thể "suy nghĩ" nhiều
// giây trước khi trả lời, mà bước này chạy GIỮA cuộc gọi thoại (khách đang chờ
// trong im lặng). "low" đủ để đối chiếu vài dãy số nhiễu, nhanh hơn hẳn medium/high.
const ARBITER_REASONING_EFFORT = process.env.DANH_BO_ARBITER_REASONING_EFFORT || "low";

// Structured output — ép model trả ĐÚNG 3 field, đúng kiểu dữ liệu. Tránh trường
// hợp model quên field do_tin_cay hoặc trả kiểu sai (vd chuỗi "cao" thay vì số)
// làm code hiểu nhầm thành tin cậy cao (xem check Number.isFinite ở tools.js).
const VERDICT_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "danh_bo_verdict",
    strict: true,
    schema: {
      type: "object",
      properties: {
        ma_danh_bo: {
          type: ["string", "null"],
          description: "Chuỗi ĐÚNG 11 chữ số suy ra được, hoặc null nếu không đủ tin cậy để ghép.",
        },
        do_tin_cay: {
          type: "number",
          description: "Độ tin cậy từ 0.0 đến 1.0 rằng ma_danh_bo là đúng.",
        },
        ly_do: {
          type: "string",
          description: "Giải thích ngắn gọn cách ghép/suy luận.",
        },
      },
      required: ["ma_danh_bo", "do_tin_cay", "ly_do"],
      additionalProperties: false,
    },
  },
};

/**
 * @param {object} p
 * @param {string[]} p.reads        Các dãy số model đã nghe (theo thứ tự thời gian).
 * @param {string[]} p.transcripts  Transcript các lượt khách đọc số.
 * @param {string[]} p.knownDanhBo  Danh bộ đăng ký theo SĐT người gọi.
 * @param {string[]} p.rejected     Các dãy đã đọc lại cho khách và bị khách BÁO SAI.
 * @returns {Promise<{ma_danh_bo:string|null, do_tin_cay:number, ly_do:string}|null>}
 */
export async function arbitrateDanhBo({ reads = [], transcripts = [], knownDanhBo = [], rejected = [] } = {}) {
  if (reads.length === 0 && transcripts.length === 0) return null;

  const prompt = `Bạn là chuyên gia phân tích lỗi nhận dạng giọng nói (ASR) tiếng Việt cho tổng đài cấp nước.
Khách hàng đang đọc MÃ DANH BỘ gồm ĐÚNG 11 CHỮ SỐ qua điện thoại. Có nhiều "bản nghe" nhiễu về CÙNG một mã, từ 2 hệ thống nghe độc lập:

=== BẢN NGHE CỦA MODEL THOẠI (kém tin cậy hơn, hay rơi mất số đầu, chép sai số) ===
${reads.length ? reads.map((r, i) => `Lần ${i + 1}: "${r}" (${r.length} số)`).join("\n") : "(không có)"}

=== TRANSCRIPT CÁC LƯỢT KHÁCH ĐỌC SỐ (model phiên âm riêng, thường chính xác hơn; khách có thể đọc tách nhiều hơi — các lượt LIỀN NHAU có thể là các PHẦN nối tiếp của cùng một mã) ===
${transcripts.length ? transcripts.map((t, i) => `Lượt ${i + 1}: "${t}"`).join("\n") : "(không có)"}

=== DANH BỘ ĐÃ ĐĂNG KÝ THEO SỐ ĐIỆN THOẠI NGƯỜI GỌI (gợi ý mạnh nếu khớp gần đúng với bản nghe, nhưng khách CÓ THỂ hỏi cho danh bộ khác) ===
${knownDanhBo.length ? knownDanhBo.join(", ") : "(không có)"}

=== CÁC DÃY BOT ĐÃ ĐỌC LẠI VÀ KHÁCH BÁO SAI (đáp án đúng KHÁC các dãy này ở ít nhất một vị trí — TUYỆT ĐỐI không trả lại y nguyên) ===
${rejected.length ? rejected.join(", ") : "(không có)"}

Nhiệm vụ: suy ra dãy 11 chữ số KHẢ DĨ NHẤT mà khách muốn đọc.
Lưu ý khi phân tích:
- Chuyển lời đọc tiếng Việt thành chữ số: "hai hai không hai ba hai" = 220232; "hai mươi hai" = 22; "lăm" = 5; "mốt" = 1; "tư" = 4.
- Khách hay đọc tách 2-3 hơi: ghép các lượt transcript liền nhau nếu tổng vừa đủ 11 số.
- Bản nghe của model thoại hay RƠI MẤT các số ĐẦU và chép sai từng số — dùng transcript làm trục chính, bản nghe model để đối chiếu.
- Nếu các nguồn mâu thuẫn từng vị trí, ưu tiên: transcript > danh bộ đăng ký khớp gần đúng > bản nghe model.
- KHÔNG bịa: nếu dữ liệu không đủ để tự tin ghép ra 11 số, trả do_tin_cay thấp.

Trả về DUY NHẤT JSON:
{"ma_danh_bo": "chuỗi 11 chữ số hoặc null nếu không suy ra được", "do_tin_cay": 0.0-1.0, "ly_do": "giải thích ngắn cách ghép"}`;

  console.log("prompt_gpt_5.1:", prompt);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ARBITER_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: ARBITER_MODEL,
        messages: [{ role: "user", content: prompt }],
        response_format: VERDICT_SCHEMA,
        reasoning_effort: ARBITER_REASONING_EFFORT,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      log.warn(`[Arbiter] API lỗi ${res.status}: ${err.slice(0, 300)}`);
      return null;
    }

    const data = await res.json();
    console.log("data_gpt_5.1:", data);
    const content = data.choices?.[0]?.message?.content;
    console.log("content_gpt_5.1:", content);
    if (!content) return null;
    const out = JSON.parse(content);
    log.info(
      `[Arbiter] model=${ARBITER_MODEL} → ma_danh_bo=${out.ma_danh_bo} ` +
      `do_tin_cay=${out.do_tin_cay} | tokens=${data.usage?.total_tokens ?? "?"} | ly_do=${out.ly_do}`
    );
    return { ...out, _usage: data.usage ?? null };
  } catch (err) {
    log.warn(`[Arbiter] Lỗi: ${err.name === "AbortError" ? `timeout ${ARBITER_TIMEOUT_MS}ms` : err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
