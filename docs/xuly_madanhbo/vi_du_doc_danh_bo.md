# Ví dụ minh hoạ — các trường hợp đọc mã danh bộ

Tài liệu này liệt kê các kịch bản thực tế khi khách đọc mã danh bộ qua giọng
nói (và một số biến thể liên quan: DTMF, mã có sẵn theo SĐT/lịch sử), cùng
đường code chính xác xử lý từng trường hợp. Đọc kèm
[README.md](./README.md) — tài liệu này chỉ minh hoạ bằng ví dụ cụ thể, không
nhắc lại toàn bộ giải thích cơ chế.

Quy ước ví dụ: mã danh bộ mẫu dùng xuyên suốt là **`22023251775`** (đúng mã
dùng làm ví dụ trong chính code, `danh-bo-arbiter.js`).

---

## 1. Đọc liền một mạch, đúng ngay lần đầu (happy path)

**Diễn biến**

```
Bot:    "Dạ, Quý Khách cho em xin mã danh bộ gồm 11 chữ số, đọc liền một mạch..."
Khách:  "Hai hai không hai ba hai năm một bảy bảy năm"
```

**Xử lý**

1. `noteDanhBoTranscript` ghi lượt vào cả hai biến; `_danhBoSession.digits`
   ngay lập tức đủ 11 ("22023251775") vì đây là **một** lượt transcript duy
   nhất.
2. `_maybeVerifyDanhBo` thấy `_du = true` → debounce ngắn
   (`DANH_BO_DEBOUNCE_DU_MS`, 1500ms), đồng thời `_clearDanhBoWatchdog()`.
3. `verifyDanhBoFromSession` chạy: `latestSessionDanhBo` trả về đúng
   `"22023251775"` (lượt đơn ra đủ 11 số) → `apiCheckP` (verify API) và
   `arbiterP` (trọng tài) chạy song song.
4. API xác nhận tồn tại → **Nhánh 1** ăn ngay: `callState.danhBo =
   { value: "22023251775", confirmed: false }`,
   `_danhBoResolvedBy = "transcript_11"`, **không** cần gate xác nhận lời nói
   bổ sung (`_danhBoNeedsVerbalYes = false`) vì khách tự đọc trôi chảy và đã
   có API bảo chứng.
5. `session-ws.js` tự phát câu xác nhận qua `_speakVerbatim` (không chờ model
   tự nói):

```json
{
  "success": true,
  "cho_khach_xac_nhan": true,
  "ma_danh_bo": "22023251775",
  "trang_thai_danh_bo": "dang_cho_xac_nhan",
  "doc_cho_khach": "Dạ, em đọc lại mã danh bộ để Quý Khách kiểm tra: Hai - Hai - Không - Hai - Ba - Hai - Năm - Một - Bảy - Bảy - Năm. Quý Khách xác nhận giúp em có đúng không ạ?"
}
```

6. Khách: **"Dạ đúng rồi ạ"** → `_isAffirmative` = true (khớp
   `_KHANG_DINH_RE`) → `danhBo.confirmed = true`, dọn phiên đọc số, tắt mọi
   watchdog, `logger.markDanhBoResolved("transcript_11", "22023251775")`. Code
   nhờ model gọi tool tra cứu ngay.

---

## 2. Đọc rời rạc nhiều hơi (ghép từ nhiều lượt)

**Diễn biến**

```
Khách: "Hai hai không hai"        (lượt 1 — 4 số)
Khách: "...ba hai năm một"        (lượt 2 — 4 số)
Khách: "...bảy bảy năm"           (lượt 3 — 3 số)
```

**Xử lý**

- Sau lượt 1 và 2: `daNghe < 11` → mỗi lần `resolveDanhBo` được gọi trong lúc
  này trả `dangGomSoResponse(daNghe)` (`"Dạ, em đang nghe ạ."`), **không**
  hỏi "còn thiếu mấy số" (cố ý — chỗ nối giữa hai hơi đọc là chỗ ASR hay nghe
  sai nhất, hỏi "còn thiếu từ đâu" chỉ gây rối).
- Sau lượt 3: `digits.length = 11` → debounce ngắn → verify chạy.
- **Không có lượt đơn nào ra đúng 11 số** (`latestSessionDanhBo` trả về `""`
  vì không turn nào tự nó dài 11) → bỏ qua Nhánh 1, sang **Nhánh 2**: dùng
  ứng viên trọng tài. Prompt gửi trọng tài liệt kê cả 3 lượt trong
  `latestTranscripts`, kèm hướng dẫn "trong MỘT lần đọc, khách có thể ngắt
  thành 2-3 hơi... ghép chúng lại trước". Trọng tài ghép ra `"22023251775"`.
- `tryProposeArbiterCandidate` verify lại qua API → đạt → đề xuất, nhưng lần
  này **CÓ** đặt `_danhBoNeedsVerbalYes = true` (ứng viên đến từ suy luận,
  không phải một lượt đọc trôi chảy đơn) — khách vẫn phải nói "đúng" một cách
  rõ ràng trước khi tra cứu.

---

## 3. Đọc thiếu, khách dừng hẳn (không đọc thêm)

**Diễn biến**

```
Khách: "Hai hai không hai"   (4 số, lần đọc ĐẦU TIÊN của cuộc gọi, requestNo=1)
       [im lặng > 9 giây — DANH_BO_DEBOUNCE_THIEU_MS]
```

**Xử lý**

`_maybeVerifyDanhBo` luôn gọi `verifyDanhBoFromSession(..., { chapNhanThieuSo:
true })` — trong `verifyDanhBoFromSession`, nếu đang ở **lần đọc đầu tiên**
(`requestNo <= 1`) và **không có quan sát nào khác** để đối chiếu (không
`knownDanhBo`, không `_danhBoReads`), code **bỏ qua hẳn trọng tài** (biết
trước sẽ chỉ nhận lại "không đủ dữ liệu", tốn ~10 giây vô ích) và gọi thẳng
`danhBoReReadOrEscalate(callState, 4)`:

```json
{
  "success": false,
  "invalid_danh_bo": true,
  "do_dai_hien_tai": 4,
  "do_dai_yeu_cau": 11,
  "doc_cho_khach": "Dạ, em nghe được bốn số, mà mã danh bộ cần đúng mười một số ạ. Quý Khách đọc lại đầy đủ từ đầu, đọc liền một mạch, đừng ngừng giữa chừng, chậm và rõ giúp em ạ."
}
```

`startDanhBoRequest` được gọi bên trong (`requestNo` tăng lên 2) — đây là lần
"đọc lại" đầu tiên khách cảm nhận được.

Nếu đây là **lần đọc thứ 2 trở đi** (đã có quan sát trước trong
`_danhBoTranscripts`) mà vẫn thiếu số, code **không** bỏ qua trọng tài nữa —
vẫn thử ghép, nhưng do dữ liệu ít nên nhiều khả năng cũng rơi về Nhánh 3
("mời đọc lại / leo thang") ở cuối `verifyDanhBoFromSession`.

---

## 4. Đọc thừa số / lẫn tạp âm

**Diễn biến**: khách đọc chồng lượt hoặc có tạp âm khiến ASR ra 13 chữ số
trong phiên.

**Xử lý**: `daNghe = 13 > DANH_BO_LENGTH` → `invalidDanhBoResponse(13,
callState)` — nói đúng bản chất thay vì bảo "đọc thiếu":

```json
{
  "success": false,
  "invalid_danh_bo": true,
  "do_dai_hien_tai": 13,
  "do_dai_yeu_cau": 11,
  "doc_cho_khach": "Dạ, đường truyền bên em nghe bị lẫn nên chưa tách được đúng mười một chữ số ạ. Quý Khách vui lòng đọc lại từ đầu, đọc liền một mạch đủ mười một chữ số, đừng ngừng giữa chừng, chậm và rõ giúp em ạ."
}
```

`callState.danhBoInvalidCount` tăng lên — dùng cho câu leo thang cuối
(`danhBoEscalationResponse`), không dùng để đếm `requestNo`.

---

## 5. Model nghe lệch một vài chữ số (không phải bịa)

**Diễn biến**: khách mới đọc 6 số đầu (`_danhBoSession.digits = "220232"`),
model gọi tool `get_bill({ ma_danh_bo: "2202325" })` (nghe thêm nhầm một số
"5" ở cuối mà khách chưa đọc tới).

**Xử lý** (`classifyModelArg("2202325", "220232")`):

- Không rỗng, session không rỗng → không phải `empty`/`R1`.
- `"220232".includes("2202325")` = false → không phải `R2`.
- Ngưỡng Levenshtein = `max(1, floor(7*0.2))` = 1. So khớp `"2202325"` với
  các cửa sổ con dài 6 của session (`"220232"`) → khoảng cách chỉnh sửa = 1
  (chỉ cần chèn thêm số "5"). `1 ≤ 1` → **`R3 — nghe_lệch`**.
- `noteModelHeardDanhBo` đưa `"2202325"` vào `_danhBoReads` (kho quan sát cho
  trọng tài) nhưng **không** dùng để tra cứu hay đếm đủ/thiếu — arg model
  không bao giờ là nguồn quyết định trực tiếp.

---

## 6. Model bịa số hoàn toàn (chưa nghe gì)

**Diễn biến**: khách vừa nói "cho em xem tiền nước tháng này", **chưa đọc số
nào** (`_danhBoSession.digits = ""`). Model gọi ngay
`get_bill({ ma_danh_bo: "725625" })` — trường hợp thật đã xảy ra
(`rtc_u2_E5eDfB96UnJE6iDWfPbRX`).

**Xử lý** (`classifyModelArg("725625", "")`): session rỗng → **`R1 — bịa`**
ngay lập tức, không tính Levenshtein. `noteModelHeardDanhBo` **bỏ hoàn toàn**
dãy này (không vào `_danhBoReads`), chỉ tăng `_hallucinationCount`. Đồng thời
`resolveDanhBo` (vì `daNghe === 0`) trả `invalidDanhBoResponse(0, callState)`
— câu xin số bình thường, hoàn toàn không nhắc gì tới `"725625"`.

Nếu việc này lặp lại lần thứ 2 (**và** khách đã từng đọc số thật trong cuộc
gọi) → `resolveDanhBo` leo thẳng sang mời bấm phím
(`danhBoDtmfInviteResponse`) — model "đã mất ngữ cảnh", nghe tiếp chỉ tốn
thời gian khách.

---

## 7. Nhiều lượt đọc mâu thuẫn nhau — trọng tài "bỏ phiếu theo vị trí"

Ví dụ nguyên văn trong prompt trọng tài (`danh-bo-arbiter.js`):

```
Lần 1: "22023251775"
Lần 2: "22023251175"
Lần 3: "22023257775"
```

Vị trí 1–8 và 10–11 khớp ở cả 3 lần; chỉ vị trí thứ 9 lệch (`7` / `1` / `7`)
→ trọng tài chọn `7` (xuất hiện 2/3 lần) → kết luận **`22023251775`**. Đây
đúng là mã mẫu dùng xuyên suốt tài liệu này — không phải trùng hợp, mà lấy
thẳng từ ví dụ gốc trong code.

---

## 8. Đọc đúng theo transcript nhưng backend báo không tồn tại

**Diễn biến**: `latestSessionDanhBo` ra đúng 11 số, nhưng
`checkDanhBoApi` báo `coThat: false` (số không có trong hệ thống — có thể ASR
nghe nhầm dù ra đủ 11 số "sạch mắt").

**Xử lý**: rơi vào **Nhánh 3** của `verifyDanhBoFromSession` — log cảnh báo
`danh_bo_not_found`, **không chốt bừa**, gọi `danhBoReReadOrEscalate` (mời
đọc lại hoặc leo thang tuỳ `requestNo`). Nếu tình huống này xảy ra **sau khi**
mã đã từng được chốt và đưa vào một tool tra cứu thật (không phải ở bước
verify này mà ở bước gọi `get_bill`/... sau đó), xử lý sẽ đi qua
`danhBoNotFoundSelfCorrect` — xem [fetchBilling.md](./fetchBilling.md).

---

## 9. Mã đã có sẵn theo số điện thoại gọi đến (`knownDanhBo`)

**Diễn biến**: khách gọi từ số đã đăng ký, hệ thống tra được danh bộ trước cả
khi khách nói gì (`callOps.knownDanhBo`). Model, theo mục "Thu thập mã danh
bộ" của `system-prompt.js`, **chủ động** đọc số này ngay từ đầu hội thoại,
không hỏi khách tự đọc.

**Xử lý**: khi model gọi tool tra cứu với `ma_danh_bo` khớp một phần tử trong
`callState.knownDanhBo`, `resolveDanhBo` **tin ngay**:

```js
callState.danhBo = { value: argModel, confirmed: true }; // confirmed NGAY, không cần khách nói "đúng"
```

Lý do: số này **vừa được backend xác minh khớp đúng SĐT đang gọi tới** — rủi
ro thấp hơn hẳn số nghe qua "tai" model, nên bỏ qua vòng xác nhận lời nói của
tầng code (model vẫn nên hỏi khách theo prompt, nhưng dù model lỡ bỏ qua thì
hệ thống không chặn).

---

## 10. Mã theo lịch sử cuộc gọi trước (`historyDanhBo`) — PHẢI xác nhận

**Diễn biến**: không có `knownDanhBo`, nhưng có `historyDanhBo` (mã khách
từng xác nhận ở cuộc gọi trước, cùng SĐT). Khách chưa đọc số nào trong phiên
hiện tại.

**Xử lý**: khác hẳn mục 9 — `resolveDanhBo` chỉ **đề xuất** (không tin ngay):

```js
callState.danhBo = { value: candidate, confirmed: false };
callState._danhBoResolvedBy = "history_tel";
callState._danhBoNeedsVerbalYes = false; // nguồn xác định, không phải suy luận trọng tài — nhưng vẫn cần gate xác nhận lời nói bên dưới
```

→ trả `confirmRequestResponse(candidate, callState)` — **vẫn** là câu đọc
lại xin xác nhận, giống hệt luồng khách tự đọc số. Chỉ đề xuất **một lần duy
nhất** trong cuộc gọi (`_historyDanhBoOffered`) và chỉ khi khách **chưa** tự
đọc số nào (nhường luồng đọc số bình thường xử lý trước nếu khách đã đọc).

Lý do khác biệt với mục 9: SĐT có thể đã đổi chủ hoặc hợp đồng đã đổi/khoá
giữa hai cuộc gọi — tin ngay như `knownDanhBo` có thể đọc thông tin của
**khách hàng khác** cho người gọi hiện tại nghe (sự cố thật đã ghi nhận ở
`rtc_u2_EBIRJxR2Jf366tXhIOZzU`, xem chú thích trong `tools.js`).

---

## 11. Khách đọc lại số khi đang chờ xác nhận

### 11a. Đọc lại TRÙNG số đang chờ → củng cố

```
Bot:    "...Hai - Hai - Không - Hai - Ba - Hai - Năm - Một - Bảy - Bảy - Năm. Đúng không ạ?"
Khách:  "Hai hai không hai ba hai năm một bảy bảy năm"   (đọc lại y hệt, không nói "đúng")
```

`_docLaiSo === callState.danhBo.value` → coi là **củng cố**, **không** đẩy
vào `_danhBoRejected` (nếu đẩy nhầm, số ĐÚNG sẽ bị trọng tài né vĩnh viễn —
đúng bug thật đã xảy ra, `docs/fix` 04/08/2026 đợt 15). Code chỉ
`_armDanhBoWatchdog()` + `_reAssertDanhBoStep(...)` — nhắc lại đúng câu xác
nhận, chờ khách nói rõ đúng/sai.

### 11b. Đọc lại KHÁC số đang chờ → phủ định ngầm

```
Bot:    "...Hai - Hai - Không - Hai - Ba - Hai - Năm - Một - Bảy - Bảy - Năm. Đúng không ạ?"
Khách:  "Hai hai không hai ba hai năm một tám bảy năm"   (số khác, không nói "sai")
```

Khác số đang chờ → `noteDanhBoRejected` (đẩy số cũ vào `_danhBoRejected`,
xoá `callState.danhBo`), `startDanhBoRequest` mở phiên đọc **mới hoàn toàn**
(không lẫn số cũ), rồi ghi lượt vừa đọc vào phiên mới đó và chạy lại
`_maybeVerifyDanhBo`.

---

## 12. Bấm phím DTMF thay vì đọc

**Diễn biến**: khách bấm `2 2 0 2 3 2 5 1 7 7 5` trên bàn phím — **bất kỳ lúc
nào** trong cuộc gọi, không cần đợi bot mời.

**Xử lý** (`input_audio_buffer.dtmf_event_received`, `session-ws.js`): mỗi
phím nối vào `_toolCallState._dtmfBuffer` (bấm `*` xoá buffer, nhập lại từ
đầu; cách nhau > 15s coi như dãy mới). Đủ 11 chữ số:

```js
callState.danhBo = { value: "22023251775", confirmed: false };
callState._danhBoResolvedBy = "dtmf";
```

Huỷ ngay mọi việc gom số bằng giọng nói đang treo (`clearTimeout` timer verify,
`_clearDanhBoWatchdog`), trả VAD về `"normal"`, và **tự phát** câu xác nhận
(không qua model, không qua trọng tài — DTMF là dữ liệu chính xác tuyệt đối):

```
"Dạ, em nhận được mã danh bộ Quý Khách vừa bấm là: Hai - Hai - Không - Hai - Ba - Hai - Năm - Một - Bảy - Bảy - Năm. Quý Khách xác nhận giúp em có đúng không ạ?"
```

Khách vẫn phải nói "đúng"/"sai" — DTMF bỏ qua gate xác nhận của **trọng tài**
(vì không suy luận gì), nhưng không bỏ qua vòng xác nhận lời nói thông
thường.

---

## 13. Đọc sai liên tục → DTMF → chuyển tổng đài viên

```
Lượt 1 (requestNo=1): đọc thiếu/sai → mời đọc lại
Lượt 2 (requestNo=2): đọc thiếu/sai → mời đọc lại
Lượt 3 (requestNo=3): đọc thiếu/sai → requestNo ≥ DANH_BO_MAX_READS (3)
                        → danhBoDtmfInviteResponse (mời bấm phím)
```

```json
{
  "success": false,
  "moi_bam_phim": true,
  "doc_cho_khach": "Dạ, em xin lỗi Quý Khách, đường truyền bên em vẫn chưa nghe trọn vẹn được mã danh bộ ạ. Quý Khách vui lòng BẤM mười một chữ số mã danh bộ trên bàn phím điện thoại giúp em; nếu lỡ bấm nhầm, Quý Khách bấm phím SAO để nhập lại từ đầu ạ. Trường hợp không tiện bấm phím, Quý Khách nói \"chuyển máy\" để gặp tổng đài viên hỗ trợ ạ."
}
```

Nếu sau đó khách bấm DTMF nhưng **bot không đọc lại đúng được câu xác nhận
DTMF** (ví dụ TTS liên tục rớt một chữ số khi phát âm — lỗi hệ thống, không
phải dữ liệu sai) → `_checkExpectedSpeak` bỏ cuộc sau khi gửi lại 2 lần vẫn
sai → `_escalateDanhBoToDtmf` thấy `_danhBoDtmfInvited` đã `true` (đã dùng
hết cả hai kênh tự động: giọng nói lẫn DTMF) → **chuyển máy tổng đài viên
ngay**, không mời DTMF thêm lần nữa (dữ liệu đã đúng, chỉ là bot không đọc
lại được):

```
"Dạ, em xin lỗi Quý Khách vì sự bất tiện này ạ. Em xin phép chuyển máy cho tổng đài viên hỗ trợ Quý Khách ngay ạ."
```

---

## Bảng tra nhanh: nguồn nào → `_danhBoResolvedBy` nào

| Kịch bản ở trên | `_danhBoResolvedBy` | Cần gate xác nhận lời nói? |
|---|---|---|
| 1. Đọc liền mạch đúng ngay | `transcript_11` | Không (nhưng vẫn hỏi lại theo thói quen UX) |
| 2. Đọc rời rạc, trọng tài ghép | `arbiter` | **Có** (`_danhBoNeedsVerbalYes = true`) |
| 9. Theo SĐT gọi đến | `known_tel` | Không — `confirmed: true` ngay |
| 10. Theo lịch sử cuộc gọi trước | `history_tel` | **Có** |
| 12. DTMF | `dtmf` | Có (xác nhận thường, không cần trọng tài) |

`logger.markDanhBoResolved(_danhBoResolvedBy, value)` ghi giá trị này vào
`conversation_summary/...json` — dùng để đo tỷ lệ mỗi nguồn qua các đợt fix
(xem `docs/fix/fix_migrate_gpt_realtime_21_20260730.md` mục "Cách test").
