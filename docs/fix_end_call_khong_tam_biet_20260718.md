# Fix: end_call không có lời tạm biệt — khách nghe 5s im lặng rồi bị cúp (18/07/2026)

## Cuộc gọi phát hiện lỗi

`rtc_u1_E2tY3rg44dIiQOsBGYFsi` (0967777637, 18/07/2026 14:14) — khách hỏi thủ tục
nâng/dời đồng hồ, cuộc gọi diễn ra tốt cho đến lúc kết thúc.

## Hiện tượng

| Thời điểm | Sự kiện |
|-----------|---------|
| 14:16:25.488 | KH: "Tạm biệt, hẹn gặp lại." |
| 14:16:25.742 | Tool call `end_call` — response **chỉ có function_call, không có audio** |
| 14:16:25 → 14:16:30 | **Không có dòng `[AI nói]` nào** — khách nghe 5s im lặng |
| 14:16:30 | Hangup |

## Nguyên nhân gốc

Code cố tình KHÔNG gửi `response.create` sau `end_call` (tránh lỗi
`conversation_already_has_active_response`) vì **giả định** model luôn nói lời
tạm biệt trong cùng response chứa `end_call`. Model mini không phải lúc nào cũng
làm vậy — cuộc này nó gọi tool "khô", không kèm audio.

Lưu ý: giả định của guard cũ chỉ sai ở vế "luôn". Khi model ĐÃ nói tạm biệt thì
gửi thêm `response.create` vẫn gây lỗi như cũ — nên không thể gửi vô điều kiện.

## Cách fix (deterministic, trong `session-ws.js`)

Tại `response.done`, nhánh `end_call`: kiểm tra mảng `output` của chính response
đó có item `type: "message"` chứa `output_audio` không.

- **Có audio** → model đã nói tạm biệt → giữ nguyên: hangup sau 5s, KHÔNG gửi
  `response.create`.
- **Không có audio** → `response.done` đã về nên không còn active response →
  gửi `response.create` với câu tạm biệt CỐ ĐỊNH, ép đọc nguyên văn (cùng cơ chế
  với câu chào và `doc_cho_khach` — cách duy nhất mini tuân thủ 100%):

  > "Dạ, em cảm ơn Quý Khách đã gọi đến Tổng đài Công ty Cổ phần Cấp nước
  > Trung An. Kính chào Quý Khách ạ."

  và lùi hangup 5s → **8s** (câu tạm biệt ~5-6s + latency tạo response).
  Set `_pendingCodeResponse = true` trước khi gửi để response này được đánh dấu
  "do code tạo" (khớp cơ chế attribution của fix echo-cancel cùng ngày, xem
  [fix_echo_cancel_nham_response_20260718.md](fix_echo_cancel_nham_response_20260718.md)).

### Event log mới

- `goodbye_forced` — xuất hiện khi response `end_call` không kèm audio và code
  phải tự tạo câu tạm biệt. Thấy event này trong conversation_summary = fix đang
  hoạt động; nếu xuất hiện quá thường xuyên nghĩa là mini bỏ lời tạm biệt gần
  như mặc định (cân nhắc luôn ép câu tạm biệt cố định cho nhất quán).

## Không đổi

- `transfer_to_agent` giữ nguyên (chưa ghi nhận cuộc nào chuyển máy "câm";
  nếu gặp, áp cùng pattern).
- Guard `_hungUp` chống end_call trùng giữ nguyên.
- Quy tắc "hangup 404 coi như thành công" không liên quan, giữ nguyên.

## Kiểm chứng

- `node --check src/session-ws.js` — pass.
- Hồi quy qua cuộc gọi thật:
  - Khách chào tạm biệt → model nói lời kết như thường lệ: KHÔNG thấy
    `goodbye_forced`, hangup sau 5s (hành vi cũ).
  - Model gọi end_call "khô": thấy `goodbye_forced`, nghe được câu tạm biệt,
    hangup sau 8s, KHÔNG có lỗi `conversation_already_has_active_response`
    trong events.

## File thay đổi

- `src/session-ws.js` — nhánh `action === "end_call"` trong `response.done`.
