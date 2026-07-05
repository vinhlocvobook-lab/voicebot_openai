# Plan: Thêm `get_payment_status` + gộp nguồn dữ liệu về `trang-thai-thanh-toan`

Ngày: 2026-07-04 · Trạng thái: **✅ ĐÃ TRIỂN KHAI (2026-07-04)** — xem mục "Nội dung đã cập nhật" cuối file

## Bối cảnh

Backend `api.php` có 3 endpoint tra cứu hóa đơn, dữ liệu lồng nhau (superset):

| Endpoint | Trả về |
|---|---|
| `tien-nuoc` | TongTien |
| `san-luong` | TongTien, SanLuong |
| `trang-thai-thanh-toan` | TongTien, SanLuong, TrangThaiThanhToan, NgayThanhToan, DonViThanhToan |

→ Chỉ cần gọi `trang-thai-thanh-toan` là đủ dữ liệu cho cả 3 nhu cầu.

**Bug hiện có:** `dispatchTool` (tools.js) đã route `get_payment_status` → `handleGetPaymentStatus` nhưng hàm này **chưa tồn tại** (gọi là ném ReferenceError), và tool cũng chưa khai báo trong `TOOLS` nên khách hỏi "đã thanh toán chưa?" bot không trả lời được.

## Thay đổi 1 — `src/system-prompt.js`

### 1a. Thêm tool `get_payment_status` vào mảng `TOOLS`

**Cũ:** không có.

**Mới:**

```js
{
  type: "function",
  name: "get_payment_status",
  description: "Tra cứu trạng thái thanh toán tiền nước (đã đóng hay chưa, ngày thanh toán). Nếu không có kỳ (tháng), năm thì lấy kỳ gần nhất.",
  parameters: {
    type: "object",
    properties: {
      ma_danh_bo: { type: "string", description: "Mã danh bộ" },
      ky: { type: "integer", description: "Kỳ (tháng) cần tra cứu, tùy chọn" },
      nam: { type: "integer", description: "Năm cần tra cứu, tùy chọn" },
    },
    required: ["ma_danh_bo"],
  },
},
```

### 1b. Cập nhật mục `# Phạm vi` trong `SYSTEM_PROMPT`

**Cũ:**

```
Hỗ trợ: tiền nước, lượng nước, so sánh lượng nước, tình trạng cấp nước, thủ tục hành chính, phản ánh/khiếu nại.
```

**Mới:**

```
Hỗ trợ: tiền nước, trạng thái thanh toán, lượng nước, so sánh lượng nước, tình trạng cấp nước, thủ tục hành chính, phản ánh/khiếu nại.
```

### 1c. Thêm hướng dẫn xử lý lỗi tra cứu (cuối phần `# Mã danh bộ` hoặc mục riêng)

**Cũ:** không có.

**Mới:**

```
# Kết quả tra cứu lỗi
- error_code "CUSTOMER_NOT_FOUND" → có thể danh bộ bị đọc/nghe sai: đọc lại dãy số cho khách xác nhận rồi tra lại.
- error_code "INVOICE_NOT_FOUND" / "PRODUCTION_NOT_FOUND" → kỳ này chưa có hóa đơn/dữ liệu: báo khách, KHÔNG yêu cầu đọc lại danh bộ.
```

## Thay đổi 2 — `src/tools.js`

### 2a. Handler chung fetch `trang-thai-thanh-toan`, mỗi tool 1 formatter

**Cũ:** `handleGetBill` gọi `getTienNuoc`, `handleGetWaterUsage` gọi `getSanLuong`, mỗi handler tự xử lý lỗi; `handleGetBill` trả raw `data` không format; thất bại bị drop `error_code`.

**Mới:** thêm helper + 3 handler mỏng:

```js
// Format "2026-06-30 15:14:54" → "30/06/2026" (đọc tự nhiên qua thoại)
function fmtNgay(s) {
  const m = String(s ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
}

// Fetch trang-thai-thanh-toan + validate danh bộ, trả { ok, error?, rows? }
async function fetchBilling(ma_danh_bo, ky, nam) {
  const chk = checkDanhBo(ma_danh_bo);
  if (!chk.ok) return { ok: false, error: chk.error };
  const r = await getTrangThaiTT(chk.normalized, ky, nam);
  if (!r.success) {
    return {
      ok: false,
      error: JSON.stringify({
        success: false,
        error_code: r.error_code || null,   // ← giữ error_code cho model phân nhánh
        message: r.message || "Không tra cứu được thông tin.",
      }),
    };
  }
  return { ok: true, rows: Array.isArray(r.data) ? r.data : [] };
}

async function handleGetBill({ ma_danh_bo, ky, nam }) {
  const f = await fetchBilling(ma_danh_bo, ky, nam);
  if (!f.ok) return f.error;
  const parts = f.rows.map((d) => {
    const tt = d.TrangThaiThanhToan === "Đã thanh toán"
      ? `, đã thanh toán ngày ${fmtNgay(d.NgayThanhToan)}`
      : `, chưa thanh toán`;
    return `Kỳ ${d.Ky}/${d.Nam}: tổng tiền ${fmtTien(d.TongTien)} đồng${tt}`;
  });
  return JSON.stringify({ success: true, message: parts.join("; ") + ".", data: f.rows });
}

async function handleGetWaterUsage({ ma_danh_bo, ky, nam }) {
  const f = await fetchBilling(ma_danh_bo, ky, nam);
  if (!f.ok) return f.error;
  const parts = f.rows.map(
    (d) => `Kỳ ${d.Ky}/${d.Nam}: ${d.SanLuong} m³, thành tiền ${fmtTien(d.TongTien)} đồng`
  );
  return JSON.stringify({ success: true, message: parts.join("; ") + ".", data: f.rows });
}

async function handleGetPaymentStatus({ ma_danh_bo, ky, nam }) {
  const f = await fetchBilling(ma_danh_bo, ky, nam);
  if (!f.ok) return f.error;
  const parts = f.rows.map((d) => {
    if (d.TrangThaiThanhToan === "Đã thanh toán") {
      return `Kỳ ${d.Ky}/${d.Nam}: đã thanh toán ngày ${fmtNgay(d.NgayThanhToan)}`;
    }
    return `Kỳ ${d.Ky}/${d.Nam}: chưa thanh toán, số tiền ${fmtTien(d.TongTien)} đồng`;
  });
  return JSON.stringify({ success: true, message: parts.join("; ") + ".", data: f.rows });
}
```

Ghi chú: **không đọc `DonViThanhToan`** cho khách (mã nội bộ như "GDGV", chưa có bảng map). Khi có bảng map mã → tên thì bổ sung sau.

### 2b. Import

**Cũ:** import `getTienNuoc`, `getSanLuong` từ `api.js`.

**Mới:** 2 hàm này không còn dùng trong tools.js — bỏ khỏi import (giữ nguyên trong `api.js` để tham khảo/rollback). `getTrangThaiTT` đã được import sẵn.

## Thay đổi 3 — `src/api.js`

**Cũ:**

```js
export async function getTrangThaiTT(maDanhBo, ky, nam) {
```

**Mới** (default null, đồng nhất với các hàm khác — không truyền ky/nam thì backend lấy kỳ gần nhất):

```js
export async function getTrangThaiTT(maDanhBo, ky = null, nam = null) {
```

## Cần xác minh với backend TRƯỚC khi code

1. ~~Sample hóa đơn chưa đóng~~ **✅ ĐÃ XÁC NHẬN (2026-07-04)**: khi chưa đóng, API trả `TrangThaiThanhToan: "Chưa thanh toán"`, `NgayThanhToan: ""`, `DonViThanhToan: ""` (chuỗi rỗng, không phải null/vắng field). Điều kiện `d.TrangThaiThanhToan === "Đã thanh toán"` trong formatter hoạt động đúng cho cả 2 nhánh.

   ```json
   // GET /trang-thai-thanh-toan?danhba=22023251775&ky=6&nam=2026
   { "Nam": 2026, "Ky": 6, "TongTien": 1180266, "SanLuong": 62,
     "TrangThaiThanhToan": "Chưa thanh toán", "NgayThanhToan": "", "DonViThanhToan": "" }
   ```

2. ~~Không truyền ky/nam có trả kỳ gần nhất không~~ **✅ ĐÃ XÁC NHẬN (log cuộc gọi 17:04 04/07)**: KHÔNG — backend mặc định kỳ hiện tại (7/2026 → `PRODUCTION_NOT_FOUND`). Đã xử lý phía client: `fetchBilling` tự lùi 1 kỳ khi không truyền ky/nam mà bị `*_NOT_FOUND` (xem mục "Điều chỉnh sau cuộc gọi test").
3. **Độ trễ** endpoint này so với `tien-nuoc` (join thêm dữ liệu thanh toán?) — voice bot nhạy với latency tool call.
4. Bảng map `DonViThanhToan` (GDGV, ...) → tên dễ đọc, nếu muốn đọc kênh thanh toán cho khách.

## Không thay đổi

- `compare_usage`, `get_outages`, `create_ticket`, `get_procedure_info`, `transfer_to_agent`, `end_call`.
- `session-ws.js`, `call-manager.js`, luồng SIP.
- `api.php` phía backend.

## Nội dung đã cập nhật (2026-07-04)

Triển khai đúng theo plan, chi tiết từng file:

### `src/system-prompt.js`
- ✅ Thêm tool `get_payment_status` vào `TOOLS` (đặt sau `get_bill`). TOOLS hiện có 9 tool: get_bill, get_payment_status, get_water_usage, compare_usage, get_outages, create_ticket, get_procedure_info, transfer_to_agent, end_call.
- ✅ Mục `# Phạm vi`: thêm "trạng thái thanh toán".
- ✅ Thêm mục `# Kết quả tra cứu lỗi` (trước `# Quy trình`): hướng dẫn model phân nhánh CUSTOMER_NOT_FOUND vs INVOICE/PRODUCTION_NOT_FOUND.

### `src/tools.js`
- ✅ Thêm helper `fmtNgay()` — "2026-06-30 15:14:54" → "30/06/2026".
- ✅ Thêm helper `fetchBilling(ma_danh_bo, ky, nam)` — validate danh bộ + gọi `getTrangThaiTT`, trả kèm `error_code` khi thất bại.
- ✅ `handleGetBill`: chuyển từ `getTienNuoc` → `fetchBilling`; message đọc sẵn kèm trạng thái thanh toán, vd "Kỳ 6/2026: tổng tiền 573.782 đồng, đã thanh toán ngày 30/06/2026".
- ✅ `handleGetWaterUsage`: chuyển từ `getSanLuong` → `fetchBilling`; giữ format m³ + tiền như cũ.
- ✅ Thêm `handleGetPaymentStatus` (fix bug: trước đây `dispatchTool` route tới hàm chưa tồn tại). Không đọc `DonViThanhToan` (mã nội bộ, chưa có bảng map).
- ✅ Import: bỏ `getTienNuoc`, `getSanLuong` (không còn dùng; hàm vẫn giữ trong api.js để rollback).

### `src/api.js`
- ✅ `getTrangThaiTT(maDanhBo, ky = null, nam = null)` — default null, đồng nhất các hàm khác; bổ sung JSDoc mô tả response (kể cả case chưa thanh toán: NgayThanhToan/DonViThanhToan = "").

### Verify đã chạy
- ✅ `node --check` pass cả 3 file.
- ✅ Import runtime: `TOOLS` đủ 9 tool, có `get_payment_status`.
- ✅ Smoke test `dispatchTool('get_payment_status', {ma_danh_bo:'123-456'})` → trả đúng nhánh `invalid_danh_bo` (6 chữ số), không crash.
- ⬜ Chưa test với backend thật (cần server api.php chạy) — dùng checklist "Test thủ công" bên dưới khi gọi thử qua SIP.

## Điều chỉnh sau cuộc gọi test (2026-07-04, 17:04, call `rtc_u7_DxrWJKfWBVGkIMCKVsDHr`)

**Vấn đề quan sát được từ log:**

1. Khách hỏi lại ngày thanh toán ở cuối cuộc gọi → model chỉ nói "đã thanh toán", không nêu ngày, dù `NgayThanhToan` có trong tool output. Nguyên nhân: `data` trả raw (`"2026-06-30 15:14:54"`, kèm `DonViThanhToan: "GDGV"` gây nhiễu) — gpt-realtime-mini khó tự trích/parse ở lượt sau.
2. Tool call đầu không truyền ky/nam → backend trả `PRODUCTION_NOT_FOUND` (mặc định kỳ hiện tại 7/2026, không phải "kỳ gần nhất" như mô tả tool) → tốn 1 lượt hỏi lại kỳ vô ích.

**Đã sửa:**

### `src/tools.js`
- ✅ Thêm `simplifyRow()`: data gửi model giờ là `{ ky: "6/2026", san_luong_m3: 29, tong_tien: "573.782 đồng", trang_thai_thanh_toan: "Đã thanh toán", ngay_thanh_toan: "30/06/2026" }` — ngày đã format, bỏ `DonViThanhToan` + timestamp raw. Cả 3 handler (get_bill / get_water_usage / get_payment_status) dùng chung.
- ✅ Thêm `prevPeriod()` + fallback trong `fetchBilling`: không truyền ky/nam mà bị `INVOICE/PRODUCTION_NOT_FOUND` → tự gọi lại với kỳ liền trước (GMT+7). Deterministic, không để model tự đoán kỳ. CONNECTION_ERROR/TIMEOUT không retry.

### `src/system-prompt.js`
- ✅ Thêm mục `# Trả lời từ kết quả tra cứu`: (a) câu hỏi tiếp theo về dữ liệu đã có → trả lời từ kết quả trước, không tra lại; (b) đã thanh toán → LUÔN nêu rõ ngày từ trường `ngay_thanh_toan`; (c) chưa có dữ liệu thanh toán → gọi get_payment_status.

**Verify:** `node --check` pass; test end-to-end với mock backend cổng 7700: không truyền kỳ → fallback lùi về 6/2026 trả đúng dữ liệu; message get_payment_status = "Kỳ 6/2026: đã thanh toán ngày 30/06/2026."

**Theo dõi cuộc gọi test kế tiếp:** hỏi "tôi đóng tiền ngày nào?" sau khi đã tra sản lượng → bot phải đọc được "ngày 30 tháng 6 năm 2026" không cần gọi tool lần 2.

## Test thủ công sau khi sửa

1. Hỏi tiền nước kỳ 6/2026 danh bộ hợp lệ → đọc tiền + trạng thái TT.
2. Hỏi "tôi đóng tiền nước chưa?" → `get_payment_status`, đọc ngày thanh toán, KHÔNG đọc "GDGV".
3. Hỏi sản lượng → đọc m³ + tiền.
4. Danh bộ sai (CUSTOMER_NOT_FOUND) → bot mời xác nhận lại số.
5. Kỳ chưa có hóa đơn (kỳ 7/2026) → bot báo chưa có, không bắt đọc lại danh bộ.
6. Danh bộ thiếu/thừa chữ số → vẫn ra nhánh `invalid_danh_bo` như cũ.
