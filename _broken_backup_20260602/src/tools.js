/**
 * tools.js
 * Xử lý function calls từ OpenAI Realtime API.
 * Mỗi handler nhận arguments object, trả về string để gửi lại cho AI.
 */

import { verifyCustomer, getBill, getWaterUsage, getOutages, createTicket } from "./mock-api.js";
import { PROCEDURES } from "./huongdanthutuc-data.js";

// ─── Handlers ────────────────────────────────────────────────────────────────

async function handleVerifyCustomer({ ma_danh_bo }) {
  const result = await verifyCustomer(ma_danh_bo);
  if (!result.valid) {
    return JSON.stringify({ success: false, message: "Mã danh bộ không hợp lệ. Quý khách vui lòng kiểm tra lại." });
  }
  return JSON.stringify({
    success: true,
    message: `Xác thực thành công. Khách hàng: ${result.customer.hoTen}, địa chỉ: ${result.customer.diaChi}.`,
    customer: { hoTen: result.customer.hoTen, diaChi: result.customer.diaChi },
  });
}

async function handleGetBill({ ma_danh_bo }) {
  console.log("[handleGetBill]: ma_danh_bo", ma_danh_bo);
  const bill = await getBill(ma_danh_bo);
  if (bill.error) return JSON.stringify({ success: false, message: bill.error });
  const trangThai = bill.daNopTien ? "đã thanh toán" : `chưa thanh toán, hạn nộp ${bill.hanNop}`;
  return JSON.stringify({
    success: true,
    message: `Hóa đơn tháng ${bill.thang}: ${bill.soTienPhaiTra.toLocaleString("vi-VN")} đồng, ${trangThai}.`,
    data: bill,
  });
}

async function handleGetWaterUsage({ ma_danh_bo }) {
  const result = await getWaterUsage(ma_danh_bo);
  if (result.error) return JSON.stringify({ success: false, message: result.error });
  const c = result.comparison;
  const trend = c.xu_huong === "tăng" ? `tăng ${c.chenh_lech} m³` :
    c.xu_huong === "giảm" ? `giảm ${Math.abs(c.chenh_lech)} m³` : "không đổi";
  return JSON.stringify({
    success: true,
    message: `Tháng ${c.thangHienTai}: ${c.luongHienTai} m³ (${trend} so với tháng ${c.thangTruoc} là ${c.luongTruoc} m³).`,
    data: result,
  });
}

async function handleGetOutages() {
  const { outages } = await getOutages();
  if (outages.length === 0) {
    return JSON.stringify({ success: true, message: "Hiện tại không có thông báo gián đoạn cấp nước nào." });
  }
  const list = outages
    .map((o) => `Khu vực ${o.khuVuc}: ${o.lyDo}, từ ${o.tuNgay} đến ${o.denNgay}.`)
    .join(" | ");
  return JSON.stringify({ success: true, message: `Các thông báo gián đoạn: ${list}`, data: outages });
}

async function handleCreateTicket({ ma_danh_bo, loai, mo_ta, khu_vuc }) {
  const result = await createTicket({ maDanhBo: ma_danh_bo, loai, moTa: mo_ta, khuVuc: khu_vuc });
  return JSON.stringify({
    success: true,
    message: result.message,
    ticketId: result.ticketId,
  });
}

function handleGetProcedureInfo({ loai_thu_tuc, doi_tuong }) {
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
      case "verify_customer": return await handleVerifyCustomer(args);
      case "get_bill": return await handleGetBill(args);
      case "get_water_usage": return await handleGetWaterUsage(args);
      case "get_outages": return await handleGetOutages();
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
