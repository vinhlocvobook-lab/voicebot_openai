# Fix 19/07/2026 — Lấy mã danh bộ theo nhóm 4-4-3 ngay từ đầu

## Cuộc gọi lỗi

`rtc_u1_E2yeCWEsecOlWrgBM8CW1` (18/07 19:41, log: `conversation_summary/2026/07/18/0967777637_E2yeCWEsecOlWrgBM8CW1.json`)

- Khách đọc đủ 11 số nhưng tách 2 hơi (`220232` + `47431`), VAD cắt thành 2 turn.
- Model chỉ lấy cụm cuối, còn chép sai số (`47431` → `43243`), gọi `confirm_danh_bo("43243")`.
- Code chuyển sang chế độ nhóm 4-4-3 (đúng thiết kế cũ), nhưng model không đọc
  nguyên văn `doc_cho_khach` mà tự bịa "em nghe được nhóm số vừa rồi là 43243…
  đọc nhóm tiếp theo" → khách và state machine lệch pha, khách cúp máy.
- Nhận xét chung: bước **chuyển giữa chừng** từ "đọc liền 11 số" sang "đọc theo
  nhóm" không mượt, gây rối cho khách.

## Thay đổi

Bỏ hẳn bước "nghe liền 11 số rồi mới chuyển nhóm". Luồng mới: **luôn dẫn dắt
4-4-3 ngay từ đầu**, xác nhận ngầm từng nhóm (đọc lại nhóm + xin nhóm kế trong
cùng câu), chốt xác nhận toàn bộ 1 lần khi đủ 11 số.

### `src/tools.js`

- `handleConfirmDanhBo`: mọi lượt có chữ số (trừ khi đủ 11 số) đều đi qua
  `handleGuidedGroup`; tự khởi tạo `_danhBoGuided` nếu chưa có. Khách lỡ đọc
  liền đủ 11 số → vẫn nhận luôn (`acceptFullDanhBo`).
- `invalidDanhBoResponse`: chỉ còn dùng khi CHƯA nhận được chữ số nào (model
  gọi tool tay không / gọi thẳng tool tra cứu) → khởi tạo guided mode, xin đúng
  nhóm đang cần; có lưu `_danhBoLastPrompt` (cơ chế re-assert của session-ws
  hoạt động từ bước đầu tiên).
- Xóa `guidedStartResponse` + 2 nhánh `soLanSai === 1/2` (dead code).
- `resolveDanhBo`: truyền `callState` vào `invalidDanhBoResponse`.

### `src/system-prompt.js`

- Thêm rule: LUÔN lấy danh bộ theo từng nhóm, câu xin mã chuẩn hóa nguyên văn
  "…Quý Khách đọc giúp em bốn số đầu của mã danh bộ ạ." — không yêu cầu đọc cả
  11 số một lần.

## Đã test (node, `dispatchTool` trực tiếp)

- Luồng chuẩn 4+4+3 → chốt đúng `22023247431`.
- Đọc liền 11 số ngay lần đầu → nhận luôn.
- Lần đầu đọc 5 số → yêu cầu đọc lại 4 số đầu (không còn câu "cần mười một số").
- `sua_nhom_vua_roi` giữa chừng → thay đúng nhóm 2, giữ nhóm 1.
- `get_bill` khi chưa có số → xin 4 số đầu, guided mode bật.
- Sai độ dài nhóm quá 2 lần → escalation (chuyển máy / tạo phiếu).

## Vấn đề còn lại (chưa xử lý trong fix này)

1. VAD cắt dãy số khi khách ngắt hơi — cân nhắc tăng `silence_duration_ms`
   trong lúc chờ danh bộ.
2. Model không đọc nguyên văn `doc_cho_khach` dù đã có instructions override —
   cân nhắc out-of-band response (`conversation: "none"`).
3. Phương án DTMF (bấm phím) cho bước nhập danh bộ.
