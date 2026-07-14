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
} from "./api.js";
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

/**
 * Chuẩn hoá mã danh bộ trước khi gọi API:
 * AI thường đọc số kèm dấu gạch ngang / khoảng trắng (vd "1-5-1-2-...").
 * Bỏ mọi ký tự không phải chữ số.
 */
function normalizeDanhBo(raw) {
  console.log("==========[normalizeDanhBo]==================")
  console.log("raw:", raw);

  // Bảo vệ code nếu raw là null/undefined, sau đó xóa sạch ký tự không phải số
  let normalized = String(raw ?? "").replace(/\D/g, "");

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
async function fetchBilling(ma_danh_bo, ky, nam) {
  const chk = checkDanhBo(ma_danh_bo);
  if (!chk.ok) return { ok: false, error: chk.error };

  let r = await getTrangThaiTT(chk.normalized, ky, nam);

  const noPeriodGiven = (ky === null || ky === undefined) && (nam === null || nam === undefined);
  const notFound = ["INVOICE_NOT_FOUND", "PRODUCTION_NOT_FOUND"].includes(r?.error_code);
  if (!r.success && noPeriodGiven && notFound) {
    const p = prevPeriod();
    r = await getTrangThaiTT(chk.normalized, p.ky, p.nam);
  }

  if (!r.success) {
    return {
      ok: false,
      error: JSON.stringify({
        success: false,
        error_code: r.error_code || null,
        message: r.message || "Không tra cứu được thông tin.",
      }),
    };
  }
  return { ok: true, rows: Array.isArray(r.data) ? r.data : [] };
}

// ─── Handlers ────────────────────────────────────────────────────────────────

async function handleGetBill({ ma_danh_bo, ky, nam }) {
  const f = await fetchBilling(ma_danh_bo, ky, nam);
  if (!f.ok) return f.error;
  const parts = f.rows.map((d) => {
    const tt = d.TrangThaiThanhToan === "Đã thanh toán"
      ? `, đã thanh toán ngày ${fmtNgay(d.NgayThanhToan)}`
      : `, chưa thanh toán`;
    return `Kỳ ${d.Ky}/${d.Nam}: tổng tiền ${docTienVN(d.TongTien)}${tt}`;
  });
  return JSON.stringify({
    success: true,
    message: parts.length ? parts.join("; ") + "." : "Không có dữ liệu hóa đơn.",
    data: f.rows.map(simplifyRow),
  });
}

async function handleGetWaterUsage({ ma_danh_bo, ky, nam }) {
  const f = await fetchBilling(ma_danh_bo, ky, nam);
  if (!f.ok) return f.error;
  const parts = f.rows.map(
    (d) => `Kỳ ${d.Ky}/${d.Nam}: ${d.SanLuong} m³, thành tiền ${docTienVN(d.TongTien)}`
  );
  return JSON.stringify({
    success: true,
    message: parts.length ? parts.join("; ") + "." : "Không có dữ liệu sản lượng.",
    data: f.rows.map(simplifyRow),
  });
}

async function handleGetPaymentStatus({ ma_danh_bo, ky, nam }) {
  const f = await fetchBilling(ma_danh_bo, ky, nam);
  if (!f.ok) return f.error;
  // KHÔNG đọc DonViThanhToan cho khách (mã nội bộ như "GDGV", chưa có bảng map).
  const parts = f.rows.map((d) => {
    if (d.TrangThaiThanhToan === "Đã thanh toán") {
      return `Kỳ ${d.Ky}/${d.Nam}: đã thanh toán ngày ${fmtNgay(d.NgayThanhToan)}`;
    }
    return `Kỳ ${d.Ky}/${d.Nam}: chưa thanh toán, số tiền ${docTienVN(d.TongTien)}`;
  });
  return JSON.stringify({
    success: true,
    message: parts.length ? parts.join("; ") + "." : "Không có dữ liệu thanh toán.",
    data: f.rows.map(simplifyRow),
  });
}

async function handleCompareUsage({ ma_danh_bo, ky, nam }) {
  const chk = checkDanhBo(ma_danh_bo);
  if (!chk.ok) return chk.error;
  const r = await getSoSanhTangGiam(chk.normalized, ky, nam);
  if (!r.success) {
    return JSON.stringify({ success: false, message: r.message || "Không có dữ liệu so sánh." });
  }
  return JSON.stringify({
    success: true,
    message: r.message || "Lấy thông tin so sánh sản lượng thành công.",
    data: r.data,
  });
}

async function handleGetOutages({ ma_danh_bo }) {
  const chk = checkDanhBo(ma_danh_bo);
  if (!chk.ok) return chk.error;
  const r = await getThongBaoCupNuoc(chk.normalized);
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

async function handleCreateTicket({ ma_danh_bo, loai, mo_ta }) {
  const chk = checkDanhBo(ma_danh_bo);
  if (!chk.ok) return chk.error;
  // Gộp loại + mô tả thành nội dung gửi lên endpoint bao-su-co.
  const noiDung = loai ? `[${loai}] ${mo_ta}` : mo_ta;
  const r = await baoSuCo(chk.normalized, noiDung);
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

  if (loai !== args.loai_thu_tuc || doiTuong !== args.doi_tuong) {
    console.warn("[get_procedure_info] Args chuẩn hoá lại:", JSON.stringify(args),
      "→", JSON.stringify({ loai_thu_tuc: loai, doi_tuong: doiTuong }));
  }
  return { loai_thu_tuc: loai, doi_tuong: doiTuong };
}

function handleGetProcedureInfo(rawArgs = {}) {
  console.log("==========[handleGetProcedureInfo]==================")
  const { loai_thu_tuc, doi_tuong } = normalizeProcedureArgs(rawArgs);
  const procedure = PROCEDURES[loai_thu_tuc];
  if (!procedure) {
    // [11/07/2026] Thủ tục ngoài phạm vi 4 thủ tục hỗ trợ → không tự hướng dẫn,
    // mời chuyển tổng đài viên hoặc tạo phiếu ghi nhận.
    return JSON.stringify({
      success: false,
      ngoai_pham_vi: true,
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
      message: `Thủ tục ${procedure.title} CHỈ áp dụng cho hộ gia đình, KHÔNG áp dụng cho doanh nghiệp hay công ty. Nếu khách là doanh nghiệp cần hỗ trợ khác, mời chuyển tổng đài viên hoặc tạo phiếu ghi nhận.`,
    });
  }

  // [12/07/2026] Thủ tục có hướng dẫn KHÁC NHAU theo đối tượng (lắp đặt, sang
  // tên): thiếu doi_tuong thì KHÔNG trả gộp cả hai trường hợp — cuộc gọi
  // E0VkaW1IIC4xom9HGSneG model nhận cả 2 case rồi tự tóm tắt làm rơi mất địa
  // chỉ văn phòng. Trả yêu cầu hỏi khách rồi gọi lại (deterministic).
  const coPhanBietDoiTuong = procedure.cases.some((c) => c.id === "doanh_nghiep");
  if (!doi_tuong && coPhanBietDoiTuong) {
    return JSON.stringify({
      success: true,
      thuTuc: procedure.title,
      can_hoi_doi_tuong: true,
      message:
        `Thủ tục ${procedure.title} có hướng dẫn KHÁC NHAU cho hộ gia đình và doanh nghiệp. ` +
        `HỎI khách một câu ngắn: "Quý Khách đăng ký cho hộ gia đình hay doanh nghiệp ạ?" ` +
        `rồi GỌI LẠI get_procedure_info với doi_tuong tương ứng. KHÔNG tự đoán, ` +
        `KHÔNG hướng dẫn giấy tờ khi chưa gọi lại tool.`,
    });
  }

  // Lọc case phù hợp đối tượng (nếu có)
  let relevantCases = procedure.cases;
  if (doi_tuong) {
    const matched = procedure.cases.filter((c) => c.id.includes(doi_tuong) || c.id === "default");
    if (matched.length > 0) relevantCases = matched;
  }

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
 * @returns {Promise<string>} - JSON string kết quả (gửi lại cho OpenAI)
 */
export async function dispatchTool(name, args) {
  try {
    switch (name) {
      case "get_bill": return await handleGetBill(args);
      case "get_water_usage": return await handleGetWaterUsage(args);
      case "get_payment_status": return await handleGetPaymentStatus(args);
      case "compare_usage": return await handleCompareUsage(args);
      case "get_outages": return await handleGetOutages(args);
      case "create_ticket": return await handleCreateTicket(args);
      case "get_procedure_info": return handleGetProcedureInfo(args);
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
