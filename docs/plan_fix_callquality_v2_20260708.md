# Plan cải thiện chất lượng cuộc gọi — đợt 2 (08/07/2026)

Trạng thái: **ĐÃ TRIỂN KHAI Mục 1a, 2, 3, 4 (08/07/2026)** — Mục 1b/1c/5 chờ
dữ liệu thêm. Chi tiết: [changelog](changelog_fix_callquality_20260708.md).

Lưu ý chung: input transcript có thể không chính xác — chỉ có giá trị tham
khảo debug, KHÔNG dùng làm căn cứ xử lý nghiệp vụ.

Tiếp nối [plan đợt 1](plan_fix_callquality_20260708.md) (đã triển khai, kiểm
chứng OK — xem [changelog](changelog_fix_callquality_20260708.md)). Đợt 2 xử lý
5 tồn đọng phát hiện từ cuộc gọi test `0967777637_DzBXPftfWBElUbKx0LT9h`.

---

## Mục 1 — Chống "chào đúp" và giảm tiếp phantom turn

**Hiện trạng:** threshold 0.6 giảm phantom (4 lần/cuộc so với trước) nhưng chưa
hết. Pattern lặp ở cả 3 cuộc gọi: ngay sau câu chào, VAD bắt echo/noise →
phantom turn → AI chào lần 2 ("Chào Quý Khách, em lắng nghe...").

**Sửa (3 lớp, làm 1a+1b trước, 1c để dành):**

1a. `src/system-prompt.js` — thêm vào section Phong cách:

```
- Sau câu chào đầu tiên, nếu chỉ nghe tạp âm/không rõ lời: IM LẶNG chờ khách
  nói, tuyệt đối không chào lại lần hai.
- Nghe thấy âm thanh nhưng không phải lời nói rõ ràng (tạp âm, tiếng thở,
  echo): không phản hồi, chờ khách nói thật.
```

1b. Quy tắc theo dõi threshold (đã ghi trong comment code, nhắc lại):
- Sau 3–5 cuộc gọi thật, nếu `emptyTranscriptCount` trung bình vẫn ≥ 3
  → tăng threshold 0.6 → 0.7 (`src/session-ws.js`).
- Khi test 0.7: PHẢI test lại kịch bản đọc mã danh bộ 11 số (rủi ro mất
  chữ số đầu / miss giọng nói nhỏ).

1c. (Để dành, chỉ làm nếu 1a+1b không đủ) Thử `semantic_vad` thay `server_vad`
trong `turn_detection` — VAD ngữ nghĩa của GA Realtime phân biệt lời nói thật
với tạp âm tốt hơn. Cần test kỹ độ trễ và hành vi ngắt lời trước khi dùng thật.

---

## Mục 2 — Chống bịa khi khách hỏi ngoài data thủ tục

**Hiện trạng:** Khách nói "thuê nhà, không có giấy sở hữu" → AI tư vấn
"hợp đồng thuê nhà dài hạn với tổ chức/cá nhân cho thuê" + "giấy xác nhận lưu
trú". Data gốc là *"Hợp đồng của cá nhân, tổ chức thuê nhà CỦA NHÀ NƯỚC dài
hạn"* — khác nghĩa hoàn toàn (nhà thuê của Nhà nước ≠ thuê của chủ tư nhân).
Khách có thể chuẩn bị sai giấy tờ.

**Sửa:** `src/system-prompt.js` — thêm vào section "# Hướng dẫn thủ tục":

```
- Chỉ nêu giấy tờ ĐÚNG NGUYÊN VĂN theo kết quả tool, không tự diễn giải rộng
  ra (vd "thuê nhà của Nhà nước" KHÁC "thuê nhà của tư nhân" — không đánh
  đồng). Trường hợp của khách không khớp rõ ràng với danh sách → nói thật là
  trường hợp này em chưa chắc chắn, mời khách chuyển tổng đài viên hoặc tạo
  phiếu để nhân viên tư vấn chính xác.
```

---

## Mục 3 — Gọi end_call khi khách chào tạm biệt

**Hiện trạng:** Khách nói "OK, cảm ơn em... bye bye" → AI đáp lời chào nhưng
không gọi `end_call` → khách phải tự cúp, outcome ghi `disconnected` (lệch
thống kê: cuộc gọi thành công bị đếm như rớt máy).

**Sửa:** `src/system-prompt.js` — thêm vào cuối prompt:

```
# Kết thúc cuộc gọi
Khách nói cảm ơn/tạm biệt/chào ("cảm ơn em", "bye", "chào em", "vậy thôi
nhé")... và không còn nhu cầu → chào tạm biệt ngắn gọn RỒI GỌI end_call ngay
trong cùng lượt. Không chờ khách cúp máy.
```

Cân nhắc thêm: làm rõ description tool `end_call` trong TOOLS:
`"Kết thúc cuộc gọi. GỌI NGAY khi khách chào tạm biệt/hết nhu cầu, sau khi đã nói lời chào."`

---

## Mục 4 — Giảm transcribe sai ("bye bye" → "拜拜")

**Hiện trạng:** đã set `language: "vi"` nhưng gpt-4o-mini-transcribe vẫn trả
chữ Hán. Transcript sai làm summary + phân tích sau cuộc gọi kém tin cậy
(không ảnh hưởng hội thoại realtime — model nghe audio trực tiếp).

**Sửa:** thêm `prompt` cho transcription trong accept params —
`src/call-manager.js` dòng ~37 (`audio.input.transcription`):

```js
transcription: {
  model: "gpt-4o-mini-transcribe",
  language: "vi",
  prompt: "Cuộc gọi tổng đài chăm sóc khách hàng công ty cấp nước tại TP.HCM, "
        + "toàn bộ bằng tiếng Việt. Có thể chứa mã danh bộ 11 chữ số, "
        + "số tiền, tên thủ tục: định mức nước, lắp đặt đồng hồ, sang tên, nâng dời đồng hồ."
}
```

---

## Mục 5 — (Điều tra, không sửa vội) Prompt caching = 0

**Hiện trạng:** `cached_text_tokens = 0` ở cả 3 cuộc gọi, trong khi text input
tăng dần theo độ dài hội thoại (cuộc 08:38 tốn 66.6k text input tokens =
$0.04). Instructions + tools (~4k token) lặp lại ở MỌI response — đáng lẽ
được cache (giảm 50% giá phần này).

**Việc cần làm:** đọc docs OpenAI Realtime về prompt caching cho SIP session
(có thể yêu cầu prefix ổn định, hoặc gpt-realtime-mini chưa hỗ trợ). Ghi nhận
kết quả vào docs. Chỉ sửa nếu có cách bật rõ ràng.

---

## Thứ tự thực hiện & kiểm chứng

1. Mục 1a + 2 + 3 (đều là system-prompt.js) + Mục 4 (transcription prompt)
   — một đợt sửa, rủi ro thấp.
2. `node --check`, gọi test lại.
3. Kịch bản kiểm chứng:
   - Nghe chào xong im lặng 5–10s → AI KHÔNG chào lần 2 (Mục 1a).
   - Hỏi thủ tục lắp đồng hồ, nói "tôi thuê nhà của tư nhân" → AI không bịa,
     đề nghị chuyển máy/tạo phiếu (Mục 2).
   - Kết thúc bằng "cảm ơn em, bye" → AI chào + tự cúp máy, outcome trong log
     = "completed" (Mục 3).
   - Xem transcript trong log: "bye bye" không còn ra chữ Hán (Mục 4).
   - So sánh stats: emptyTranscriptCount, vadTurnCount/customerTurns (Mục 1b).
4. Mục 1b/1c và Mục 5: quyết định sau khi có thêm dữ liệu từ 3–5 cuộc gọi.

## Rollback

Các mục độc lập. Mục 4 chỉ thêm field `prompt` — xóa field là về như cũ.
