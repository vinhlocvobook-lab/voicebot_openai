/**
 * danh-bo-arbiter.js — [fix 19/07/2026]
 * TRỌNG TÀI mã danh bộ: gom mọi quan sát nhiễu về CÙNG một mã danh bộ rồi nhờ
 * model mạnh (mặc định gpt-5.1) suy ra dãy 11 số khả dĩ nhất.
 * [fix 19/07/2026 v2] Chạy như CO-PILOT NGẦM ngay từ lượt đọc ĐẦU TIÊN (song
 * song lúc bot đọc lại số cho khách) — xem verifyDanhBoFromSession trong tools.js.
 *
 * Nguồn quan sát (mỗi lần khách đọc có tới 2 "tai" nghe độc lập):
 *   1. reads       — dãy số model realtime nghe được qua tham số `ma_danh_bo` của các
 *                    tool tra cứu, ĐÃ lọc bỏ số bịa (classifyModelArg trong tools.js).
 *   2. transcripts — transcript các lượt khách đọc số, do session-ws.js buffer vào
 *                    callState._danhBoTranscripts (biến 1 — TOÀN cuộc gọi).
 *   2b. latestTranscripts — transcript của LẦN ĐỌC MỚI NHẤT (callState._danhBoSession,
 *                    biến 2 — MỘT lượt yêu cầu). Ưu tiên cao nhất khi suy luận.
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
// LUÔN chạy NỀN (không chặn function_call_output) — xem verifyDanhBoFromSession.
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
 * @param {string[]} p.transcripts  Transcript các lượt khách đọc số (TOÀN cuộc gọi).
 * @param {string[]} p.latestTranscripts [1.7 — 26/07/2026] Transcript của LẦN ĐỌC
 *   MỚI NHẤT (từ `_danhBoSession.turns`) — khách vừa được yêu cầu đọc TRỌN VẸN mã.
 * @param {string[]} p.knownDanhBo  Danh bộ đăng ký theo SĐT người gọi.
 * @param {string[]} p.rejected     Các dãy đã đọc lại cho khách và bị khách BÁO SAI.
 * @returns {Promise<{ma_danh_bo:string|null, do_tin_cay:number, ly_do:string}|null>}
 */
export async function arbitrateDanhBo({
  reads = [], transcripts = [], latestTranscripts = [], knownDanhBo = [], rejected = [],
} = {}) {
  if (reads.length === 0 && transcripts.length === 0 && latestTranscripts.length === 0) return null;

  // [1.7] Tách LẦN ĐỌC MỚI NHẤT khỏi các lần trước. Cuộc rtc_u2_E5eDfB96UnJE6iDWfPbRX:
  // trọng tài nhận một cục 31 chữ số trộn 5 lượt rác của nhiều lần đọc khác nhau →
  // từ chối (rất đúng đắn — dữ liệu VÀO mới là thứ sai). Khi tách ra, lần đọc mới
  // nhất chỉ chứa đúng "22023251775" và bài toán trở nên tầm thường.
  const _truoc = transcripts.filter((t) => !latestTranscripts.includes(t));
  //- Ví dụ: lần 1 "22023251775", lần 2 "22023251175", lần 3 "22023257775" → vị trí 1-8 và 10-11 mọi lần đều khớp; chỉ vị trí 9 lệch (7/1/7) → chọn 7 → 22023251775... (áp dụng tương tự cho từng vị trí).
  const prompt = `Bạn là chuyên gia phân tích lỗi nhận dạng giọng nói (ASR) tiếng Việt cho tổng đài cấp nước.
Khách hàng đang đọc MÃ DANH BỘ gồm ĐÚNG 11 CHỮ SỐ qua điện thoại. Có nhiều "bản nghe" nhiễu về CÙNG một mã, từ 2 hệ thống nghe độc lập:

=== LẦN ĐỌC MỚI NHẤT (khách vừa được yêu cầu đọc TRỌN VẸN mã — ƯU TIÊN CAO NHẤT) ===
${latestTranscripts.length ? latestTranscripts.map((t, i) => `Lượt ${i + 1}: "${t}"`).join("\n") : "(không có)"}

=== CÁC LẦN ĐỌC TRƯỚC ĐÓ (mỗi lần khách được mời đọc TRỌN VẸN cùng MỘT mã — hãy đối chiếu THEO VỊ TRÍ) ===
${_truoc.length ? _truoc.map((t, i) => `Lượt ${i + 1}: "${t}"`).join("\n") : "(không có)"}

=== BẢN NGHE CỦA MODEL THOẠI (kém tin cậy hơn, hay rơi mất số đầu, chép sai số) ===
${reads.length ? reads.map((r, i) => `Lần ${i + 1}: "${r}" (${r.length} số)`).join("\n") : "(không có)"}

=== DANH BỘ ĐÃ ĐĂNG KÝ THEO SỐ ĐIỆN THOẠI NGƯỜI GỌI (gợi ý mạnh nếu khớp gần đúng với bản nghe, nhưng khách CÓ THỂ hỏi cho danh bộ khác) ===
${knownDanhBo.length ? knownDanhBo.join(", ") : "(không có)"}

=== CÁC DÃY BOT ĐÃ ĐỌC LẠI VÀ KHÁCH BÁO SAI (đáp án đúng KHÁC các dãy này ở ít nhất một vị trí — TUYỆT ĐỐI không trả lại y nguyên) ===
${rejected.length ? rejected.join(", ") : "(không có)"}

Nhiệm vụ: suy ra dãy 11 chữ số KHẢ DĨ NHẤT mà khách muốn đọc.

QUAN TRỌNG — cách các lần đọc liên hệ với nhau:
- MỌI lần đọc ở trên đều là khách đọc CÙNG MỘT mã danh bộ, mỗi lần đọc TRỌN VẸN từ đầu. Chúng KHÔNG phải các phần nối tiếp của nhau.
- Vì vậy hãy coi đây là bài toán BỎ PHIẾU THEO TỪNG VỊ TRÍ: căn các lần đọc lại với nhau rồi chọn chữ số xuất hiện nhiều nhất ở mỗi vị trí.

- Trong MỘT lần đọc, khách có thể ngắt thành 2-3 hơi (các lượt liền nhau của cùng lần đọc đó) → ghép chúng lại trước, rồi mới đem so với các lần đọc khác.
- Một lần đọc bị thiếu số (khách đọc dở, bị ngắt giữa chừng) vẫn dùng được: căn phần khớp được vào đúng vị trí, đừng loại bỏ cả lần đọc đó.

Lưu ý khác khi phân tích:
- Nếu LẦN ĐỌC MỚI NHẤT tự nó đã ra đúng 11 số và khớp với đa số các lần trước thì LẤY LUÔN.
- Chuyển lời đọc tiếng Việt thành chữ số: "hai hai không hai ba hai" = 220232; "hai mươi hai" = 22; "lăm" = 5; "mốt" = 1; "tư" = 4.
- Lỗi ASR thường gặp: rơi mất chữ số ĐẦU hoặc CUỐI, nhân đôi một chữ số, nghe nhầm 1↔7, 3↔2, 5↔9. Ưu tiên phương án giải thích được nhiều lần đọc nhất bằng ÍT lỗi nhất.
- Bản nghe của model thoại kém tin cậy nhất — chỉ dùng để phá thế hoà khi các lần đọc mâu thuẫn ngang nhau.
- Nếu các nguồn mâu thuẫn từng vị trí, ưu tiên: đa số các lần đọc > lần đọc mới nhất > danh bộ đăng ký khớp gần đúng > bản nghe model.
- KHÔNG bịa: nếu dữ liệu không đủ để tự tin ghép ra 11 số, trả do_tin_cay thấp. Nhưng nếu có MỘT phương án nổi trội hơn hẳn các phương án khác thì cứ trả về kèm độ tin cậy vừa phải — hệ thống sẽ tự đối chiếu với cơ sở dữ liệu trước khi dùng.

Trả về DUY NHẤT JSON:
{"ma_danh_bo": "chuỗi 11 chữ số hoặc null nếu không suy ra được", "do_tin_cay": 0.0-1.0, "ly_do": "giải thích ngắn cách ghép"}`;

  log.debug(`[Arbiter] prompt:\n${prompt}`);
  console.log("=================ArbitrateDanhbo=================");
  console.log("[arbitrateDanhBo]:prompt = ", prompt);
  console.log("=================================================");
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
    const content = data.choices?.[0]?.message?.content;
    log.debug(`[Arbiter] raw content: ${content}`);
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
