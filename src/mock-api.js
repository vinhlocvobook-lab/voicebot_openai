/**
 * mock-api.js
 * Mock backend API – thay bằng REST API thật khi sẵn sàng.
 * Tất cả function trả về Promise để dễ swap sang fetch() sau này.
 */

// ─── Mock data ────────────────────────────────────────────────────────────────

// Mã danh bộ (số danh bộ) là chuỗi 11 chữ số, ví dụ: "12345678901"
const CUSTOMERS = {
  "12345678901": {
    maDanhBo: "12345678901",
    hoTen: "Nguyễn Văn An",
    diaChi: "12 Lê Lợi, phường 1, TP.HCM",
    soDienThoai: "0901234567",
  },
  "98765432100": {
    maDanhBo: "98765432100",
    hoTen: "Trần Thị Bích",
    diaChi: "45 Nguyễn Huệ, phường 6, TP.HCM",
    soDienThoai: "0987654321",
  },
  "11122334455": {
    maDanhBo: "11122334455",
    hoTen: "Lê Minh Cường",
    diaChi: "78 Cộng Hòa, phường 4, TP.HCM",
    soDienThoai: "0912345678",
  },
};

const BILLS = {
  "12345678901": { thang: "05/2026", soTienPhaiTra: 185000, daNopTien: false, hanNop: "25/05/2026" },
  "98765432100": { thang: "05/2026", soTienPhaiTra: 320000, daNopTien: true, hanNop: "25/05/2026" },
  "11122334455": { thang: "05/2026", soTienPhaiTra: 95000, daNopTien: false, hanNop: "25/05/2026" },
};

const WATER_USAGE = {
  "12345678901": [
    { thang: "05/2026", luongNuoc: 14, donVi: "m³" },
    { thang: "04/2026", luongNuoc: 12, donVi: "m³" },
    { thang: "03/2026", luongNuoc: 11, donVi: "m³" },
  ],
  "98765432100": [
    { thang: "05/2026", luongNuoc: 24, donVi: "m³" },
    { thang: "04/2026", luongNuoc: 20, donVi: "m³" },
    { thang: "03/2026", luongNuoc: 22, donVi: "m³" },
  ],
  "11122334455": [
    { thang: "05/2026", luongNuoc: 8, donVi: "m³" },
    { thang: "04/2026", luongNuoc: 9, donVi: "m³" },
    { thang: "03/2026", luongNuoc: 7, donVi: "m³" },
  ],
};

const OUTAGES = {
  "12345678901": {
    id: "TB001",
    khuVuc: "Quận 12, phường Thạnh Lộc",
    lyDo: "Bảo trì đường ống định kỳ",
    tuNgay: "30/05/2026 08:00",
    denNgay: "30/06/2026 17:00",
  },
  "98765432100": {
    id: "TB002",
    khuVuc: "Gò Vấp, phường 12",
    lyDo: "Sự cố đường ống",
    tuNgay: "29/05/2026 14:00",
    denNgay: "29/06/2026 22:00",
  },
};

// ─── API functions ────────────────────────────────────────────────────────────

/**
 * Xác thực mã khách hàng.
 * @returns {{ valid: boolean, customer?: object, error?: string }}
 */
export async function verifyCustomer(maDanhBo) {
  // Validate: mã danh bộ phải là đúng 11 chữ số
  const normalized = String(maDanhBo ?? "").replace(/\s/g, "");
  if (!/^\d{11}$/.test(normalized)) {
    return { valid: false, error: "Mã danh bộ không hợp lệ. Mã danh bộ gồm đúng 11 chữ số." };
  }
  const customer = CUSTOMERS[normalized];
  if (!customer) {
    return { valid: false, error: "Mã khách hàng không tồn tại" };
  }
  return { valid: true, customer };
}

/**
 * Tra cứu hóa đơn tiền nước tháng hiện tại.
 * @returns {{ thang, soTienPhaiTra, daNopTien, hanNop } | { error }}
 */
export async function getBill(maDanhBo) {
  const bill = BILLS[maDanhBo];
  if (!bill) return { error: "Không tìm thấy hóa đơn" };
  return bill;
}

/**
 * Tra cứu lượng nước sử dụng (3 tháng gần nhất).
 * @returns {{ usageList: Array, comparison: object } | { error }}
 */
export async function getWaterUsage(maDanhBo) {
  const usage = WATER_USAGE[maDanhBo];
  if (!usage || usage.length === 0) return { error: "Không tìm thấy dữ liệu sử dụng nước" };

  const [current, prev] = usage;
  const diff = current.luongNuoc - prev.luongNuoc;
  const comparison = {
    thangHienTai: current.thang,
    luongHienTai: current.luongNuoc,
    thangTruoc: prev.thang,
    luongTruoc: prev.luongNuoc,
    chenh_lech: diff,
    xu_huong: diff > 0 ? "tăng" : diff < 0 ? "giảm" : "không đổi",
  };

  return { usageList: usage, comparison };
}

/**
 * Lấy danh sách thông báo gián đoạn cung cấp nước.
 * @returns {{ outages: Array }}
 */
export async function getOutages() {
  console.log(`[MockAPI] getOutages`);
  // get_outages không nhận tham số → trả về toàn bộ thông báo gián đoạn hiện có.
  return { outages: Object.values(OUTAGES) };
}

/**
 * Tạo phiếu tiếp nhận sự cố / phản ánh.
 * @returns {{ ticketId, message }}
 */
export async function createTicket({ maDanhBo, loai, moTa, khuVuc }) {
  const ticketId = `TK${Date.now().toString().slice(-6)}`;
  console.log(`[MockAPI] Tạo ticket ${ticketId}: [${loai}] ${moTa} (KH: ${maDanhBo || "ẩn danh"}, khu vực: ${khuVuc || "không rõ"})`);
  return {
    ticketId,
    message: `Phiếu tiếp nhận ${ticketId} đã được ghi nhận. Bộ phận kỹ thuật sẽ xử lý trong thời gian sớm nhất.`,
  };
}
