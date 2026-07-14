# Nhật ký vấn đề & giải pháp — Voice Bot CSKH (11–14/07/2026)

Tài liệu tổng hợp các vấn đề phát hiện qua log cuộc gọi thật (`conversation_summary/`)
và chi tiết các thay đổi đã thực hiện để khắc phục. Model chính: `gpt-realtime-2.1-mini`.

**Bài học xuyên suốt**: model mini KHÔNG tuân thủ ổn định các rule đặt trong system prompt
(kể cả khi viết "TUYỆT ĐỐI/CẤM"). Mọi lỗi lặp lại đều phải chuyển về **fix deterministic
bằng code** trong `tools.js` / `session-ws.js`; rule prompt chỉ là lớp phụ. Sau mỗi thay
đổi phải kiểm chứng lại bằng log cuộc gọi thật.

---

## 0. Nền tảng: cập nhật thủ tục theo tài liệu mới (11/07)

Nguồn: `docs/huongdanthutuc_20260711.md`.

| Thay đổi | File |
|---|---|
| Định mức nước: phân theo CCCD TP.HCM (không tính Bình Dương/Vũng Tàu cũ) vs CCCD tỉnh khác (CT07/CT08/VNeID) | `src/huongdanthutuc-data.js` |
| Gắn đồng hồ hộ gia đình: CCCD chính chủ (bắt buộc) + 1-trong-3 giấy tờ (rút từ 10 xuống 3) | `src/huongdanthutuc-data.js` |
| Sang tên hộ gia đình: cần **số danh bạ** (thay hóa đơn kỳ mới nhất) + sổ hồng; giấy bổ sung tùy trường hợp (`optional`) | `src/huongdanthutuc-data.js` |
| Gắn đồng hồ & sang tên cho **doanh nghiệp** → chuyển tổng đài viên (`transferToAgent: true`) | data + `tools.js` (`can_chuyen_tong_dai`) |
| Website chỉ còn là kênh đăng ký của thủ tục nâng/dời (`procedure.channels` ghi đè kênh mặc định) | data + `tools.js` |
| Thủ tục NGOÀI 4 loại hỗ trợ → không tự hướng dẫn, mời chuyển tổng đài viên (`transfer_to_agent`) hoặc tạo phiếu (`create_ticket`) | `tools.js` (`ngoai_pham_vi`) + prompt |

---

## 1. Model gọi tool sai tham số → báo nhầm "ngoài phạm vi"

**Hiện tượng** (3 biến thể, 3 cuộc gọi khác nhau):

| Cuộc gọi | Args model gửi | Lỗi |
|---|---|---|
| `E0UYAPzruSwXtEvyqt0sx` (11/07) | `{"loại_thu_tuc": "lap_dat_dong_ho", ...}` | Tên key có DẤU tiếng Việt → `args.loai_thu_tuc = undefined` |
| `E0VWyeMHOBEXkWvBCCUdB` (12/07) | `{"lap_dat_dong_ho": "lap_dat_dong_ho", "dinh_muc_nuoc": "0", ...}` | Value đúng nằm trong key rác |
| `E11HysUBZhNRGG2XKE6AD` (13/07) | `{"lap_dat_dong_ho": true, "sang_ten_dong_ho": false, ...}` | KHÔNG có `loai_thu_tuc` — mã hóa dạng cờ boolean |

Hệ quả: khách hỏi đúng thủ tục hỗ trợ nhưng bot trả lời "ngoài phạm vi phục vụ".

**Giải pháp** — `normalizeProcedureArgs()` trong `tools.js` (deterministic, cùng triết lý
`normalizeDanhBo`), chuẩn hóa theo 3 tầng:

1. Key sai dấu/hoa thường → bỏ dấu (`canonValue`) rồi so khớp `loai_thu_tuc` / `doi_tuong`.
   Value cũng được chuẩn hóa (vd `"lắp đặt đồng hồ"` → `lap_dat_dong_ho`).
2. Quét value: nhận khi có ĐÚNG MỘT id thủ tục hợp lệ trong values (không đoán khi mâu thuẫn).
3. Cờ boolean: key là id thủ tục/đối tượng + value truthy (`true/1/"true"/"1"`) → nhận khi
   duy nhất một cờ bật.

Kèm log warning `[get_procedure_info] Args chuẩn hoá lại: ...` để theo dõi. Message
"ngoài phạm vi" cũng liệt kê 4 id hợp lệ và yêu cầu model gọi lại nếu khách thực ra hỏi
1 trong 4 thủ tục (cho model cơ hội tự sửa).

**Kiểm chứng**: các cuộc sau 13/07 đều resolve đúng thủ tục bất kể args rác.

---

## 2. Lỗi hành vi hội thoại (câu chữ)

**Hiện tượng** (nhiều cuộc):

- "Em đã giải thích đơn giản vậy cho dễ nghe rồi nhé" (nghe như chê khách) — `E0UvGulKzGkvZY8NGC2MA`.
- Mở đầu bằng cảm thán: "Tuyệt vời", "Ok", "Được chứ!"; từ suồng sã: "bật mí", "nha".
- Gọi khách là "bạn", "Quý vị", "anh chị" (quy định chỉ dùng "Quý Khách").
- Lộ meta nội bộ: "trong hướng dẫn em thấy ghi", "hệ thống báo", "nộp tại **tham số**...".
- Đòi cúp máy khi khách đang hỏi (nghe nhầm câu mơ hồ thành lời chào); gọi `end_call`
  mà không nói lời tạm biệt (cúp máy im lặng).
- Hỏi đối tượng xong nói thêm "em sẽ **gọi lại**" (khách hiểu nhầm là gọi điện lại).

**Giải pháp** — bổ sung rules vào `src/system-prompt.js`:

- Cấm tự nhận xét về câu trả lời của mình; cấm từ cảm thán mở đầu; cấm từ suồng sã;
  cấm gọi khách "anh/chị/bạn"; cấm nhắc "hướng dẫn/tài liệu/kết quả/tham số/hệ thống".
- Khách nói "nói lại/đọc lại/chưa nghe rõ" → đọc lại, KHÔNG hiểu nhầm thành lời chào.
- CHỈ kết thúc khi khách chào tạm biệt RÕ RÀNG; câu mơ hồ → hỏi lại; đang giữa tư vấn
  → không tự đề nghị kết thúc; LUÔN nói lời chào trước khi gọi `end_call` (cùng lượt).
- Hỏi đối tượng đúng MỘT câu ngắn rồi dừng, không nói "em sẽ gọi lại".

**Lưu ý**: đây là nhóm fix bằng prompt — mini tuân thủ ~80–90%, thi thoảng vẫn lỡ
("Ok", "Quý vị"); tần suất giảm dần qua các cuộc, chấp nhận theo dõi.

---

## 3. Thiếu đối tượng → đọc gộp 2 trường hợp, rơi thông tin

**Hiện tượng** (`E0VkaW1IIC4xom9HGSneG`, 12/07): model gọi tool không có `doi_tuong`
→ tool trả cả case hộ gia đình + doanh nghiệp → model tự tóm tắt và **nuốt mất 2 địa chỉ
văn phòng** ("tại văn phòng theo địa chỉ công ty cung cấp").

**Giải pháp** — `tools.js`: thủ tục có phân biệt đối tượng (lắp đặt, sang tên) mà thiếu
`doi_tuong` → tool trả `can_hoi_doi_tuong: true` kèm câu hỏi soạn sẵn ("Quý Khách đăng ký
cho hộ gia đình hay doanh nghiệp ạ?") — model hỏi rồi gọi lại; không bao giờ nhận cả 2 case.
Prompt thêm rule xử lý cờ này + rule "LUÔN đọc đầy đủ CẢ HAI địa chỉ".

**Kiểm chứng**: từ `E0Vu0A3D9QbGpHC9l3ng8` trở đi luồng hỏi–gọi lại chạy đúng 100%.

---

## 4. Tóm tắt tự do làm rơi ý / bịa tên giấy tờ

**Hiện tượng**:

- Bịa cụm vô nghĩa khi paraphrase: "vày cơ sở đăng ký sở hữu nhà", "giấy tờ tỷ lệ"
  (`E0VWyeMHOBEXkWvBCCUdB`).
- Rơi giấy tờ bắt buộc (CCCD) và địa chỉ dù prompt cấm (`E0Vu0A3D9QbGpHC9l3ng8`).
- Đọc nguyên nhãn điều khiển "cần có 3 ý quan trọng, Ý một..." nghe máy móc
  (`E1030jdrzgL8nTwnryZET`).

**Giải pháp** (tiến hóa qua 3 bước trong `tools.js`):

1. Message đánh số ý + chỉ thị "PHẢI ĐỌC ĐẦY ĐỦ CẢ N Ý" + field `so_y_phai_doc`.
2. Nhãn "Ý 1/Ý 2" → "Thứ nhất/Thứ hai/Thứ ba" (tự nhiên khi đọc thành tiếng) + chỉ thị
   không nói với khách "có N ý/N phần".
3. Xem mục 6 & 7 (tách field, ép đọc nguyên văn) — giải quyết triệt để.

---

## 5. Đối chiếu "khách đã có giấy X, cần gì nữa?" bị sai

**Hiện tượng**: yêu cầu nghiệp vụ — khách nói "có giấy phép xây dựng rồi, cần gì nữa?"
thì phải đối chiếu: GPXD thỏa nhóm một-trong → chỉ còn thiếu CCCD. Rule prompt dạy cách
đối chiếu bị mini làm SAI (`E11zOBRGO46YlRelgoR0x`: nói "GPXD đáp ứng nhóm bắt buộc" và
quên CCCD → khách sẽ mang thiếu hồ sơ).

**Giải pháp** — tool mới **`check_missing_docs`** (đối chiếu bằng code):

- Input: `loai_thu_tuc`, `doi_tuong`, `giay_to_da_co` (ghi theo lời khách).
- So khớp bỏ dấu (`canonText`) + bigram + alias tên dân dã (`DOC_ALIASES`: sổ hồng/sổ đỏ
  → giấy chứng nhận quyền..., hợp đồng mua bán → hợp đồng chuyển quyền sở hữu).
- Output: `ho_so_du`, `con_thieu[]`, câu trả lời soạn sẵn "Dạ, Quý Khách còn cần...".
  Giấy không nhận diện được (vd CMND cũ) → câu "em chưa chắc chắn dùng thay được, mời
  tổng đài viên xác nhận". Tái dùng guard `can_hoi_doi_tuong`/`can_chuyen_tong_dai`.
- Model không gọi tool ở cuộc đầu (`E163Ra5secSq1Sin0I5jq`) → bổ sung **trigger phrases
  khẩu ngữ vào description** ("X rồi cần gì nữa", "có sổ hồng rồi thiếu gì"...) — mini
  chọn tool chủ yếu theo description.

**Kiểm chứng**: `E16bvkEAw8Q6EeCAS4OXJ`, `E16o8RrrNDst0VHNClIwO` — gọi tool đúng lúc,
trả lời chính xác "còn cần Căn cước công dân chính chủ".

---

## 6. Xác nhận SAI theo khách (sycophancy) — nguy hiểm thực tế

**Hiện tượng** (`E16bvkEAw8Q6EeCAS4OXJ`): khách nghe nhầm hỏi "873**E** Quang Trung hả?"
→ model hùa theo "là Tám bảy ba E... cứ nộp hồ sơ ở đó nhé" (địa chỉ đúng là 873**A**)
— khách có thể đi nhầm địa chỉ.

**Giải pháp** — rule prompt: khách đọc lại địa chỉ/tên/số để xác nhận → ĐỐI CHIẾU với
kết quả tool; đọc sai → sửa ngay ("Dạ chưa đúng ạ, chính xác là..."), cấm lặp theo lời sai.

**Kiểm chứng**: `E16o8RrrNDst0VHNClIwO` — khách nói "873E" → model sửa "Dạ, gần đúng
nhưng chưa đúng ạ... Tám bảy ba A Quang Trung". ✅

---

## 7. Model đọc nguyên văn CHỈ THỊ điều khiển cho khách / vẫn tóm tắt

**Hiện tượng** (nghiêm trọng nhất về trải nghiệm):

- `E17jLdcYX5ACzRQ7IuGh0` (13/07): model đọc nguyên cả chỉ thị "PHẢI ĐỌC ĐẦY ĐỦ CẢ 3
  PHẦN... KHÔNG nói với khách..." + đoạn quy định dài → bài đọc ~90 giây, khách chê
  "nó bị khùng khùng ha".
- `E18GPiH9S0EO3dkWUSzUk`: bị hút vào field `quy_dinh` (dài, đứng trước) → trộn vào bài
  đọc, thay mất phần địa chỉ.
- `E1Nof3VRCX1u0hVwBoueJ` (14/07): dù đã ghi "KỊCH BẢN — CẤM tóm tắt", vẫn tóm tắt sai
  logic ("cần CCCD nếu đã có...") và rơi 2 địa chỉ — lần thứ 3 liên tiếp.

**Giải pháp** (3 lớp, lớp cuối là chốt):

1. **Tách field** trong kết quả tool: `doc_cho_khach` (nội dung sạch để đọc) ↔
   `luu_y_cho_tro_ly` (chỉ thị nội bộ, mở đầu "TUYỆT ĐỐI KHÔNG đọc cho khách").
   `quy_dinh` bỏ khỏi bài đọc mặc định, chuyển xuống CUỐI JSON + prefix
   "(GHI CHÚ NỘI BỘ — ...)"; câu trả lời của `check_missing_docs` cũng soạn sẵn
   dạng khách nghe được.
2. Prompt: "doc_cho_khach là KỊCH BẢN — đọc nguyên văn từng câu ngay từ lượt đầu".
3. **Fix chốt (deterministic 100%)** — `session-ws.js`: khi tool result có
   `doc_cho_khach`, server gửi `response.create` với
   `instructions: 'Đọc CHÍNH XÁC từng từ đoạn sau..."<doc_cho_khach>"'`
   — đúng cơ chế của câu chào đầu cuộc (thứ duy nhất mini đọc nguyên văn tuyệt đối).

**Kiểm chứng**: `E1Nz5RmNdRDQGjCensV0G` (14/07) — bài đọc nguyên văn đúng từng chữ,
đủ 3 phần, đủ 2 địa chỉ. ✅

---

## 8. Nhiễu / prompt echo

**Hiện tượng**:

- Transcript "lượt khách" thực chất là transcription prompt bị dội lại, lệch vài dấu câu
  nên filter exact-match cũ không bắt được (`E16o8RrrNDst0VHNClIwO`).
- Nhiễu kích VAD → OpenAI tạo response → model tự nói câu thừa khi khách im lặng
  ("Dạ, em nghe rõ rồi ạ..." — `E1NSYW1IIC4xom9HGSneG`).

**Giải pháp** — `session-ws.js`:

1. Filter echo so khớp SAU KHI chuẩn hóa (bỏ dấu câu, thường hóa, gộp khoảng trắng)
   + so "chữ ký" 40 ký tự đầu của prompt.
2. Theo dõi `_responseActive` (bật ở `response.created`, tắt ở `response.done`);
   phát hiện echo mà đang có response chạy → server gửi `response.cancel`
   (guard: không hủy khi đang cúp máy/chuyển máy). Event log: `response_cancel_sent`.

**Kiểm chứng**: `E1Nof3VRCX1u0hVwBoueJ`, `E1Nz5RmNdRDQGjCensV0G` — echo bị bắt và
response nhiễu bị hủy (`client_cancelled`), model chỉ kịp nói nửa câu thay vì cả câu thừa.

---

## 9. Dữ liệu giải thích thuật ngữ CT07/CT08

**Hiện tượng**: khách thắc mắc "CT07 là gì, xin ở đâu" — bot không có dữ liệu, tự chế
hoặc trả lời mơ hồ.

**Giải pháp**: tra cứu (Thông tư 66/2023/TT-BCA; luatvietnam.vn, thuvienphapluat.vn,
13/07/2026) và thêm field `thuatNgu` vào `dinh_muc_nuoc` trong `huongdanthutuc-data.js`:

- CT07 = Giấy xác nhận thông tin về cư trú (Công an xã/phường cấp).
- CT08 = Thông báo kết quả giải quyết đăng ký cư trú.
- Xin tại Công an xã/phường bất kỳ hoặc online (Cổng DVC Bộ Công an / VNeID), miễn phí;
  kết quả nửa ngày–3 ngày làm việc; giá trị 1 năm (6 tháng nếu chưa có nơi cư trú).

Tool trả field `giai_thich_thuat_ngu` (cuối JSON, prefix nội bộ, đã qua `toSpoken`);
prompt: khách hỏi thuật ngữ → đọc phần liên quan, không có thì mời tổng đài viên, cấm bịa.

**Kiểm chứng**: `E1NSYW1IIC4xom9HGSneG`, `E1Nz5RmNdRDQGjCensV0G` — trả lời đúng cả
"là gì" lẫn "xin ở đâu". ✅

---

## 10. Các hỗ trợ phát âm (toSpoken)

Vì mini không áp dụng ổn định quy tắc phát âm trong prompt, mọi text bot phải đọc đều
được chuyển sẵn sang dạng đọc trong `tools.js#toSpoken()`: CCCD → "Căn cước công dân",
VNeID → "Vi-en-e-ai-đi", CT07/CT08 → "Xê-Tê-không-bảy/tám", SAWACO CSKH →
"Sa-qua-cô Xê-ét-ka-hát", website → đọc chữ, số nhà 873A/540 → đọc chữ.

---

## 11. Vấn đề còn mở

1. **Nhiễu/echo đường SIP** vẫn ngắt lời model giữa câu (cuộc `E1Nz5RmNdRDQGjCensV0G`:
   8 response bị cancel). Hướng xử lý: tăng `threshold`/`silence_duration` của
   `turn_detection` trong `session.update` (session-ws.js) và kiểm tra echo cancellation
   phía Asterisk. Chưa thực hiện.
2. Lỗi câu chữ lặt vặt của mini (thi thoảng "Ok", "Quý vị") — theo dõi thêm; nếu cần
   sạch tuyệt đối thì cân nhắc nâng model realtime bản thường.

---

## Phụ lục: cấu trúc kết quả `get_procedure_info` hiện tại

```json
{
  "success": true,
  "thuTuc": "Đăng ký định mức nước",
  "so_phan_phai_doc": 3,
  "luu_y_cho_tro_ly": "Ghi chú nội bộ, TUYỆT ĐỐI KHÔNG đọc cho khách: ...",
  "doc_cho_khach": "<kịch bản sạch — server ép đọc nguyên văn qua response.create>",
  "quy_dinh": "(GHI CHÚ NỘI BỘ — ...) <quy định đối tượng/số người>",
  "giai_thich_thuat_ngu": "(GHI CHÚ NỘI BỘ — ...) <CT07/CT08 là gì, xin ở đâu...>"
}
```

Các cờ điều phối: `can_hoi_doi_tuong` (thiếu đối tượng → hỏi rồi gọi lại),
`can_chuyen_tong_dai` (doanh nghiệp → chuyển máy), `ngoai_pham_vi` (ngoài 4 thủ tục
→ chuyển máy hoặc tạo phiếu).
