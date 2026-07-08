# Changelog cải thiện chất lượng cuộc gọi — 08/07/2026

Thực hiện theo [plan_fix_callquality_20260708.md](plan_fix_callquality_20260708.md).
Tất cả các mục trong plan đã triển khai xong; `node --check` pass cả 4 file.

## Files thay đổi

| File | Mục | Nội dung |
|---|---|---|
| `src/system-prompt.js` | 0, 2, 3b | Enum description + quy tắc thủ tục + quy tắc im lặng |
| `src/tools.js` | 1 | Giữ ngữ nghĩa MỘT-TRONG/ĐẦY-ĐỦ trong kết quả `get_procedure_info` |
| `src/session-ws.js` | 3a, 4 | VAD threshold 0.6 + debug log VAD/response lifecycle |
| `src/conversation-logger.js` | 4f | 3 chỉ số chẩn đoán mới trong `stats` |

## Chi tiết

### Mục 0 (đã làm trước, sáng 08/07) — `src/system-prompt.js`
- Description tool `get_procedure_info`: bỏ "đăng ký" (gây neo sai sang
  `dinh_muc_nuoc`), đổi thành "Lấy hướng dẫn thủ tục hành chính về cấp nước (...)".
- Enum `loai_thu_tuc`: thêm từ khóa nhận diện từng giá trị, ghi rõ
  `dinh_muc_nuoc` chỉ áp dụng hộ gia đình.
- ✅ Đã xác nhận hiệu quả ở cuộc gọi 08/07 07:47: chọn đúng `lap_dat_dong_ho`.

### Mục 1 — `src/tools.js` (`handleGetProcedureInfo`)
- `docsText` tách riêng: `required` → "CẦN ĐẦY ĐỦ các giấy tờ sau: ...",
  `options` → "CHỈ CẦN MỘT trong các giấy tờ sau: ...".
- Trước đây gộp phẳng 2 danh sách, bỏ rơi `note` → AI trả lời mâu thuẫn
  "cần hết hay cần một" (cuộc gọi 08/07).
- Không đổi `huongdanthutuc-data.js` (data đã đúng sẵn).
- Đã test: hộ gia đình ra "CHỈ CẦN MỘT", doanh nghiệp ra "CẦN ĐẦY ĐỦ".

### Mục 2 — `src/system-prompt.js` (SYSTEM_PROMPT, section mới "# Hướng dẫn thủ tục")
- Luôn nói rõ "chỉ cần MỘT" / "cần ĐẦY ĐỦ" theo đúng kết quả tool.
- Danh sách > 4 loại giấy tờ: không đọc nguyên văn, nói số lượng + vài loại
  phổ biến, hỏi khách thuộc trường hợp nào.
- Khách hỏi cùng thủ tục cho đối tượng khác → gọi lại tool ngay, không đề
  nghị chuyển máy/tạo phiếu.

### Mục 3a — `src/session-ws.js` (turn_detection)
- `threshold: 0.5 → 0.6`. Giữ nguyên `prefix_padding_ms: 500` (tránh mất chữ
  số đầu danh bộ) và `silence_duration_ms: 1200`.
- Điều chỉnh tiếp theo dữ liệu: còn phantom turn → 0.7; khách phàn nàn
  "bot không nghe thấy" → về 0.5.

### Mục 3b — `src/system-prompt.js` (section "# Phong cách", 2 dòng mới)
- Khách im lặng: chờ, không tự nhắc lại; hỏi "còn nghe máy không" tối đa 1 lần.
- Không tự trả lời lại cùng một ý với cách diễn đạt khác.

### Mục 4 — `src/session-ws.js` + `src/conversation-logger.js` (debug log)
Event mới trong timeline JSON:
- `vad_speech_started` / `vad_speech_stopped` — mỗi lần VAD kích hoạt.
- `empty_transcript` — VAD kích hoạt nhưng transcript rỗng (phantom turn).
- `response_created` — mỗi response model tạo (kèm response id).
- `response_create_sent` — code chủ động gửi `response.create` (detail:
  `tool_result: <tên tool>`); đối chiếu với `response_created` để biết response
  nào do VAD kích hoạt.
- `response_cancelled` / `response_failed` / `response_incomplete` — response
  không hoàn tất (khách ngắt lời, lỗi...), kèm `status_details`.
- `transcription_failed` — ghi vào `errors`.

Chỉ số mới trong `stats` (đếm từ events lúc save):
- `vadTurnCount` — số lần VAD kích hoạt. Khỏe: ≈ `customerTurns`.
- `emptyTranscriptCount` — số phantom turn. Khỏe: ≈ 0.
- `cancelledResponseCount` — số response bị ngắt/hủy/lỗi.

## Cách kiểm chứng sau cuộc gọi test

1. Mở file JSON mới trong `conversation_summary/2026/07/...`.
2. Xem `stats`: `vadTurnCount` so với `customerTurns`, `emptyTranscriptCount`.
3. Kịch bản test đề xuất:
   - "Thủ tục gắn đồng hồ nước cho hộ gia đình" → hỏi "cần hết hay một cái?"
     → AI phải trả lời nhất quán "chỉ cần MỘT trong".
   - "Còn doanh nghiệp?" → AI gọi lại tool ngay, không đề nghị chuyển máy.
   - Đọc danh bộ 11 số → threshold 0.6 không được cắt mất số đầu.
   - Im lặng 30–60s → AI không tự nói quá 1 lần.

## Rollback

Các mục độc lập, revert riêng từng file được. VAD: đổi `threshold` về `0.5`
tại `src/session-ws.js` (trong `session.update`, khối `turn_detection`).

---

## Kết quả kiểm chứng — cuộc gọi test 08/07/2026 08:38

Log: `conversation_summary/2026/07/08/0967777637_DzBXPftfWBElUbKx0LT9h.json`
(301s, 2 tool call, outcome disconnected — khách chào tạm biệt rồi cúp).

| Fix | Kết quả |
|---|---|
| Mục 1 (MỘT-TRONG/ĐẦY-ĐỦ) | ✅ Tool trả "CHỈ CẦN MỘT"/"CẦN ĐẦY ĐỦ"; AI nhất quán suốt cuộc gọi, khách hỏi xác nhận 2 lần đều đúng |
| Mục 2 (danh sách dài) | ✅ AI nói "Có khoảng 10 loại giấy tờ, chỉ cần một trong số đó. Ví dụ như..." thay vì đọc nguyên văn |
| Mục 2 (đối tượng khác) | ✅ Khách hỏi "còn doanh nghiệp?" → gọi tool ngay, không đề nghị chuyển máy |
| Mục 3 (lặp lời) | ✅ aiTurns/customerTurns: 12/5 → 20/15; hết chuỗi 4 lượt AI tự nói; khách im lặng → hỏi "còn nghe máy" đúng 1 lần |
| Mục 4 (debug log) | ✅ stats mới: vadTurnCount=19, emptyTranscriptCount=4, cancelledResponseCount=3; timeline thấy rõ phantom turn và response bị hủy (turn_detected) |

**Tồn đọng** (xem [plan_fix_callquality_v2_20260708.md](plan_fix_callquality_v2_20260708.md)):
1. Còn 4 phantom turn với threshold 0.6; đáng chú ý là pattern "chào đúp"
   (phantom ngay sau câu chào → AI chào lần 2) xuất hiện ở cả 3 cuộc gọi.
2. AI bịa nhẹ khi khách hỏi ngoài data: "hợp đồng thuê nhà dài hạn với cá
   nhân/tổ chức cho thuê" trong khi data là "thuê nhà CỦA NHÀ NƯỚC dài hạn".
3. Khách chào tạm biệt nhưng AI không gọi end_call → outcome disconnected.
4. "bye bye" bị transcribe thành "拜拜" dù đã set language "vi".
5. cached_text_tokens = 0 ở cả 3 cuộc gọi → chưa tận dụng prompt caching,
   chi phí text input tăng theo độ dài cuộc gọi.

---

# Đợt 2 — triển khai chiều 08/07/2026

Theo [plan_fix_callquality_v2_20260708.md](plan_fix_callquality_v2_20260708.md).
`node --check` pass.

**Nguyên tắc ghi nhớ** (từ chủ dự án): input transcript của khách có thể
KHÔNG chính xác — chỉ dùng để log/debug, KHÔNG dùng làm căn cứ xử lý nghiệp
vụ. Model realtime nghe audio trực tiếp, không phụ thuộc transcript.

### Mục 1a — `src/system-prompt.js` (Phong cách, 2 dòng mới)
- Sau câu chào đầu tiên, chỉ nghe tạp âm → im lặng chờ, không chào lần hai.
- Âm thanh không phải lời nói rõ ràng (tạp âm/thở/echo) → không phản hồi.

### Mục 2 — `src/system-prompt.js` (Hướng dẫn thủ tục, 1 dòng mới)
- Chỉ nêu giấy tờ đúng nguyên văn kết quả tool, không diễn giải rộng
  ("thuê nhà của Nhà nước" ≠ "thuê của tư nhân"). Không khớp danh sách →
  nhận là chưa chắc chắn, mời chuyển máy/tạo phiếu.

### Mục 3 — `src/system-prompt.js`
- Section mới "# Kết thúc cuộc gọi": khách chào tạm biệt → chào ngắn gọn rồi
  GỌI end_call trong cùng lượt, không chờ khách cúp.
- Description tool `end_call`: "GỌI NGAY khi khách chào tạm biệt hoặc hết
  nhu cầu, sau khi đã nói lời chào tạm biệt."

### Mục 4 — `src/call-manager.js` (accept body)
- Thêm `prompt` cho `audio.input.transcription`: ngữ cảnh tổng đài cấp nước
  TP.HCM, tiếng Việt, mã danh bộ 11 số, tên thủ tục → giảm transcribe sai
  ngôn ngữ. Transcript vẫn chỉ phục vụ log/debug.

### Chưa làm (chờ dữ liệu)
- Mục 1b: threshold 0.6 → 0.7 nếu sau 3–5 cuộc `emptyTranscriptCount` vẫn ≥ 3.
- Mục 1c: semantic_vad (phương án cuối).
- Mục 5: điều tra prompt caching = 0.

### Kiểm chứng cuộc gọi tiếp theo
1. Nghe chào xong im lặng 5–10s → AI không chào lần 2.
2. "Tôi thuê nhà của tư nhân" → AI không bịa, đề nghị chuyển máy/tạo phiếu.
3. Kết thúc "cảm ơn em, bye" → outcome = "completed" (AI tự end_call).
4. Transcript không còn chữ Hán.
5. So sánh stats: emptyTranscriptCount, vadTurnCount vs customerTurns.
