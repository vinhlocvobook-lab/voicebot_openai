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
  getThongTinKhachHang,
} from "./api.js";
import { arbitrateDanhBo } from "./danh-bo-arbiter.js";
import { PROCEDURES } from "./huongdanthutuc-data.js";

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
  mot: "1", hai: "2", ba: "3",
  bon: "4", tu: "4", nam: "5", lam: "5",
  sau: "6", bay: "7", tam: "8", chin: "9",
};

/**
 * Ghép chuỗi ĐỌC THÀNH CHỮ ("Hai - Hai - Không...") thành chữ số. CHỈ nhận khi
 * MỌI token đều là chữ số đọc bằng lời — có 1 token lạ (câu chữ thường) → trả ""
 * để không ghép nhầm số từ câu nói bình thường.
 */
function viDigitsFromWords(raw) {
  const tokens = _deAccent(raw).split(/[^a-z]+/).filter(Boolean);
  if (tokens.length === 0) return "";
  let out = "";
  for (const t of tokens) {
    if (!(t in _VI_DIGIT_WORDS)) return "";
    out += _VI_DIGIT_WORDS[t];
  }
  return out;
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
  console.log("==========[normalizeDanhBo]==================")
  console.log("raw:", raw);

  // Bảo vệ code nếu raw là null/undefined, sau đó xóa sạch ký tự không phải số
  let normalized = String(raw ?? "").replace(/\D/g, "");

  // Không có chữ số ASCII nào → thử ghép từ chữ số đọc bằng lời tiếng Việt.
  if (normalized.length === 0) {
    const fromWords = viDigitsFromWords(raw);
    if (fromWords) normalized = fromWords;
  }

  console.log("normalized:", normalized);
  return normalized;
}

const DANH_BO_LENGTH = 11;

/**
 * Kiểm tra độ dài mã danh bộ bằng CODE (deterministic) — không để model tự đếm bằng tai.
 * Trả về { ok, normalized, length, error } để handler chặn gọi API khi sai độ dài
 * và phản hồi cho model con số chính xác.
 */
function checkDanhBo(raw) {
  const normalized = normalizeDanhBo(raw);
  const length = normalized.length;
  if (length !== DANH_BO_LENGTH) {
    return {
      ok: false,
      normalized,
      length,
      error: JSON.stringify({
        success: false,
        invalid_danh_bo: true,
        do_dai_hien_tai: length,
        do_dai_yeu_cau: DANH_BO_LENGTH,
        message:
          `Mã danh bộ vừa nhận có ${length} chữ số, cần đúng ${DANH_BO_LENGTH} chữ số. ` +
          `KHÔNG tra cứu. Hãy báo Quý Khách số chữ số đang nhận được và nhờ đọc lại chậm, ` +
          `từng chữ số một, cho đủ ${DANH_BO_LENGTH} số. Không tự đoán hay tự thêm/bớt số.`,
      }),
    };
  }
  return { ok: true, normalized, length };
}

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

/**
 * Đóng gói kết quả bước lấy danh bộ + LƯU câu đang chờ khách trả lời vào
 * callState. [fix 18/07/2026 v5] Cuộc E2yXyLXpaZz66DmCfxQBi: prompt echo làm
 * code hủy response giữa chừng, để lại câu nói dở của bot trong context →
 * model tự bịa hội thoại, không gọi tool nữa, khách cúp máy.
 * session-ws.js dùng câu lưu ở đây để kéo cuộc gọi về đúng bước sau khi hủy.
 */
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
      `Đã nhiều lần không nhận được mã danh bộ. KHÔNG tra cứu. ` +
      `Đọc NGUYÊN VĂN "doc_cho_khach" rồi DỪNG chờ khách chọn. ` +
      `Khách chọn chuyển máy → gọi transfer_to_agent. ` +
      `Khách muốn nhân viên gọi lại → gọi create_ticket. ` +
      `Khách vẫn muốn đọc lại số → gọi lại hàm tra cứu với ma_danh_bo = dãy mới nghe được.`,
  });
}

function invalidDanhBoResponse(length, callState = {}) {
  if (length === 0) {
    return danhBoPayload(callState, {
      success: false,
      invalid_danh_bo: true,
      do_dai_hien_tai: 0,
      do_dai_yeu_cau: DANH_BO_LENGTH,
      doc_cho_khach:
        `Dạ, Quý Khách cho em xin mã danh bộ gồm ${DANH_BO_LENGTH} chữ số, ` +
        `đọc chậm từng chữ số giúp em ạ.`,
      message:
        `Chưa có mã danh bộ. Đọc NGUYÊN VĂN "doc_cho_khach" để xin mã danh bộ. ` +
        `Khách đọc xong → gọi lại hàm tra cứu (get_bill/…) với ma_danh_bo = dãy số nghe được; hệ thống tự ghép/xác nhận.`,
    });
  }

  callState.danhBoInvalidCount = (callState.danhBoInvalidCount || 0) + 1;
  return danhBoPayload(callState, {
    success: false,
    invalid_danh_bo: true,
    do_dai_hien_tai: length,
    do_dai_yeu_cau: DANH_BO_LENGTH,
    doc_cho_khach:
      `Dạ, em nghe được ${docSoLuong(length)} số, mà mã danh bộ cần đúng ` +
      `${docSoLuong(DANH_BO_LENGTH)} số ạ. Quý Khách đọc lại đầy đủ, ` +
      `chậm từng chữ số giúp em ạ.`,
    message:
      `Nghe chưa đủ ${DANH_BO_LENGTH} số. Đọc NGUYÊN VĂN "doc_cho_khach" rồi DỪNG chờ khách. ` +
      `Khách đọc lại → gọi lại hàm tra cứu với ma_danh_bo = dãy số nghe được; hệ thống tự ghép/xác nhận.`,
  });
}

function confirmRequestResponse(normalized, callState = {}) {
  return danhBoPayload(callState, {
    success: true,
    cho_khach_xac_nhan: true,
    ma_danh_bo: normalized,
    doc_cho_khach:
      `Dạ, em đọc lại mã danh bộ để Quý Khách kiểm tra: ${danhBoSpoken(normalized)}. ` +
      `Quý Khách xác nhận giúp em có đúng không ạ?`,
    message:
      `Đã ghi nhận đủ ${DANH_BO_LENGTH} chữ số. Đọc NGUYÊN VĂN "doc_cho_khach" rồi DỪNG chờ khách. ` +
      `Khách xác nhận ĐÚNG → gọi lại hàm tra cứu khách cần, KHÔNG cần đọc số ` +
      `(hệ thống tự dùng số đã xác nhận). Khách báo SAI hoặc đọc dãy khác → CHỜ, ` +
      `hệ thống tự xử lý ở lượt sau; đừng tự bịa số, đừng tự đọc lại.`,
  });
}

/**
 * [fix 23/07/2026] Danh bộ ĐÃ xác nhận nhưng model vẫn gọi confirm_danh_bo với
 * dãy rác (cuộc E4jpBWc...: khách đã "đúng đó", model re-transcribe ra 9 số sai
 * → hệ thống bắt đọc lại, khởi động lại vòng danh bộ, khách cúp máy). Nhắc model
 * dùng số đã xác nhận đi tra cứu, KHÔNG hỏi/đọc lại số.
 */
function danhBoAlreadyConfirmedResponse(callState) {
  return danhBoPayload(callState, {
    success: true,
    da_xac_nhan: true,
    ma_danh_bo: callState.danhBo?.value || null,
    message:
      `Mã danh bộ ĐÃ được Quý Khách xác nhận — KHÔNG hỏi lại, KHÔNG đọc lại số, ` +
      `KHÔNG gọi confirm_danh_bo nữa. Gọi NGAY tool tra cứu mà Quý Khách cần ` +
      `(get_bill / get_payment_status / get_water_usage / get_outages / create_ticket...), ` +
      `KHÔNG truyền ma_danh_bo — hệ thống tự dùng số đã xác nhận.`,
  });
}

/** Chốt dãy 11 số: lưu callState + reset bộ đếm. */
function acceptFullDanhBo(normalized, callState) {
  callState.danhBo = { value: normalized, confirmed: false };
  callState.danhBoInvalidCount = 0;
  // Khách tự đọc thẳng (không qua trọng tài) → KHÔNG cần gate xác nhận lời nói
  // thật (xem resolveDanhBo) — chỉ áp dụng cho danh bộ do trọng tài suy luận.
  callState._danhBoNeedsVerbalYes = false;
  return confirmRequestResponse(normalized, callState);
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
      knownDanhBo: callState.knownDanhBo || [],
      rejected: callState._danhBoRejected || [],
    });
  } catch (e) {
    console.warn(`[danh_bo][arbiter] Lỗi gọi trọng tài: ${e.message}`);
  }
  callState._logger?.addEvent?.(
    "danh_bo_arbiter",
    verdict ? JSON.stringify(verdict) : "arbiter_failed"
  );
  return verdict;
}

/**
 * Fire-and-forget: chạy trọng tài SONG SONG trong lúc bot đang đọc lại 11 số
 * cho khách (~8-10s) — khi khách trả lời "sai", ứng viên sửa đã có sẵn,
 * không ai phải chờ. Khách nói "đúng" → verdict bị bỏ, vô hại.
 */
function fireBackgroundArbiter(callState) {
  callState._danhBoBgVerdict = undefined; // undefined = đang chạy; null = fail
  callState._danhBoBgPromise = runDanhBoArbiter(callState)
    .then((v) => { callState._danhBoBgVerdict = v ?? null; return v; })
    .catch(() => { callState._danhBoBgVerdict = null; return null; });
}

/** Lấy verdict nền; nếu còn đang chạy thì chờ thêm tối đa extraWaitMs. */
async function awaitBackgroundVerdict(callState, extraWaitMs = 6000) {
  if (callState._danhBoBgVerdict !== undefined) return callState._danhBoBgVerdict;
  if (!callState._danhBoBgPromise) return null;
  return Promise.race([callState._danhBoBgPromise, _sleep(extraWaitMs).then(() => null)]);
}

/** API nghiệp vụ có biết danh bộ này không. Lỗi mạng/timeout ≠ số sai → coi như có. */
async function candidateExistsInApi(candidate, callState) {
  try {
    const r = await getThongTinKhachHang(candidate);
    const khongKetNoiDuoc = ["TIMEOUT", "CONNECTION_ERROR", "INVALID_RESPONSE"].includes(r?.error_code);
    const coKhach = r?.success && Array.isArray(r.data) && r.data.length > 0;
    if (khongKetNoiDuoc) return true;
    if (!coKhach) {
      console.warn(`[danh_bo][arbiter] "${candidate}" không có trong hệ thống.`);
      callState._logger?.addEvent?.("danh_bo_arbiter", `candidate ${candidate} không tồn tại trong hệ thống`);
    }
    return coKhach;
  } catch (e) {
    console.warn(`[danh_bo][arbiter] Xác thực lỗi (${e.message}) — vẫn cho khách xác nhận.`);
    return true;
  }
}

/**
 * Ứng viên trọng tài đạt chuẩn → lưu + trả câu đọc lại xác nhận. Không đạt → null.
 * Chuẩn: đủ 11 số, đủ tin cậy, CHƯA từng bị khách bác, tồn tại trong API,
 * và chưa quá 2 lần đề xuất (chống lặp vô hạn đoán-sai-đoán-lại).
 *
 * [fix 19/07/2026] do_tin_cay thiếu/sai kiểu → Number() ra NaN, mọi so sánh với
 * NaN đều false → viết theo hướng CHẤP NHẬN để dữ liệu rác tự rơi vào nhánh loại.
 */
async function tryProposeArbiterCandidate(verdict, callState) {
  const candidate = normalizeDanhBo(verdict?.ma_danh_bo);
  const conf = Number(verdict?.do_tin_cay);
  const duTinCay = Number.isFinite(conf) && conf >= ARBITER_MIN_CONFIDENCE;
  if (candidate.length !== DANH_BO_LENGTH || !duTinCay) {
    console.warn(`[danh_bo][arbiter] Không đủ tin cậy (candidate="${candidate}", conf=${conf}).`);
    return null;
  }
  if ((callState._danhBoRejected || []).includes(candidate)) return null;
  if ((callState._danhBoProposeCount || 0) >= 2) return null;
  if (!(await candidateExistsInApi(candidate, callState))) return null;

  callState._danhBoProposeCount = (callState._danhBoProposeCount || 0) + 1;
  console.log(`[danh_bo][arbiter] Ứng viên "${candidate}" (conf=${conf}) → đọc lại xác nhận.`);
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
  // [fix 25/07/2026] Gọi trọng tài ON-DEMAND (thay awaitBackgroundVerdict — nền đã tắt).
  const verdict = await runDanhBoArbiter(callState);
  const candidate = normalizeDanhBo(verdict?.ma_danh_bo);
  if (candidate.length !== DANH_BO_LENGTH || candidate === current) return null;
  callState._logger?.addEvent?.(
    "danh_bo_self_correct",
    `NOT_FOUND "${current}" → thử ứng viên "${candidate}"`
  );
  console.log(`[danh_bo][self-correct] NOT_FOUND "${current}" → đọc lại ứng viên "${candidate}".`);
  // tryProposeArbiterCandidate tự xác thực API + set gate xác nhận lời nói.
  return tryProposeArbiterCandidate(verdict, callState);
}

/** Ghi nhận dãy đã bị khách bác bỏ (để trọng tài né và không đề xuất lại). */
function rejectStoredDanhBo(callState) {
  const stored = callState.danhBo?.value;
  if (!stored) return;
  (callState._danhBoRejected ??= []);
  if (!callState._danhBoRejected.includes(stored)) callState._danhBoRejected.push(stored);
  callState.danhBo = null;
  // [fix 25/07/2026] Xóa cache on-demand để lượt resolveDanhBo kế chạy lại trọng
  // tài (không trả lại câu đọc-lại số vừa bị bác).
  callState._danhBoLastResolveSig = null;
  callState._danhBoLastResolveResp = null;
}

/** Khách báo sai, chưa có ứng viên thay thế → mời đọc lại toàn bộ. */
function reReadRequestResponse(callState) {
  return danhBoPayload(callState, {
    success: false,
    doc_lai: true,
    doc_cho_khach:
      `Dạ, em xin lỗi ạ. Quý Khách đọc lại giúp em toàn bộ ${docSoLuong(DANH_BO_LENGTH)} ` +
      `chữ số mã danh bộ, chậm từng chữ số một ạ.`,
    message:
      `Số vừa đọc lại khách báo SAI. Đọc NGUYÊN VĂN "doc_cho_khach" rồi DỪNG chờ khách. ` +
      `Khách đọc lại → gọi lại hàm tra cứu với ma_danh_bo = dãy số nghe được; hệ thống tự ghép/xác nhận.`,
  });
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
    message:
      `Đã hết lượt đọc bằng giọng nói — chuyển sang BẤM PHÍM. Đọc NGUYÊN VĂN "doc_cho_khach" ` +
      `rồi DỪNG chờ. Hệ thống TỰ ĐỘNG ghi nhận phím bấm — TUYỆT ĐỐI không tự đọc/đoán số từ ` +
      `tiếng bấm phím. Khách muốn chuyển máy → transfer_to_agent. Khách muốn nhân viên gọi lại → create_ticket.`,
  });
}

/**
 * [fix 23/07/2026] Lấy dãy 11 số từ LƯỢT transcript ĐƠN gần nhất (model phiên âm
 * riêng — theo CLAUDE.md đáng tin hơn "tai" model thoại). Chỉ nhận khi một lượt
 * đơn ra ĐÚNG 11 số; lượt đọc tách hơi (mỗi lượt <11 số) → để trọng tài ghép.
 */
function latestTranscriptDanhBo(callState = {}) {
  const arr = callState._danhBoTranscripts || [];
  console.log("[latestTranscriptDanhBo]: callState._danhBoTranscripts", arr);
  for (let i = arr.length - 1; i >= 0; i--) {
    const d = normalizeDanhBo(arr[i]?.text);
    if (d.length === DANH_BO_LENGTH) return d;
  }
  return "";
}

// [fix 19/07/2026 v2] Luồng: đọc liền 11 số, tối đa DANH_BO_MAX_READS (3) lượt
// giọng nói, co-pilot gpt-5.1 hỗ trợ ngầm từ lượt 1; hết lượt → mời bấm DTMF.
async function handleConfirmDanhBo({ day_so } = {}, callState = {}) {

  console.log("==========[handleConfirmDanhBo]==================")
  console.log("day_so:", day_so);
  console.log("callState:", callState);

  // [fix 23/07/2026] Model mini chép mã danh bộ qua "tai" rất hay SAI (đảo/rơi
  // số: cuộc E4k6V nghe "12023251757", E4k8t nghe "3213251775" trong khi khách
  // đọc đúng 22023251775). Nếu LƯỢT transcript đơn gần nhất ra đúng 11 số → dùng
  // nó thay day_so model. Giữ lại bản model nghe cho trọng tài đối chiếu.
  const modelHeard = normalizeDanhBo(day_so);
  const txDanhBo = latestTranscriptDanhBo(callState);
  const normalized = (txDanhBo && txDanhBo !== modelHeard) ? txDanhBo : modelHeard;
  if (normalized !== modelHeard) {
    console.warn(`[danh_bo] Ưu tiên transcript "${normalized}" thay cho day_so model "${modelHeard}".`);
  }
  const stored = callState.danhBo?.value || null;
  const storedConfirmed = !!callState.danhBo?.confirmed;
  const saidNo = !!callState._danhBoCustomerSaidNo;
  callState._danhBoCustomerSaidNo = false;

  // ── Danh bộ ĐÃ XÁC NHẬN mà model vẫn gọi confirm_danh_bo ───────────────────
  // [fix 23/07/2026] Chỉ dãy 11 số MỚI khác hẳn mới coi là khách ĐỔI danh bộ
  // (rơi xuống nhánh chuẩn bên dưới → acceptFullDanhBo, xác nhận lại). Còn lại
  // (rỗng / trùng số cũ / sai độ dài do model tự re-transcribe) → KHÔNG khởi động
  // lại vòng danh bộ, giữ nguyên số đã chốt, nhắc model đi tra cứu.
  if (storedConfirmed && stored &&
    !(normalized.length === DANH_BO_LENGTH && normalized !== stored)) {
    return danhBoAlreadyConfirmedResponse(callState);
  }

  // ── Model ECHO đúng số ĐANG CHỜ xác nhận (khách CHƯA phủ định) ─────────────
  // [fix 23/07/2026] Co-pilot vừa đọc lại số cho khách; model mini thường tự gọi
  // confirm_danh_bo lặp lại chính số đó (bằng chữ số hoặc bản đọc thành chữ).
  // Đây KHÔNG phải khách báo sai → giữ nguyên trạng thái chờ (kể cả gate
  // _danhBoNeedsVerbalYes của trọng tài), không reset cờ/bộ đếm, không ghi nhiễu
  // vào reads. Trả lại đúng câu đang chờ để model khỏi bịa câu khác.
  if (stored && !storedConfirmed && !saidNo && normalized === stored) {
    return confirmRequestResponse(stored, callState);
  }

  // ── Khách BÁO SAI số đã đọc lại mà KHÔNG kèm dãy mới ──────────────────────
  // (model gọi với day_so rỗng, hoặc lặp lại đúng số cũ sau lượt khách phủ định)
  // [fix 23/07/2026] BẮT BUỘC có cờ saidNo (khách phủ định thật trong transcript)
  // — day_so rỗng do normalize xoá bản đọc-thành-chữ KHÔNG được tính là báo sai.
  const laBaoSai = stored && !storedConfirmed && saidNo &&
    (normalized.length === 0 || normalized === stored);
  if (laBaoSai) {
    rejectStoredDanhBo(callState);
    // Co-pilot nền đã phân tích từ lúc bot đọc lại số → dùng ngay nếu đạt chuẩn.
    const verdict = await awaitBackgroundVerdict(callState);
    const resp = await tryProposeArbiterCandidate(verdict, callState);
    if (resp) return resp;
    if ((callState._danhBoReads?.length || 0) >= DANH_BO_MAX_READS) {
      return danhBoDtmfInviteResponse(callState);
    }
    return reReadRequestResponse(callState);
  }

  if (normalized.length === 0) return invalidDanhBoResponse(0, callState);

  // Lưu quan sát của model cho trọng tài (kể cả dãy sai độ dài).
  const reads = (callState._danhBoReads ??= []);
  if (modelHeard) reads.push(modelHeard);
  // Khách đọc dãy MỚI thay cho số cũ chưa xác nhận → số cũ coi như bị bác.
  // [fix 23/07/2026] KHÔNG bác dựa trên "tai" model: model mini hay chép sai/thiếu
  // số trong lúc khách đọc LẠI chính số đang chờ (cuộc E4k8t: nghe 10 số
  // "3213251775" trong khi khách đọc đúng 22023251775 → suýt bác số đúng, deadlock).
  //  - Ứng viên TRỌNG TÀI (đối chiếu transcript) chỉ bị bác khi KHÁCH báo sai (saidNo).
  //  - Chỉ bác khi nghe RÕ dãy ĐỦ 11 số MỚI khác hẳn (khách chủ động đổi danh bộ).
  const uVienTrongTai = !!callState._danhBoNeedsVerbalYes;
  if (stored && !storedConfirmed && !uVienTrongTai &&
    normalized.length === DANH_BO_LENGTH && normalized !== stored) {
    rejectStoredDanhBo(callState);
  }

  // ── Đủ 11 số ──────────────────────────────────────────────────────────────
  // [fix 19/07/2026 v3] LUÔN đọc lại NGAY bản realtime (không bao giờ chặn chờ
  // trọng tài — gpt-5.1 reasoning có thể >12s), co-pilot LUÔN chạy nền. Số được
  // sửa khi: khách báo sai (dùng verdict nền) hoặc tra cứu NOT_FOUND (tự sửa).
  if (normalized.length === DANH_BO_LENGTH) {
    const out = acceptFullDanhBo(normalized, callState);
    fireBackgroundArbiter(callState);
    return out;
  }

  // ── Sai độ dài ────────────────────────────────────────────────────────────
  // Đã mời bấm phím rồi mà vẫn quay lại đọc sai tiếp → không lặp, escalation.
  if (callState._danhBoDtmfInvited) {
    callState.danhBoInvalidCount = (callState.danhBoInvalidCount || 0) + 1;
    return danhBoEscalationResponse(callState);
  }
  if (reads.length < DANH_BO_MAX_READS) {
    // Từ lượt 2: thử trọng tài cứu (ghép các mảnh) trước khi bắt khách đọc lại.
    if (reads.length >= 2) {
      const verdict = await runDanhBoArbiter(callState);
      const resp = await tryProposeArbiterCandidate(verdict, callState);
      if (resp) return resp;
    }
    return invalidDanhBoResponse(normalized.length, callState);
  }
  // Hết lượt đọc → trọng tài lần cuối; vẫn không được → mời bấm phím.
  callState.danhBoInvalidCount = (callState.danhBoInvalidCount || 0) + 1;
  const verdict = await runDanhBoArbiter(callState);
  const resp = await tryProposeArbiterCandidate(verdict, callState);
  if (resp) return resp;
  return danhBoDtmfInviteResponse(callState);
}

// ─── [fix 19/07/2026 v3] Co-pilot TỰ GOM số từ transcript (không chờ model) ───
// Model mini không gom được số khách đọc qua NHIỀU HƠI (semantic VAD tạo response
// mỗi hơi → model đáp "chưa đủ" ngay, không kịp tích lũy, thậm chí KHÔNG gọi
// confirm_danh_bo). session-ws.js gọi hàm này sau khi khách NGƯNG đọc số một
// nhịp: gpt-5.1 ghép mọi transcript hơi đọc thành 11 số, code đọc lại xác nhận.

/**
 * Chạy trọng tài trên MỌI quan sát hiện có; nếu ra ứng viên 11 số đủ tin cậy +
 * hợp lệ → lưu callState + trả CÂU đọc lại xác nhận (chuỗi doc_cho_khach) cho
 * session-ws đọc. Không đủ tin cậy → null (im lặng, không làm phiền khách).
 * Chỉ chạy khi CHƯA có danh bộ đang chờ/đã xác nhận (không chen ngang model/DTMF).
 */
export async function proactiveAssembleDanhBo(callState = {}) {
  if (callState.danhBo) return null; // đã có ứng viên (model/DTMF/trọng tài) → không chen
  if (callState._danhBoDtmfInvited) return null; // đã mời bấm phím → chờ khách bấm, thôi gom giọng nói
  callState._danhBoAssembleTries = (callState._danhBoAssembleTries || 0) + 1;
  const verdict = await runDanhBoArbiter(callState, { waitTranscriptMs: 0 });
  const resp = await tryProposeArbiterCandidate(verdict, callState);
  if (resp) {
    try { return JSON.parse(resp).doc_cho_khach || null; } catch { return null; }
  }
  // Đã gom nhiều nhịp mà gpt-5.1 vẫn không ghép nổi 11 số tin cậy → mời BẤM PHÍM
  // (đọc trực tiếp, không phụ thuộc model có gọi tool hay không).
  if (callState._danhBoAssembleTries >= 3 && !callState._danhBoDtmfInvited) {
    try { return JSON.parse(danhBoDtmfInviteResponse(callState)).doc_cho_khach || null; } catch { return null; }
  }
  return null;
}

/** session-ws gọi khi khách PHỦ ĐỊNH số đang chờ xác nhận: đẩy vào rejected +
 *  xoá để co-pilot / model được đề xuất dãy khác. */
export function noteDanhBoRejected(callState = {}) {
  rejectStoredDanhBo(callState);
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
// tài do proactiveAssembleDanhBo (session-ws) lo; hết lượt → DTMF → chuyển máy.
async function resolveDanhBo(rawArg, callState = {}) {
  const stored = callState.danhBo;
  const txDanhBo = latestTranscriptDanhBo(callState); // lượt transcript đơn = 11 số

  // ── Đã có số ĐÃ XÁC NHẬN ──────────────────────────────────────────────────
  if (stored?.value && stored.confirmed) {
    // Khách đọc MỘT dãy 11 số MỚI khác hẳn → đổi danh bộ → xác nhận lại số mới.
    if (txDanhBo && txDanhBo !== stored.value) {
      console.warn(`[danh_bo] Khách đọc danh bộ MỚI "${txDanhBo}" khác số đã xác nhận "${stored.value}" → xác nhận lại.`);
      callState.danhBo = { value: txDanhBo, confirmed: false };
      callState._danhBoNeedsVerbalYes = false;
      return { ok: false, error: confirmRequestResponse(txDanhBo, callState) };
    }
    callState._danhBoLastPrompt = null; // đã chốt — tắt cơ chế re-assert
    return { ok: true, value: stored.value };
  }

  // ── Có ứng viên đang CHỜ xác nhận (chưa confirmed) ────────────────────────
  // KHÔNG cho tra cứu tới khi khách xác nhận lời nói. Arg model (hay sai) KHÔNG
  // được thay/bác ứng viên đang chờ — giữ nguyên, đọc lại xác nhận.
  if (stored?.value) {
    return { ok: false, error: confirmRequestResponse(stored.value, callState) };
  }

  // ── Chưa có số ────────────────────────────────────────────────────────────
  // Danh bộ do HỆ THỐNG cấp (lookup theo SĐT) → tin ngay, không ép xác nhận.
  const argModel = normalizeDanhBo(rawArg);
  if (argModel.length === DANH_BO_LENGTH &&
    Array.isArray(callState.knownDanhBo) && callState.knownDanhBo.includes(argModel)) {
    callState.danhBo = { value: argModel, confirmed: true };
    return { ok: true, value: argModel };
  }

  // Chưa nghe khách đọc số nào → xin số ngay (chưa cần chờ).
  if ((callState._danhBoTranscripts || []).length === 0 && !argModel) {
    return { ok: false, error: invalidDanhBoResponse(0, callState) };
  }

  // Tổng số chữ số đang có: max(arg model, ghép mọi lượt transcript).
  const digitsAvailable = () => {
    const txConcat = (callState._danhBoTranscripts || []).map((t) => normalizeDanhBo(t.text)).join("");
    return Math.max(txConcat.length, normalizeDanhBo(rawArg).length);
  };

  // Leo thang khi CHƯA đủ số: mời đọc lại (còn lượt) → DTMF → chuyển máy/tạo phiếu.
  const notEnough = (heardLen) => {
    callState._danhBoResolveTries = (callState._danhBoResolveTries || 0) + 1;
    let rr;
    if (callState._danhBoDtmfInvited) rr = danhBoEscalationResponse(callState);
    else if (callState._danhBoResolveTries >= DANH_BO_MAX_READS) rr = danhBoDtmfInviteResponse(callState);
    else rr = invalidDanhBoResponse(heardLen, callState);
    callState._danhBoLastResolveResp = rr;
    return { ok: false, error: rr };
  };

  // Cache chống gọi trùng khi model gọi tool nhiều lần trên CÙNG trạng thái vào.
  const entrySig = `${(callState._danhBoTranscripts || []).length}|${argModel}`;
  if (callState._danhBoLastResolveSig === entrySig && callState._danhBoLastResolveResp) {
    return { ok: false, error: callState._danhBoLastResolveResp };
  }

  // ── CHỜ đủ 11 số rồi mới chạy trọng tài / phát lời ────────────────────────
  // [fix 25/07/2026] Nếu CẢ arg model LẪN transcript đều < 11 số (đếm thô) → KHOAN
  // phát lời, chờ khách đọc tiếp (khách hay đọc tách nhiều hơi). Poll tối đa
  // DANH_BO_WAIT_MS; đủ 11 số thì chạy trọng tài NGAY. Hết giờ vẫn thiếu thì VẪN
  // chạy trọng tài lần chót (bên dưới), chỉ mời đọc lại khi trọng tài cũng thiếu.
  const DANH_BO_WAIT_MS = Number(process.env.DANH_BO_WAIT_MS || 15000);
  const DANH_BO_POLL_MS = 700;
  let waited = 0;
  while (digitsAvailable() < DANH_BO_LENGTH && waited < DANH_BO_WAIT_MS) {
    await _sleep(DANH_BO_POLL_MS);
    waited += DANH_BO_POLL_MS;
  }
  if (digitsAvailable() < DANH_BO_LENGTH) {
    // [fix 25/07/2026] Hết giờ chờ mà ĐẾM THÔ vẫn thiếu → VẪN thử trọng tài lần
    // chót: gpt-5.1 có thể ghép / đọc chữ số tiếng Việt mà đếm thô bỏ sót
    // ("hai mươi hai" = 22, "lăm" = 5...). Chỉ khi trọng tài CŨNG không ra đủ 11
    // số mới phát lời mời khách cung cấp lại số (nhánh cuối).
    console.log(`[danh_bo] Chờ ${waited}ms, đếm thô mới ${digitsAvailable()} số → vẫn thử trọng tài lần chót.`);
  }

  // ── GỌI TRỌNG TÀI gpt-5.1 ON-DEMAND (dù đủ số hay đã hết giờ chờ) ─────────
  callState._danhBoLastResolveSig = `${(callState._danhBoTranscripts || []).length}|${argModel}`;
  const verdict = await runDanhBoArbiter(callState, { waitTranscriptMs: 0 });
  // tryProposeArbiterCandidate CHỈ chốt khi ứng viên ĐỦ 11 số + đủ tin cậy + tồn tại API.
  const resp = await tryProposeArbiterCandidate(verdict, callState);
  if (resp) {
    callState._danhBoLastResolveResp = resp;
    return { ok: false, error: resp };
  }

  // Trọng tài KHÔNG ra đủ 11 số tin cậy → transcript đơn = 11 số (chưa bị bác) đọc lại.
  const txNow = latestTranscriptDanhBo(callState);
  if (txNow && !(callState._danhBoRejected || []).includes(txNow)) {
    callState.danhBo = { value: txNow, confirmed: false };
    callState._danhBoNeedsVerbalYes = false;
    const r = confirmRequestResponse(txNow, callState);
    callState._danhBoLastResolveResp = r;
    return { ok: false, error: r };
  }

  // Cả trọng tài lẫn transcript đều chưa đủ 11 số → mời khách cung cấp lại số.
  return notEnough(digitsAvailable() >= DANH_BO_LENGTH ? 0 : digitsAvailable());
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
 * Fetch chung cho nhóm tra cứu hóa đơn: gọi trang-thai-thanh-toan (superset:
 * TongTien + SanLuong + TrangThaiThanhToan) — 1 lần gọi đủ dữ liệu cho
 * get_bill / get_water_usage / get_payment_status, khách hỏi tiếp không cần gọi API lần 2.
 *
 * Backend KHÔNG tự lấy "kỳ gần nhất" khi thiếu ky/nam (mặc định kỳ hiện tại →
 * thường chưa có dữ liệu đầu tháng). Nên: không truyền ky/nam mà bị *_NOT_FOUND
 * → tự lùi 1 kỳ và gọi lại (fallback deterministic, không để model tự đoán kỳ).
 *
 * Trả về { ok, rows?, error? } — error là JSON string sẵn cho AI, giữ error_code
 * để model phân biệt CUSTOMER_NOT_FOUND (đọc lại danh bộ) vs INVOICE/PRODUCTION_NOT_FOUND (kỳ chưa có).
 */
async function fetchBilling(ma_danh_bo, ky, nam, callState) {
  console.log("[fetchBilling] ma_danh_bo", ma_danh_bo);
  console.log("[fetchBilling] ky", ky);
  console.log("[fetchBilling] nam", nam);
  console.log("[fetchBilling] callState._danhBoTranscripts : ", callState._danhBoTranscripts);
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
  // ma_danh_bo: rs.value,
  return { ok: true, rows: Array.isArray(r.data) ? r.data : [] };
}

// ─── Handlers ────────────────────────────────────────────────────────────────

async function handleGetBill({ ma_danh_bo, ky, nam }, callState) {
  const f = await fetchBilling(ma_danh_bo, ky, nam, callState);
  if (!f.ok) return f.error;
  // const parts = f.rows.map((d) => {
  //   const tt = d.TrangThaiThanhToan === "Đã thanh toán"
  //     ? `, đã thanh toán ngày ${fmtNgay(d.NgayThanhToan)}`
  //     : `, chưa thanh toán`;
  //   return `Kỳ ${d.Ky}/${d.Nam}: tổng tiền ${docTienVN(d.TongTien)}${tt}`;
  // });
  console.log("[handleGetBill] f", f);
  const parts = f.rows.map((d) => {
    const tt = d.TrangThaiThanhToan === "Đã thanh toán"
      ? `, đã thanh toán ngày ${fmtNgay(d.NgayThanhToan)}`
      : `, chưa thanh toán`;
    return `Mã danh bộ ${f.ma_danh_bo}, Kỳ ${d.Ky}/${d.Nam}: tổng tiền ${docTienVN(d.TongTien)}${tt}`;
  });
  return JSON.stringify({
    success: true,
    message: parts.length ? parts.join("; ") + "." : "Không có dữ liệu hóa đơn.",
    data: f.rows.map(simplifyRow),
  });
}

async function handleGetWaterUsage({ ma_danh_bo, ky, nam }, callState) {
  const f = await fetchBilling(ma_danh_bo, ky, nam, callState);
  if (!f.ok) return f.error;
  const parts = f.rows.map(
    (d) => `Mã danh bộ ${f.ma_danh_bo}, Kỳ ${d.Ky}/${d.Nam}: ${d.SanLuong} m³, thành tiền ${docTienVN(d.TongTien)}`
  );
  return JSON.stringify({
    success: true,
    message: parts.length ? parts.join("; ") + "." : "Không có dữ liệu sản lượng.",
    data: f.rows.map(simplifyRow),
  });
}

async function handleGetPaymentStatus({ ma_danh_bo, ky, nam }, callState) {
  const f = await fetchBilling(ma_danh_bo, ky, nam, callState);
  if (!f.ok) return f.error;
  // KHÔNG đọc DonViThanhToan cho khách (mã nội bộ như "GDGV", chưa có bảng map).
  const parts = f.rows.map((d) => {
    if (d.TrangThaiThanhToan === "Đã thanh toán") {
      return `Mã danh bộ ${f.ma_danh_bo}, Kỳ ${d.Ky}/${d.Nam}: đã thanh toán ngày ${fmtNgay(d.NgayThanhToan)}, số tiền ${docTienVN(d.TongTien)}`;
    }
    return `Mã danh bộ ${f.ma_danh_bo}, Kỳ ${d.Ky}/${d.Nam}: chưa thanh toán, số tiền ${docTienVN(d.TongTien)}`;
  });
  return JSON.stringify({
    success: true,
    message: parts.length ? parts.join("; ") + "." : "Không có dữ liệu thanh toán.",
    data: f.rows.map(simplifyRow),
  });
}

async function handleCompareUsage({ ma_danh_bo, ky, nam }, callState) {
  const rs = await resolveDanhBo(ma_danh_bo, callState);
  if (!rs.ok) return rs.error;
  const r = await getSoSanhTangGiam(rs.value, ky, nam);
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
  const r = await baoSuCo(rs.value, noiDung);
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
function handleTransferToAgent({ ly_do }) {
  return JSON.stringify({
    success: true,
    action: "transfer_to_agent",
    message: "Đang chuyển máy cho tổng đài viên, Quý khách vui lòng chờ trong giây lát.",
    ly_do,
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
      // [23/07/2026] confirm_danh_bo GỠ khỏi TOOLS — model không còn tự quản danh
      // bộ; thu-xác nhận do CODE lo (resolveDanhBo + proactiveAssembleDanhBo + DTMF).
      case "get_bill": return await handleGetBill(args, callState);
      case "get_water_usage": return await handleGetWaterUsage(args, callState);
      case "get_payment_status": return await handleGetPaymentStatus(args, callState);
      case "compare_usage": return await handleCompareUsage(args, callState);
      case "get_outages": return await handleGetOutages(args, callState);
      case "create_ticket": return await handleCreateTicket(args, callState);
      case "get_procedure_info": return handleGetProcedureInfo(args, callState);
      case "check_missing_docs": return handleCheckMissingDocs(args);
      case "transfer_to_agent": return handleTransferToAgent(args);
      case "end_call": return handleEndCall(args);
      default:
        return JSON.stringify({ success: false, message: `Tool "${name}" không được hỗ trợ.` });
    }
  } catch (err) {
    console.error(`[Tool] Lỗi khi xử lý "${name}":`, err.message);
    return JSON.stringify({ success: false, message: "Đã xảy ra lỗi hệ thống. Vui lòng thử lại." });
  }
}
