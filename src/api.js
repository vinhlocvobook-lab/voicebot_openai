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

// [fix 12/08/2026] Dùng fetch của CHÍNH gói "undici" thay vì fetch built-in
// của Node — fetch built-in dùng bản undici đóng gói SẴN BÊN TRONG Node
// (khác version với gói "undici" cài qua npm). Gán `dispatcher` (Agent) từ
// npm-undici vào fetch built-in gây lệch version nội bộ → lỗi
// "UND_ERR_INVALID_ARG: invalid onRequestStart method" (thấy trên Node 22 +
// undici 8.x của máy Mac test). Import cả fetch lẫn Agent từ CÙNG một gói để
// đảm bảo khớp version, tránh lỗi này vĩnh viễn — không phụ thuộc Node version.
import { Agent, fetch as undiciFetch } from "undici";
import { log as logger } from "./logger.js";
import { recordApiCall } from "./api-trace.js";

// Base URL của api.php. Đặt trong .env: TONGDAI_API_BASE
const API_BASE = (process.env.TONGDAI_API_BASE || "http://127.0.0.1:7700/api.php").replace(/\/$/, "");
const API_TIMEOUT_MS = parseInt(process.env.TONGDAI_API_TIMEOUT_MS || "15000", 10);
// API key gửi qua header Authorization: Bearer <key> — khớp
// config.json["auth"]["api"]["api_key"] bên cntaapi1 (xem
// docs/api_key/plan_xac_thuc_api_key_20260812.md). Trống → không gửi header
// (api.php sẽ tự 401 nếu phía server đã cấu hình api_key).
const API_KEY = process.env.TONGDAI_API_KEY || "";
if (!API_KEY) {
  logger?.warn?.("[API] TONGDAI_API_KEY trống — request tới api.php sẽ không có Authorization, có thể bị 401 nếu server đã bật auth.");
}

// [12/08/2026] api.php chuyển sang Apache HTTPS với self-signed cert (Node fetch
// mặc định từ chối cert không tin cậy: "self-signed certificate" / "unable to
// verify the first certificate"). BẬT TONGDAI_API_INSECURE_TLS=true để bỏ qua
// verify CHỈ CHO request tới đúng base URL này (dùng undici Agent riêng qua
// `dispatcher`, KHÔNG đụng NODE_TLS_REJECT_UNAUTHORIZED — biến đó tắt verify
// CẢ TIẾN TRÌNH, kể cả các kết nối TLS thật tới OpenAI). Khớp quy ước
// verify_ssl:false phía TongDaiApiClient.php cho endpoint nội bộ 127.0.0.1.
// Đổi lại "false"/bỏ trống khi cert đã là CA hợp lệ (production thật).
const API_INSECURE_TLS = /^true$/i.test(process.env.TONGDAI_API_INSECURE_TLS || "");
const API_DISPATCHER = API_INSECURE_TLS ? new Agent({ connect: { rejectUnauthorized: false } }) : undefined;
if (API_INSECURE_TLS) {
  logger?.warn?.("[API] TONGDAI_API_INSECURE_TLS=true — BỎ QUA xác thực chứng chỉ TLS khi gọi api.php (chỉ dùng cho self-signed cert nội bộ).");
}

// ─── Trace helpers ───────────────────────────────────────────────────────────

const API_TRACE_CLIP = 8000; // số ký tự tối đa của response_outer trong trace

/** Thời gian GMT+7 dạng ISO có offset (khớp format của conversation-logger). */
function _traceNow() {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().replace("Z", "+07:00");
}

/** Giữ nguyên object nếu nhỏ; quá lớn thì lưu chuỗi cắt ngắn (tránh log phình to). */
function _clipResponse(outer, rawText) {
  try {
    const v = outer ?? rawText ?? null;
    if (v == null) return null;
    const s = typeof v === "string" ? v : JSON.stringify(v);
    if (s.length <= API_TRACE_CLIP) return v;
    return s.slice(0, API_TRACE_CLIP) + `…[đã cắt bớt, tổng ${s.length} ký tự]`;
  } catch {
    return null;
  }
}

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

  // Trace request/response — ghi vào context của tool call hiện tại (api-trace.js).
  // KHÔNG ghi headers vào trace (tránh lộ API key trong log/trace).
  const _t0 = Date.now();
  const _trace = {
    time: _traceNow(),
    method,
    url,                       // đã gồm query string
    query: query ?? null,
    body: body ?? null,
    http_status: null,
    duration_ms: null,
    response_outer: null,      // response GỐC 2 lớp từ api.php (đã clip)
    error_code: null,
  };

  try {
    const opts = { method, signal: controller.signal, headers: { Accept: "application/json" } };
    if (API_KEY) {
      opts.headers["Authorization"] = `Bearer ${API_KEY}`;
    }
    if (API_DISPATCHER) {
      opts.dispatcher = API_DISPATCHER;
    }
    if (body) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }

    logger?.debug?.(`[API] → ${method} ${url}`);
    // Chỉ dùng fetch của gói "undici" khi THỰC SỰ có dispatcher tuỳ chỉnh (khớp
    // version, tránh UND_ERR_INVALID_ARG) — bình thường vẫn gọi qua `fetch`
    // toàn cục để KHÔNG phá cơ chế mock `globalThis.fetch` của test_case/*.test.mjs.
    const res = await (API_DISPATCHER ? undiciFetch : fetch)(url, opts);
    const text = await res.text();
    _trace.http_status = res.status;
    _trace.duration_ms = Date.now() - _t0;

    let outer;
    try {
      outer = JSON.parse(text);
    } catch {
      _trace.error_code = "INVALID_RESPONSE";
      _trace.response_outer = _clipResponse(null, text);
      logger?.warn?.(`[API] ${method} ${path} → ${res.status} (${_trace.duration_ms}ms) INVALID_RESPONSE`);
      return { success: false, error_code: "INVALID_RESPONSE", message: "Phản hồi không hợp lệ từ máy chủ.", data: null };
    }

    _trace.response_outer = _clipResponse(outer, text);
    logger?.info?.(`[API] ${method} ${path} → ${res.status} (${_trace.duration_ms}ms)`);
    logger?.debug?.(`[API] response: ${text}`);

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
    _trace.duration_ms = Date.now() - _t0;
    _trace.error_code = aborted ? "TIMEOUT" : "CONNECTION_ERROR";
    // undici bọc mọi lỗi mạng/TLS trong TypeError "fetch failed" — lý do thật
    // (ECONNREFUSED, self-signed cert, DNS...) nằm ở err.cause, không phải
    // err.message. Log cả 2 để đỡ phải đoán khi tunnel/TLS có vấn đề.
    logger?.error?.(`[API] Lỗi gọi ${url}: ${err.message}${err.cause ? ` — nguyên nhân: ${err.cause.code || ""} ${err.cause.message || err.cause}` : ""} (${_trace.duration_ms}ms)`);
    return {
      success: false,
      error_code: aborted ? "TIMEOUT" : "CONNECTION_ERROR",
      message: aborted ? "Máy chủ phản hồi quá lâu." : "Không kết nối được tới máy chủ.",
      data: null,
    };
  } finally {
    clearTimeout(timer);
    recordApiCall(_trace); // ghi 1 lần cho MỌI nhánh (thành công / lỗi / timeout)
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
 * POST /bao-su-co  body: { danhba, noidung,tel }
 */
export async function baoSuCo(maDanhBo, noiDung, tel) {
  return callApi("/bao-su-co", { method: "POST", body: { danhba: maDanhBo, noidung: noiDung, tel: tel } });
}
/**
 * Tra cứu trạng thái thanh toán (superset: TongTien + SanLuong + TrangThaiThanhToan).
 * GET /trang-thai-thanh-toan?danhba=...&ky=...&nam=...
 * data: [{ Nam, Ky, TongTien, SanLuong, TrangThaiThanhToan, NgayThanhToan, DonViThanhToan }]
 * Chưa thanh toán: TrangThaiThanhToan = "Chưa thanh toán", NgayThanhToan/DonViThanhToan = "".
 */
export async function getTrangThaiTT(maDanhBo, ky = null, nam = null) {
  return callApi("/trang-thai-thanh-toan", { query: { danhba: maDanhBo, ky, nam } });
}



export async function getAvailableAgents() {
  return callApi("/available-agents");
}
