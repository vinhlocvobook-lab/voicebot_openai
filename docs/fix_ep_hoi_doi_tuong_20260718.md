# Fix: Ép hỏi đối tượng — chặn model tự đoán doi_tuong lượt đầu (18/07/2026)

## Cuộc gọi phát hiện lỗi

`rtc_u1_E2u70cuT94h0rwpLAKOyA` (test2_santendhn_giadinh, 18/07/2026 14:51) —
khách hỏi sang tên đồng hồ, KHÔNG nói mình là hộ gia đình hay doanh nghiệp.

## Hiện tượng

Model gọi tool ngay lượt đầu với `doi_tuong: "ho_gia_dinh"` **tự đoán** — bỏ qua
luồng `can_hoi_doi_tuong` (so sánh: cuộc test1 cùng kịch bản model hỏi đúng
"hộ gia đình hay doanh nghiệp ạ?" rồi mới gọi lại). Test này trùng hợp đúng,
nhưng nếu khách là doanh nghiệp thì bị đọc nhầm hướng dẫn hộ gia đình — trong
khi doanh nghiệp phải chuyển tổng đài viên.

## Nguyên nhân

Rule "KHÔNG tự đoán" chỉ nằm trong prompt/message của tool — mini không tuân thủ
ổn định (đúng như quy ước dự án: fix hành vi phải deterministic bằng code).
Code không thể biết khách đã nói đối tượng hay chưa (không dựa vào transcript —
transcript chỉ để debug), nên định nghĩa deterministic của "đã biết":

> `doi_tuong` chỉ được chấp nhận SAU KHI tool đã trả `can_hoi_doi_tuong`
> (tức model đã được lệnh hỏi khách) cho thủ tục đó trong CÙNG cuộc gọi.

## Cách fix

### 1. State theo cuộc gọi cho tool handler

- `dispatchTool(name, args, callState = {})` — thêm tham số thứ 3.
- `session-ws.js` tạo `const _toolCallState = {}` cho mỗi cuộc gọi và truyền vào
  mọi `dispatchTool`. State sống suốt cuộc gọi, tự hủy khi WS đóng.

### 2. Guard trong `handleGetProcedureInfo` (`src/tools.js`)

Với thủ tục có hướng dẫn khác nhau theo đối tượng (`coPhanBietDoiTuong` — hiện
là lắp đặt và sang tên):

- `callState.daHoiDoiTuong` = Set các `loai_thu_tuc` đã được tool yêu cầu hỏi.
- Lượt gọi kèm `doi_tuong` nhưng thủ tục CHƯA có trong Set → **bỏ qua**
  `doi_tuong`, trả `can_hoi_doi_tuong` như khi thiếu (log warn
  "Bỏ qua doi_tuong=... (model tự đoán, chưa hỏi khách)").
- Trả `can_hoi_doi_tuong` → add thủ tục vào Set → lượt gọi lại kèm `doi_tuong`
  được chấp nhận bình thường.

Không đụng: `nang_doi_dong_ho` (một hướng dẫn chung), `dinh_muc_nuoc`
(`apDung` riêng), `check_missing_docs` (chạy sau khi đã tư vấn).

## Trade-off chấp nhận

Nếu khách nói rõ ngay từ đầu ("sang tên cho công ty tôi") thì vẫn bị hỏi lại
một lần "hộ gia đình hay doanh nghiệp ạ?" — thêm 1 lượt hỏi nhưng đổi lấy chắc
chắn 100% không tư vấn nhầm đối tượng.

## Cập nhật v2 (18/07) — câu ép hỏi đổi thành câu XÁC NHẬN

### Cuộc gọi lộ trade-off

`rtc_u1_E2uLXv4UbNfF0Do3JAccO` (test1_DangKyDongHoNuoc_HoGiaDinh, 15:06):
model **tự hỏi** "hộ gia đình hay doanh nghiệp ạ?" bằng lời của nó (không gọi
tool trước), khách trả lời "cho gia đình", model gọi tool kèm `doi_tuong` →
guard chặn đúng thiết kế → hỏi mở lần nữa → **khách phải trả lời trùng 2 lần**.

### Tinh chỉnh

Code không phân biệt được "model đã hỏi thật" với "model đoán bừa" (cùng dạng
args, không dùng transcript). Thay vì hỏi mở lại, khi guard chặn `doi_tuong`
tool trả câu **xác nhận** giá trị model gửi:

> "Dạ, em xin xác nhận lại: Quý Khách đăng ký cho hộ gia đình, phải không ạ?"

- Model đã hỏi thật → khách chỉ cần "đúng rồi" (nhẹ hơn hẳn trả lời lại).
- Model đoán bừa sai → khách sửa ngay → model gọi lại với doi_tuong khách nói
  (được chấp nhận vì thủ tục đã vào Set).
- Vẫn an toàn 100%: đối tượng luôn qua lời khách xác nhận.
- Kết quả tool có thêm trường `xac_nhan_doi_tuong` để nhận diện nhánh này
  trong log.
- Model gọi tool KHÔNG kèm `doi_tuong` (luồng chuẩn) → vẫn câu hỏi mở như cũ.

### Kiểm chứng v2 (4/4 pass)

Lượt đầu kèm doi_tuong → câu xác nhận; khách xác nhận → trả hướng dẫn; khách
sửa thành doanh nghiệp → chuyển tổng đài viên; không kèm doi_tuong → hỏi mở.

## Kiểm chứng (đã chạy, 6/6 pass)

| # | Tình huống | Kết quả |
|---|-----------|---------|
| 1 | Đoán `doi_tuong` ngay lượt đầu (bug test2) | Ép hỏi ✅ |
| 2 | Gọi lại sau khi hỏi (hộ gia đình) | Trả hướng dẫn ✅ |
| 3 | Thủ tục KHÁC cùng cuộc gọi, đoán ngay | Ép hỏi riêng ✅ |
| 4 | Lắp đặt doanh nghiệp sau khi hỏi | Chuyển tổng đài viên ✅ |
| 5 | Nâng/dời kèm `doi_tuong` (không phân biệt) | Không bị chặn ✅ |
| 6 | Luồng chuẩn 2 bước như test1 | Không đổi ✅ |

## File thay đổi

- `src/tools.js` — `dispatchTool` nhận `callState`; guard trong
  `handleGetProcedureInfo`.
- `src/session-ws.js` — tạo `_toolCallState` và truyền vào `dispatchTool`.
