# Plan cải thiện chất lượng cuộc gọi — 08/07/2026

Trạng thái: **ĐÃ TRIỂN KHAI 08/07/2026** — xem [changelog_fix_callquality_20260708.md](changelog_fix_callquality_20260708.md)

## Bối cảnh

Phân tích 2 log cuộc gọi từ số `0967777637`:

| Cuộc gọi | File log | Kết quả |
|---|---|---|
| 05/07 18:20 | `conversation_summary/2026/07/05/0967777637_DyFBywXdrvq556IFwGSKl.json` | completed — nhưng chọn sai thủ tục `dinh_muc_nuoc` thay vì `lap_dat_dong_ho` |
| 08/07 07:47 | `conversation_summary/2026/07/08/0967777637_DzAjQz4pTwd1aorzn7nHb.json` | **disconnected** — khách tự cúp máy sau khi AI lặp lời 4 lần liên tiếp và né câu hỏi về doanh nghiệp |

## Mục 0 — ĐÃ LÀM (08/07): mô tả enum `loai_thu_tuc`

File: `src/system-prompt.js`. Bỏ từ "đăng ký" khỏi description tool
`get_procedure_info`, thêm từ khóa nhận diện cho từng giá trị enum.
Kết quả xác nhận ở cuộc gọi 08/07: model chọn đúng `lap_dat_dong_ho` ngay lần đầu.

---

## Mục 1 — Giữ ngữ nghĩa MỘT-TRONG / ĐẦY-ĐỦ khi trả kết quả tool

**Vấn đề:** Cuộc gọi 08/07, khách hỏi "chuẩn bị hết ba cái hay một cái?" — AI trả lời
mâu thuẫn (lần 1: cần hết; lần 2: chỉ cần một).

**Nguyên nhân gốc:** Data trong `src/huongdanthutuc-data.js` ĐÃ phân biệt rõ:
- `options` + note "Cung cấp một trong các giấy tờ sau" (hộ gia đình)
- `required` + note "Cần đầy đủ các giấy tờ" (doanh nghiệp)

Nhưng `handleGetProcedureInfo` trong `src/tools.js` (dòng ~305–313) gộp
`required` và `options` thành một danh sách phẳng và **bỏ rơi `note`** khi danh sách
có phần tử → model không biết là AND hay OR, phải tự đoán.

**Sửa:** `src/tools.js` — build `docsText` giữ nguyên ngữ nghĩa:

```js
const docsText = relevantCases
  .map((c) => {
    const docs = c.requiredDocs;
    const parts = [];
    if (docs.required?.length) {
      parts.push(`CẦN ĐẦY ĐỦ các giấy tờ sau: ${docs.required.join("; ")}`);
    }
    if (docs.options?.length) {
      parts.push(`CHỈ CẦN MỘT trong các giấy tờ sau: ${docs.options.join("; ")}`);
    }
    if (parts.length === 0) parts.push(docs.note || "");
    return `${c.label}: ${parts.join(". ")}`;
  })
  .join(" || ");
```

(Không đổi cấu trúc `huongdanthutuc-data.js` — data đã đúng.)

---

## Mục 2 — Quy tắc đọc danh sách giấy tờ dài (system prompt)

**Vấn đề:** Thủ tục lắp đặt hộ gia đình có 10 loại giấy tờ. AI lần 1 đọc dở dang
kèm "…", lần 2 tự rút còn 3 mục → chính con số "ba cái" gây nhầm lẫn ở Mục 1.

**Sửa:** `src/system-prompt.js` — thêm section vào `SYSTEM_PROMPT`:

```
# Hướng dẫn thủ tục (get_procedure_info)
- LUÔN nói rõ quan hệ giấy tờ theo đúng kết quả tool: "chỉ cần MỘT trong các
  giấy tờ" hay "cần ĐẦY ĐỦ các giấy tờ". Không tự suy diễn.
- Danh sách giấy tờ dài (trên 4 loại): KHÔNG đọc hết nguyên văn. Nói số lượng
  và nhóm chính (vd "có khoảng mười loại giấy tờ, chỉ cần một trong số đó —
  phổ biến nhất là sổ hồng, giấy phép xây dựng, hoặc xác nhận tạm trú"),
  rồi hỏi khách thuộc trường hợp nào để đọc đúng phần liên quan.
- Khách hỏi CÙNG thủ tục cho đối tượng khác (hộ gia đình ↔ doanh nghiệp):
  GỌI LẠI get_procedure_info với doi_tuong mới NGAY. Thông tin này em hỗ trợ
  được — KHÔNG đề nghị chuyển tổng đài viên hay tạo phiếu.
```

Dòng cuối xử lý luôn lỗi ở cả 2 cuộc gọi: khách hỏi "còn doanh nghiệp thì sao?"
→ AI né và đề nghị chuyển máy dù data có sẵn (08/07 khách cúp máy ngay sau đó).

---

## Mục 3 — Chống AI tự nói liên tục khi khách im lặng

**Vấn đề:** Cuộc gọi 08/07 có 12 lượt AI / 5 lượt khách; đoạn 07:48:59→07:49:33
AI nói 4 lượt liên tiếp không có input; cuối cuộc gọi trả lời đúp 2 lần.
`transcription_count` = 14 nhưng chỉ 5 câu khách có nội dung → VAD bắt nhầm
tiếng ồn/echo SIP thành lượt nói, mỗi lần lại sinh một response.

**Sửa (2 lớp):**

3a. `src/session-ws.js` (dòng ~112–117) — tăng ngưỡng VAD:

```js
turn_detection: {
  type: "server_vad",
  threshold: 0.6,          // 0.5 → 0.6: giảm phantom turn do noise/echo
  prefix_padding_ms: 500,  // GIỮ NGUYÊN — tránh mất chữ số đầu danh bộ
  silence_duration_ms: 1200
}
```

Lưu ý: bản comment cũ từng dùng 0.7. Lên 0.6 trước, theo dõi; nếu còn phantom
turn thì lên 0.7. Rủi ro ngược: threshold cao quá sẽ bỏ sót giọng nói nhỏ —
cần test với cuộc gọi thật qua SIP.

3b. `src/system-prompt.js` — thêm vào section Phong cách:

```
- Khách im lặng: CHỜ, không tự nhắc lại hay diễn đạt lại câu vừa nói.
  Chỉ hỏi "Quý Khách còn nghe máy không ạ?" nếu im lặng rất lâu, tối đa 1 lần.
- Đã trả lời xong một ý: KHÔNG tự trả lời lại lần nữa với cách diễn đạt khác.
```

**Theo dõi thêm (không sửa code đợt này):** nếu sau 3a+3b vẫn lặp, cân nhắc
guard phía server trong `session-ws.js`: đếm số response liên tiếp không có
transcript khách hợp lệ ở giữa, vượt ngưỡng (vd 2) thì bỏ qua/log cảnh báo.

---

## Mục 4 — Bổ sung debug log phục vụ phân tích cuộc gọi

**Vấn đề:** Khi phân tích cuộc gọi 08/07, log JSON không đủ dữ kiện để khẳng định
nguyên nhân AI lặp lời — phải suy đoán. `session-ws.js` hiện chỉ xử lý 6 loại
event, các event chẩn đoán quan trọng rơi vào `default` (bỏ qua).

**Sửa:** `src/session-ws.js` — thêm các case sau (ghi vào `logger.addEvent` để
xuất hiện trong timeline JSON, không chỉ console):

4a. **VAD turn** — xác nhận phantom turn do noise/echo:

```js
case "input_audio_buffer.speech_started":
  logger.addEvent("vad_speech_started", null);
  break;
case "input_audio_buffer.speech_stopped":
  logger.addEvent("vad_speech_stopped", null);
  break;
```

4b. **Transcript rỗng** — hiện bị bỏ im lặng, chỉ in console. Ghi thêm event
để timeline khớp với `transcription_count`:

```js
// trong case ...input_audio_transcription.completed, nhánh else:
logger.addEvent("empty_transcript", "VAD kích hoạt nhưng transcript rỗng (noise/echo?)");
```

4c. **Nguồn gốc mỗi response** — phân biệt response do VAD hay do code:

```js
case "response.created":
  logger.addEvent("response_created", event.response?.id || null);
  break;
```

(Code cũng nên log lý do mỗi lần TỰ gửi `response.create`: "greeting",
"tool_result" — thêm `logger.addEvent("response_create_sent", <lý do>)` tại
2 chỗ gửi hiện có.)

4d. **Response bị ngắt/hủy** — cuộc gọi 08/07 có câu "Dạ, cảm ơn Qu" bị cắt
nhưng không event nào ghi lại. Trong `case "response.done"` đọc thêm status:

```js
const st = event?.response?.status;
if (st && st !== "completed") {
  logger.addEvent("response_" + st,               // cancelled / failed / incomplete
    _safeJson(event.response?.status_details) || null);
}
```

4e. **Transcription lỗi:**

```js
case "conversation.item.input_audio_transcription.failed":
  logger.addError("transcription_failed", event.error?.message || null);
  break;
```

4f. **Chỉ số tổng hợp trong `stats`** — để lọc nhanh cuộc gọi có vấn đề mà
không cần đọc timeline. Thêm vào `conversation-logger.js`:
`vadTurnCount` (số speech_started), `emptyTranscriptCount`,
`cancelledResponseCount`. Cuộc gọi "khỏe" có vadTurnCount ≈ customerTurns;
lệch lớn = phantom VAD.

**Lưu ý dung lượng:** các event trên nhỏ (không chứa audio), mỗi cuộc gọi thêm
~vài chục dòng timeline — chấp nhận được. Không log payload audio/delta
(`response.audio.delta`, `output_audio_buffer.*`) vì quá nhiều và không cần.

---

## Thứ tự thực hiện & kiểm chứng

1. Mục 4 (debug log) TRƯỚC — để có dữ kiện đo lường hiệu quả các mục sau.
2. Mục 1 (tools.js) + Mục 2 (prompt) — sửa nhanh, rủi ro thấp.
3. Mục 3a (VAD 0.6) + 3b — cần gọi test thật qua SIP; so sánh
   `vadTurnCount`/`emptyTranscriptCount` trước và sau khi đổi threshold.
4. `node --check` các file sau khi sửa.
4. Kịch bản gọi test:
   - "Thủ tục gắn đồng hồ nước cho hộ gia đình" → hỏi lại "cần hết hay một cái?"
     → AI phải trả lời nhất quán "chỉ cần MỘT trong".
   - Tiếp: "còn doanh nghiệp?" → AI phải gọi lại tool, không đề nghị chuyển máy.
   - Đọc danh bộ 11 số → xác nhận VAD 0.6 không cắt mất số đầu.
   - Im lặng 30–60s giữa cuộc gọi → AI không tự nói quá 1 lần.
5. So sánh log mới trong `conversation_summary/` : tỷ lệ aiTurns/customerTurns,
   outcome, số response_count.

## Rollback

Mỗi mục độc lập, revert riêng được. Riêng Mục 3a nếu khách phàn nàn "bot không
nghe thấy tôi nói" → hạ threshold về 0.5 ngay.
