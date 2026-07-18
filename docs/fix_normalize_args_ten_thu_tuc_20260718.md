# Fix: normalizeProcedureArgs trượt pattern "key thủ tục + value tên thủ tục" (18/07/2026)

## Cuộc gọi phát hiện lỗi

`rtc_u2_E2u0Db8u91GWMPBYS9aj4` (test1_santendhn_giadinh, 18/07/2026 14:43) —
khách hỏi sang tên đồng hồ cho hộ gia đình.

## Hiện tượng

Nửa đầu cuộc gọi đúng kịch bản: gọi tool → `can_hoi_doi_tuong` → hỏi "hộ gia
đình hay doanh nghiệp". Khách trả lời "hộ gia đình" → model gọi lại tool với
args dị dạng:

```json
{"doi_tuong":"ho_gia_dinh","dinh_muc_nuoc":"N/A","lap_dat_dong_ho":"N/A","sang_ten_dong_ho":"Sang tên đồng hồ nước","nang_doi_dong_ho":"N/A"}
```

Thiếu `loai_thu_tuc`. Chuẩn hoá trượt → tool báo `ngoai_pham_vi` → bot nói
"em không có thông tin về yêu cầu này" dù khách hỏi đúng 1 trong 4 thủ tục hỗ
trợ → khách cúp máy.

## Vì sao 3 bước chuẩn hoá cũ đều trượt

Pattern mới của mini: **đệm cả 4 key thủ tục bằng `"N/A"`, key được chọn mang
value là TÊN thủ tục đầy đủ**.

| Bước | Vì sao trượt |
|------|--------------|
| 1. Key sai dấu | Không có key nào canon ra `loai_thu_tuc` |
| 2. Quét value khớp id | `canonValue("Sang tên đồng hồ nước")` = `sang_ten_dong_ho_nuoc` ≠ id `sang_ten_dong_ho` (thừa `_nuoc`) |
| 3. Cờ boolean | Value `"Sang tên đồng hồ nước"` không phải `true/1/"true"/"1"` |

## Fix: thêm 2 lớp vá trong `normalizeProcedureArgs` (`src/tools.js`)

Vẫn triết lý cũ: deterministic, chỉ nhận khi khớp ĐÚNG MỘT ứng viên (không đoán
bừa).

- **2b — value CHỨA id**: canon value chứa đúng một id thủ tục
  (`sang_ten_dong_ho_nuoc`.includes(`sang_ten_dong_ho`)). An toàn vì 4 id không
  chứa lẫn nhau.
- **3b — key là id + value có nghĩa**: key canon ra id thủ tục và value KHÔNG
  phải marker rỗng (`"N/A"`, `"na"`, `""`, `"null"`, `"none"`, `"khong"`,
  `"false"`, `"0"`, `null`, `false`, `0`) → đó là lựa chọn của model. Áp dụng
  cho cả `loai_thu_tuc` lẫn `doi_tuong`.

Cả `handleGetProcedureInfo` và `check_missing_docs` (dùng chung
`normalizeProcedureArgs`) đều hưởng fix.

## Kiểm chứng (đã chạy)

| Args | Kết quả |
|------|---------|
| Pattern bug hôm nay (4 key N/A + tên thủ tục) | ✅ OK: Sang tên đồng hồ nước, đúng case hộ gia đình |
| `type: "nang_doi_dong_ho"` + N/A padding (cuộc sáng 18/07) | ✅ OK (hồi quy) |
| Args chuẩn `loai_thu_tuc` + `doi_tuong` | ✅ OK (hồi quy) |
| Cờ boolean (fix 13/07) | ✅ OK (hồi quy) |
| Key sai dấu `loại_thu_tuc` (fix 11/07) | ✅ OK (hồi quy) |
| Rác hoàn toàn (`thu_tuc: "tạm ngưng nước"`) | ✅ Vẫn `ngoai_pham_vi` — không đoán bừa |

## Lịch sử các pattern args sai của mini (get_procedure_info)

| Ngày | Cuộc | Pattern | Fix |
|------|------|---------|-----|
| 11/07 | E0UYAPzruSwXtEvyqt0sx | Key có dấu `loại_thu_tuc` | Bước 1 (canon key) |
| 13/07 | E11HysUBZhNRGG2XKE6AD | Cờ boolean `{lap_dat_dong_ho: true}` | Bước 3 |
| 18/07 sáng | E2ou4DurIiPbGRvrrggKr | `type` thay `loai_thu_tuc` + N/A padding | Bước 2 (đã có) |
| 18/07 chiều | E2u0Db8u91GWMPBYS9aj4 | Key id + value tên thủ tục + N/A padding | Bước 2b + 3b (fix này) |

## File thay đổi

- `src/tools.js` — `normalizeProcedureArgs`: thêm bước 2b và 3b.
