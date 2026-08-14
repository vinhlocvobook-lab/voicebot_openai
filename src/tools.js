/**
 * tools.js
 * Xử lý function calls từ OpenAI Realtime API.
 * Mỗi handler nhận arguments object, trả về string để gửi lại cho AI.
 */

import {
  getSoSanhTangGiam,
  getThongBaoCupNuoc,
  baoSuCo,
  getTrangThaiTT,
  getThongTinKhachHang, getAvailableAgents
} from "./api.js";

import { arbitrateDanhBo } from "./danh-bo-arbiter.js";
import { PROCEDURES } from "./huongdanthutuc-data.js";
import { log } from "./logger.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtTien = (n) => (typeof n === "number" ? n.toLocaleString("vi-VN") : n);

/**
 * Đọc số tiền thành CHỮ tiếng Việt để model đọc nguyên văn qua thoại.
 * Lý do: TTS đọc sai chuỗi "1.180.266 đồng" thành "một nghìn..." (dấu chấm
 * ngăn cách nghìn bị hiểu nhầm) — log cuộc gọi 05/07 11:08.
 * Vd: 1180266 → "một triệu một trăm tám mươi nghìn hai trăm sáu mươi sáu đồng".
 */
function docTienVN(n) {
  const num = Math.round(Number(n));
  if (!isFinite(num)) return String(n);
  if (num === 0) return "không đồng";
  const ones = ["", "một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín"];
  const units = ["", " nghìn", " triệu", " tỷ", " nghìn tỷ"];
  let v = Math.abs(num);
  const groups = [];
  while (v > 0) { groups.unshift(v % 1000); v = Math.floor(v / 1000); }
  const parts = [];
  groups.forEach((g, i) => {
    if (g === 0) return;
    const isFirst = parts.length === 0;
    const tr = Math.floor(g / 100), ch = Math.floor((g % 100) / 10), dv = g % 10;
    const w = [];
    if (tr > 0) w.push(ones[tr] + " trăm");
    else if (!isFirst) w.push("không trăm");
    if (ch > 1) {
      w.push(ones[ch] + " mươi");
      if (dv === 1) w.push("mốt");
      else if (dv === 5) w.push("lăm");
      else if (dv > 0) w.push(ones[dv]);
    } else if (ch === 1) {
      w.push("mười");
      if (dv === 5) w.push("lăm");
      else if (dv > 0) w.push(ones[dv]);
    } else if (dv > 0) {
      if (tr > 0 || !isFirst) w.push("lẻ");
      w.push(ones[dv]);
    }
    parts.push(w.join(" ") + units[groups.length - 1 - i]);
  });
  return (num < 0 ? "âm " : "") + parts.join(" ") + " đồng";
}

// Bỏ dấu tiếng Việt + hạ chữ thường (để so khớp chữ số đọc bằng lời).
function _deAccent(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d").replace(/Đ/g, "D")
    .toLowerCase();
}

// Chữ số đọc bằng lời tiếng Việt (đã bỏ dấu) → chữ số.
const _VI_DIGIT_WORDS = {
  khong: "0", linh: "0", le: "0",
  mot: "1", hai: "2", hay: "2", ba: "3", ban: "3",
  bon: "4", tu: "4", nam: "5", lam: "5",
  sau: "6", bay: "7", tam: "8", chin: "9",
};

/**
 * Ghép chuỗi ĐỌC THÀNH CHỮ ("Hai - Hai - Không...") thành chữ số.
 * [fix 30/07/2026 — cuộc rtc_u1_E7JWxaN1u2ZbQG9SnKbwh] Bản cũ yêu cầu MỌI token
 * trong CẢ câu đều là chữ số — chỉ cần một từ khung câu bình thường xen vào
 * ("Số danh bộ LÀ hai hai không...") là bị bỏ TOÀN BỘ, dù khách đọc digit-word
 * đúng. Khách hầu như luôn kèm câu dẫn khi đọc số ("Số danh bộ là...", "...ạ"),
 * nên bản cũ gần như luôn thất bại với lối đọc tách chữ → session ghi "0/11"
 * dù khách đã đọc, kéo theo cả chuỗi hệ quả (model tự nghe đúng số nhưng bị
 * `classifyModelArg` coi là bịa vì baseline session rỗng, cuộc gọi rối loạn).
 * Sửa: tìm CHUỖI LIÊN TỤC DÀI NHẤT gồm toàn token chữ số (≥3 token liên tiếp —
 * cùng ngưỡng với `_DIGIT_WORD_RE` dùng để NHẬN DIỆN đây là lượt đọc số ở
 * `_looksLikeDigitTurn`, session-ws.js), bỏ qua từ khung câu ở đầu/cuối/xen
 * giữa. Vẫn giữ tinh thần chống ghép nhầm: câu bình thường lỡ có 1-2 từ trùng
 * số ("một chút") không đủ dài để tính là đọc số.
 */
function viDigitsFromWords(raw) {
  const tokens = _deAccent(raw).split(/[^a-z]+/).filter(Boolean);
  if (tokens.length === 0) return "";
  let best = "", cur = "";
  for (const t of tokens) {
    if (t in _VI_DIGIT_WORDS) {
      cur += _VI_DIGIT_WORDS[t];
    } else {
      if (cur.length > best.length) best = cur;
      cur = "";
    }
  }
  if (cur.length > best.length) best = cur;
  return best.length >= 3 ? best : "";
}

/**
 * Chuẩn hoá mã danh bộ trước khi gọi API:
 * AI thường đọc số kèm dấu gạch ngang / khoảng trắng (vd "1-5-1-2-...").
 * Bỏ mọi ký tự không phải chữ số.
 * [fix 23/07/2026] Model đôi khi echo lại bản ĐỌC THÀNH CHỮ ("Hai - Hai -
 * Không...") vào day_so — strip ký tự sẽ ra RỖNG và bị hiểu nhầm là "khách báo
 * sai" (cuộc E4jVVW..., danh bộ đúng 22023251775 bị đẩy vào rejected → deadlock).
 * Rỗng mà chuỗi là dãy chữ số đọc bằng lời → ghép lại từ chữ.
 */
function normalizeDanhBo(raw) {
  // Bảo vệ code nếu raw là null/undefined, sau đó xóa sạch ký tự không phải số
  let normalized = String(raw ?? "").replace(/\D/g, "");

  // Không có chữ số ASCII nào → thử ghép từ chữ số đọc bằng lời tiếng Việt.
  if (normalized.length === 0) {
    const fromWords = viDigitsFromWords(raw);
    if (fromWords) normalized = fromWords;
  }

  // [0.2 — 26/07/2026] Trước đây in 2 dòng console.log mỗi lần gọi; hàm này chạy
  // hàng chục lần mỗi cuộc gọi nên log bị ngập (>40 khối trong cuộc
  // rtc_u2_E5eDfB96UnJE6iDWfPbRX), che mất các dòng quan trọng. Hạ xuống debug.
  log.debug(`[normalizeDanhBo] "${raw}" → "${normalized}"`);
  return normalized;
}

const DANH_BO_LENGTH = 11;

// ─── Xác nhận mã danh bộ qua tool (fix 18/07/2026 — cuộc E2uhVdS9X4mVBoXs0uYMP) ──
// Model mini KHÔNG giữ được dãy số ổn định qua các lượt: khách đọc 11 số
// (2 lần giống nhau), model đọc lại thành 12 số (biến thể 1), rồi gọi tool với
// 12 số KHÁC cả bản nó vừa đọc (biến thể 2) → guard chặn, khách bực, cúp máy.
// Deterministic hoá bằng CODE:
//   1. Khách đọc số → model gọi confirm_danh_bo → code normalize + đếm + LƯU
//      vào callState.danhBo; model đọc lại NGUYÊN VĂN "doc_cho_khach" (chính là
//      dãy hệ thống sẽ dùng tra cứu — khép kín khoảng hở "đọc một đằng, tra một nẻo").
//   2. Khách xác nhận → model gọi tool tra cứu KHÔNG truyền ma_danh_bo — code
//      dùng giá trị đã lưu, không cho model chép lại số (nguồn sai chính).
//   3. Model gọi thẳng tool tra cứu khi chưa có số đã lưu → KHÔNG tra ngay,
//      trả yêu cầu đọc lại xác nhận (ép read-back từ tool output ít nhất 1 lần).
//   4. Danh bộ do HỆ THỐNG cấp (lookup SĐT, callState.knownDanhBo) → tin ngay,
//      không ép vòng xác nhận tool (số không đi qua "tai" model).

const DIGIT_WORDS = ["Không", "Một", "Hai", "Ba", "Bốn", "Năm", "Sáu", "Bảy", "Tám", "Chín"];
// export [fix 19/07/2026 v2]: session-ws.js cần đọc lại số khách BẤM PHÍM (DTMF).
export const danhBoSpoken = (s) => String(s).split("").map((d) => DIGIT_WORDS[+d] ?? d).join(" - ");

const SO_CHU = ["không", "một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín", "mười", "mười một"];
const docSoLuong = (n) => SO_CHU[n] ?? String(n);

// [fix 19/07/2026] BỎ phương án đọc theo nhóm 4-4-3 (bước "chuyển sang đọc
// từng nhóm" giữa chừng làm khách rối — cuộc E2yeCWEsecOlWrgBM8CW1 cúp máy).
// [fix 19/07/2026 v2] TRỌNG TÀI thành CO-PILOT NGẦM chạy từ LƯỢT 1:
//   - Lượt 1 đủ 11 số → đọc lại NGAY bản realtime (không thêm độ trễ), đồng
//     thời fire trọng tài gpt-5.1 chạy NỀN (song song lúc bot đang đọc lại).
//     Khách báo SAI không kèm dãy mới → dùng ngay ứng viên nền, không bắt đọc lại.
//   - Lượt ≥2 (khách đọc lại) → trọng tài chạy ĐỒNG BỘ đối chiếu MỌI quan sát
//     (các dãy model nghe + transcript + danh bộ theo SĐT + các dãy đã bị bác)
//     trước khi đọc lại xác nhận.
//   - Hết DANH_BO_MAX_READS lượt đọc giọng nói vẫn chưa chốt → mời BẤM PHÍM
//     (DTMF, session-ws.js tự ghi nhận); không bấm được → chuyển máy / tạo phiếu.
const DANH_BO_MAX_READS = 3;
const ARBITER_MIN_CONFIDENCE = Number(process.env.DANH_BO_ARBITER_MIN_CONFIDENCE || 0.7);
// [fix 26/07/2026] Ngưỡng THẤP — chỉ dùng khi API xác nhận DỨT KHOÁT số có thật.
// Xem giải thích ở tryProposeArbiterCandidate.
const ARBITER_LOW_CONFIDENCE = Number(process.env.DANH_BO_ARBITER_LOW_CONFIDENCE || 0.3);
// [1.5 — 26/07/2026] Hạn chờ trọng tài trong LUỒNG XÁC MINH (chạy ở đường nền,
// KHÔNG chặn function_call_output). Khách không phải chờ trong im lặng vì
// session-ws đã phát câu lấp khoảng lặng trước khi gọi.
//
// [fix 26/07/2026] 6000 → 10000. Cuộc rtc_u1_E5hSj6jwK5jeMHvCZV7yx: gpt-5.1 mất
// 7,3s / 8,2s / 9,3s (reasoning ~1000 token) nên bị cắt cả 3 lần — lần cuối nó
// trả về ĐÚNG "22023251775" chỉ 2 giây SAU hạn chờ. Bắt khách đọc lại trọn 11 số
// tốn 30+ giây, đắt hơn nhiều so với chờ thêm 4 giây có câu lấp khoảng lặng.
const DANH_BO_VERIFY_WAIT_MS = Number(process.env.DANH_BO_VERIFY_WAIT_MS || 10000);

// ─── [1.1 — 26/07/2026] HAI BIẾN TÍCH LUỸ ────────────────────────────────────
// Biến 1 — `callState._danhBoTranscripts`: TOÀN cuộc gọi, chỉ để cấp quan sát
//          cho trọng tài gpt-5.1. KHÔNG BAO GIỜ dùng để đếm đủ/thiếu.
// Biến 2 — `callState._danhBoSession`: MỘT lượt yêu cầu khách đọc. Reset mỗi khi
//          code mời khách đọc lại TOÀN BỘ mã. Đây là biến DUY NHẤT được dùng để
//          xác định đã đủ / chưa đủ / vượt 11 số.
//
// Lý do tách (cuộc rtc_u2_E5eDfB96UnJE6iDWfPbRX): code cũ ghép mù toàn bộ buffer
// → sau vài lượt đã có 31 chữ số, vòng chờ "đủ 11 số" thoát tức thì và chết lâm
// sàng đúng lúc cần nhất, còn khách thì nghe "chưa có mã danh bộ" dù đã đọc 5 lần.

/** Lấy (hoặc khởi tạo) phiên đọc số hiện tại. */
export function ensureDanhBoSession(callState = {}) {
  if (!callState._danhBoSession) {
    callState._danhBoSession = { requestNo: 0, startedAt: null, turns: [], digits: "" };
  }
  return callState._danhBoSession;
}

/**
 * Mở một LƯỢT YÊU CẦU mới: xoá sạch số đã gom, tăng `requestNo`.
 * Gọi mỗi khi code phát câu mời khách đọc TOÀN BỘ mã danh bộ.
 */
export function startDanhBoRequest(callState = {}, lyDo = null) {
  const s = ensureDanhBoSession(callState);

  // [1.8] KHÔNG tính là lượt mới nếu lượt trước chưa nghe được chữ số nào.
  // Model hay gọi liên tiếp nhiều tool tra cứu trước khi khách kịp nói — mỗi lần
  // như vậy đều rơi vào nhánh "xin số", nếu cứ tăng `requestNo` thì mới 3 tool
  // call là đã mời khách bấm phím dù khách chưa được hỏi lần nào.
  if (s.turns.length === 0 && s.startedAt != null) {
    s.startedAt = Date.now();
    log.debug(`[danh_bo] Giữ nguyên lượt #${s.requestNo} (lượt trước chưa nghe được chữ số nào).`);
    return s;
  }

  s.requestNo += 1;
  s.startedAt = Date.now();
  s.turns = [];
  s.digits = "";
  callState._logger?.markDanhBoStarted?.();
  callState._logger?.setDanhBoRequestCount?.(s.requestNo);
  callState._logger?.addEvent?.("danh_bo_request", `lượt ${s.requestNo}${lyDo ? ` — ${lyDo}` : ""}`);
  log.info(`[danh_bo] Mở lượt yêu cầu #${s.requestNo}${lyDo ? ` (${lyDo})` : ""}`);
  return s;
}

/** Ghi một lượt transcript có chữ số vào CẢ HAI biến. Trả về phiên hiện tại. */
export function noteDanhBoTranscript(callState = {}, text = "") {
  const s = ensureDanhBoSession(callState);
  if (s.requestNo === 0) startDanhBoRequest(callState, "khách chủ động đọc số");

  // Biến 1 — kho quan sát cho trọng tài (toàn cuộc gọi).
  const all = (callState._danhBoTranscripts ??= []);
  all.push({ at: Date.now(), text });
  // [1.10] 10 → 20: trọng tài cần bề dày lịch sử, mỗi phần tử chỉ là chuỗi ngắn.
  while (all.length > 20) all.shift();

  // Biến 2 — phiên đọc hiện tại (dùng để đếm).
  s.turns.push({ at: Date.now(), text });
  s.digits += normalizeDanhBo(text);
  return s;
}

/** Số chữ số đã gom trong LƯỢT YÊU CẦU hiện tại. */
export function danhBoSessionDigits(callState = {}) {
  return ensureDanhBoSession(callState).digits.length;
}

/**
 * Dãy 11 số lấy từ MỘT lượt transcript ĐƠN trong phiên hiện tại (mới nhất trước).
 * Chỉ nhận lượt đơn ra đúng 11 số — lượt đọc tách hơi để trọng tài ghép.
 */
function latestSessionDanhBo(callState = {}) {
  const turns = ensureDanhBoSession(callState).turns;
  for (let i = turns.length - 1; i >= 0; i--) {
    const d = normalizeDanhBo(turns[i]?.text);
    if (d.length === DANH_BO_LENGTH) return d;
  }
  return "";
}

/**
 * Đóng gói kết quả bước lấy danh bộ + LƯU câu đang chờ khách trả lời vào
 * callState. [fix 18/07/2026 v5] Cuộc E2yXyLXpaZz66DmCfxQBi: prompt echo làm
 * code hủy response giữa chừng, để lại câu nói dở của bot trong context →
 * model tự bịa hội thoại, không gọi tool nữa, khách cúp máy.
 * session-ws.js dùng câu lưu ở đây để kéo cuộc gọi về đúng bước sau khi hủy.
 */
// [fix 27/07/2026 đợt 7] `message` NẰM LẠI VĨNH VIỄN trong hội thoại (nó là
// nội dung của function_call_output). Nếu nó chứa mệnh lệnh 'Đọc NGUYÊN VĂN
// doc_cho_khach' thì model sẽ bám vào đó ở MỌI lượt sau — cuộc
// rtc_u2_E66xM4TYW8qxz07ijdLzB: code đã chốt đúng mã, gửi câu đọc lại xác nhận,
// nhưng model vẫn lặp lại 'cần mã danh bộ chính xác, đọc lại giúp em' 3 lượt liền
// rồi khách cúp máy. Cuộc rtc_u1_E66uZSbb8P6ZJF6VVLKr6 (KHÔNG có tool call nào
// trong giai đoạn thu số) thì đọc đúng câu xác nhận ngay lần đầu.
// → `message` chỉ MÔ TẢ TRẠNG THÁI. Việc ép đọc nguyên văn đặt ở `instructions`
//   của response.create (chỉ có hiệu lực cho ĐÚNG response đó).
function danhBoPayload(callState, obj) {
  callState._danhBoLastPrompt = obj.doc_cho_khach || null;
  return JSON.stringify(obj);
}

/** Đã thử nhiều lần vẫn không xong → mời chuyển tổng đài viên / tạo phiếu. */
function danhBoEscalationResponse(callState) {
  return danhBoPayload(callState, {
    success: false,
    invalid_danh_bo: true,
    da_sai_nhieu_lan: callState.danhBoInvalidCount || 0,
    doc_cho_khach:
      `Dạ, em xin lỗi Quý Khách, đường truyền bên em vẫn chưa nghe trọn vẹn được mã danh bộ ạ. ` +
      `Để Quý Khách khỏi mất thời gian, em chuyển máy sang tổng đài viên hỗ trợ trực tiếp, ` +
      `hoặc em ghi nhận lại để nhân viên gọi lại cho Quý Khách. Quý Khách chọn giúp em cách nào ạ?`,
    message:
      `Đã nhiều lần không nhận được mã danh bộ. KHÔNG tra cứu, KHÔNG tự đọc/đoán chữ số nào. ` +
      `Hệ thống TỰ phát câu thoại của bước này. ` +
      `Khách chọn chuyển máy → gọi transfer_to_agent. ` +
      `Khách muốn nhân viên gọi lại → gọi create_ticket. ` +
      `Khách vẫn muốn đọc lại số → gọi lại hàm tra cứu với ma_danh_bo = dãy mới nghe được.`,
  });
}

/**
 * [1.6 — 26/07/2026] Mời khách đọc (lại) TOÀN BỘ mã danh bộ — mở một LƯỢT YÊU CẦU mới.
 * Phân biệt rõ 3 trạng thái. Trước đây khi ghép mù vượt 11 số, code truyền `0`
 * xuống đây làm khách nghe "chưa có mã danh bộ" trong khi hệ thống đã nghe 31
 * chữ số (cuộc rtc_u2_E5eDfB96UnJE6iDWfPbRX) — hỏi lại như chưa nói gì, rất ức chế.
 */
function invalidDanhBoResponse(length, callState = {}) {
  startDanhBoRequest(callState, `mời đọc lại (đang nghe ${length} số)`);

  if (length === 0) {
    return danhBoPayload(callState, {
      success: false,
      invalid_danh_bo: true,
      do_dai_hien_tai: 0,
      do_dai_yeu_cau: DANH_BO_LENGTH,
      // [fix 04/08/2026 đợt 14] Quan sát từ log thật: khách đọc LIÊN TỤC một mạch
      // đủ 11 số (không ngắt quãng, không tách nhiều lượt) có tỉ lệ trọng tài chốt
      // được ngay lần đầu cao hơn hẳn so với đọc rời rạc nhiều hơi/nhiều lượt —
      // đọc rời rạc còn kéo theo hệ quả phụ nghiêm trọng hơn: cuộc
      // rtc_u0_E95Q90QYobubPqXAMJSP2 (3 lượt đọc rời rạc) khiến model, dù đã có
      // ứng viên và được yêu cầu đọc câu XÁC NHẬN, vẫn quay lại nói "còn thiếu số,
      // đọc tiếp đi" — lịch sử hội thoại đầy các lượt "thiếu số" khiến model bám
      // vào ngữ cảnh cũ thay vì làm theo instructions mới nhất. Đổi "đọc chậm từng
      // chữ số" (dễ hiểu lầm là ngắt nghỉ giữa mỗi số) thành "đọc liền một mạch".
      doc_cho_khach:
        `Dạ, Quý Khách cho em xin mã danh bộ gồm ${DANH_BO_LENGTH} chữ số, ` +
        `đọc liền một mạch từ đầu đến cuối, đừng ngừng giữa chừng, chậm và rõ giúp em ạ.`,
      // [fix 31/07/2026 đợt 10] Cùng lớp rủi ro với đợt 6 (dangXacMinhResponse):
      // "TUYỆT ĐỐI không đọc/tự đoán" là mệnh lệnh tuyệt đối, mà message này NẰM
      // LẠI VĨNH VIỄN trong hội thoại — có thể xung đột với yêu cầu đọc số ở bước
      // xác nhận sau này. Đổi thành mô tả trạng thái + báo trước bước sau không bị
      // ràng buộc bởi câu này.
      message:
        `Chưa có mã danh bộ — đang chờ khách đọc, hệ thống TỰ gom số và TỰ phát câu ` +
        `thoại ở bước này. Lượt NÀY model không cần tự đọc/đoán số nào. Khi nào hệ ` +
        `thống gửi yêu cầu đọc số riêng thì làm đúng yêu cầu đó, không bị câu này ràng buộc.`,
    });
  }

  callState.danhBoInvalidCount = (callState.danhBoInvalidCount || 0) + 1;

  // Vượt 11 số: thường do lẫn tạp âm / khách đọc chồng lượt. Nói đúng bản chất
  // thay vì bảo khách "đọc thiếu".
  if (length > DANH_BO_LENGTH) {
    return danhBoPayload(callState, {
      success: false,
      invalid_danh_bo: true,
      do_dai_hien_tai: length,
      do_dai_yeu_cau: DANH_BO_LENGTH,
      // [fix 04/08/2026 đợt 14] xem giải thích ở nhánh length===0 phía trên —
      // đổi sang "đọc liền một mạch" thay vì "chậm và rõ từng chữ số".
      doc_cho_khach:
        `Dạ, đường truyền bên em nghe bị lẫn nên chưa tách được đúng ` +
        `${docSoLuong(DANH_BO_LENGTH)} chữ số ạ. Quý Khách vui lòng đọc lại từ đầu, ` +
        `đọc liền một mạch đủ ${docSoLuong(DANH_BO_LENGTH)} chữ số, đừng ngừng giữa chừng, ` +
        `chậm và rõ giúp em ạ.`,
      message:
        `Nghe được ${length} số (NHIỀU HƠN ${DANH_BO_LENGTH}) — lẫn nhiễu, hệ thống đang tự ` +
        `chờ khách đọc lại và tự phát câu thoại của bước này. Lượt NÀY model không cần tự ` +
        `đọc/đoán số nào. Khi hệ thống gửi yêu cầu đọc số riêng thì mới đọc, không bị câu ` +
        `này ràng buộc.`,
    });
  }

  return danhBoPayload(callState, {
    success: false,
    invalid_danh_bo: true,
    do_dai_hien_tai: length,
    do_dai_yeu_cau: DANH_BO_LENGTH,
    // [fix 04/08/2026 đợt 14] xem giải thích ở nhánh length===0 phía trên — giữ
    // nguyên cụm "đọc lại đầy đủ" (test_case/danh_bo_verify_flow.test.mjs đang
    // kiểm tra cụm này) nhưng thêm "đọc liền một mạch, đừng ngừng giữa chừng".
    doc_cho_khach:
      `Dạ, em nghe được ${docSoLuong(length)} số, mà mã danh bộ cần đúng ` +
      `${docSoLuong(DANH_BO_LENGTH)} số ạ. Quý Khách đọc lại đầy đủ từ đầu, ` +
      `đọc liền một mạch, đừng ngừng giữa chừng, chậm và rõ giúp em ạ.`,
    message:
      `Nghe chưa đủ ${DANH_BO_LENGTH} số — hệ thống đang tự chờ khách đọc lại và tự phát ` +
      `câu thoại. Lượt NÀY model không cần tự đọc/đoán số nào; khi hệ thống gửi yêu cầu ` +
      `đọc số riêng thì mới đọc theo đúng yêu cầu đó, không bị câu này ràng buộc.`,
  });
}

/**
 * [1.3] Đã đủ số, đường nền đang xác minh (API + trọng tài). Tool trả ngay để
 * không treo; câu đọc lại xác nhận do CODE phát qua `_speakVerbatim`.
 */
function dangXacMinhResponse() {
  return JSON.stringify({
    success: false,
    dang_xac_minh: true,
    doc_cho_khach: `Dạ, em ghi nhận rồi ạ, Quý Khách chờ em một chút.`,
    // [fix 30/07/2026 đợt 6] Bản cũ viết "TUYỆT ĐỐI không đọc/không đoán chữ số
    // nào" — một MỆNH LỆNH tuyệt đối, mà function_call_output này NẰM LẠI VĨNH
    // VIỄN trong hội thoại (cùng lỗi đã ghi nhận với "doc_cho_khach là KỊCH BẢN,
    // đừng đọc"). Ngay lượt SAU đó, code gửi response.create riêng bảo model đọc
    // NGUYÊN VĂN câu xác nhận có kèm 11 chữ số — hai chỉ dẫn ("đừng bao giờ đọc
    // số" vs "đọc câu này có số") cùng nằm trong context, gây giằng co. Cuộc
    // rtc_u2_E7LLkANEJmyTSp0B3t5EP: model né tránh đọc số 3/3 lần, nói vòng vo
    // "chưa thể đọc ra số tiền... liên hệ tổng đài viên" dù lúc đó get_bill CHƯA
    // hề được gọi. Sửa: đổi mệnh lệnh tuyệt đối thành MÔ TẢ TRẠNG THÁI + báo
    // trước rằng lượt SAU sẽ có yêu cầu đọc số riêng, không bị câu này ràng buộc.
    message:
      `Hệ thống đã nhận đủ số và đang xác minh ở nền. Lượt NÀY model không cần tự ` +
      `nói gì thêm về số — chỉ đợi. Bước KẾ TIẾP hệ thống sẽ tự gửi một yêu cầu ` +
      `riêng kèm câu xác nhận có đọc số; lúc đó cứ đọc đúng câu được yêu cầu, ` +
      `không bị ràng buộc bởi câu này nữa.`,
  });
}

/**
 * [fix 26/07/2026 đợt 4] Khách ĐANG đọc dở — chỉ báo hiệu là em đang nghe, KHÔNG
 * hướng dẫn gì thêm, KHÔNG reset phiên, KHÔNG tăng `requestNo`.
 *
 * Trước đó bản đợt 3 nhắc "đọc tiếp N số còn lại" — sai về trải nghiệm: khách
 * KHÔNG biết hệ thống nghe được tới đâu, mà chỗ nối giữa hai hơi đọc lại đúng là
 * chỗ ASR hay nghe sai nhất. Khi thật sự cần, ta mời khách đọc lại TRỌN VẸN mã
 * (invalidDanhBoResponse) — mỗi lần đọc đầy đủ là một quan sát độc lập để trọng
 * tài đối chiếu theo từng vị trí chữ số.
 */
function dangGomSoResponse(daNghe) {
  return JSON.stringify({
    success: false,
    dang_gom_so: true,
    da_nghe: daNghe,
    can: DANH_BO_LENGTH,
    doc_cho_khach: `Dạ, em đang nghe ạ.`,
    // [fix 31/07/2026 đợt 10] Cùng lớp rủi ro với đợt 6 — message này tồn dư vĩnh
    // viễn trong hội thoại và fire ở HẦU HẾT các lượt đọc số dở dang (nhiều hơn hẳn
    // dang_xac_minh), nên mệnh lệnh tuyệt đối "không đọc số" càng dễ chồng chất và
    // xung đột với yêu cầu đọc số ở bước xác nhận sau này. Đổi thành mô tả trạng
    // thái + báo trước bước sau không bị ràng buộc.
    message:
      `Hệ thống ĐANG GOM số (${daNghe}/${DANH_BO_LENGTH}) — khách có thể còn đang đọc dở, ` +
      `hệ thống TỰ phát mọi câu thoại của bước này. Lượt NÀY model không cần tự đọc/đoán ` +
      `số, không cần hỏi khách đọc tiếp từ đâu, không cần bảo khách đọc lại. Khách hỏi ` +
      `chuyện KHÁC (thủ tục, khiếu nại...) thì trả lời bình thường. Khi hệ thống gửi yêu ` +
      `cầu đọc số riêng thì mới đọc, không bị câu này ràng buộc.`,
  });
}

/**
 * [1.8] Mời đọc lại, hoặc leo thang khi khách đã phải đọc quá nhiều lần.
 * `requestNo` là bộ đếm leo thang DUY NHẤT — nó đếm đúng thứ khách cảm nhận
 * được ("tôi đã phải đọc lại bao nhiêu lần rồi"), thay cho 2 bộ đếm cũ
 * (`_danhBoResolveTries`, `_danhBoAssembleTries`) vốn đếm theo nhánh code nội bộ
 * nên cuộc gọi mẫu chạy 3,5 phút mà chưa lần nào khách được mời bấm phím.
 */
function danhBoReReadOrEscalate(callState, heardLen) {
  if (callState._danhBoDtmfInvited) return danhBoEscalationResponse(callState);
  if (ensureDanhBoSession(callState).requestNo >= DANH_BO_MAX_READS) {
    return danhBoDtmfInviteResponse(callState);
  }
  return invalidDanhBoResponse(heardLen, callState);
}

function confirmRequestResponse(normalized, callState = {}) {
  const { vuotNguong } = danhBoConfirmSpamGate(callState, "dang_cho_xac_nhan");
  return danhBoPayload(callState, {
    success: true,
    cho_khach_xac_nhan: true,
    ma_danh_bo: normalized,
    trang_thai_danh_bo: "dang_cho_xac_nhan",
    ...(vuotNguong ? { _danhBoConfirmSpamEscalate: true } : {}),
    doc_cho_khach:
      `Dạ, em đọc lại mã danh bộ để Quý Khách kiểm tra: ${danhBoSpoken(normalized)}. ` +
      `Quý Khách xác nhận giúp em có đúng không ạ?`,
    message:
      `Đã ghi nhận đủ ${DANH_BO_LENGTH} chữ số, hệ thống TỰ đọc lại cho khách xác nhận. ` +
      `Khách xác nhận ĐÚNG → gọi lại hàm tra cứu khách cần, KHÔNG cần đọc số ` +
      `(hệ thống tự dùng số đã xác nhận). Khách báo SAI hoặc đọc dãy khác → CHỜ, ` +
      `hệ thống tự xử lý ở lượt sau; đừng tự bịa số, đừng tự đọc lại.`,
  });
}

// ─── [migrate 30/07/2026 — confirm_danh_bo] Trạng thái tường minh cho model ───
// Field DUY NHẤT model cần đọc để biết đang ở đâu trong luồng danh bộ, thay vì tự
// suy luận từ nhiều cờ rải rác (cho_khach_xac_nhan/success/...). Dùng cho
// DANH_BO_MODE=confirm_tool (xem docs/fix/fix_migrate_gpt_realtime_21_20260730.md).
//
// "da_xac_nhan"/"dang_cho_xac_nhan" bám vào callState.danhBo — GIÁ TRỊ NÀY LUÔN
// do CODE xác minh (API + trọng tài gpt-5.1), KHÔNG BAO GIỜ lấy từ arg model hay
// từ việc model "nghĩ" số nào đúng. Cờ `confirmed` cũng CHỈ do session-ws.js set,
// dựa trên regex bắt từ khẳng định trên TRANSCRIPT THẬT của khách — model gọi
// tool này bao nhiêu lần, nói gì, đều không có quyền tự chốt xác nhận
// (xem memory [[voicebot-danhbo-verbal-confirm-gate]]).
function danhBoTrangThai(callState) {
  const d = callState.danhBo;
  if (!d?.value) return "chua_co";
  return d.confirmed ? "da_xac_nhan" : "dang_cho_xac_nhan";
}

/**
 * [confirm_danh_bo] Gate chống model tự gọi lặp lại tool này (hoặc bất kỳ tool
 * nào rơi vào nhánh "đang chờ xác nhận" của resolveDanhBo) mà không có lượt
 * khách nào xen giữa — nếu không chặn, khách có thể nghe bot lặp lại CÙNG một
 * câu xác nhận vô hạn lần. Đây là trục lỗi KHÁC với requestNo/_danhBoProposeCount
 * (những bộ đếm đó đếm "khách đọc lại bao nhiêu lần", không bắt được "model tự
 * kích hoạt lại tool bao nhiêu lần"). So theo CHỮ KÝ (trạng thái + giá trị) chứ
 * không chỉ trạng thái, để không hiểu lầm "đề xuất ứng viên MỚI sau khi bị bác"
 * là một lần lặp lại.
 * @returns {{lapLai:boolean, vuotNguong:boolean}}
 */
function danhBoConfirmSpamGate(callState, trangThaiMoi) {
  const chuKy = `${trangThaiMoi}:${callState.danhBo?.value || ""}`;
  const laLapLai = callState._danhBoConfirmLastSig === chuKy && !callState._danhBoConfirmNewTurnSince;
  if (laLapLai) {
    callState._danhBoConfirmSpamCount = (callState._danhBoConfirmSpamCount || 0) + 1;
  } else {
    callState._danhBoConfirmLastSig = chuKy;
    callState._danhBoConfirmNewTurnSince = false;
    callState._danhBoConfirmSpamCount = 0;
  }
  const nguong = Number(process.env.DANH_BO_CONFIRM_SPAM_MAX || 3);
  const vuotNguong = laLapLai && callState._danhBoConfirmSpamCount >= nguong;
  if (laLapLai) {
    log.warn(`[danh_bo][confirm_spam] lặp lại "${chuKy}" lần ${callState._danhBoConfirmSpamCount}` +
      `${vuotNguong ? " — VƯỢT NGƯỠNG, escalate" : ""}`);
    callState._logger?.addEvent?.("danh_bo_confirm_spam",
      `${chuKy} — lần ${callState._danhBoConfirmSpamCount}${vuotNguong ? " (escalate)" : ""}`);
  }
  return { lapLai: laLapLai, vuotNguong };
}

/** session-ws.js gọi mỗi khi có MỘT LƯỢT KHÁCH THẬT (không phải model tự gọi
 *  tool) để mở lại "cửa sổ" cho confirm_danh_bo báo lại — tránh coi lượt xác
 *  nhận/phủ định hợp lệ của khách như "model tự spam". */
export function noteDanhBoConfirmNewTurn(callState = {}) {
  callState._danhBoConfirmNewTurnSince = true;
}

/**
 * [confirm_danh_bo — MỚI, DANH_BO_MODE=confirm_tool] Model gọi tool này ở giai
 * đoạn XÁC NHẬN (sau khi code đã mở khoá create_response). Bỏ qua hoàn toàn mọi
 * arg — chỉ đọc callState.danhBo. Trả `action:"no_reply"` khi bị chặn bởi gate
 * chống spam để session-ws.js KHÔNG tạo response.create tiếp theo (khách không
 * nghe lặp lại); `_danhBoConfirmSpamEscalate` báo session-ws.js tự fallback.
 */
function handleConfirmDanhBo(callState = {}) {
  const trangThai = danhBoTrangThai(callState);
  const { lapLai, vuotNguong } = danhBoConfirmSpamGate(callState, trangThai);

  if (lapLai) {
    return JSON.stringify({
      action: "no_reply",
      trang_thai_danh_bo: trangThai,
      ma_danh_bo: callState.danhBo?.value || null,
      ...(vuotNguong ? { _danhBoConfirmSpamEscalate: true } : {}),
      message: "Đã báo trạng thái này rồi, chưa có gì mới — KHÔNG gọi lại tool này, " +
        "chờ khách nói gì đó rồi hệ thống sẽ tự báo lại.",
    });
  }

  if (trangThai === "chua_co") {
    return JSON.stringify({
      trang_thai_danh_bo: "chua_co",
      ma_danh_bo: null,
      message: "Hệ thống CHƯA xác định được mã danh bộ nào — KHÔNG gọi tool này lúc này, " +
        "chờ hệ thống tự xử lý sau khi khách đọc số.",
    });
  }

  if (trangThai === "da_xac_nhan") {
    return JSON.stringify({
      trang_thai_danh_bo: "da_xac_nhan",
      ma_danh_bo: callState.danhBo.value,
      message:
        "Mã danh bộ ĐÃ ĐƯỢC KHÁCH XÁC NHẬN — dùng NGAY số này để gọi tool tra cứu khách cần " +
        "(get_bill/compare_usage/get_outages/create_ticket...). " +
        "KHÔNG hỏi lại, KHÔNG đọc lại số, KHÔNG truyền ma_danh_bo khác với số hệ thống đang giữ.",
    });
  }

  // dang_cho_xac_nhan — model CHỈ đọc hộ câu hỏi, KHÔNG tự đánh giá đúng/sai và
  // KHÔNG có quyền tự coi là đã xác nhận (xem ghi chú đầu file phần này).
  return JSON.stringify({
    trang_thai_danh_bo: "dang_cho_xac_nhan",
    ma_danh_bo: callState.danhBo.value,
    doc_cho_khach:
      `Dạ, em đọc lại mã danh bộ để Quý Khách kiểm tra: ${danhBoSpoken(callState.danhBo.value)}. ` +
      `Quý Khách xác nhận giúp em có đúng không ạ?`,
    message:
      "Mã danh bộ ĐANG CHỜ khách xác nhận bằng lời — đọc câu doc_cho_khach cho khách nghe. " +
      "KHÔNG tự tra cứu, KHÔNG tự coi là đã xác nhận dù model 'nghĩ' số này đúng — chỉ hệ " +
      "thống mới được đổi trạng thái này, dựa trên câu trả lời thật của khách.",
  });
}

// ─── [fix 19/07/2026 v2] CO-PILOT gpt-5.1 chạy ngầm từ lượt 1 ────────────────

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Gom mọi quan sát hiện có trong callState rồi hỏi trọng tài gpt-5.1.
 * waitTranscriptMs: transcript chạy song song, thường về TRỄ hơn tool call vài
 * trăm ms → chờ một nhịp để quan sát của lượt vừa rồi kịp vào buffer.
 */
async function runDanhBoArbiter(callState, { waitTranscriptMs = 800 } = {}) {
  await _sleep(waitTranscriptMs);
  let verdict = null;
  try {
    verdict = await arbitrateDanhBo({
      reads: callState._danhBoReads || [],
      transcripts: (callState._danhBoTranscripts || []).map((t) => t.text),
      // [1.7] Lần đọc mới nhất = phiên hiện tại (biến 2) — ưu tiên cao nhất.
      latestTranscripts: ensureDanhBoSession(callState).turns.map((t) => t.text),
      knownDanhBo: callState.knownDanhBo || [],
      rejected: callState._danhBoRejected || [],
    });
  } catch (e) {
    log.warn(`[danh_bo][arbiter] Lỗi gọi trọng tài: ${e.message}`);
  }
  callState._logger?.addEvent?.(
    "danh_bo_arbiter",
    verdict ? JSON.stringify(verdict) : "arbiter_failed"
  );
  return verdict;
}

/**
 * Hỏi API nghiệp vụ xem danh bộ này có thật không.
 * @returns {{coThat:boolean, chacChan:boolean}}
 *   `chacChan` = API trả lời DỨT KHOÁT (không phải lỗi mạng/timeout). Cần phân
 *   biệt vì lỗi mạng ≠ số sai: khi đó vẫn cho khách xác nhận (`coThat: true`)
 *   nhưng KHÔNG được coi là bằng chứng để nới ngưỡng tin cậy.
 */
async function checkDanhBoApi(candidate, callState) {
  try {
    const r = await getThongTinKhachHang(candidate);
    const khongKetNoiDuoc = ["TIMEOUT", "CONNECTION_ERROR", "INVALID_RESPONSE"].includes(r?.error_code);
    if (khongKetNoiDuoc) return { coThat: true, chacChan: false };
    const coKhach = !!(r?.success && Array.isArray(r.data) && r.data.length > 0);
    if (!coKhach) {
      log.warn(`[danh_bo][arbiter] "${candidate}" không có trong hệ thống.`);
      callState._logger?.addEvent?.("danh_bo_arbiter", `candidate ${candidate} không tồn tại trong hệ thống`);
    }
    return { coThat: coKhach, chacChan: true };
  } catch (e) {
    log.warn(`[danh_bo][arbiter] Xác thực lỗi (${e.message}) — vẫn cho khách xác nhận.`);
    return { coThat: true, chacChan: false };
  }
}

/** API nghiệp vụ có biết danh bộ này không. Lỗi mạng/timeout ≠ số sai → coi như có. */
async function candidateExistsInApi(candidate, callState) {
  return (await checkDanhBoApi(candidate, callState)).coThat;
}

/**
 * Ứng viên trọng tài đạt chuẩn → lưu + trả câu đọc lại xác nhận. Không đạt → null.
 * Chuẩn: đủ 11 số, CHƯA từng bị khách bác, chưa quá 2 lần đề xuất (chống lặp vô
 * hạn đoán-sai-đoán-lại), tồn tại trong API, và đủ tin cậy theo 2 mức dưới đây.
 *
 * [fix 19/07/2026] do_tin_cay thiếu/sai kiểu → Number() ra NaN, mọi so sánh với
 * NaN đều false → viết theo hướng CHẤP NHẬN để dữ liệu rác tự rơi vào nhánh loại.
 *
 * [fix 26/07/2026] HAI MỨC TIN CẬY — API là trọng tài cuối, không phải LLM.
 * Cuộc rtc_u1_E5hSj6jwK5jeMHvCZV7yx: gpt-5.1 suy ra ĐÚNG "22023251775" nhưng tự
 * chấm do_tin_cay = 0.4 (nó phải ghép qua nhiều mảnh nên khiêm tốn) → ngưỡng cứng
 * 0.7 loại thẳng, khách phải bấm DTMF. Trong khi chỉ cần 40ms gọi API là biết chắc
 * số đó CÓ THẬT. Nên: tin cậy thấp vẫn được đề xuất, miễn API xác nhận DỨT KHOÁT
 * là có — và khách vẫn phải xác nhận bằng lời trước khi tra cứu (gate bên dưới).
 */
async function tryProposeArbiterCandidate(verdict, callState) {
  const candidate = normalizeDanhBo(verdict?.ma_danh_bo);
  const conf = Number(verdict?.do_tin_cay);

  if (candidate.length !== DANH_BO_LENGTH) {
    log.warn(`[danh_bo][arbiter] Không có ứng viên đủ ${DANH_BO_LENGTH} số (candidate="${candidate}", conf=${conf}).`);
    return null;
  }
  if ((callState._danhBoRejected || []).includes(candidate)) return null;
  if ((callState._danhBoProposeCount || 0) >= 2) return null;

  // Hỏi API TRƯỚC khi xét tin cậy: đây là nguồn sự thật rẻ nhất (~40ms) và chắc
  // nhất, đừng bắt LLM tự chịu trách nhiệm chọn duy nhất một đáp án.
  const api = await checkDanhBoApi(candidate, callState);
  if (!api.coThat) return null;

  const duTinCay = Number.isFinite(conf) && conf >= ARBITER_MIN_CONFIDENCE;
  const duTinCayThap = Number.isFinite(conf) && conf >= ARBITER_LOW_CONFIDENCE;
  if (!duTinCay && !(duTinCayThap && api.chacChan)) {
    log.warn(`[danh_bo][arbiter] Không đủ tin cậy (candidate="${candidate}", conf=${conf}, api_chac_chan=${api.chacChan}).`);
    return null;
  }
  if (!duTinCay) {
    log.info(`[danh_bo][arbiter] conf=${conf} dưới ngưỡng ${ARBITER_MIN_CONFIDENCE} nhưng API xác nhận "${candidate}" CÓ THẬT → vẫn đề xuất.`);
  }

  callState._danhBoProposeCount = (callState._danhBoProposeCount || 0) + 1;
  log.info(`[danh_bo][arbiter] Ứng viên "${candidate}" (conf=${conf}) → đọc lại xác nhận.`);
  callState.danhBo = { value: candidate, confirmed: false };
  // [fix 19/07/2026] Cuộc E3JJPyzYujYdwQG048Bf7: danh bộ do trọng tài SUY LUẬN
  // (không phải khách tự đọc trôi chảy) rủi ro cao hơn nếu sai → bắt buộc có
  // LƯỢT KHÁCH THẬT chứa từ khẳng định mới cho tra cứu (gỡ cờ ở session-ws.js,
  // chặn ở resolveDanhBo bên dưới).
  callState._danhBoNeedsVerbalYes = true;
  return confirmRequestResponse(candidate, callState);
}

/**
 * [fix 19/07/2026 v2] TỰ SỬA khi tra cứu chết ở CUSTOMER_NOT_FOUND: số đang
 * dùng (thường là bản realtime khách "xác nhận") không có trong hệ thống, NHƯNG
 * co-pilot gpt-5.1 chạy nền có thể đã suy ra dãy KHÁC đúng hơn (vd realtime nghe
 * 22273240168, transcript 23273240168 — sai 1 số). Thay vì báo khách "không tìm
 * thấy, đọc lại", đọc lại ỨNG VIÊN co-pilot cho khách xác nhận.
 * Trả về response string (đọc lại xác nhận) nếu có ứng viên khác hợp lệ; null nếu không.
 */
async function danhBoNotFoundSelfCorrect(callState) {
  const current = callState.danhBo?.value || null;
  // Số hiện tại vừa NOT_FOUND → đẩy vào rejected để trọng tài KHÔNG quay lại nó.
  if (current) rejectStoredDanhBo(callState);

  // [1.3 — 26/07/2026] MỨC B: trước đây gọi `runDanhBoArbiter` trực tiếp, có thể
  // chặn tới 20s ngay giữa một tool call. Giờ đi qua LUỒNG XÁC MINH dùng chung
  // (§2.3) — có hạn chờ DANH_BO_VERIFY_WAIT_MS và chạy 2 kênh song song.
  const r = await verifyDanhBoFromSession(callState, { chapNhanThieuSo: true });
  if (r.action === "none" || !r.payload) return null;

  if (r.action === "confirm") {
    callState._logger?.addEvent?.(
      "danh_bo_self_correct",
      `NOT_FOUND "${current}" → thử ứng viên "${r.value}" (${r.by})`
    );
    log.info(`[danh_bo][self-correct] NOT_FOUND "${current}" → đọc lại ứng viên "${r.value}".`);
  } else {
    log.info(`[danh_bo][self-correct] NOT_FOUND "${current}" → không có ứng viên thay thế, ${r.action}.`);
  }
  return r.payload;
}

/** Ghi nhận dãy đã bị khách bác bỏ (để trọng tài né và không đề xuất lại). */
function rejectStoredDanhBo(callState) {
  const stored = callState.danhBo?.value;
  if (!stored) return;
  (callState._danhBoRejected ??= []);
  if (!callState._danhBoRejected.includes(stored)) callState._danhBoRejected.push(stored);
  callState.danhBo = null;
  callState._danhBoResolvedBy = null;
}

/**
 * Hết lượt đọc giọng nói → mời BẤM PHÍM (DTMF). session-ws.js tự buffer phím
 * bấm, đủ 11 số sẽ tự đọc lại xác nhận — model KHÔNG tham gia nghe phím.
 */
function danhBoDtmfInviteResponse(callState) {
  callState._danhBoDtmfInvited = true;
  return danhBoPayload(callState, {
    success: false,
    moi_bam_phim: true,
    doc_cho_khach:
      `Dạ, em xin lỗi Quý Khách, đường truyền bên em vẫn chưa nghe trọn vẹn được mã danh bộ ạ. ` +
      `Quý Khách vui lòng BẤM ${docSoLuong(DANH_BO_LENGTH)} chữ số mã danh bộ trên bàn phím ` +
      `điện thoại giúp em; nếu lỡ bấm nhầm, Quý Khách bấm phím SAO để nhập lại từ đầu ạ. ` +
      `Trường hợp không tiện bấm phím, Quý Khách nói "chuyển máy" để gặp tổng đài viên hỗ trợ ạ.`,
    // [fix 31/07/2026 đợt 10] Cùng lớp rủi ro — bỏ mệnh lệnh tuyệt đối, chỉ mô tả
    // trạng thái để không xung đột với yêu cầu đọc số (đọc lại kết quả DTMF) sau này.
    message:
      `Đã hết lượt đọc bằng giọng nói — chuyển sang BẤM PHÍM. Hệ thống TỰ phát câu mời ` +
      `bấm phím và TỰ ĐỘNG ghi nhận phím bấm. Lượt NÀY model không cần tự đọc/đoán số từ ` +
      `tiếng bấm phím. Khách muốn chuyển máy → transfer_to_agent. Khách muốn nhân viên gọi ` +
      `lại → create_ticket. Khi hệ thống gửi yêu cầu đọc số riêng thì mới đọc, không bị ` +
      `câu này ràng buộc.`,
  });
}

// ─── [1.5 — 26/07/2026] LUỒNG XÁC MINH mã danh bộ (§2.3 kế hoạch v3) ──────────
// Chạy ở ĐƯỜNG NỀN (session-ws gọi sau khi khách ngưng đọc), KHÔNG chặn tool.
//
// Nguyên tắc: transcript ra đúng 11 số VẪN phải qua gpt-5.1 — gpt-4o-transcribe
// hoàn toàn có thể nghe sai mà vẫn cho ra đủ 11 chữ số, con số trông "sạch"
// nhưng lại sai, rất khó phát hiện nếu chốt thẳng.
//
// Hai kênh chạy SONG SONG (không nối tiếp):
//   (a) verify API  — ~40ms, biết chắc mã có tồn tại không
//   (b) trọng tài gpt-5.1 — ~6-15s, đối chiếu mọi quan sát
// Chờ (b) tối đa DANH_BO_VERIFY_WAIT_MS rồi quyết định theo bảng bên dưới.

/**
 * @returns {Promise<{action:"confirm"|"reread"|"dtmf"|"none", prompt?:string, value?:string, by?:string}>}
 */
export async function verifyDanhBoFromSession(callState = {}, { chapNhanThieuSo = false } = {}) {
  // Guard: đã có ứng viên đang chờ / đã chốt (model, DTMF, lượt trước) → không chen ngang.
  if (callState.danhBo) return { action: "none" };
  if (callState._danhBoDtmfInvited) return { action: "none" };

  const session = ensureDanhBoSession(callState);
  // Biến 2 rỗng nhưng biến 1 còn quan sát → vẫn chạy được (đường tự sửa khi API
  // báo CUSTOMER_NOT_FOUND gọi thẳng hàm này, không qua lượt đọc mới).
  if (!session.digits && (callState._danhBoTranscripts || []).length === 0) return { action: "none" };

  // [fix 26/07/2026 đợt 3] CHƯA ĐỦ 11 SỐ THÌ CHƯA GỌI TRỌNG TÀI.
  // Cuộc rtc_u2_E5hhmAHqS8cDGvUnCph0x: verify nổ khi mới có 4/11 số → gpt-5.1
  // đương nhiên trả null ("thiếu 7 chữ số") → code hiểu là bó tay và RESET phiên
  // ngay giữa lúc khách đang đọc dở. Vừa tốn token vừa phá cuộc gọi.
  if (!chapNhanThieuSo && session.digits.length < DANH_BO_LENGTH) {
    return { action: "chua_du_so", prompt: null };
  }

  // [fix 30/07/2026] LẦN ĐỌC ĐẦU TIÊN của cả cuộc gọi (requestNo <= 1), thiếu số,
  // VÀ không có quan sát nào khác để đối chiếu (không danh bộ theo SĐT, không có
  // lượt đọc/nghe nào trước đó) → trọng tài CHẮC CHẮN không đủ dữ liệu để ghép
  // (không có gì để bỏ phiếu theo vị trí). Gọi vẫn tốn ~10s + token cho một kết
  // quả biết trước sẽ là null/do_tin_cay thấp.
  // Cuộc rtc_u2_E7BmrdXWyeLTMmcQfmjLY (30/07/2026 10:32): khách chỉ đọc "2202"
  // (4/11) rồi im, hệ thống vẫn gọi gpt-5.1 mất ~12s chỉ để nhận lại "không đủ
  // dữ liệu". Từ LẦN ĐỌC #2 trở đi vẫn cho trọng tài thử ghép bình thường — khi
  // đó đã có ít nhất một lần đọc trước trong `_danhBoTranscripts` để đối chiếu.
  const khongCoQuanSatKhac =
    (callState.knownDanhBo || []).length === 0 &&
    (callState._danhBoReads || []).length === 0;
  if (session.digits.length < DANH_BO_LENGTH && session.requestNo <= 1 && khongCoQuanSatKhac) {
    log.info(
      `[danh_bo][verify] Lần đọc #1 thiếu số (${session.digits.length}/${DANH_BO_LENGTH}), ` +
      `không có quan sát nào khác → bỏ qua trọng tài, mời đọc lại ngay.`
    );
    const out = danhBoReReadOrEscalate(callState, session.digits.length);
    const action = callState._danhBoDtmfInvited ? "dtmf" : "reread";
    return { action, prompt: _docChoKhach(out), payload: out };
  }

  const requestNoAtStart = session.requestNo;
  const digitsAtStart = session.digits; // để phát hiện khách đọc thêm trong lúc chờ // guard chống verdict về trễ (xem cuối hàm)

  const rejected = callState._danhBoRejected || [];
  const txSingle = latestSessionDanhBo(callState); // lượt ĐƠN ra đúng 11 số (nếu có)

  // (a) và (b) khởi động cùng lúc.
  const apiCheckP = (txSingle && !rejected.includes(txSingle))
    ? candidateExistsInApi(txSingle, callState)
    : Promise.resolve(false);
  const arbiterP = runDanhBoArbiter(callState, { waitTranscriptMs: 0 });

  // [fix 26/07/2026] Cờ `xong` để nhánh hết-giờ KHÔNG log cảnh báo giả khi trọng
  // tài đã về kịp (cuộc rtc_u1_E5hSj6j: log báo "quá 6000ms" ngay sau khi verdict
  // đã dùng xong — timer vẫn chạy tiếp sau khi Promise.race đã ngã ngũ).
  let xong = false;
  const verdict = await Promise.race([
    arbiterP.then((v) => { xong = true; return v; }),
    _sleep(DANH_BO_VERIFY_WAIT_MS).then(() => {
      if (xong) return null;
      log.warn(`[danh_bo][verify] Trọng tài quá ${DANH_BO_VERIFY_WAIT_MS}ms — quyết định bằng dữ liệu đang có.`);
      return null;
    }),
  ]);
  const txExists = await apiCheckP;

  // Trong lúc chờ, khách có thể đã bấm DTMF / lượt yêu cầu đã sang phiên mới →
  // kết quả này thuộc về phiên CŨ, bỏ đi (guard §3.3 kế hoạch v3).
  if (callState.danhBo) return { action: "none" };
  if (session.requestNo !== requestNoAtStart) {
    log.info(`[danh_bo][verify] Bỏ kết quả phiên #${requestNoAtStart} (đã sang phiên #${session.requestNo}).`);
    return { action: "none" };
  }
  // [fix 26/07/2026 đợt 3] Khách đọc THÊM số trong lúc trọng tài chạy → phán quyết
  // này dựa trên dữ liệu CŨ, áp lên trạng thái MỚI là sai. Cuộc rtc_u2_E5hhmAHq:
  // trọng tài chạy với 4 số, lúc trả kết quả phiên đã có 8 số, code vẫn reset phiên.
  if (session.digits !== digitsAtStart) {
    log.info(`[danh_bo][verify] Bỏ kết quả cũ (${digitsAtStart.length} số) — khách đã đọc thêm (${session.digits.length} số).`);
    return { action: "none" };
  }

  // ── Nhánh 1: lượt đơn ra 11 số VÀ tồn tại trong hệ thống → tin transcript ──
  // (transcript > suy luận; lại đã có API bảo chứng). Đây cũng là nhánh khi
  // trọng tài đồng ý — kết quả như nhau nên không cần tách.
  if (txSingle && txExists) {
    callState.danhBo = { value: txSingle, confirmed: false };
    callState._danhBoResolvedBy = "transcript_11";
    // Khách tự đọc thẳng, không qua suy luận của trọng tài → KHÔNG áp gate
    // xác nhận lời nói (gate chỉ dành cho số do trọng tài SUY RA).
    callState._danhBoNeedsVerbalYes = false;
    const arbSame = normalizeDanhBo(verdict?.ma_danh_bo) === txSingle;
    log.info(`[danh_bo][verify] Chốt "${txSingle}" từ transcript (API OK, trọng tài ${arbSame ? "đồng ý" : "khác/không có"}).`);
    callState._logger?.addEvent?.("danh_bo_verified",
      `transcript_11 "${txSingle}" — API OK, trọng tài ${arbSame ? "đồng ý" : "khác/không có"}`);
    const payload = confirmRequestResponse(txSingle, callState);
    return { action: "confirm", value: txSingle, by: "transcript_11", prompt: _docChoKhach(payload), payload };
  }

  // ── Nhánh 2: transcript không tồn tại trong API (hoặc không có lượt đơn 11 số)
  // → dùng ứng viên của trọng tài (tryProposeArbiterCandidate tự verify API +
  //   đặt gate `_danhBoNeedsVerbalYes`).
  const resp = await tryProposeArbiterCandidate(verdict, callState);
  if (resp) {
    const value = callState.danhBo?.value || null;
    callState._danhBoResolvedBy = "arbiter";
    log.info(`[danh_bo][verify] Chốt "${value}" từ trọng tài gpt-5.1.`);
    callState._logger?.addEvent?.("danh_bo_verified", `arbiter "${value}"`);
    return { action: "confirm", value, by: "arbiter", prompt: _docChoKhach(resp), payload: resp };
  }

  // ── Nhánh 3: cả hai kênh đều không ra ứng viên hợp lệ → mời đọc lại / leo thang ──
  if (txSingle && !txExists) {
    log.warn(`[danh_bo][verify] "${txSingle}" nghe đủ 11 số nhưng KHÔNG có trong hệ thống — không chốt bừa.`);
    callState._logger?.addEvent?.("danh_bo_not_found", `${txSingle} — 11 số nhưng không tồn tại`);
  }
  const out = danhBoReReadOrEscalate(callState, session.digits.length);
  const action = callState._danhBoDtmfInvited ? "dtmf" : "reread";
  return { action, prompt: _docChoKhach(out), payload: out };
}

/** Bóc `doc_cho_khach` khỏi payload JSON của các hàm dựng câu thoại. */
function _docChoKhach(payloadJson) {
  try { return JSON.parse(payloadJson).doc_cho_khach || null; } catch { return null; }
}

// ─── [2.1 — 26/07/2026] PHÁT HIỆN MODEL BỊA SỐ ───────────────────────────────
// `ma_danh_bo` là trường `required` trong schema các tool tra cứu (get_bill,
// compare_usage, get_outages — [fix 05/08/2026] gộp get_payment_status +
// get_water_usage vào get_bill, giảm từ 5 xuống còn 3 tool) → structured output
// BUỘC model phải điền một giá trị kể cả khi nó chưa nghe được gì. Cuộc
// rtc_u2_E5eDfB96UnJE6iDWfPbRX: khách mới nói "xem giúp anh tiền nước tháng này",
// chưa đọc số nào, model gọi get_bill({"ma_danh_bo":"725625"}).
//
// Ta GIỮ trường này (nó là nguồn nghe thứ hai cho trọng tài — `_danhBoReads` đã
// chết từ 23/07 khi gỡ tool confirm_danh_bo), nhưng lọc số bịa ở đây.

/** Khoảng cách Levenshtein (chỉ dùng cho chuỗi số ngắn ≤ 20 ký tự). */
function _levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,                                  // xoá
        cur[j - 1] + 1,                               // thêm
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1) // thay
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Phân loại dãy số model truyền vào, đối chiếu với số khách THỰC SỰ đã đọc
 * trong LƯỢT YÊU CẦU hiện tại (biến 2).
 *
 *  R1 — phiên chưa có chữ số nào            → BỊA (bắt trọn ca "725625")
 *  R2 — arg là substring của phiên          → nghe đúng
 *  R3 — Levenshtein ≤ max(1, ⌊len*0.2⌋)     → nghe lệch (chấp nhận làm quan sát)
 *  R4 — còn lại                             → BỊA
 *
 * @returns {{verdict:"empty"|"nghe_dung"|"nghe_lech"|"bia", rule?:string, distance?:number}}
 */
export function classifyModelArg(arg, sessionDigits) {
  const a = String(arg || "");
  const s = String(sessionDigits || "");
  if (!a) return { verdict: "empty" };
  if (!s) return { verdict: "bia", rule: "R1" };
  if (s.includes(a)) return { verdict: "nghe_dung", rule: "R2" };

  const nguong = Math.max(1, Math.floor(a.length * 0.2));
  let best = Infinity;
  for (const len of [a.length - 1, a.length, a.length + 1]) {
    if (len <= 0 || len > s.length) continue;
    for (let i = 0; i + len <= s.length; i++) {
      const d = _levenshtein(a, s.substr(i, len));
      if (d < best) best = d;
      if (best === 0) break;
    }
  }
  if (best <= nguong) return { verdict: "nghe_lech", rule: "R3", distance: best };
  return { verdict: "bia", rule: "R4", distance: Number.isFinite(best) ? best : null };
}

/**
 * [2.2] Ghi nhận dãy model nghe được. BỊA → bỏ hoàn toàn (không vào `_danhBoReads`,
 * không đếm, không tra cứu). Còn lại → đưa vào kho quan sát cho trọng tài.
 */
function noteModelHeardDanhBo(argModel, callState = {}) {
  if (!argModel) return;
  const s = ensureDanhBoSession(callState);
  const c = classifyModelArg(argModel, s.digits);

  if (c.verdict === "bia") {
    callState._hallucinationCount = (callState._hallucinationCount || 0) + 1;
    log.warn(`[danh_bo] Model BỊA số "${argModel}" (${c.rule}${c.distance != null ? `, d=${c.distance}` : ""}) — bỏ qua.`);
    callState._logger?.addEvent?.("danh_bo_arg_hallucinated",
      `${argModel} (${c.rule}${c.distance != null ? `, d=${c.distance}` : ""}) — lần ${callState._hallucinationCount}`);
    return;
  }

  const reads = (callState._danhBoReads ??= []);
  reads.push(argModel);
  while (reads.length > 20) reads.shift();
  log.debug(`[danh_bo] Ghi nhận bản nghe model "${argModel}" (${c.verdict}/${c.rule}).`);
}

/** session-ws gọi khi khách PHỦ ĐỊNH số đang chờ xác nhận: đẩy vào rejected +
 *  xoá để co-pilot / model được đề xuất dãy khác. */
export function noteDanhBoRejected(callState = {}) {
  rejectStoredDanhBo(callState);
}

/**
 * [1.8] Câu mời BẤM PHÍM để session-ws phát trực tiếp (watchdog / leo thang),
 * không cần đi qua một tool call nào.
 */
export function danhBoDtmfInvitePrompt(callState = {}) {
  return _docChoKhach(danhBoDtmfInviteResponse(callState));
}

/**
 * Lấy mã danh bộ CHO TOOL TRA CỨU từ callState (ưu tiên) hoặc từ arg của model.
 * Trả { ok: true, value } khi được phép tra cứu; { ok: false, error } khi phải
 * dừng lại (sai độ dài / cần khách xác nhận trước).
 */
// [fix 23/07/2026] CỔNG danh bộ dùng chung cho MỌI hàm tra cứu — thay cho tool
// confirm_danh_bo (đã gỡ). Nguyên tắc: KHÔNG tin "tai" model (arg ma_danh_bo hay
// sai/thiếu); ưu tiên transcript; số chỉ được TRA CỨU sau khi khách xác nhận LỜI
// NÓI (session-ws bắt "đúng" → danhBo.confirmed=true). Thu số nhiều hơi + trọng
// tài do verifyDanhBoFromSession (session-ws gọi ở đường nền) lo; hết lượt → DTMF → chuyển máy.
// [1.3 — 26/07/2026] MỨC B: hàm này giờ là một CỔNG KHÔNG CHẶN. Nó chỉ đọc
// trạng thái hiện tại và trả lời ngay (mục tiêu ≤ 2s). Việc gom số, gọi trọng
// tài và đọc lại xác nhận do ĐƯỜNG NỀN lo (session-ws → verifyDanhBoFromSession),
// nơi CODE tự phát lời qua `_speakVerbatim` — cùng mô hình đã chứng minh hiệu quả
// ở luồng DTMF.
async function resolveDanhBo(rawArg, callState = {}) {
  console.log("==========[resolveDanhBo]===================");
  console.log("[resoleDanhbo]:rawArg = ", rawArg);
  console.log("[resoleDanhbo]:callState.knownDanhBo = ", callState.knownDanhBo);
  console.log("[resoleDanhbo]:callState._danhBoSession = ", JSON.stringify(callState._danhBoSession, null, 2));
  console.log("[resoleDanhbo]:callState._danhBoTranscripts = ", callState._danhBoTranscripts);

  // _danhBoReads: [ '220223251' ],
  // _danhBoVerifyRunning: false,
  // _danhBoVerifyLastAt: 1785314832413,
  // _danhBoVerifyPending: false,
  // _danhBoProposeCount: 1,
  // danhBo: { value: '22023251775', confirmed: true },
  // _danhBoNeedsVerbalYes: false,
  // _danhBoLastPrompt: 'Dạ, em đọc lại mã danh bộ để Quý Khách kiểm tra: Hai - Hai - Không - Hai - Ba - Hai - Năm - Một - Bảy - Bảy - Năm. Quý Khách xác nhận giúp em có đúng không ạ?',
  // _danhBoResolvedBy: 'arbiter'

  console.log("[resoleDanhbo]:callState._danhBoReads=", callState._danhBoReads)
  console.log("[resoleDanhbo]:callState._danhBoVerifyRunning=", callState._danhBoVerifyRunning)
  console.log("[resoleDanhbo]:callState._danhBoVerifyLastAt=", callState._danhBoVerifyLastAt)
  console.log("[resoleDanhbo]:callState._danhBoVerifyPending=", callState._danhBoVerifyPending)
  console.log("[resoleDanhbo]:callState._danhBoProposeCount=", callState._danhBoProposeCount)
  console.log("[resoleDanhbo]:callState.danhBo=", callState.danhBo)
  console.log("[resoleDanhbo]:callState._danhBoNeedsVerbalYes=", callState._danhBoNeedsVerbalYes)
  console.log("[resoleDanhbo]:callState._danhBoLastPrompt=", callState._danhBoLastPrompt)
  console.log("[resoleDanhbo]:callState._danhBoResolvedBy=", callState._danhBoResolvedBy)

  const stored = callState.danhBo;
  const session = ensureDanhBoSession(callState);
  const txSession = latestSessionDanhBo(callState); // lượt đơn 11 số TRONG phiên hiện tại

  // ── Đã có số ĐÃ XÁC NHẬN ──────────────────────────────────────────────────
  if (stored?.value && stored.confirmed) {
    // Khách đọc MỘT dãy 11 số MỚI khác hẳn → đổi danh bộ → xác nhận lại số mới.
    if (txSession && txSession !== stored.value) {
      log.warn(`[danh_bo] Khách đọc danh bộ MỚI "${txSession}" khác số đã xác nhận "${stored.value}" → xác nhận lại.`);
      callState.danhBo = { value: txSession, confirmed: false };
      callState._danhBoNeedsVerbalYes = false;
      return { ok: false, error: confirmRequestResponse(txSession, callState) };
    }
    callState._danhBoLastPrompt = null; // đã chốt — tắt cơ chế re-assert
    // [fix 10/08/2026] Đánh dấu "đã thật sự tra cứu bằng số vừa xác nhận" — cho
    // session-ws.js biết KHÔNG cần gửi thêm nudge "gọi tool ngay" nữa nếu model
    // đã tự chủ động gọi tool này trong chính lượt phản hồi "đúng rồi" (race giữa
    // response tự nhiên của model và _requestModelReply/_openDanhBoConfirmTurn
    // do code lên lịch — xem session-ws.js#_requestModelReply). Không đặt điều
    // kiện gì thêm: MỌI lần tra cứu thành công bằng số đã confirmed đều tính.
    callState._danhBoPostConfirmActionDone = true;
    return { ok: true, value: stored.value };
  }

  // ── Có ứng viên đang CHỜ xác nhận (chưa confirmed) ────────────────────────
  // KHÔNG cho tra cứu tới khi khách xác nhận lời nói. Arg model (hay sai) KHÔNG
  // được thay/bác ứng viên đang chờ — giữ nguyên, đọc lại xác nhận.
  if (stored?.value) {
    return { ok: false, error: confirmRequestResponse(stored.value, callState) };
  }

  // ── Chưa có số ────────────────────────────────────────────────────────────
  // Danh bộ do HỆ THỐNG cấp (lookup theo SĐT SỐNG) → tin ngay, không ép xác
  // nhận qua tầng code (số này VỪA được hệ thống sống xác minh khớp đúng SĐT
  // đang gọi tới, nên dù model lỡ bỏ qua bước hỏi thì rủi ro vẫn thấp).
  const argModel = normalizeDanhBo(rawArg);
  if (argModel.length === DANH_BO_LENGTH &&
    Array.isArray(callState.knownDanhBo) && callState.knownDanhBo.includes(argModel)) {
    callState.danhBo = { value: argModel, confirmed: true };
    callState._logger?.markDanhBoResolved?.("known_tel", argModel);
    return { ok: true, value: argModel };
  }

  // [fix 10/08/2026 — revert sau kiểm chứng thật] historyDanhBo (mã lấy từ LỊCH
  // SỬ cuộc gọi trước theo cùng SĐT, xem server.js#_handleIncomingCall +
  // log-api.js#getDanhBoHistory) ĐÃ ĐƯA VÀO customerContext (giống knownDanhBo)
  // nhưng TUYỆT ĐỐI KHÔNG được gộp vào nhóm "tin ngay" ở trên — ban đầu đã thử
  // gộp chung, nhưng log thật (cuộc rtc_u2_EBIRJxR2Jf366tXhIOZzU 10/08/2026) cho
  // thấy model KHÔNG hỏi khách xác nhận trước khi gọi get_bill, chỉ nói "để em
  // kiểm tra" rồi gọi tool luôn với mã từ lịch sử — đúng điều nguyên tắc "Gate
  // xác nhận lời nói" ở trên file này đã cảnh báo: "Model gọi thẳng tool tra cứu
  // KHÔNG tính là bằng chứng đồng ý". Khác knownDanhBo (VỪA được xác minh sống
  // khớp đúng SĐT), historyDanhBo là dữ liệu CŨ — SĐT có thể đã đổi chủ, hợp
  // đồng có thể đã đổi/khoá — nếu tin ngay như trên, model lười hỏi sẽ đọc thẳng
  // hóa đơn của khách KHÁC cho người gọi hiện tại nghe (lộ thông tin thật). Nên
  // dù model có echo đúng số, vẫn ĐỀ XUẤT làm ứng viên rồi bắt qua gate xác nhận
  // lời nói THẬT như luồng khách tự đọc số (dùng lại confirmRequestResponse).
  // Chỉ đề xuất khi khách CHƯA tự đọc số nào trong phiên này (nhường luồng đọc
  // số bình thường xử lý trước) và MỚI đề xuất LẦN ĐẦU trong cuộc gọi (bị khách
  // bác thì thôi, chuyển sang xin đọc số bình thường).
  if (session.digits.length === 0 &&
    Array.isArray(callState.historyDanhBo) && callState.historyDanhBo.length > 0 &&
    !callState._historyDanhBoOffered) {
    callState._historyDanhBoOffered = true;
    const candidate = callState.historyDanhBo[0];
    callState.danhBo = { value: candidate, confirmed: false };
    callState._danhBoResolvedBy = "history_tel";
    callState._danhBoNeedsVerbalYes = false; // nguồn xác định (lịch sử), không phải suy luận trọng tài
    log.info(`[danh_bo][history] Đề xuất mã "${candidate}" từ lịch sử cuộc gọi trước theo SĐT — chờ khách xác nhận lời nói.`);
    callState._logger?.addEvent?.("danh_bo_history_proposed", candidate);
    return { ok: false, error: confirmRequestResponse(candidate, callState) };
  }

  // [2.2] Arg của model CHỈ là một quan sát cho trọng tài — không bao giờ được
  // dùng để tra cứu hay để đếm đủ/thiếu (nguyên tắc §1.1 kế hoạch v3).
  noteModelHeardDanhBo(argModel, callState);

  // [2.3] Model bịa số ≥2 lần = nó đã mất ngữ cảnh; nghe tiếp chỉ tốn thời gian
  // của khách → chuyển thẳng sang bấm phím (đường chắc chắn nhất).
  //
  // ĐIỀU KIỆN: khách phải đã TỪNG đọc số trong cuộc gọi này. Model rất hay bắn
  // liên tiếp nhiều tool call ngay khi khách chưa kịp nói gì — nếu leo thang
  // luôn thì khách vừa nghe "cho em xin mã danh bộ" đã bị chuyển sang "vui lòng
  // bấm phím", cụt lủn và chưa cho khách một cơ hội nào để đọc.
  const khachDaTungDocSo = (callState._danhBoTranscripts || []).length > 0;
  if ((callState._hallucinationCount || 0) >= 2 && khachDaTungDocSo && !callState._danhBoDtmfInvited) {
    log.warn(`[danh_bo] Model bịa số ${callState._hallucinationCount} lần → mời bấm phím DTMF.`);
    return { ok: false, error: danhBoDtmfInviteResponse(callState) };
  }

  // ── Quyết định theo BIẾN 2 (phiên đọc hiện tại), KHÔNG chờ ────────────────
  const daNghe = session.digits.length;

  // Chưa nghe khách đọc số nào trong phiên này → xin số ngay.
  if (daNghe === 0) {
    return { ok: false, error: invalidDanhBoResponse(0, callState) };
  }

  // Đang gom dở → trả NGAY, để đường nền tiếp tục gom.
  if (daNghe < DANH_BO_LENGTH) {
    return { ok: false, error: dangGomSoResponse(daNghe) };
  }

  // Đủ hoặc thừa số → đường nền đang xác minh (API + gpt-5.1), trả câu chờ ngắn.
  return { ok: false, error: dangXacMinhResponse() };
}

// function normalizeDanhBo(raw) {
//   console.log("==========[normalizeDanhBo]==================")
//   console.log("raw", raw)
//   // loại bỏ tất cả cá các khoảng trắng và dầu - 
//   let normalized = String(raw ?? "").replace(/\s/g, "");
//   normalized = String(normalized ?? "").replace(/-/g, "");
//   normalized = String(normalized ?? "").replace(/\D/g, "");
//   console.log("normalized", normalized)
//   return normalized;
// }

/** Format "2026-06-30 15:14:54" → "30/06/2026" (đọc tự nhiên qua thoại). */
function fmtNgay(s) {
  const m = String(s ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
}

/**
 * Rút gọn 1 dòng hóa đơn thành object "sạch" cho model đọc:
 * - ngày đã format DD/MM/YYYY (model mini khó tự parse "2026-06-30 15:14:54"),
 * - bỏ DonViThanhToan (mã nội bộ như "GDGV", gây nhiễu),
 * - tiền đã format kèm đơn vị.
 * Giúp model trả lời được các câu hỏi tiếp theo (vd "đóng ngày nào?") từ chính data này.
 */
function simplifyRow(d) {
  const paid = d.TrangThaiThanhToan === "Đã thanh toán";
  return {
    ky: `${d.Ky}/${d.Nam}`,
    san_luong_m3: d.SanLuong,
    tong_tien: docTienVN(d.TongTien), // dạng CHỮ — model đọc nguyên văn
    tong_tien_so: d.TongTien,         // số raw để tham chiếu/log
    trang_thai_thanh_toan: d.TrangThaiThanhToan || null,
    ngay_thanh_toan: paid ? fmtNgay(d.NgayThanhToan) : null,
  };
}

/** Kỳ liền trước theo giờ GMT+7 (kỳ = tháng). */
function prevPeriod() {
  const now = new Date(Date.now() + 7 * 60 * 60 * 1000);
  let ky = now.getUTCMonth() + 1;
  let nam = now.getUTCFullYear();
  ky -= 1;
  if (ky === 0) { ky = 12; nam -= 1; }
  return { ky, nam };
}

/**
 * Fetch chung cho tra cứu hóa đơn: gọi trang-thai-thanh-toan (superset:
 * TongTien + SanLuong + TrangThaiThanhToan) — 1 lần gọi đủ dữ liệu cho
 * get_bill, khách hỏi tiếp (thanh toán/sản lượng) không cần gọi API lần 2.
 *
 * Backend KHÔNG tự lấy "kỳ gần nhất" khi thiếu ky/nam (mặc định kỳ hiện tại →
 * thường chưa có dữ liệu đầu tháng). Nên: không truyền ky/nam mà bị *_NOT_FOUND
 * → tự lùi 1 kỳ và gọi lại (fallback deterministic, không để model tự đoán kỳ).
 *
 * Trả về { ok, rows?, error? } — error là JSON string sẵn cho AI, giữ error_code
 * để model phân biệt CUSTOMER_NOT_FOUND (đọc lại danh bộ) vs INVOICE/PRODUCTION_NOT_FOUND (kỳ chưa có).
 */
async function fetchBilling(ma_danh_bo, ky, nam, callState) {
  log.debug(`[fetchBilling] ma_danh_bo=${ma_danh_bo} ky=${ky} nam=${nam}`);
  console.log("[fetchBilling]:ma_danh_bo=", ma_danh_bo);
  console.log("[fetchBilling]:ky=", ky);
  console.log("[fetchBilling]:nam=", nam);


  const rs = await resolveDanhBo(ma_danh_bo, callState);
  if (!rs.ok) return { ok: false, error: rs.error };

  let r = await getTrangThaiTT(rs.value, ky, nam);

  const noPeriodGiven = (ky === null || ky === undefined) && (nam === null || nam === undefined);
  const notFound = ["INVOICE_NOT_FOUND", "PRODUCTION_NOT_FOUND"].includes(r?.error_code);
  if (!r.success && noPeriodGiven && notFound) {
    const p = prevPeriod();
    r = await getTrangThaiTT(rs.value, p.ky, p.nam);
  }

  if (!r.success) {
    // Danh bộ không có trong hệ thống → thử tự sửa bằng ứng viên co-pilot nền.
    if (r.error_code === "CUSTOMER_NOT_FOUND") {
      const corrected = await danhBoNotFoundSelfCorrect(callState);
      if (corrected) return { ok: false, error: corrected };
    }
    return {
      ok: false,
      error: JSON.stringify({
        success: false,
        error_code: r.error_code || null,
        message: r.message || "Không tra cứu được thông tin.",
      }),
    };
  }
  // [fix 26/07/2026 — cuộc rtc_u1_E5hSj6jwK5jeMHvCZV7yx] Dòng này TỪNG bị comment
  // nên `f.ma_danh_bo` là undefined, các handler dựng câu "Mã danh bộ undefined,
  // Kỳ 7/2026: 18 m³...". Model đọc thấy chữ "undefined" liền KẾT LUẬN là tra cứu
  // hỏng, rồi nói với khách "hệ thống vẫn trả về mã danh bộ không đúng nên em chưa
  // thể đọc số khối nước" — MẶC DÙ tool đã trả success kèm dữ liệu thật. Khách bấm
  // DTMF đúng 2 lần, xác nhận 2 lần, vẫn bị bảo là sai số rồi cúp máy.
  return { ok: true, ma_danh_bo: rs.value, rows: Array.isArray(r.data) ? r.data : [] };
}

// ─── Handlers ────────────────────────────────────────────────────────────────

// [fix 05/08/2026] Gộp handleGetBill + handleGetWaterUsage + handleGetPaymentStatus
// làm MỘT — cả 3 tool cũ gọi CHUNG một API (`getTrangThaiTT` qua `fetchBilling`,
// trả sẵn TongTien + SanLuong + TrangThaiThanhToan trong cùng 1 lần gọi), chỉ khác
// nhau ở cách format lại `message` từ CÙNG một bộ dữ liệu. Log thật cho thấy model
// hay gọi get_bill rồi ngay sau đó gọi thêm get_water_usage cho đúng kỳ đó — 2
// vòng round-trip cho cùng một lần tra cứu. Gộp lại: hỏi 1 trong 3 thứ (tiền, sản
// lượng, trạng thái thanh toán) → trả lời đủ cả 3 luôn từ lần hỏi đầu.
// KHÔNG đọc DonViThanhToan cho khách (mã nội bộ như "GDGV", chưa có bảng map).
async function handleGetBill({ ma_danh_bo, ky, nam }, callState) {
  const f = await fetchBilling(ma_danh_bo, ky, nam, callState);
  if (!f.ok) return f.error;
  console.log("[handleGetBill] f=", f);
  console.log("f.ma_danh_bo", f.ma_danh_bo);
  const parts = f.rows.map((d) => {
    const tt = d.TrangThaiThanhToan === "Đã thanh toán"
      ? `đã thanh toán ngày ${fmtNgay(d.NgayThanhToan)}`
      : `chưa thanh toán`;
    return `Kỳ ${d.Ky}/${d.Nam}: sản lượng ${d.SanLuong} m³, tổng tiền ${docTienVN(d.TongTien)}, ${tt}`;
  });

  return JSON.stringify({
    success: true,
    message: parts.length ? parts.join("; ") + "." : "Không có dữ liệu hóa đơn.",
    data: f.rows.map(simplifyRow),
  });
}

async function handleCompareUsage({ ma_danh_bo, ky, nam }, callState) {
  const rs = await resolveDanhBo(ma_danh_bo, callState);
  if (!rs.ok) return rs.error;
  let r = await getSoSanhTangGiam(rs.value, ky, nam);
  // [fix 04/08/2026] Cùng vấn đề đã sửa ở fetchBilling (26/07): khi không truyền
  // ky/nam, backend /so-sanh-tang-giam mặc định lấy THEO NGÀY GỌI HIỆN TẠI thay vì
  // kỳ gần nhất có dữ liệu → "Chưa có dữ liệu sản lượng cho kỳ 8/2026" dù kỳ 7 đã
  // có đủ dữ liệu (rtc_u2_E963mRMGPfEe5EOma4Xx1). Thử lại với kỳ liền trước khi
  // không truyền ky/nam và lần đầu không có dữ liệu.
  const noPeriodGiven = (ky === null || ky === undefined) && (nam === null || nam === undefined);
  if (!r.success && noPeriodGiven) {
    const p = prevPeriod();
    r = await getSoSanhTangGiam(rs.value, p.ky, p.nam);
  }
  if (!r.success) {
    return JSON.stringify({ success: false, message: r.message || "Không có dữ liệu so sánh." });
  }
  return JSON.stringify({
    success: true,
    message: r.message || "Lấy thông tin so sánh sản lượng thành công.",
    data: r.data,
  });
}

async function handleGetOutages({ ma_danh_bo }, callState) {
  const rs = await resolveDanhBo(ma_danh_bo, callState);
  if (!rs.ok) return rs.error;
  const r = await getThongBaoCupNuoc(rs.value);
  if (!r.success) {
    return JSON.stringify({ success: false, message: r.message || "Không tra cứu được thông tin cúp nước." });
  }
  const d = r.data || {};
  if (!d.coSuCo) {
    return JSON.stringify({
      success: true,
      message: d.thongBao || "Khách hàng không nằm trong vùng bị sự cố.",
      data: d,
    });
  }
  const tg = d.thoiGianDuKienHoanThanh ? ` Dự kiến hoàn thành: ${d.thoiGianDuKienHoanThanh}.` : "";
  return JSON.stringify({
    success: true,
    message: `${d.thongBao || "Khu vực của Quý khách đang bị sự cố cấp nước."}${tg}`,
    data: d,
  });
}

async function handleCreateTicket({ ma_danh_bo, loai, mo_ta }, callState) {
  const rs = await resolveDanhBo(ma_danh_bo, callState);
  if (!rs.ok) return rs.error;
  // Gộp loại + mô tả thành nội dung gửi lên endpoint bao-su-co.
  const noiDung = loai ? `[${loai}] ${mo_ta}` : mo_ta;
  const r = await baoSuCo(rs.value, noiDung, callState.callerPhone);
  console.log("[handleCreateTicket]:kq_baoSuCo=", r);
  if (!r.success) {
    return JSON.stringify({ success: false, message: r.message || "Không tạo được phiếu sự cố." });
  }
  return JSON.stringify({
    success: true,
    message: r.message || "Phiếu tiếp nhận sự cố đã được ghi nhận.",
    data: r.data,
  });
}

// [fix 08/07/2026 đợt 6] Chuyển tên riêng sang DẠNG ĐỌC trong text mà AI phải
// đọc cho khách. Lý do: gpt-realtime-mini không áp dụng được quy tắc phát âm
// đặt trong system prompt (cuộc gọi DzIgZD3y AI vẫn nói "VNeID" nguyên dạng)
// — cách tin cậy duy nhất là viết sẵn dạng đọc vào text. Data gốc + các field
// cấu trúc (thuTuc, quy_dinh) vẫn giữ CHỮ CHUẨN cho log/summary sạch.
function toSpoken(text) {
  return text
    .replace(/ ?\(CCCD\)/g, "")                 // "Căn cước công dân (CCCD)" → bỏ ngoặc, tránh lặp
    .replace(/CCCD/g, "Căn cước công dân")
    .replace(/VNeID/g, "Vi-en-e-ai-đi")
    .replace(/CT07/g, "Xê-Tê-không-bảy")
    .replace(/CT08/g, "Xê-Tê-không-tám")
    .replace(/SAWACO CSKH/g, "Sa-qua-cô Xê-ét-ka-hát")
    .replace(/www\.capnuoctrungan\.vn/g, "vê kép vê kép vê kép chấm cấp nước trung an chấm vi-en")
    .replace(/873A Quang Trung/g, "Tám bảy ba A Quang Trung")
    .replace(/540 Hà Huy Giáp/g, "Năm trăm bốn mươi Hà Huy Giáp")
    .replace(/TP.HCM/g, "Thành Phố Hồ Chí Minh");
}

// [11/07/2026] gpt-realtime-mini đôi khi sinh SAI TÊN THAM SỐ tool: cuộc gọi
// E0UYAPzruSwXtEvyqt0sx gửi "loại_thu_tuc" (có dấu tiếng Việt) thay vì
// "loai_thu_tuc", kèm key rác → args.loai_thu_tuc = undefined → báo nhầm
// "ngoài phạm vi" dù khách hỏi đúng thủ tục hỗ trợ. Chuẩn hoá bằng CODE
// (deterministic, cùng triết lý normalizeDanhBo): bỏ dấu + so khớp key/value.
const stripDiacritics = (s) =>
  String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D");
// Chuẩn hoá value về dạng id: bỏ dấu, thường hoá, khoảng trắng/gạch → "_"
// (vd "lắp đặt đồng hồ" → "lap_dat_dong_ho").
const canonValue = (v) => stripDiacritics(v).toLowerCase().trim().replace(/[\s-]+/g, "_");

const DOI_TUONG_IDS = ["ho_gia_dinh", "doanh_nghiep"];

function normalizeProcedureArgs(args = {}) {
  let loai = PROCEDURES[args.loai_thu_tuc] ? args.loai_thu_tuc : undefined;
  let doiTuong = DOI_TUONG_IDS.includes(args.doi_tuong) ? args.doi_tuong : undefined;

  // 1) Key viết sai (có dấu/hoa thường) nhưng bỏ dấu thì khớp đúng tên tham số.
  if (!loai || !doiTuong) {
    for (const [k, v] of Object.entries(args)) {
      const key = canonValue(k);
      const val = canonValue(v);
      if (!loai && key === "loai_thu_tuc" && PROCEDURES[val]) loai = val;
      if (!doiTuong && key === "doi_tuong" && DOI_TUONG_IDS.includes(val)) doiTuong = val;
    }
  }
  // 2) Fallback: quét value — chỉ nhận khi có ĐÚNG MỘT id thủ tục (tránh đoán bừa).
  if (!loai) {
    const ids = [...new Set(
      Object.values(args).map(canonValue).filter((v) => PROCEDURES[v])
    )];
    if (ids.length === 1) loai = ids[0];
  }
  // 2b) [fix 18/07/2026] Cuộc E2u0Db8u91GWMPBYS9aj4: value là TÊN thủ tục đầy đủ
  // ("Sang tên đồng hồ nước" → canon "sang_ten_dong_ho_nuoc") — khớp exact trượt.
  // Nhận khi canon value CHỨA đúng MỘT id thủ tục (các id không chứa lẫn nhau).
  if (!loai) {
    const hits = [...new Set(
      Object.values(args)
        .map(canonValue)
        .flatMap((v) => Object.keys(PROCEDURES).filter((id) => v.includes(id)))
    )];
    if (hits.length === 1) loai = hits[0];
  }
  if (!doiTuong) {
    const dts = [...new Set(
      Object.values(args).map(canonValue).filter((v) => DOI_TUONG_IDS.includes(v))
    )];
    if (dts.length === 1) doiTuong = dts[0];
  }
  // 3) [13/07/2026] Model mã hoá dạng CỜ BOOLEAN — cuộc gọi E11HysUBZhNRGG2XKE6AD
  // gửi { lap_dat_dong_ho: true, sang_ten_dong_ho: false, ... } KHÔNG có
  // loai_thu_tuc → key chính là id, value truthy đánh dấu lựa chọn.
  const truthy = (v) => v === true || v === 1 || v === "true" || v === "1";
  if (!loai) {
    const flagged = [...new Set(
      Object.entries(args)
        .filter(([k, v]) => PROCEDURES[canonValue(k)] && truthy(v))
        .map(([k]) => canonValue(k))
    )];
    if (flagged.length === 1) loai = flagged[0];
  }
  if (!doiTuong) {
    const flagged = [...new Set(
      Object.entries(args)
        .filter(([k, v]) => DOI_TUONG_IDS.includes(canonValue(k)) && truthy(v))
        .map(([k]) => canonValue(k))
    )];
    if (flagged.length === 1) doiTuong = flagged[0];
  }
  // 3b) [fix 18/07/2026] Cuộc E2u0Db8u91GWMPBYS9aj4: model đệm cả 4 key thủ tục
  // bằng "N/A", key ĐƯỢC CHỌN mang value có nghĩa (tên thủ tục, "có", ...).
  // → key là id thủ tục + value KHÔNG phải marker rỗng = lựa chọn của model.
  // Chỉ nhận khi có ĐÚNG MỘT key như vậy (tránh đoán bừa).
  const NULL_MARKERS = new Set(["", "n/a", "na", "null", "none", "khong", "khong_co", "false", "0"]);
  const isNullish = (v) => v == null || v === false || v === 0 || NULL_MARKERS.has(canonValue(v));
  if (!loai) {
    const selected = [...new Set(
      Object.entries(args)
        .filter(([k, v]) => PROCEDURES[canonValue(k)] && !isNullish(v))
        .map(([k]) => canonValue(k))
    )];
    if (selected.length === 1) loai = selected[0];
  }
  if (!doiTuong) {
    const selected = [...new Set(
      Object.entries(args)
        .filter(([k, v]) => DOI_TUONG_IDS.includes(canonValue(k)) && !isNullish(v))
        .map(([k]) => canonValue(k))
    )];
    if (selected.length === 1) doiTuong = selected[0];
  }

  if (loai !== args.loai_thu_tuc || doiTuong !== args.doi_tuong) {
    console.warn("[get_procedure_info] Args chuẩn hoá lại:", JSON.stringify(args),
      "→", JSON.stringify({ loai_thu_tuc: loai, doi_tuong: doiTuong }));
  }
  return { loai_thu_tuc: loai, doi_tuong: doiTuong };
}

function handleGetProcedureInfo(rawArgs = {}, callState = {}) {
  console.log("==========[handleGetProcedureInfo]==================")
  const { loai_thu_tuc, doi_tuong } = normalizeProcedureArgs(rawArgs);
  const procedure = PROCEDURES[loai_thu_tuc];
  if (!procedure) {
    // [11/07/2026] Thủ tục ngoài phạm vi 4 thủ tục hỗ trợ → không tự hướng dẫn,
    // mời chuyển tổng đài viên hoặc tạo phiếu ghi nhận.
    return JSON.stringify({
      success: false,
      ngoai_pham_vi: true,
      doc_cho_khach:
        "Dạ, em không có thông tin về yêu cầu này! " +
        "Quý khách có muốn em chuyển máy sang tổng đài viên hỗ trợ trực tiếp, hoặc ghi nhận lại yêu cầu để nhân viên liên hệ lại sau không ạ?",
      message:
        "Loại thủ tục không thuộc 4 thủ tục hỗ trợ (dinh_muc_nuoc, lap_dat_dong_ho, " +
        "sang_ten_dong_ho, nang_doi_dong_ho). Nếu khách đang hỏi MỘT trong 4 thủ tục này " +
        "→ GỌI LẠI tool với đúng tham số loai_thu_tuc. Nếu là thủ tục khác → ngoài phạm vi: " +
        "KHÔNG tự hướng dẫn, mời khách chọn chuyển tổng đài viên (transfer_to_agent) " +
        "hoặc tạo phiếu ghi nhận (create_ticket) để nhân viên liên hệ lại sau.",
    });
  }

  // [08/07/2026] Thủ tục giới hạn đối tượng (vd định mức nước chỉ cho hộ gia
  // đình) → khách hỏi cho đối tượng khác thì báo rõ, không trả nhầm nội dung.
  if (procedure.apDung && doi_tuong && doi_tuong !== procedure.apDung) {
    return JSON.stringify({
      success: true,
      thuTuc: procedure.title,
      doc_cho_khach:
        `Dạ, thủ tục ${procedure.title} hiện chỉ áp dụng cho hộ gia đình, ` +
        `chưa áp dụng cho doanh nghiệp ạ. Quý Khách có muốn em chuyển máy sang tổng đài viên ` +
        `hỗ trợ trực tiếp, hoặc ghi nhận lại yêu cầu không ạ?`,
      message: `Thủ tục ${procedure.title} CHỈ áp dụng cho hộ gia đình, KHÔNG áp dụng cho doanh nghiệp hay công ty. Nếu khách là doanh nghiệp cần hỗ trợ khác, mời chuyển tổng đài viên hoặc tạo phiếu ghi nhận.`,

    });
  }

  // [12/07/2026] Thủ tục có hướng dẫn KHÁC NHAU theo đối tượng (lắp đặt, sang
  // tên): thiếu doi_tuong thì KHÔNG trả gộp cả hai trường hợp — cuộc gọi
  // E0VkaW1IIC4xom9HGSneG model nhận cả 2 case rồi tự tóm tắt làm rơi mất địa
  // chỉ văn phòng. Trả yêu cầu hỏi khách rồi gọi lại (deterministic).
  const coPhanBietDoiTuong = procedure.cases.some((c) => c.id === "doanh_nghiep");

  // [fix 18/07/2026] Cuộc E2u70cuT94h0rwpLAKOyA: model TỰ ĐOÁN doi_tuong ngay
  // lượt tool đầu tiên (khách chưa hề nói hộ gia đình hay doanh nghiệp) → nguy
  // cơ đọc nhầm hướng dẫn hộ gia đình cho doanh nghiệp (DN phải chuyển tổng đài
  // viên). Deterministic: với thủ tục có hướng dẫn khác nhau theo đối tượng,
  // doi_tuong CHỈ được chấp nhận SAU KHI tool đã yêu cầu hỏi khách
  // (can_hoi_doi_tuong) cho thủ tục đó trong CÙNG cuộc gọi — trước đó thì bỏ
  // qua giá trị model gửi và ép hỏi.
  const _daHoiDoiTuong = (callState.daHoiDoiTuong ??= new Set());
  const effDoiTuong = doi_tuong;
  if (coPhanBietDoiTuong && effDoiTuong && !_daHoiDoiTuong.has(loai_thu_tuc)) {
    // [fix 18/07/2026 v2] Cuộc E2uLXv4UbNfF0Do3JAccO: model TỰ HỎI đối tượng
    // bằng lời của nó rồi mới gọi tool → guard hỏi mở lần nữa làm khách phải
    // trả lời TRÙNG 2 lần. Code không phân biệt được "model đã hỏi thật" với
    // "model đoán bừa" → thay câu hỏi mở bằng câu XÁC NHẬN giá trị model gửi:
    // khách chỉ cần "đúng rồi" (nếu đã nói) hoặc sửa ngay (nếu model đoán sai).
    // Vẫn an toàn 100% vì đối tượng luôn qua lời khách xác nhận.
    _daHoiDoiTuong.add(loai_thu_tuc);
    const _dtLabel = effDoiTuong === "doanh_nghiep" ? "doanh nghiệp" : "hộ gia đình";
    console.warn(`[get_procedure_info] doi_tuong="${effDoiTuong}" chưa qua bước hỏi — trả câu xác nhận đối tượng`);
    return JSON.stringify({
      success: true,
      thuTuc: procedure.title,
      can_hoi_doi_tuong: true,
      xac_nhan_doi_tuong: effDoiTuong,
      message:
        `Cần khách XÁC NHẬN đối tượng trước khi hướng dẫn. ĐỌC câu trong doc_cho_khach rồi DỪNG, chờ khách trả lời. ` +
        `Khách xác nhận đúng → GỌI LẠI get_procedure_info với doi_tuong="${effDoiTuong}". ` +
        `Khách sửa lại → GỌI LẠI với doi_tuong khách nói. ` +
        `KHÔNG hướng dẫn giấy tờ khi chưa gọi lại tool.`,
      doc_cho_khach: `Dạ, em xin xác nhận lại: Quý Khách đăng ký cho ${_dtLabel}, phải không ạ?`,
    });
  }

  if (!effDoiTuong && coPhanBietDoiTuong) {
    _daHoiDoiTuong.add(loai_thu_tuc);
    return JSON.stringify({
      success: true,
      thuTuc: procedure.title,
      can_hoi_doi_tuong: true,
      message:
        `Thủ tục ${procedure.title} có hướng dẫn KHÁC NHAU cho hộ gia đình và doanh nghiệp. ` +
        `HỎI khách một câu ngắn: "Quý Khách đăng ký cho hộ gia đình hay doanh nghiệp ạ?" ` +
        `rồi GỌI LẠI get_procedure_info với doi_tuong tương ứng. KHÔNG tự đoán, ` +
        `KHÔNG hướng dẫn giấy tờ khi chưa gọi lại tool.`,
      doc_cho_khach: `Dạ, thủ tục ${procedure.title} có hướng dẫn khác nhau cho hộ gia đình và doanh nghiệp ạ. Quý Khách đăng ký cho hộ gia đình hay doanh nghiệp ạ?`,

    });
  }

  // Lọc case phù hợp đối tượng (nếu có)
  let relevantCases = procedure.cases;
  if (effDoiTuong) {
    const matched = procedure.cases.filter((c) => c.id.includes(effDoiTuong) || c.id === "default");
    if (matched.length > 0) relevantCases = matched;
  }
  console.log("2. relevantCases_after_matching", relevantCases);
  // [11/07/2026] Case đánh dấu transferToAgent (vd doanh nghiệp gắn/sang tên
  // đồng hồ) → không hướng dẫn giấy tờ, mời chuyển tổng đài viên hoặc tạo phiếu.
  if (relevantCases.length > 0 && relevantCases.every((c) => c.transferToAgent)) {
    return JSON.stringify({
      success: true,
      thuTuc: procedure.title,
      can_chuyen_tong_dai: true,
      message:
        `Thủ tục ${procedure.title} đối với doanh nghiệp/công ty do tổng đài viên hỗ trợ trực tiếp, ` +
        `trợ lý KHÔNG tự hướng dẫn giấy tờ. Mời khách chọn: chuyển tổng đài viên (transfer_to_agent), ` +
        `hoặc tạo phiếu ghi nhận (create_ticket) để nhân viên liên hệ lại sau.`,
      doc_cho_khach: `Dạ, thủ tục ${procedure.title} đối với doanh nghiệp/công ty do tổng đài viên hỗ trợ trực tiếp. Quý khách có muốn em chuyển máy sang tổng đài viên hỗ trợ trực tiếp, hoặc ghi nhận lại yêu cầu để nhân viên liên hệ lại sau không ạ?`,


    });
  }

  // Tổng hợp giấy tờ thành CÁC Ý ĐÁNH SỐ.
  // [fix 08/07/2026] Giữ ngữ nghĩa AND/OR của data: `required` = cần đầy đủ,
  // `options` = chỉ cần một trong, `optional` = bổ sung tùy trường hợp.
  // [fix 12/07/2026] Đánh số ý + chỉ thị "đọc đủ N ý" — cuộc gọi
  // E0Vu0A3D9QbGpHC9l3ng8 model mini tự tóm tắt chuỗi dài, làm rơi giấy tờ
  // bắt buộc (CCCD) và địa chỉ văn phòng dù prompt đã cấm.
  const spokenItems = [];
  const nhieuCase = relevantCases.length > 1;
  relevantCases.forEach((c) => {
    const prefix = nhieuCase ? `Trường hợp ${c.label} — ` : "";
    if (c.transferToAgent) {
      spokenItems.push(`${prefix}tổng đài viên hỗ trợ trực tiếp: mời chuyển tổng đài viên hoặc tạo phiếu ghi nhận`);
      return;
    }
    const docs = c.requiredDocs;
    let coY = false;
    if (docs.required?.length) {
      spokenItems.push(`${prefix}giấy tờ BẮT BUỘC: ${docs.required.join("; ")}`);
      coY = true;
    }
    if (docs.options?.length) {
      spokenItems.push(`${prefix}kèm CHỈ CẦN MỘT trong các giấy tờ sau: ${docs.options.join("; ")}`);
      coY = true;
    }
    if (docs.optional?.length) {
      spokenItems.push(`${prefix}giấy tờ bổ sung TÙY TRƯỜNG HỢP: ${docs.optional.join("; ")}`);
      coY = true;
    }
    if (!coY) spokenItems.push(`${prefix}${docs.note || "không có yêu cầu giấy tờ cụ thể"}`);
  });

  // [08/07/2026] Viết CHỮ CHUẨN (SAWACO CSKH, www.capnuoctrungan.vn) — cách
  // phát âm dạy trong SYSTEM_PROMPT (section "Cách đọc tên riêng"), không
  // nhúng phiên âm vào data để log/summary sạch.
  // [11/07/2026] Theo tài liệu mới, website chỉ là kênh của thủ tục nâng/dời
  // → procedure.channels (data) ghi đè kênh mặc định.
  const channels =
    procedure.channels ||
    "Nộp hồ sơ qua: app SAWACO CSKH, hoặc trực tiếp tại " +
    "văn phòng 873A Quang Trung, phường An Hội Tây, TP.HCM hoặc 540 Hà Huy Giáp, phường An Phú Đông, TP.HCM.";

  // Kênh nộp hồ sơ luôn là ý cuối — bắt buộc đọc (kèm đầy đủ 2 địa chỉ).
  spokenItems.push(channels);

  // [13/07/2026] Dùng "Thứ nhất/Thứ hai..." thay "Ý 1/Ý 2" — model đọc nguyên
  // văn nhãn đánh số cho khách (cuộc E1030jdrzgL8nTwnryZET nói "cần có 3 ý
  // quan trọng, Ý một..." nghe máy móc, khách rối). Số thứ tự chữ nghe tự nhiên.
  const THU_TU = ["Thứ nhất", "Thứ hai", "Thứ ba", "Thứ tư", "Thứ năm", "Thứ sáu", "Thứ bảy"];
  const bodyDanhSo = spokenItems
    .map((s, i) => `${THU_TU[i] || `Thứ ${i + 1}`}, ${s.replace(/\.\s*$/, "")}.`)
    .join(" ");

  // [13/07/2026 đợt 2] TÁCH chỉ thị khỏi nội dung đọc — cuộc gọi
  // E17jLdcYX5ACzRQ7IuGh0 model đọc NGUYÊN VĂN cả chỉ thị điều khiển lẫn đoạn
  // quy_dinh dài trong "message" cho khách nghe (khách: "nó bị khùng khùng ha").
  // → "doc_cho_khach" = nội dung sạch, đọc nguyên văn; "luu_y_cho_tro_ly" =
  // chỉ thị nội bộ, cấm đọc. quy_dinh KHÔNG nằm trong phần đọc mặc định —
  // chỉ dùng trả lời câu hỏi tiếp theo.
  // [13/07/2026 đợt 3] doc_cho_khach đặt TRƯỚC quy_dinh trong JSON + cảnh báo
  // ngay trong giá trị quy_dinh — cuộc E18GPiH9S0EO3dkWUSzUk model bị hút vào
  // field quy_dinh dài (đứng trước), trộn nó vào bài đọc và làm rơi phần địa chỉ.
  return JSON.stringify({
    success: true,
    thuTuc: procedure.title,
    so_phan_phai_doc: spokenItems.length,
    luu_y_cho_tro_ly:
      `Ghi chú nội bộ, TUYỆT ĐỐI KHÔNG đọc cho khách: "doc_cho_khach" là KỊCH BẢN — ` +
      `đọc NGUYÊN VĂN toàn bộ, TỪNG CÂU, ngay từ lượt trả lời ĐẦU TIÊN. ` +
      `CẤM tóm tắt, CẤM diễn đạt lại, CẤM rút gọn (đủ ${spokenItems.length} phần, không bỏ phần nào, ` +
      `không đổi địa chỉ, không nói "có ${spokenItems.length} phần"). ` +
      `KHÔNG trộn nội dung "quy_dinh" vào bài đọc.`,
    // doc_cho_khach dùng dạng đọc (toSpoken); quy_dinh/thuTuc giữ chữ chuẩn
    // để log/summary sạch.
    doc_cho_khach: toSpoken(`${procedure.purpose} ${bodyDanhSo}`),
    ...(procedure.quyDinh
      ? {
        quy_dinh:
          "(GHI CHÚ NỘI BỘ — KHÔNG đọc khi hướng dẫn giấy tờ; chỉ dùng khi khách " +
          "hỏi thêm về đối tượng hoặc số người được đăng ký) " + procedure.quyDinh,
      }
      : {}),
    // [13/07/2026] Giải thích thuật ngữ (CT07/CT08...) — khách hỏi "CT07 là gì"
    // thì đọc phần liên quan, không để model tự bịa.
    ...(procedure.thuatNgu
      ? {
        giai_thich_thuat_ngu: toSpoken(
          "(GHI CHÚ NỘI BỘ — KHÔNG đọc khi hướng dẫn giấy tờ; chỉ dùng khi khách " +
          "hỏi hoặc thắc mắc thuật ngữ, đọc NGẮN GỌN phần liên quan) " + procedure.thuatNgu
        ),
      }
      : {}),
  });
}

// ─── check_missing_docs ──────────────────────────────────────────────────────
// [13/07/2026] Đối chiếu giấy tờ khách ĐÃ CÓ bằng CODE. Cuộc gọi
// E11zOBRGO46YlRelgoR0x: rule prompt yêu cầu model tự đối chiếu nhưng mini trả
// lời SAI (nói giấy phép xây dựng đáp ứng "nhóm bắt buộc" và quên CCCD).

// Chuẩn hoá text để so khớp: bỏ dấu, thường hoá, bỏ ký tự lạ, gộp khoảng trắng.
const canonText = (v) =>
  stripDiacritics(v).toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

// Tên dân dã khách hay dùng → cụm đặc trưng trong tên giấy tờ chuẩn.
const DOC_ALIASES = [
  { keys: ["so hong", "so do", "giay to nha dat"], target: "giay chung nhan quyen" },
  { keys: ["hop dong mua ban"], target: "hop dong chuyen quyen so huu" },
];

function docMatches(customerRaw, docRaw) {
  const cus = canonText(customerRaw);
  const doc = canonText(docRaw);
  if (!cus || !doc) return false;
  if (doc.includes(cus)) return true;
  for (const a of DOC_ALIASES) {
    if (a.keys.some((k) => cus.includes(k)) && doc.includes(a.target)) return true;
  }
  // Khách nói dài dòng hơn tên giấy chuẩn: khớp khi có cụm 2 từ liên tiếp trùng.
  const words = cus.split(" ");
  for (let i = 0; i + 1 < words.length; i++) {
    const bigram = `${words[i]} ${words[i + 1]}`;
    if (bigram.length >= 7 && doc.includes(bigram)) return true;
  }
  return false;
}

function handleCheckMissingDocs(rawArgs = {}) {
  console.log("==========[handleCheckMissingDocs]==================");
  const { loai_thu_tuc, doi_tuong } = normalizeProcedureArgs(rawArgs);
  const procedure = PROCEDURES[loai_thu_tuc];
  if (!procedure) {
    return JSON.stringify({
      success: false,
      ngoai_pham_vi: true,
      message:
        "Loại thủ tục không thuộc 4 thủ tục hỗ trợ. Nếu khách hỏi 1 trong 4 thủ tục → gọi lại " +
        "với đúng loai_thu_tuc; nếu không → mời chuyển tổng đài viên (transfer_to_agent) " +
        "hoặc tạo phiếu (create_ticket).",
    });
  }
  const coPhanBietDoiTuong = procedure.cases.some((c) => c.id === "doanh_nghiep");
  if (!doi_tuong && coPhanBietDoiTuong) {
    return JSON.stringify({
      success: true,
      thuTuc: procedure.title,
      can_hoi_doi_tuong: true,
      message:
        `Cần biết đối tượng trước. HỎI khách: "Quý Khách đăng ký cho hộ gia đình hay ` +
        `doanh nghiệp ạ?" rồi gọi lại tool với doi_tuong tương ứng.`,
    });
  }
  let relevantCases = procedure.cases;
  if (doi_tuong) {
    const matched = procedure.cases.filter((c) => c.id.includes(doi_tuong) || c.id === "default");
    if (matched.length > 0) relevantCases = matched;
  }
  if (relevantCases.length > 0 && relevantCases.every((c) => c.transferToAgent)) {
    return JSON.stringify({
      success: true,
      thuTuc: procedure.title,
      can_chuyen_tong_dai: true,
      message:
        `Thủ tục ${procedure.title} cho doanh nghiệp/công ty do tổng đài viên hỗ trợ trực tiếp ` +
        `— mời khách chuyển tổng đài viên (transfer_to_agent) hoặc tạo phiếu (create_ticket).`,
    });
  }
  const cs = relevantCases.find((c) => !c.transferToAgent);
  const docsReq = cs?.requiredDocs || {};
  const required = docsReq.required || [];
  const options = docsReq.options || [];

  let daCo = rawArgs.giay_to_da_co;
  if (typeof daCo === "string") daCo = [daCo];
  if (!Array.isArray(daCo)) daCo = [];
  daCo = daCo.filter((x) => typeof x === "string" && x.trim());
  if (daCo.length === 0) {
    return JSON.stringify({
      success: false,
      message:
        "Thiếu danh sách giấy tờ khách đã có. Gọi lại tool với giay_to_da_co là mảng " +
        'các giấy tờ khách nói đã có (vd ["giấy phép xây dựng"]).',
    });
  }

  const matchedRequired = new Set();
  let optionHit = null;
  const unrecognized = [];
  for (const item of daCo) {
    let hit = false;
    for (const r of required) {
      if (docMatches(item, r)) { matchedRequired.add(r); hit = true; }
    }
    for (const o of options) {
      if (docMatches(item, o)) { if (!optionHit) optionHit = o; hit = true; }
    }
    if (!hit) unrecognized.push(item);
  }
  const missingRequired = required.filter((r) => !matchedRequired.has(r));
  const needOption = options.length > 0 && !optionHit;
  const hoSoDu = missingRequired.length === 0 && !needOption;

  const daDuParts = [];
  if (optionHit) daDuParts.push(`nhóm "chỉ cần một trong" ĐÃ ĐỦ (khách có: ${optionHit})`);
  if (matchedRequired.size) daDuParts.push(`giấy bắt buộc đã có: ${[...matchedRequired].join("; ")}`);
  const thieu = [];
  if (missingRequired.length) thieu.push(`giấy tờ BẮT BUỘC: ${missingRequired.join("; ")}`);
  if (needOption) thieu.push(`MỘT trong các giấy tờ sau: ${options.join("; ")}`);
  // Câu cho KHÁCH về giấy chưa nhận diện được (đọc được); chỉ thị nội bộ để ở luu_y.
  const canhBaoKhach = unrecognized.length
    ? ` Riêng "${unrecognized.join('", "')}" thì em chưa chắc chắn dùng thay được, ` +
    `Quý Khách có thể yêu cầu gặp tổng đài viên để xác nhận ạ.`
    : "";

  // [13/07/2026 đợt 2] Tách chỉ thị (luu_y_cho_tro_ly) khỏi nội dung đọc
  // (doc_cho_khach) — cuộc E17jLdcYX5ACzRQ7IuGh0 model đọc nguyên văn chỉ thị
  // nằm chung trong "message" cho khách nghe.
  return JSON.stringify({
    success: true,
    thuTuc: procedure.title,
    ho_so_du: hoSoDu,
    con_thieu: hoSoDu ? [] : thieu,
    luu_y_cho_tro_ly:
      `Ghi chú nội bộ, TUYỆT ĐỐI KHÔNG đọc cho khách: đã đối chiếu xong` +
      `${daDuParts.length ? ` (${daDuParts.join("; ")})` : ""}. ` +
      `Đọc NGUYÊN VĂN "doc_cho_khach", KHÔNG đọc lại giấy tờ khách đã có, ` +
      `KHÔNG đọc lại toàn bộ danh sách.`,
    doc_cho_khach: toSpoken(
      hoSoDu
        ? `Dạ, hồ sơ giấy tờ của Quý Khách như vậy là đã đủ cho thủ tục ` +
        `${procedure.title}, Quý Khách chỉ cần nộp hồ sơ thôi ạ.${canhBaoKhach}`
        : `Dạ, Quý Khách còn cần ${thieu.join(", và ")}.${canhBaoKhach}`
    ),
  });
}

// transfer_to_agent và end_call được xử lý ở session-ws.js vì cần gọi OpenAI REST API
// Handlers này chỉ trả về confirmation text cho AI đọc
//
// [fix 05/08/2026] Kiểm tra getAvailableAgents trước khi chuyển máy — nếu
// KHÔNG có tổng đài viên rảnh (`available_agents === 0`) thì hỏi khách có
// muốn để lại lời nhắn thay vì chuyển máy vào hàng chờ trống.
//
// `doc_cho_khach` (không phải chỉ `message`): session-ws.js có cơ chế ép đọc
// NGUYÊN VĂN mọi tool result có trường này (cùng cơ chế đã dùng cho
// get_procedure_info, các bước danh bộ...) — bắt buộc phải có để khách nghe
// ĐÚNG câu hỏi "có muốn để lại lời nhắn không", không bị model tự diễn giải
// hay (nghiêm trọng hơn) bị nhánh tool-thường ép thêm câu hỏi kết thúc cố định
// "Quý Khách có cần em hỗ trợ gì thêm không ạ?" đè lên trên (xem đợt 25-27
// trong docs/fix/fix_migrate_gpt_realtime_21_20260730.md — nhánh đó CHỈ áp
// dụng khi thiếu doc_cho_khach).
//
// Bọc try/catch quanh getAvailableAgents: `callApi` (api.js) đã tự có timeout
// nội bộ (TONGDAI_API_TIMEOUT_MS, mặc định 15000ms) và KHÔNG BAO GIỜ throw —
// luôn trả về {success:false, error_code,...} khi lỗi/timeout. Race với
// timeout NGẮN HƠN (bản cũ 3000ms) mà không có try/catch là nguy hiểm: nếu
// API chỉ hơi chậm (3-15s, vẫn trong giới hạn bình thường của chính nó),
// timeoutPromise reject TRƯỚC → exception văng lên dispatchTool's catch
// chung, trả "Đã xảy ra lỗi hệ thống. Vui lòng thử lại." KHÔNG có field
// "action" — khách hỏi chuyển máy nhưng không được mời chuyển máy hay để lại
// lời nhắn gì cả, chỉ nghe một câu lỗi chung chung. Coi timeout/lỗi như
// "không xác định được có ai rảnh" → an toàn hơn là mời để lại lời nhắn,
// không phải im re.
async function handleTransferToAgent({ ly_do }) {
  let availableAgents = null;
  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), 4500)
    );
    availableAgents = await Promise.race([getAvailableAgents(), timeoutPromise]);
    log.debug(`[tools][transfer_to_agent] availableAgents=`, availableAgents);
  } catch (e) {
    log.warn(`[tools][transfer_to_agent] Không lấy được trạng thái tổng đài viên (${e.message}) — coi như không có ai rảnh.`);
  }
  //  data: { available_agents: 0, queue: 'GroupDay5' }
  let { available_agents, queue } = availableAgents?.data || {};
  // available_agents = 1;
  if (available_agents > 0) {
    return JSON.stringify({
      success: true,
      action: "transfer_to_agent",
      doc_cho_khach: "Dạ, em xin phép chuyển máy cho tổng đài viên hỗ trợ Quý Khách ngay ạ.",
      message: "Đang chuyển máy cho tổng đài viên, Quý khách vui lòng chờ trong giây lát.",
      ly_do,
      available_agents,
      queue,
    });
  }
  return JSON.stringify({
    success: false,
    action: "leave_message",
    doc_cho_khach:
      "Dạ, hiện tại chưa có tổng đài viên nào rảnh để hỗ trợ ạ. Quý Khách có muốn " +
      "để lại lời nhắn để nhân viên liên hệ lại không ạ?",
    // [fix 05/08/2026] Cuộc rtc_u7_EA507YePMlSD2e1ixrC08: hướng dẫn CŨ bảo gọi
    // create_ticket — nhưng create_ticket LUÔN đòi mã danh bộ 11 số (qua
    // resolveDanhBo). Khách vừa được thông báo "không có tổng đài viên" thường
    // KHÔNG có mã danh bộ sẵn trong đầu (gọi chỉ để nhờ liên hệ lại, không phải
    // đang tra cứu hoá đơn) — bot bị kẹt lặp lại yêu cầu đọc số, khách không
    // hiểu vì sao, cúp máy. Đổi sang tool riêng `leave_callback_message` — không
    // qua resolveDanhBo, dùng SĐT người gọi (hệ thống tự biết, không cần hỏi).
    message:
      "Không có tổng đài viên khả dụng — đã hỏi khách có muốn để lại lời nhắn không. " +
      "Khách ĐỒNG Ý → hỏi lại nội dung cần nhắn, tóm tắt xác nhận đúng ý, CÓ THỂ hỏi " +
      "thêm mã danh bộ nếu khách có sẵn (KHÔNG bắt buộc, khách không có/không nhớ thì " +
      "bỏ qua, đừng ép đọc) rồi gọi leave_callback_message (KHÔNG dùng create_ticket " +
      "cho trường hợp này — hệ thống tự dùng SĐT cuộc gọi, không cần hỏi SĐT). " +
      "Khách TỪ CHỐI → hỏi khách còn cần hỗ trợ gì khác không, không tự gọi tool nào " +
      "khi khách chưa đồng ý.",
    ly_do,
  });
}

/**
 * [fix 05/08/2026, cập nhật 07/08/2026] Ghi nhận lời nhắn nhờ gọi lại khi
 * KHÔNG có tổng đài viên rảnh (action "leave_message" ở handleTransferToAgent).
 *
 * [cập nhật 07/08/2026 — theo yêu cầu chủ dự án] Xử lý GIỐNG create_ticket:
 * gọi `baoSuCo` lưu remote + `insertTicket` lưu local (session-ws.js). Khác
 * biệt duy nhất: mã danh bộ KHÔNG BẮT BUỘC — model có thể hỏi thêm nếu khách
 * có sẵn, nhưng KHÔNG được ép qua vòng thu thập/xác nhận nghiêm ngặt của
 * `resolveDanhBo` (cơ chế đó dành cho tra cứu tài khoản, sai một chữ số là
 * tra nhầm dữ liệu người khác — không phù hợp cho một trường tham khảo không
 * bắt buộc trên lời nhắn). Cuộc rtc_u7_EA507YePMlSD2e1ixrC08: khách gọi chỉ để
 * nhờ liên hệ lại, không có mã sẵn trong đầu, bot kẹt vòng lặp đòi đọc mã danh
 * bộ (qua resolveDanhBo), khách không hiểu, cúp máy — đây chính là lý do tách
 * tool riêng thay vì tái dùng create_ticket.
 *
 * `baoSuCo` (api.js) giờ nhận thêm SĐT làm tham số thứ 3 — không cần nhồi SĐT
 * vào nội dung như bản trước nữa.
 */
async function handleLeaveCallbackMessage({ noi_dung, ma_danh_bo }, callState = {}) {
  const phone = callState.callerPhone || null;
  // Chuẩn hoá NẾU khách có cung cấp, nhưng không ép — chuỗi rỗng/null đều hợp lệ.
  const maDanhBoChuan = ma_danh_bo ? normalizeDanhBo(ma_danh_bo) : "";
  const r = await baoSuCo(maDanhBoChuan || null, noi_dung || "", phone);
  if (!r.success) {
    return JSON.stringify({
      success: false,
      message: r.message ||
        "Không ghi nhận được lời nhắn. Xin lỗi khách, đề nghị khách gọi lại sau ít phút.",
    });
  }
  return JSON.stringify({
    success: true,
    doc_cho_khach:
      "Dạ, em đã ghi nhận lời nhắn của Quý Khách rồi ạ. Nhân viên sẽ liên hệ lại " +
      "Quý Khách sớm nhất có thể.",
    message: "Đã ghi nhận lời nhắn thành công.",
    ma_danh_bo: maDanhBoChuan || null,
    data: r.data,
  });
}

function handleEndCall({ ly_do } = {}) {
  return JSON.stringify({
    success: true,
    action: "end_call",
    message: "Kết thúc cuộc gọi.",
    ly_do: ly_do || "Khách hàng đã được hỗ trợ xong",
  });
}

// [migrate 30/07/2026] wait_for_user (pattern "wait_for_user" của OpenAI, xem
// docs/fix/fix_migrate_gpt_realtime_21_20260730.md) — action "no_reply" báo cho
// session-ws.js biết: KHÔNG tạo response.create tiếp theo sau function_call_output
// này (khác với mọi tool khác, vốn luôn được nối theo một response đọc kết quả).
function handleWaitForUser() {
  return JSON.stringify({
    success: true,
    action: "no_reply",
    message:
      "Âm thanh không cần trả lời (im lặng/tạp âm/không hướng tới Trợ lý). " +
      "KHÔNG nói gì thêm, không gọi tool khác cho lượt này.",
  });
}

// ─── Router ───────────────────────────────────────────────────────────────────

/**
 * Dispatch function call từ OpenAI đến handler phù hợp.
 * @param {string} name - Tên function
 * @param {object} args - Arguments đã parse từ JSON
 * @param {object} [callState] - State theo CUỘC GỌI (session-ws truyền vào,
 *   sống suốt cuộc gọi). Dùng cho các guard cần nhớ ngữ cảnh giữa các tool call
 *   (vd đã hỏi đối tượng của thủ tục nào — fix 18/07/2026).
 * @returns {Promise<string>} - JSON string kết quả (gửi lại cho OpenAI)
 */
export async function dispatchTool(name, args, callState = {}) {
  try {
    switch (name) {
      // [23/07/2026] confirm_danh_bo cũ GỠ khỏi TOOLS (model không còn tự quản
      // danh bộ; thu-xác nhận do CODE lo — resolveDanhBo + verifyDanhBoFromSession
      // + DTMF). [migrate 30/07/2026] confirm_danh_bo MỚI đăng ký lại bên dưới,
      // chỉ có hiệu lực làm đường chính khi DANH_BO_MODE=confirm_tool (session-ws.js
      // ép tool_choice gọi đúng tool này ở đúng thời điểm) — bản chất khác hẳn tool
      // cũ: KHÔNG tin arg model, chỉ đọc lại callState.danhBo đã được code xác minh.
      case "confirm_danh_bo": return handleConfirmDanhBo(callState);
      // [fix 05/08/2026] get_water_usage/get_payment_status đã GỘP vào get_bill
      // (xem chú thích ở handleGetBill) — không còn nằm trong TOOLS schema nên
      // model không thể tự gọi nữa, nhưng vẫn giữ alias ở đây để phòng thủ nếu có
      // tham chiếu cũ nào còn sót (context cũ, tool_choice ép cứng...).
      case "get_bill":
      case "get_water_usage":
      case "get_payment_status":
        return await handleGetBill(args, callState);
      case "compare_usage": return await handleCompareUsage(args, callState);
      case "get_outages": return await handleGetOutages(args, callState);
      case "create_ticket": return await handleCreateTicket(args, callState);
      case "get_procedure_info": return handleGetProcedureInfo(args, callState);
      case "check_missing_docs": return handleCheckMissingDocs(args);
      case "transfer_to_agent": return handleTransferToAgent(args);
      // [fix 05/08/2026] Ghi nhận lời nhắn khi không có tổng đài viên rảnh —
      // xem chú thích ở handleLeaveCallbackMessage. KHÔNG qua resolveDanhBo.
      case "leave_callback_message": return await handleLeaveCallbackMessage(args, callState);
      case "end_call": return handleEndCall(args);
      case "wait_for_user": return handleWaitForUser();
      default:
        return JSON.stringify({ success: false, message: `Tool "${name}" không được hỗ trợ.` });
    }
  } catch (err) {
    console.error(`[Tool] Lỗi khi xử lý "${name}":`, err.message);
    return JSON.stringify({ success: false, message: "Đã xảy ra lỗi hệ thống. Vui lòng thử lại." });
  }
}
