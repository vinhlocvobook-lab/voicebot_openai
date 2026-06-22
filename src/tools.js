/**
 * tools.js
 * Xử lý function calls từ OpenAI Realtime API.
 * Mỗi handler nhận arguments object, trả về string để gửi lại cho AI.
 */

import {
  getTienNuoc,
  getSanLuong,
  getSoSanhTangGiam,
  getThongBaoCupNuoc,
  baoSuCo,
} from "./api.js";
import { PROCEDURES } from "./huongdanthutuc-data.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtTien = (n) => (typeof n === "number" ? n.toLocaleString("vi-VN") : n);

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

// ─── Handlers ────────────────────────────────────────────────────────────────

async function handleGetBill({ ma_danh_bo, ky, nam }) {
  const chk = checkDanhBo(ma_danh_bo);
  if (!chk.ok) return chk.error;
  const r = await getTienNuoc(chk.normalized, ky, nam);
  if (!r.success) {
    return JSON.stringify({ success: false, message: r.message || "Không tìm thấy hóa đơn." });
  }
  return JSON.stringify({
    success: true,
    message: r.message || "Lấy thông tin tiền nước thành công.",
    data: r.data,
  });
}

async function handleGetWaterUsage({ ma_danh_bo, ky, nam }) {
  const chk = checkDanhBo(ma_danh_bo);
  if (!chk.ok) return chk.error;
  const r = await getSanLuong(chk.normalized, ky, nam);
  if (!r.success) {
    return JSON.stringify({ success: false, message: r.message || "Không tìm thấy dữ liệu sản lượng." });
  }
  const arr = Array.isArray(r.data) ? r.data : [];
  const parts = arr.map(
    (d) => `Kỳ ${d.Ky}/${d.Nam}: ${d.SanLuong} m³, thành tiền ${fmtTien(d.TongTien)} đồng`
  );
  return JSON.stringify({
    success: true,
    message: parts.length ? parts.join("; ") + "." : r.message,
    data: r.data,
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

function handleGetProcedureInfo({ loai_thu_tuc, doi_tuong }) {
  console.log("==========[handleGetProcedureInfo]==================")
  const procedure = PROCEDURES[loai_thu_tuc];
  if (!procedure) {
    return JSON.stringify({ success: false, message: "Không tìm thấy thủ tục này." });
  }

  // Lọc case phù hợp đối tượng (nếu có)
  let relevantCases = procedure.cases;
  if (doi_tuong) {
    const matched = procedure.cases.filter((c) => c.id.includes(doi_tuong) || c.id === "default");
    if (matched.length > 0) relevantCases = matched;
  }

  // Tổng hợp giấy tờ cần thiết
  const docsText = relevantCases
    .map((c) => {
      const docs = c.requiredDocs;
      const items = [...(docs.required || []), ...(docs.options || [])];
      return items.length > 0
        ? `${c.label}: ${items.join("; ")}`
        : `${c.label}: ${docs.note}`;
    })
    .join(" || ");

  const channels =
    "Nộp hồ sơ qua: app SAWACO CSKH, website www.capnuoctrungan.vn, hoặc trực tiếp tại văn phòng 873A Quang Trung hoặc 540 Hà Huy Giáp, TP.HCM.";

  return JSON.stringify({
    success: true,
    thuTuc: procedure.title,
    message: `${procedure.purpose} Giấy tờ cần thiết: ${docsText}. ${channels}`,
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
      case "compare_usage": return await handleCompareUsage(args);
      case "get_outages": return await handleGetOutages(args);
      case "create_ticket": return await handleCreateTicket(args);
      case "get_procedure_info": return handleGetProcedureInfo(args);
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
