# Fix: Cancel echo hủy nhầm response thật — bot "câm" 28 giây (18/07/2026)

> **Có bản cập nhật v2 cùng ngày** — khớp item chưa đủ, xem
> [phần v2 cuối file](#cập-nhật-v2-1807-chiều--khớp-item-chưa-đủ).

## Cuộc gọi phát hiện lỗi

`rtc_u1_E2ou4DurIiPbGRvrrggKr` (0967777637, 18/07/2026 09:17) — khách hỏi thủ tục
nâng/dời đồng hồ.

## Hiện tượng

| Thời điểm | Sự kiện |
|-----------|---------|
| 09:17:44 | Khách hỏi thủ tục nâng/dời đồng hồ (lượt **thật**) |
| 09:17:51 | Transcript **prompt echo** (nhiễu, của lượt trước đó) về trễ 7s → code gửi `response.cancel` |
| 09:17:51 → 09:18:12 | Bot **im lặng 21 giây** — response trả lời câu hỏi thật đã bị hủy nhầm |
| 09:18:12 | Khách phải nói "A lô." bot mới trả lời + gọi tool |

Tổng cộng khách chờ ~28 giây từ lúc hỏi đến lúc được trả lời.

## Nguyên nhân gốc

Cơ chế cancel echo (fix 14/07/2026, cuộc `E1NSYW1IIC4xom9HGSneG`) hủy **bất kỳ**
response đang chạy khi phát hiện transcript trùng transcription prompt:

```js
// Code CŨ — session-ws.js
if (_responseActive && !_hungUp && !_transferred) {
  ws.send(JSON.stringify({ type: "response.cancel" }));
}
```

Vấn đề: transcript của `gpt-4o-mini-transcribe` chạy **bất đồng bộ** và có thể về
trễ vài giây so với lượt audio tương ứng. Khi echo về trễ, response đang chạy lúc
đó có thể là câu trả lời cho **lượt thật** của khách (hoặc greeting/đọc kết quả
tool do code tạo) — cancel là hủy nhầm.

## Cách fix

Gắn mỗi response với **item audio đã kích hoạt nó**, chỉ cancel khi item của
transcript echo trùng item đã kích hoạt response đang chạy.

### Chuỗi sự kiện Realtime API tận dụng

```
VAD bắt speech → input_audio_buffer.committed (có item_id)
              → response.created  (response do VAD tạo cho item vừa commit)
...
conversation.item.input_audio_transcription.completed (có item_id, VỀ TRỄ được)
```

### State mới trong `session-ws.js`

| Biến | Ý nghĩa |
|------|---------|
| `_lastCommittedItemId` | `item_id` audio vừa được VAD commit |
| `_activeResponseTriggerItemId` | item đã kích hoạt response đang chạy; `null` = response do code tạo |
| `_pendingCodeResponse` | cờ đánh dấu `response.create` sắp tới là do code gửi (greeting / tool result) |

### Luồng logic

1. `input_audio_buffer.committed` → lưu `_lastCommittedItemId`.
2. Code gửi `response.create` (greeting, đọc kết quả tool) → set
   `_pendingCodeResponse = true` ngay trước khi gửi.
3. `response.created`:
   - `_pendingCodeResponse` đang bật → response do code tạo, trigger = `null`, tắt cờ.
   - Ngược lại → response do VAD tạo, trigger = `_lastCommittedItemId`.
4. `response.done` → reset trigger về `null`.
5. Phát hiện prompt echo (transcript có `item_id = X`):
   - Response đang chạy **và** trigger trùng `X` → gửi `response.cancel`
     (event `response_cancel_sent`).
   - Response đang chạy nhưng trigger **khác** `X` (lượt thật / code tạo) →
     **không hủy**, ghi event `response_cancel_skipped`.
   - Không có response đang chạy → không làm gì (như cũ).

### Event log mới (conversation_summary)

- `audio_committed` — `item_id` mỗi lần VAD commit audio.
- `response_created` — nay ghi kèm nguồn: `resp_xxx (trigger: item_yyy)` hoặc
  `(trigger: code)`.
- `response_cancel_sent` — nay ghi kèm `item_id` của lượt echo bị hủy.
- `response_cancel_skipped` — echo về trễ nhưng response đang chạy thuộc lượt
  khác → giữ nguyên. **Thấy event này = fix đang cứu đúng tình huống lỗi cũ.**

## Vì sao fix bằng code, không bằng prompt

Theo quy ước dự án (memory + CLAUDE.md): model mini không tuân thủ rule prompt ổn
định — mọi fix hành vi phải deterministic trong code. Việc đối chiếu `item_id` là
hoàn toàn cơ học, không phụ thuộc model.

## Kiểm chứng

- `node --check src/session-ws.js` — pass.
- Hồi quy cần theo dõi qua log các cuộc gọi thật:
  - Tình huống fix 14/07 (nhiễu → model tự nói câu thừa): vẫn phải thấy
    `response_cancel_sent` khi echo và response cùng item.
  - Tình huống lỗi 18/07 (echo về trễ đè lượt thật): phải thấy
    `response_cancel_skipped`, bot trả lời khách bình thường, không còn khoảng
    im lặng dài.

## File thay đổi

- `src/session-ws.js` — toàn bộ fix nằm trong file này.

## Ghi chú thêm từ cuộc gọi phân tích

- Model gọi tool sai schema (`type` thay vì `loai_thu_tuc`, kèm các field `"N/A"`)
  → lớp chuẩn hoá trong `tools.js` xử lý đúng, không cần sửa.
- Transcript "hỏi coi guitar" là ASR sai (khả năng "khỏi cần giấy tờ") — model
  nghe audio trực tiếp nên vẫn trả lời đúng; transcript chỉ để debug, bỏ qua.
- WS đóng code 1006 sau khi khách xong việc = khách tự cúp máy, bình thường.

---

## Cập nhật v2 (18/07 chiều) — khớp item CHƯA ĐỦ

### Cuộc gọi tái diễn lỗi

`rtc_u0_E2tkwslo38l9Flut5ptF4` (0967777637, 18/07/2026 14:28):

| Thời điểm | Sự kiện |
|-----------|---------|
| 14:28:32 | KH hỏi thủ tục nâng đồng hồ (lượt thật, transcript đã về) |
| 14:28:39 | Echo về, item **TRÙNG** trigger → `response_cancel_sent` (fix v1 hoạt động đúng thiết kế) |
| 14:28:39.4 | AI bị cắt giữa câu: "Dạ, em sẽ xem qua hướng dẫn thủ tục... trước," |
| 14:28:39 → 14:29:03 | Bot câm **24s**, KH phải "Hello?" mới được trả lời |

### Vì sao khớp item vẫn cancel nhầm

Semantic VAD đang bật `interrupt_response: true`. Chuỗi thực tế:

1. KH hỏi (item A) → response R1 trả lời.
2. Nhiễu ngay sau đó (item B) → OpenAI **tự ngắt R1**, tạo response R2 gắn với
   item B.
3. Context hội thoại vẫn còn câu hỏi chưa đáp → model dùng R2 để **trả lời câu
   hỏi thật** ("Dạ, em sẽ xem qua hướng dẫn thủ tục...").
4. Transcript echo của B về → item khớp trigger của R2 → v1 cancel → giết nhầm
   câu trả lời.

Bài học: response do item nhiễu kích hoạt **không đồng nghĩa** nội dung của nó
là "câu thừa" — khi còn câu hỏi treo, model tận dụng response đó để trả lời.

### Guard bổ sung: `_unansweredRealTurn`

Cờ theo dõi "có lượt khách THẬT chưa được trả lời xong":

- Transcript khách thật (không echo, không rỗng) về → bật cờ.
- `response.done` với `status === "completed"` → tắt cờ (response dở dang do
  cancel/interrupt KHÔNG tính — câu hỏi vẫn treo).

Điều kiện cancel giờ cần **đủ 2**: item echo trùng trigger **và** cờ đang tắt.
Còn lượt thật chưa đáp → skip, event `response_cancel_skipped` ghi rõ lý do
(`item trùng nhưng còn lượt khách thật chưa được trả lời`).

### Ma trận tình huống

| Tình huống | Item trùng? | Cờ | Kết quả |
|-----------|-------------|-----|---------|
| Khách im lặng, nhiễu → model nói câu thừa (bug 14/07) | ✅ | tắt | **Cancel** ✅ |
| Echo về trễ, response đang chạy của lượt thật (bug sáng 18/07) | ❌ | — | Skip ✅ |
| Nhiễu interrupt sau câu hỏi thật, model trả lời qua response nhiễu (bug chiều 18/07) | ✅ | **bật** | Skip ✅ |

### Hạn chế còn lại (chấp nhận)

Nếu transcript lượt thật của khách về TRỄ hơn transcript echo (hiếm — thường
lượt thật được transcribe trước), cờ chưa kịp bật → có thể vẫn cancel nhầm.
Không giải quyết triệt để được bằng metadata; cần theo dõi thêm nếu tái diễn.
