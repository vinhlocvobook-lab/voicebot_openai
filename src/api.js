/**
 * api.js
 * Client gọi REST API thật của Tổng đài CNTA (thay cho mock-api.js).
 * Endpoint wrapper: docs/api.php  → TongDaiApiClient.
 *
 * Cấu trúc response của api.php (2 lớp):
 *   {
 *     success: bool,          // lớp ngoài: trạng thái của API gateway
 *     http_code: number,
 *     error?: string,
 *     data: {                 // lớp trong: payload nghiệp vụ từ server gốc
 *       success: bool,
 *       message?: string,
 *       error_code?: string,
 *       data: any
 *     }
 *   }
 *
 * Các hàm dưới đây trả về "lớp trong" đã chuẩn hoá để tools.js dùng.
 */

import { log as logger } from "./logger.js";

// Base URL của api.php. Đặt trong .env: TONGDAI_API_BASE
const API_BASE = (process.env.TONGDAI_API_BASE || "http://127.0.0.1:7700/api.php").replace(/\/$/, "");
const API_TIMEOUT_MS = parseInt(process.env.TONGDAI_API_TIMEOUT_MS || "15000", 10);

/**
 * Gọi 1 endpoint và trả về payload nghiệp vụ (lớp trong).
 * @returns {Promise<{success:boolean, message?:string, error_code?:string, data:any}>}
 */
async function callApi(path, { method = "GET", query = null, body = null } = {}) {
  let url = API_BASE + path;

  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== null && v !== undefined && v !== "") params.append(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += "?" + qs;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const opts = { method, signal: controller.signal, headers: { Accept: "application/json" } };
    if (body) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }

    logger?.debug?.(`[API] ${method} ${url}`);
    const res = await fetch(url, opts);
    const text = await res.text();

    let outer;
    try {
      outer = JSON.parse(text);
    } catch {
      return { success: false, error_code: "INVALID_RESPONSE", message: "Phản hồi không hợp lệ từ máy chủ.", data: null };
    }

    // Lấy lớp trong nếu có, nếu không thì trả nguyên outer.
    const inner = outer && typeof outer.data === "object" && outer.data !== null && "success" in outer.data
      ? outer.data
      : outer;

    if (outer && outer.success === false && outer.error && !inner.message) {
      inner.message = outer.error;
    }
    return inner;
  } catch (err) {
    const aborted = err.name === "AbortError";
    logger?.error?.(`[API] Lỗi gọi ${url}: ${err.message}`);
    return {
      success: false,
      error_code: aborted ? "TIMEOUT" : "CONNECTION_ERROR",
      message: aborted ? "Máy chủ phản hồi quá lâu." : "Không kết nối được tới máy chủ.",
      data: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ─── API functions ────────────────────────────────────────────────────────────

/**
 * Tra cứu thông tin khách hàng theo danh bộ hoặc số điện thoại.
 * GET /thong-tin-khach-hang?danhba=...&sdt=...
 * data: [{ danhBa, hoTen }, ...]
 */
export async function getThongTinKhachHang(maDanhBo = null, sdt = null) {
  return callApi("/thong-tin-khach-hang", { query: { danhba: maDanhBo, sdt } });
}

/**
 * Xác thực khách hàng (dựa trên thong-tin-khach-hang).
 * @returns {{ valid:boolean, customers?:Array, customer?:object, error?:string }}
 */
export async function verifyCustomer(maDanhBo, sdt = null) {
  const r = await getThongTinKhachHang(maDanhBo, sdt);
  const list = Array.isArray(r.data) ? r.data : [];
  if (!r.success || list.length === 0) {
    return { valid: false, error: r.message || "Không tìm thấy thông tin khách hàng." };
  }
  return { valid: true, customers: list, customer: list[0] };
}

/**
 * Tra cứu tiền nước (hóa đơn).
 * GET /tien-nuoc?danhba=...&ky=...&nam=...
 */
export async function getTienNuoc(maDanhBo, ky = null, nam = null) {
  return callApi("/tien-nuoc", { query: { danhba: maDanhBo, ky, nam } });
}

/**
 * Tra cứu sản lượng nước sử dụng.
 * GET /san-luong?danhba=...&ky=...&nam=...
 * data: [{ Nam, Ky, TongTien, SanLuong }]
 */
export async function getSanLuong(maDanhBo, ky = null, nam = null) {
  return callApi("/san-luong", { query: { danhba: maDanhBo, ky, nam } });
}

/**
 * So sánh tăng/giảm sản lượng so với kỳ trước.
 * GET /so-sanh-tang-giam?danhba=...&ky=...&nam=...
 */
export async function getSoSanhTangGiam(maDanhBo, ky = null, nam = null) {
  return callApi("/so-sanh-tang-giam", { query: { danhba: maDanhBo, ky, nam } });
}

/**
 * Tra cứu thông báo cúp nước / sự cố theo danh bộ.
 * GET /cup-nuoc?danhba=...
 * data: { coSuCo, thongBao, thoiGianDuKienHoanThanh }
 */
export async function getThongBaoCupNuoc(maDanhBo) {
  return callApi("/cup-nuoc", { query: { danhba: maDanhBo } });
}

/**
 * Báo sự cố rò rỉ / áp lực nước.
 * POST /bao-su-co  body: { danhba, noidung }
 */
export async function baoSuCo(maDanhBo, noiDung) {
  return callApi("/bao-su-co", { method: "POST", body: { danhba: maDanhBo, noidung: noiDung } });
}
