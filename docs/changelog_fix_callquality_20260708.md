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

---

## Kết quả kiểm chứng đợt 2 — cuộc gọi test 08/07/2026 10:51

Log: `conversation_summary/2026/07/08/0967777637_DzDbH1Hqkye3aPZefQmlz.json`
(172s, thủ tục nâng/dời đồng hồ, outcome disconnected).

| Fix đợt 1+2 | Kết quả |
|---|---|
| Phantom turn / chào đúp | ✅ emptyTranscriptCount = 0; vadTurnCount = customerTurns = 12; không chào đúp |
| Chọn thủ tục qua enum mới | ✅ "muốn DỊCH cái đồng hồ nước" → chọn đúng nang_doi_dong_ho |
| Transcribe sai ngôn ngữ | ✅ "bye bye" ra đúng, không còn chữ Hán |
| end_call khi khách chào | ❌ khách "cảm ơn anh, bye bye" → AI vẫn đáp "nếu cần thêm..." không gọi end_call |

**Vấn đề mới phát hiện:**
1. **Prompt echo**: transcription prompt (Mục 4 đợt 2) bị "dội" nguyên văn vào
   transcript làm 2 lượt khách giả khi audio im lặng/nhiễu — hành vi đã biết
   của gpt-4o-mini-transcribe. Chỉ ảnh hưởng log/stats/summary, không ảnh
   hưởng hội thoại (model nghe audio trực tiếp).
2. **Bịa TRƯỚC khi gọi tool**: AI tự đoán "cần khoảng ba đến bốn loại giấy tờ,
   ví dụ sổ đỏ..." rồi 20s sau mới gọi tool (data thật: không cần giấy tờ).
   Quy tắc "nguyên văn theo tool" đợt 2 chỉ chặn diễn giải SAU khi có kết quả.
3. Data `nang_doi_dong_ho` chứa chữ phiên âm TTS ("SA QUA CÔ", "Cê ét ka hát")
   lẫn trong message, trùng lặp phần kênh nộp hồ sơ — chưa sửa, chờ quyết định.

---

# Đợt 3 — triển khai trưa 08/07/2026

`node --check` pass. Files: `src/session-ws.js`, `src/conversation-logger.js`,
`src/system-prompt.js`.

### Mục 1 — Lọc prompt echo (`src/session-ws.js` + `src/conversation-logger.js`)
- Trong case `input_audio_transcription.completed`: transcript trùng (hoặc là
  đoạn con ≥ 20 ký tự của) transcription prompt → ghi event
  `transcript_prompt_echo`, KHÔNG gọi `addCustomerTurn` → không còn lượt khách
  giả trong transcript/summary.
- Giữ nguyên transcription prompt (đã sửa được lỗi chữ Hán).
- Stats mới: `promptEchoCount`.

### Mục 2 — Siết end_call (`src/system-prompt.js`, section "# Kết thúc cuộc gọi")
- Thêm: áp dụng CẢ KHI khách chào xen vào lúc AI đang nói.
- Thêm: khách đã chào tạm biệt → KHÔNG đáp "nếu cần thêm thông tin em sẵn
  sàng", phải kết thúc.

### Mục 3 — Cấm bịa trước khi gọi tool (`src/system-prompt.js`, "# Hướng dẫn thủ tục")
- Dòng đầu tiên mới: khách hỏi thủ tục → gọi tool TRƯỚC, có kết quả mới trả
  lời; tuyệt đối không đoán giấy tờ/bước thủ tục (kể cả "thường sẽ cần...").

### Kiểm chứng cuộc gọi tiếp theo
1. Hỏi thủ tục bất kỳ → AI gọi tool ngay, KHÔNG đoán giấy tờ trước.
2. Kết thúc "cảm ơn em, bye" (thử cả khi AI đang nói dở) → outcome "completed".
3. stats: `promptEchoCount` thay vì lượt khách giả; customerTurns = số lượt nói thật.
4. Theo dõi tiếp: emptyTranscriptCount (quyết định threshold 0.7 — Mục 1b plan v2),
   prompt caching = 0 (Mục 5 plan v2), dọn data nang_doi_dong_ho.

---

## Kết quả kiểm chứng đợt 3 — cuộc gọi test 08/07/2026 11:12

Log: `conversation_summary/2026/07/08/0967777637_DzDwV14fdUUdpAlAA2pRI.json`
(173s, hỏi định mức nước, outcome disconnected — khách cảm ơn rồi cúp ngay 2s
sau nên chưa kiểm chứng được end_call).

| Fix đợt 3 | Kết quả |
|---|---|
| Cấm bịa trước khi gọi tool | ✅ Khách hỏi → AI chỉ nói "em sẽ tra cứu", gọi tool sau 1s |
| Lọc prompt echo | ✅ promptEchoCount = 0, không còn lượt khách giả |
| VAD (duy trì) | ✅ vadTurnCount = customerTurns = 8, emptyTranscriptCount = 0 |
| end_call | ⏳ Chưa kiểm chứng được (khách cúp 2s sau lời cảm ơn) |

**Vấn đề mới:** AI tư vấn nghiệp vụ VƯỢT data — khách hỏi "8 người, 4 có hộ
khẩu 4 không, đăng ký được mấy người?" → AI khẳng định "đăng ký được tất cả"
trong khi data thủ tục không nói gì về số người được đăng ký. Rủi ro tư vấn
sai quy định.

---

# Đợt 4 — triển khai trưa 08/07/2026

`node --check` pass. File: `src/system-prompt.js`.

### Chặn tư vấn quy định/định lượng ngoài data ("# Hướng dẫn thủ tục", 1 dòng mới)
Câu hỏi về quy định/định lượng mà kết quả tool không trả lời trực tiếp
("đăng ký được mấy người?", "định mức bao nhiêu khối?", "chưa có tạm trú có
được tính không?") → không suy diễn/khẳng định; nói thật không có thông tin,
mời chuyển tổng đài viên hoặc tạo phiếu. (Cùng tinh thần quy tắc "cách tính
tiền nước" có sẵn trong section Phạm vi.)

### Kiểm chứng cuộc gọi tiếp theo
1. Hỏi "đăng ký định mức được mấy người?" → AI không khẳng định, đề nghị
   chuyển máy/tạo phiếu.
2. end_call: kết thúc bằng "cảm ơn em, bye" và CHỜ 5–10s không cúp máy →
   outcome phải là "completed".
3. Còn treo: threshold 0.7 (nếu phantom quay lại), prompt caching = 0,
   dọn chữ phiên âm TTS trong data nang_doi_dong_ho.

---

## Kết quả kiểm chứng đợt 4 — cuộc gọi test 08/07/2026 11:30

Log: `conversation_summary/2026/07/08/0967777637_DzEDGgHciPqxMjpQua61J.json`
(314s, hỏi định mức, **outcome = completed lần đầu tiên**).

| Fix | Kết quả |
|---|---|
| end_call | ✅ Khách chào lần 2 → AI chào + gọi end_call, outcome "completed" |
| Chặn suy diễn quy định (đợt 4) | ✅ Khách hỏi "8 người đăng ký được mấy?" 4 lần → AI kiên định không suy diễn, đề nghị chuyển máy |
| Lọc prompt echo | ✅ promptEchoCount = 4, không lượt khách giả nào lọt vào transcript |

**Tồn đọng:** phantom turn quay lại 4 lần/cuộc (giờ hiện dạng prompt echo thay
vì empty transcript) → 3 câu mở đầu liên tiếp đầu cuộc gọi + 1 đoạn AI nhắc
lại 2 lần. Đủ điều kiện Mục 1b plan v2 (threshold 0.7) — CHỜ DUYỆT.
Lỗi nhỏ: AI xưng "bạn" 1 câu; đọc "VNeID" thành "VnID".

---

# Đợt 5 — Cải thiện trả lời thủ tục định mức nước (08/07/2026)

Theo [plan_dinhmuc_nuoc_20260708.md](plan_dinhmuc_nuoc_20260708.md), dựa trên
tài liệu hướng dẫn chính thức + quy tắc nghiệp vụ do chủ dự án xác nhận.
`node --check` pass; test `dispatchTool` pass 6/6 điểm.

### Mục 1 — `src/huongdanthutuc-data.js`
- `dinh_muc_nuoc` thêm field `quyDinh`: thường trú HOẶC tạm trú (có giấy tờ
  chứng minh) đều được đăng ký; không tạm trú → không được; số người đăng ký
  = số người chứng minh được; kèm ví dụ 8 người → 6 người (4 hộ khẩu + 2 tạm
  trú), 2 người không tạm trú cần đăng ký tạm trú trước rồi bổ sung.
- Cập nhật giấy tờ 2 case theo tài liệu chính thức (CCCD, 'Thông báo số định
  danh cá nhân và thông tin trong CSDL quốc gia về dân cư', VNeID).
- Chuẩn hóa tên riêng trong data: "Vi eN i ai Đi" → "VNeID"; note của
  `nang_doi_dong_ho` bỏ phiên âm "SA QUA CÔ"/"Cê ét ka hát" → "SAWACO CSKH",
  "www.capnuoctrungan.vn".

### Mục 2 — `src/tools.js` (`handleGetProcedureInfo`)
- Kết quả trả thêm field `quy_dinh` (khi thủ tục có), và nhúng vào `message`
  ("Quy định đối tượng: ...").
- `channels` viết chữ chuẩn + tên phường: "873A Quang Trung, phường An Hội
  Tây" / "540 Hà Huy Giáp, phường An Phú Đông".

### Mục 3 — `src/system-prompt.js`
- "# Hướng dẫn thủ tục": cho phép trả lời đối tượng/số người theo trường
  "quy_dinh" (được đếm/cộng: 4 + 2 = 6); quy tắc không-suy-diễn giữ nguyên
  cho những gì ngoài quy định (vd "định mức bao nhiêu khối?").
- Thêm nhắc khách 1 lần sau mỗi thủ tục: có thể gặp tổng đài viên bất cứ lúc nào.
- Section mới "# Cách đọc tên riêng": VNeID, SAWACO CSKH, website, CCCD
  (phương án A — data viết chuẩn, phát âm dạy trong prompt).

### Kiểm chứng cuộc gọi tiếp theo
1. "Nhà 8 người, 4 hộ khẩu, 2 tạm trú, 2 không có gì — đăng ký được mấy
   người?" → AI trả lời **6 người**, khuyên 2 người còn lại đăng ký tạm trú
   trước rồi bổ sung.
2. "Định mức mỗi người bao nhiêu khối?" → AI vẫn từ chối suy diễn (ngoài
   quy_dinh), mời chuyển máy.
3. Nghe AI đọc "VNeID" ("Vi-en-e-ai-đi"), "SAWACO", website — có tự nhiên không.
4. Sau khi hướng dẫn thủ tục, AI nhắc quyền gặp tổng đài viên đúng 1 lần.
5. Còn treo: threshold 0.7 (chờ duyệt), prompt caching = 0, data
   sang_ten_dong_ho/doanh_nghiep có mục giấy tờ trùng lặp (phát hiện khi rà
   data, chưa sửa — cần chủ dự án xác nhận nội dung đúng).

---

## Kết quả kiểm chứng đợt 5 — cuộc gọi test 08/07/2026 16:16

Log: `conversation_summary/2026/07/08/0967777637_DzIgZD3y0UHaN6YmCxBns.json`.

| Fix | Kết quả |
|---|---|
| quy_dinh trong kết quả tool | ✅ Về đầy đủ, AI tóm tắt đúng điều kiện thường trú/tạm trú |
| Chọn tool khi khách nói đứt quãng | ✅ Đúng 2/2 lần |
| Quy tắc đọc tên riêng trong SYSTEM_PROMPT | ❌ AI vẫn nói "VNeID", "CCCD", "www.capnuoctrungan.vn" nguyên dạng — model mini KHÔNG áp dụng được quy tắc phát âm đặt xa trong prompt |

**Bug mới:** AI đọc nguyên văn instruction câu chào ra loa: "Đợi 1 giây rồi
nói: ... Alo ..." — do greetingInstruction chứa chỉ dẫn "đợi 1 giây rồi nói"
(thừa, code đã setTimeout 1s).

---

# Đợt 6 — Dạng đọc trong tool message + fix greeting (08/07/2026)

`node --check` pass; test `dispatchTool` pass 6/6.

### Mục 1 — `src/tools.js`: hàm `toSpoken()` (phương án C, thay phương án A đợt 5)
Bài học: với gpt-realtime-mini, cách duy nhất tin cậy để kiểm soát phát âm là
viết sẵn DẠNG ĐỌC vào text mà AI phải đọc. Giải pháp lai:
- Data + field cấu trúc (`thuTuc`, `quy_dinh`) giữ CHỮ CHUẨN (log/summary sạch).
- Riêng field `message` (phần AI đọc cho khách) đi qua `toSpoken()`:
  - "(CCCD)" → bỏ (tránh lặp "Căn cước công dân (Căn cước công dân)")
  - "CCCD" → "Căn cước công dân"
  - "VNeID" → "Vi-en-e-ai-đi"
  - "SAWACO CSKH" → "Sa-oa-cô Xê-ét-ka-hát"
  - "www.capnuoctrungan.vn" → "vê kép vê kép vê kép chấm cấp nước trung an chấm vi-en"
- Section "# Cách đọc tên riêng" trong SYSTEM_PROMPT giữ lại làm lớp phụ trợ.

### Mục 2 — `src/session-ws.js`: fix greeting instruction
`greetingInstruction` đổi từ 'đợi 1 giây rồi nói "..."' → 'Nói nguyên văn: "..."'
(delay 1s đã có sẵn bằng setTimeout trong code).

### Kiểm chứng cuộc gọi tiếp theo
1. Câu chào KHÔNG còn "Đợi 1 giây rồi nói".
2. Nghe AI đọc: "Vi-en-e-ai-đi", "Sa-oa-cô", "vê kép... chấm vi-en" tự nhiên.
3. Transcript AI sẽ chứa dạng đọc (chấp nhận — đó là điều AI thực sự nói);
   field quy_dinh/thuTuc trong toolCalls vẫn chữ chuẩn.

### Bổ sung cùng đợt: định mức nước CHỈ áp dụng hộ gia đình
(Xác nhận từ chủ dự án — không áp dụng doanh nghiệp/công ty.)
- `huongdanthutuc-data.js`: `dinh_muc_nuoc` thêm `apDung: "ho_gia_dinh"`;
  `quyDinh` mở đầu bằng câu "CHỈ áp dụng cho hộ gia đình, KHÔNG áp dụng cho
  doanh nghiệp hay công ty".
- `tools.js`: guard chung — thủ tục có `apDung` mà `doi_tuong` khác →
  trả message báo rõ chỉ dành cho hộ gia đình, gợi ý chuyển máy/tạo phiếu,
  KHÔNG trả nhầm nội dung hộ gia đình cho doanh nghiệp.
- Enum description trong system-prompt.js đã có sẵn "(chỉ áp dụng hộ gia
  đình)" từ đợt 0.
- Test 5/5: DN bị chặn ✓, hộ gia đình bình thường ✓, không truyền doi_tuong
  vẫn OK ✓, lap_dat_dong_ho doanh nghiệp không ảnh hưởng ✓.

---

## Kết quả kiểm chứng đợt 6 — cuộc gọi test 08/07/2026 19:07

Log: `conversation_summary/2026/07/08/0967777637_DzLM04hXvNf30hZayYeus.json`
(21s, khách hỏi dời đồng hồ rồi cúp). Đã xác minh qua call_params: cuộc gọi
chạy đúng prompt/tools mới nhất — lỗi là hành vi model, không phải thiếu deploy.

**2 lỗi:**
1. Khách hỏi "dời đồng hồ nước" → AI đòi mã danh bộ thay vì gọi
   get_procedure_info (thủ tục này không cần danh bộ, tool cũng không có
   tham số đó). Nguyên nhân: section "# Mã danh bộ" chiếm tỷ trọng lớn trong
   prompt + "# Quy trình" dặn "thu thập thông tin cần thiết" → model mini gán
   nhầm thủ tục vào nhóm tra cứu (vốn cần danh bộ).
2. Câu chào bị model diễn giải lại: "Chào anh/chị, cảm ơn anh/chị..." — sai
   câu chuẩn, sai persona (anh/chị thay vì Quý Khách) dù instruction đợt 6 là
   'Nói nguyên văn: "..."'.

---

# Đợt 7 — Thủ tục không cần danh bộ + siết câu chào (08/07/2026)

`node --check` pass. Files: `src/system-prompt.js`, `src/session-ws.js`.

### Mục 1 — `src/system-prompt.js` ("# Hướng dẫn thủ tục", 1 dòng mới)
Hỏi thủ tục hành chính KHÔNG cần mã danh bộ — tuyệt đối không hỏi danh bộ,
gọi get_procedure_info ngay. Danh bộ chỉ cần cho tra cứu hóa đơn/thanh toán/
sản lượng/cúp nước/tạo phiếu.

### Mục 2 — Câu chào (2 lớp)
- `src/system-prompt.js` ("# Phong cách"): thêm "KHÔNG BAO GIỜ gọi khách là
  anh/chị" + câu chào chuẩn nguyên văn vào prompt làm lớp dự phòng.
- `src/session-ws.js`: greetingInstruction siết thành "Đọc CHÍNH XÁC từng từ
  câu sau, không thêm bớt, không diễn giải lại: ...".

### Kiểm chứng cuộc gọi tiếp theo
1. Hỏi "dời đồng hồ nước" → AI gọi get_procedure_info ngay, KHÔNG hỏi danh bộ.
2. Câu chào đúng nguyên văn "... Alo ... Xin chào Quý Khách..."; không còn
   "anh/chị" trong cả cuộc gọi.
