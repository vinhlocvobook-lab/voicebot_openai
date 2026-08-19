# `fetchBilling()` — nội dung trả về

`fetchBilling(ma_danh_bo, ky, nam, callState)` (`src/tools.js`, hàm nội bộ
không export) là điểm tra cứu dùng chung duy nhất cho `get_bill` (và các alias
đã gộp `get_water_usage`/`get_payment_status` — xem `CLAUDE.md`). Nó gọi
`getTrangThaiTT()` (`src/api.js`) — API **superset** trả sẵn tiền, trạng thái
thanh toán và sản lượng trong một lần gọi.

Đọc cùng với [README.md](./README.md) §4 (`resolveDanhBo`) — `fetchBilling`
**luôn** đi qua `resolveDanhBo` trước, nên phần lớn các "trạng thái danh bộ
chưa xong" (đang gom số, đang xác minh, chờ xác nhận...) mà `fetchBilling` có
thể trả về thực chất được sinh ra bởi các hàm dựng payload trong
`resolveDanhBo`, không phải logic riêng của `fetchBilling`.

## Chữ ký & giá trị trả về

```js
async function fetchBilling(ma_danh_bo, ky, nam, callState)
// → Promise<{ ok: true, ma_danh_bo: string, rows: Array<RowThoTT> }
//          | { ok: false, error: string /* JSON đã stringify, sẵn để trả cho model */ }>
```

`rows` là mảng thô lấy thẳng từ `r.data` của `getTrangThaiTT` (không qua
`simplifyRow` — việc rút gọn cho model đọc là việc của **caller**, xem
`handleGetBill` bên dưới). Mỗi phần tử có dạng:

```json
{
  "Nam": 2026,
  "Ky": 7,
  "TongTien": 1180266,
  "SanLuong": 18,
  "TrangThaiThanhToan": "Đã thanh toán",
  "NgayThanhToan": "2026-06-30 15:14:54",
  "DonViThanhToan": "GDGV"
}
```

(`TrangThaiThanhToan` = `"Chưa thanh toán"` thì `NgayThanhToan`/`DonViThanhToan`
là chuỗi rỗng — xem chú thích tại `api.js:getTrangThaiTT`.)

## Luồng bên trong (đọc theo đúng thứ tự code chạy)

1. **`resolveDanhBo(ma_danh_bo, callState)`** — cổng không chặn (README §4).
   Không `ok` → `fetchBilling` trả ngay `{ ok: false, error: rs.error }`,
   **không gọi API**. Đây là nguồn phổ biến nhất của `ok:false` — không phải
   lỗi backend mà là "danh bộ chưa sẵn sàng để tra cứu".
2. **`getTrangThaiTT(rs.value, ky, nam)`** — gọi lần 1.
3. **Fallback lùi kỳ**: nếu `ky`/`nam` model **không truyền** (cả hai đều
   `null`/`undefined`) **và** lỗi là `INVOICE_NOT_FOUND` hoặc
   `PRODUCTION_NOT_FOUND` → tự tính kỳ liền trước (`prevPeriod()`, theo giờ
   GMT+7) rồi gọi lại **một lần**. Lý do: backend không tự suy ra "kỳ gần
   nhất" khi thiếu `ky`/`nam` — nó mặc định kỳ hiện tại, mà đầu tháng thường
   chưa có dữ liệu kỳ đó. Fallback này **không** chạy nếu model có truyền
   `ky`/`nam` cụ thể (tôn trọng ý khách hỏi đúng kỳ đó, kể cả khi kỳ đó rỗng).
4. **Vẫn lỗi sau fallback**:
   - `error_code === "CUSTOMER_NOT_FOUND"` → gọi
     `danhBoNotFoundSelfCorrect(callState)` (README §6) thử tìm ứng viên khác
     từ co-pilot nền. Có ứng viên hợp lệ → trả `{ ok: false, error: corrected }`
     (payload là câu **đọc lại xác nhận ứng viên mới**, không phải thông báo
     lỗi). Không có → rơi xuống nhánh lỗi chung.
   - Nhánh lỗi chung: `{ ok: false, error: JSON.stringify({ success:false, error_code, message }) }`.
5. **Thành công**: `{ ok: true, ma_danh_bo: rs.value, rows: Array.isArray(r.data) ? r.data : [] }`.
   Lưu ý dùng `rs.value` (số đã qua `resolveDanhBo`, tức số **đã xác nhận**)
   chứ không phải `ma_danh_bo` (arg thô của model) — từng có bug dòng này bị
   comment nhầm khiến model đọc "mã danh bộ undefined" cho khách nghe dù tool
   đã trả `success:true` (xem chú thích trong code, cuộc
   `rtc_u1_E5hSj6jwK5jeMHvCZV7yx`).

## Bảng các giá trị `ok:false` có thể gặp

| Nguồn | `error` (đã parse) | Khi nào |
|---|---|---|
| `resolveDanhBo` | `{ invalid_danh_bo:true, do_dai_hien_tai, doc_cho_khach, message }` | Chưa đủ/quá 11 số trong phiên hiện tại. |
| `resolveDanhBo` | `{ dang_gom_so:true, da_nghe, can, doc_cho_khach, message }` | Đang gom dở (1–10 số), đường nền vẫn đang gom tiếp. |
| `resolveDanhBo` | `{ dang_xac_minh:true, doc_cho_khach, message }` | Đủ/thừa số, API + trọng tài đang xác minh ở nền. |
| `resolveDanhBo` | `{ cho_khach_xac_nhan:true, ma_danh_bo, trang_thai_danh_bo:"dang_cho_xac_nhan", doc_cho_khach, message }` | Có ứng viên, đang chờ khách xác nhận đúng/sai. |
| `resolveDanhBo` | `{ moi_bam_phim:true, doc_cho_khach, message }` | Hết lượt đọc giọng nói → mời bấm phím DTMF. |
| `resolveDanhBo` | `{ invalid_danh_bo:true, da_sai_nhieu_lan, doc_cho_khach, message }` | Đã mời DTMF rồi vẫn không xong → mời chuyển máy / tạo phiếu. |
| `fetchBilling` (self-correct) | payload đọc lại xác nhận **ứng viên mới** (dạng giống `cho_khach_xac_nhan` ở trên) | `CUSTOMER_NOT_FOUND` nhưng co-pilot nền có ứng viên khác. |
| `fetchBilling` (lỗi chung) | `{ success:false, error_code, message }` | `CUSTOMER_NOT_FOUND` không tự sửa được, hoặc `INVOICE_NOT_FOUND`/`PRODUCTION_NOT_FOUND` sau khi đã thử lùi kỳ, hoặc lỗi mạng/timeout từ `api.js` (`error_code: "TIMEOUT" | "CONNECTION_ERROR" | "INVALID_RESPONSE"`). |

Tất cả các payload trên (trừ nhánh lỗi chung cuối) đều có `doc_cho_khach` —
đây là **kịch bản** hệ thống muốn model đọc nguyên văn hoặc dựa vào để hành
động; xem README §11 về việc `message` khác `doc_cho_khach` như thế nào.

## `handleGetBill` — nơi duy nhất tiêu thụ `fetchBilling` (đường thành công)

```js
async function handleGetBill({ ma_danh_bo, ky, nam }, callState) {
  const f = await fetchBilling(ma_danh_bo, ky, nam, callState);
  if (!f.ok) return f.error;               // trả thẳng JSON lỗi, KHÔNG bọc thêm
  const parts = f.rows.map((d) => { ... }); // câu tóm tắt "Kỳ x/y: sản lượng...m³, tổng tiền...VNĐ, đã/chưa thanh toán"
  return JSON.stringify({
    success: true,
    message: parts.join("; ") + ".",         // hoặc "Không có dữ liệu hóa đơn."
    data: f.rows.map(simplifyRow),
  });
}
```

`simplifyRow(d)` (`tools.js`) rút gọn mỗi dòng thô thành object "sạch" cho
model đọc/tham chiếu ở các câu hỏi tiếp theo:

```json
{
  "ky": "7/2026",
  "san_luong_m3": 18,
  "tong_tien": "một triệu một trăm tám mươi nghìn hai trăm sáu mươi sáu đồng",
  "tong_tien_so": 1180266,
  "trang_thai_thanh_toan": "Đã thanh toán",
  "ngay_thanh_toan": "30/06/2026"
}
```

Lý do các phép biến đổi trong `simplifyRow`:
- `tong_tien` viết THÀNH CHỮ (`docTienVN`) — TTS đọc sai chuỗi số có dấu chấm
  ngăn cách nghìn (`"1.180.266 đồng"` bị đọc nhầm thành `"một nghìn..."`).
  `tong_tien_so` giữ số thô để tham chiếu/log, **không** để model đọc trực
  tiếp.
- `ngay_thanh_toan` format `DD/MM/YYYY` (`fmtNgay`) — model mini khó tự parse
  chuỗi ISO `"2026-06-30 15:14:54"`; `null` nếu chưa thanh toán.
- `DonViThanhToan` bị **bỏ hẳn** — mã nội bộ (vd `"GDGV"`) không có bảng
  mapping ra tên dễ hiểu, gây nhiễu nếu lộ ra cho khách.

## Ví dụ payload `handleGetBill` trả về (thành công, 1 kỳ)

```json
{
  "success": true,
  "message": "Kỳ 7/2026: sản lượng 18 m³, tổng tiền một triệu một trăm tám mươi nghìn hai trăm sáu mươi sáu đồng, đã thanh toán ngày 30/06/2026.",
  "data": [
    {
      "ky": "7/2026",
      "san_luong_m3": 18,
      "tong_tien": "một triệu một trăm tám mươi nghìn hai trăm sáu mươi sáu đồng",
      "tong_tien_so": 1180266,
      "trang_thai_thanh_toan": "Đã thanh toán",
      "ngay_thanh_toan": "30/06/2026"
    }
  ]
}
```

## Ví dụ payload lỗi (không có dữ liệu kỳ đó, sau khi đã tự lùi 1 kỳ)

```json
{
  "success": false,
  "error_code": "INVOICE_NOT_FOUND",
  "message": "Không tìm thấy hóa đơn cho kỳ yêu cầu."
}
```

`system-prompt.js` dạy model xử lý đúng `error_code` này: báo khách "kỳ này
chưa có dữ liệu", **không** yêu cầu đọc lại danh bộ (khác `CUSTOMER_NOT_FOUND`,
vốn gợi ý danh bộ có thể nghe sai).

`handleCompareUsage`/`handleGetOutages` (cùng file) đi qua `resolveDanhBo`
tương tự nhưng **không** dùng `fetchBilling` — mỗi hàm tự gọi API tương ứng
(`getSoSanhTangGiam`/`getThongBaoCupNuoc`) sau khi có `rs.value`.
