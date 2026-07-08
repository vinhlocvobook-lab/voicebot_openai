# Review cuộc gọi 05/07/2026 & đề xuất cải tiến

Call: `rtc_u1_Dy7mletgyI8FcpiCPuxzL` · 10:26–10:30 (223s) · $0.147 · Trạng thái: **đề xuất, chưa triển khai**

Log: `conversation_summary/2026/07/05/0967777637_Dy7mletgyI8FcpiCPuxzL.json`

## Hoạt động tốt (xác nhận các fix ngày 04/07)

- Fallback lùi kỳ chạy đúng: không truyền ky/nam → tự về 6/2026, bot không phải hỏi lại kỳ như cuộc gọi trước.
- Model gọi đúng `get_payment_status` khi khách thắc mắc "đã đóng rồi mà báo chưa".
- Data đơn giản hóa (`san_luong_m3`, `tong_tien` format sẵn) được model dùng đúng ở các câu hỏi tiếp theo.
- `end_call` kích hoạt đúng khi khách chào tạm biệt.

## Đề xuất cải tiến (theo mức ưu tiên)

### 1. Rule prompt: hỏi lại khi không chắc ý — `system-prompt.js`

Hiện tượng (10:27:53): khách hỏi "bao nhiêu khối" (audio nhiễu, transcript ghi "xài nhiều game") → AI trả lời SỐ TIỀN; khách phải hỏi lại 2 lần.

Đề xuất thêm vào `# Trả lời từ kết quả tra cứu`:

```
- Khách hỏi "khối"/"mét khối"/"sản lượng" → trả lời san_luong_m3; hỏi "tiền" → tong_tien. Không chắc khách hỏi gì → hỏi lại ngắn gọn, KHÔNG đoán rồi trả lời thứ khác.
```

### 2. Xử lý khách khẳng định đã thanh toán nhưng hệ thống báo chưa — `system-prompt.js`

Hiện tượng (10:27:32): AI recheck rồi chỉ khuyên khách "tự kiểm tra biên nhận" — không đề nghị tạo phiếu/chuyển máy.

Đề xuất thêm mục:

```
# Khách báo đã thanh toán nhưng hệ thống ghi nhận chưa
- Giải thích: thanh toán qua app/ngân hàng có thể cần 1-2 ngày để gạch nợ. [⚠️ CẦN XÁC NHẬN NGHIỆP VỤ với Trung An trước khi thêm dòng này]
- Chủ động đề nghị: tạo phiếu ghi nhận (create_ticket, loai=khieunai) HOẶC chuyển tổng đài viên. Không để khách tự xoay.
```

### 3. Giải thích cách tính tiền nước — gap lớn nhất cuộc gọi

Hiện tượng (10:28:35 → 10:29:24): khách hỏi 3 lần "62 khối sao ra 1,18 triệu?", AI chỉ nói chung chung "bậc thang" rồi đẩy khách tự xem hóa đơn. Summary tự chấm cuộc gọi "trung bình" vì lý do này.

**✅ ĐÃ TRIỂN KHAI (2026-07-05) theo quyết định:** bot CHƯA có biểu giá nước → nội dung này NGOÀI phạm vi. Đã thêm rule vào `# Phạm vi` (`system-prompt.js`): không tự giải thích/nêu nguyên tắc chung; báo khách ngoài phạm vi và mời chọn chuyển tổng đài viên (transfer_to_agent) hoặc tạo phiếu (create_ticket) để nhân viên liên hệ lại.

Hướng mở rộng sau (chưa làm):
- Tạo `src/giabieunuoc-data.js` + tool `get_price_info` khi có biểu giá hiện hành của Trung An → đưa nội dung này VÀO phạm vi.
- Dài hạn: endpoint backend chi tiết hóa đơn (breakdown theo bậc + thuế + phí).

### 4. Cache API trong tools.js

Hiện tượng: 2 tool call cách nhau 28s cùng danh bộ → 4 HTTP request giống hệt (mỗi lần đều chạy lại no-ky → NOT_FOUND → fallback kỳ trước).

Đề xuất: cache module-level theo key `(danhba, ky, nam)`, TTL ~60s, trong `fetchBilling`; cache cả kết quả "kỳ hiện tại NOT_FOUND" để khỏi thử lại. Giảm tải backend, bớt ~100ms/lượt.

### 5. (Ghi nhận) Chi phí prompt

`cached_text_tokens = 0` — system prompt ~2k token bị tính lại đủ giá cho cả 16 response ($0.019 text input/cuộc). Rule mới thêm cần viết ngắn; nếu prompt phình thêm, cân nhắc rà soát/gộp các mục.

### 6. ✅ ĐÃ TRIỂN KHAI (2026-07-05): đọc số tiền thành chữ

Hiện tượng (call `rtc_u1_Dy8Rut8ygtrh0cOgNJan4`, 11:08): TTS đọc "1.180.266 đồng" sai — khách nghe thành "một ngàn" ("Ủa sáu mươi hai khối mà sao có một ngàn?"). Dấu chấm ngăn cách nghìn bị TTS hiểu nhầm.

Fix (chọn phương án format thành chữ, tin cậy hơn bỏ format):
- `tools.js`: thêm `docTienVN(n)` — 1180266 → "một triệu một trăm tám mươi nghìn hai trăm sáu mươi sáu đồng" (xử lý đúng mốt/lăm/lẻ/không trăm). Dùng trong message của cả 3 handler billing và `simplifyRow` (`tong_tien` = chữ, thêm `tong_tien_so` = số raw để tham chiếu).
- `system-prompt.js`: thêm rule "số tiền đã viết thành chữ → đọc nguyên văn, không tự quy đổi".
- Verify: test 12 case biên (21, 15, 105, 1000005, 2 tỷ...) đều đúng; end-to-end qua mock backend OK.

Ghi nhận thêm từ call này: rule "ngoài phạm vi biểu giá" (mục 3) và `transfer_to_agent` hoạt động đúng — khách hỏi cách tính, bot từ chối đúng kịch bản, đưa 2 lựa chọn, khách chọn chuyển máy và REFER thành công.

## Thứ tự triển khai gợi ý

1. Mục 1 + 2 (sửa prompt, ít rủi ro) — sau khi xác nhận nghiệp vụ gạch nợ ở mục 2.
2. Mục 4 (cache, độc lập).
3. Mục 3 khi có biểu giá nước.
