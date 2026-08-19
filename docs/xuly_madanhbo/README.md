# Xử lý mã danh bộ — tài liệu kỹ thuật cho developer

Tài liệu này giải thích **logic và code thực thi** việc thu thập, xác minh, xác
nhận và sử dụng **mã danh bộ** (11 chữ số, định danh khách hàng) trong Voice Bot
CSKH Cấp nước Trung An. Đọc file này trước khi sửa bất cứ gì liên quan đến danh
bộ — đây là phần phức tạp nhất và dễ vỡ nhất của repo (đã trải qua hơn 30 đợt
fix dựa trên log cuộc gọi thật, xem `docs/fix/fix_danh_bo_*.md`).

Bối cảnh chung của dự án: xem [`CLAUDE.md`](../../CLAUDE.md) và
[`README.md`](../../README.md) ở gốc repo.

## Vì sao logic này phức tạp

Mã danh bộ là định danh **chính xác cao**: nghe sai một chữ số có thể tra ra —
và đọc cho khách nghe — thông tin của **khách hàng khác**. Đồng thời, dữ liệu
đầu vào (audio qua điện thoại, ASR tiếng Việt, mô hình realtime cỡ nhỏ) vốn dĩ
nhiễu. Nguyên tắc thiết kế xuyên suốt:

> **CODE làm chủ luồng danh bộ, không nhờ model quyết định.** Model realtime
> (`gpt-realtime-2.1-mini`) chỉ đọc lại đúng câu / xử lý đúng theo trạng thái mà
> code đưa ra qua kết quả tool. Việc thu số, đếm đủ/thiếu, xác minh, và xác nhận
> đều do `tools.js` + `session-ws.js` điều phối bằng state máy tường minh.

Lý do: model mini không giữ được dãy số ổn định qua nhiều lượt hội thoại (đọc
lại sai, tự bịa số khi chưa nghe được gì, quên chỉ dẫn cũ khi hội thoại dài).
Mọi cơ chế trong tài liệu này đều tồn tại để bù đắp cho những điểm yếu đó — xem
mục "Bẫy thường gặp" ở cuối trước khi cho rằng một rule nào đó "không cần
thiết nữa".

## Bản đồ file

| File | Vai trò trong luồng danh bộ |
|---|---|
| `src/tools.js` | **Lõi state machine.** `resolveDanhBo()` (cổng không chặn cho mọi tool tra cứu), `verifyDanhBoFromSession()` (luồng xác minh nền), các hàm dựng câu thoại (`invalidDanhBoResponse`, `confirmRequestResponse`, `dangXacMinhResponse`, `danhBoDtmfInviteResponse`...), chống bịa số (`classifyModelArg`), chuẩn hoá (`normalizeDanhBo`), tool `confirm_danh_bo` mới (`handleConfirmDanhBo`). |
| `src/session-ws.js` | **Bộ điều phối realtime.** Nhận transcript/DTMF từ OpenAI, quyết định khi nào gọi `verifyDanhBoFromSession`, tự phát câu thoại bằng `_speakVerbatim` (MỨC C), kiểm chứng bot có đọc đúng câu không, chuyển đổi chế độ VAD, các watchdog an toàn. |
| `src/danh-bo-arbiter.js` | **Trọng tài.** Gửi mọi quan sát về cùng một mã cho model mạnh (`gpt-5.1` mặc định) để suy ra 11 chữ số khả dĩ nhất khi các nguồn nghe mâu thuẫn nhau. |
| `src/system-prompt.js` | Đoạn `# Thu thập mã danh bộ` trong `SYSTEM_PROMPT` (chỉ model cách phối hợp với state do code đưa ra) + schema tool `get_bill`/`compare_usage`/`get_outages`/`confirm_danh_bo`/`wait_for_user`. |
| `src/conversation-logger.js` | Ghi timeline sự kiện (`addEvent`) + `markDanhBoStarted/setDanhBoRequestCount/markDanhBoResolved` để đo lường nguồn nào giải được mã (transcript / arbiter / DTMF / known_tel...) qua các đợt fix. |
| `docs/fix/fix_danh_bo_*.md`, `fix_migrate_gpt_realtime_21_20260730.md` | Lịch sử quyết định thiết kế — **đọc trước khi coi một rule là dư thừa**, xem mục cuối tài liệu này. |

---

## 1. Hai biến tích luỹ — nền tảng của toàn bộ luồng

Đây là khái niệm quan trọng nhất cần hiểu trước khi đọc bất cứ hàm nào khác
(xem `docs/fix/fix_danh_bo_hai_bien_muc_b_20260726.md`).

### Biến 1 — `callState._danhBoTranscripts`

- Phạm vi: **toàn bộ cuộc gọi**, tối đa 20 phần tử gần nhất.
- Vai trò: kho quan sát thô để **cấp dữ liệu cho trọng tài** (`danh-bo-arbiter.js`).
- **KHÔNG BAO GIỜ dùng để đếm đủ/thiếu.** Đây là ngoại lệ có chủ đích của quy
  ước "transcript chỉ để debug" trong bộ nhớ dự án — chỉ dùng làm dữ liệu
  fallback, kết quả cuối cùng luôn phải qua API + khách xác nhận lại.

### Biến 2 — `callState._danhBoSession` (`ensureDanhBoSession`)

```js
{ requestNo: 0, startedAt: null, turns: [], digits: "" }
```

- Phạm vi: **MỘT lượt yêu cầu** khách đọc trọn vẹn mã. Reset sạch (`turns = []`,
  `digits = ""`, `requestNo += 1`) mỗi khi code mời khách đọc lại từ đầu
  (`startDanhBoRequest`).
- Vai trò: biến **DUY NHẤT** dùng để xác định đã đủ 11 số / thiếu / vượt số
  (`danhBoSessionDigits`).
- `requestNo` là bộ đếm leo thang **duy nhất** — nó đếm đúng số lần khách *cảm
  nhận* là phải đọc lại, khác các bộ đếm nội bộ cũ (`_danhBoResolveTries`,
  `_danhBoAssembleTries`) từng đếm theo nhánh code, không phản ánh trải nghiệm
  thật (một cuộc gọi mẫu chạy 3 phút rưỡi mà chưa lần nào mời bấm phím).

Lý do tách hai biến: nếu ghép mù toàn bộ buffer cuộc gọi để đếm, chỉ vài lượt
đọc là buffer đã có 30+ chữ số → vòng chờ "đủ 11 số" thoát sai thời điểm và
"reset phiên" xảy ra ngay giữa lúc khách đang đọc dở (sự cố gốc dẫn tới thiết
kế này — cuộc `rtc_u2_E5eDfB96UnJE6iDWfPbRX`).

`noteDanhBoTranscript(callState, text)` (`tools.js`) là hàm **duy nhất** ghi
vào cả hai biến cùng lúc; luôn gọi hàm này thay vì tự đẩy vào mảng.

---

## 2. Trạng thái `callState.danhBo`

```js
callState.danhBo = { value: "22023251775", confirmed: false | true };
```

- `value`: dãy 11 chữ số đang là **ứng viên** hoặc đã chốt.
- `confirmed`: `true` **CHỈ** khi được set bởi một trong hai nguồn:
  1. `session-ws.js` bắt được **lượt khách THẬT** chứa từ khẳng định (regex
     `_KHANG_DINH_RE` / `_KHANG_DINH_TU_DON_RE`, xem §6);
  2. Danh bộ do **hệ thống cấp sẵn** theo SĐT gọi đến (`callState.knownDanhBo`)
     — số này vừa được backend xác minh khớp SĐT đang gọi, không đi qua "tai"
     model nên tin ngay (`resolveDanhBo`, nhánh `known_tel`).
- **Model gọi tool tra cứu KHÔNG BAO GIỜ được tính là bằng chứng đồng ý** — kể
  cả khi model "nghĩ" số đó đúng. Đây là gate quan trọng nhất chống lộ dữ liệu
  khách hàng khác; xem thêm `docs/fix/fix_danh_bo_trong_tai_20260719.md`.

Các trường liên quan khác trên `callState` (không đầy đủ, xem chú thích trong
`tools.js` §"HAI BIẾN TÍCH LUỸ" và §"PHÁT HIỆN MODEL BỊA SỐ"):

| Trường | Ý nghĩa |
|---|---|
| `knownDanhBo` | Danh bộ tra sẵn theo SĐT gọi đến — tin ngay, không ép xác nhận qua tầng code. |
| `historyDanhBo` | Danh bộ khách **đã xác nhận** ở cuộc gọi trước cùng SĐT — chỉ dùng khi `knownDanhBo` rỗng; **PHẢI** qua gate xác nhận lời nói như luồng đọc số bình thường (khác `knownDanhBo`) vì SĐT có thể đã đổi chủ. |
| `_danhBoReads` | Các dãy số model *nghe* qua tham số `ma_danh_bo`, đã lọc bịa (`classifyModelArg`) — một "quan sát" nữa cho trọng tài. |
| `_danhBoRejected` | Các dãy đã đọc lại cho khách và bị khách báo sai — trọng tài né, không đề xuất lại. |
| `_danhBoProposeCount` | Số lần trọng tài đã đề xuất ứng viên (chặn ở 2 lần, chống vòng lặp đoán-sai-đoán-lại). |
| `_danhBoResolvedBy` | Nguồn chốt được mã: `transcript_11` / `arbiter` / `dtmf` / `known_tel` / `history_tel` — dùng để đo lường hiệu quả giữa các đợt fix (`logger.markDanhBoResolved`). |
| `_hallucinationCount` | Số lần model bịa số bị `classifyModelArg` bắt được — dùng để leo thang sang DTMF. |
| `_danhBoNeedsVerbalYes` | `true` khi ứng viên đến từ suy luận (trọng tài/lịch sử) — rủi ro cao hơn khách tự đọc trôi chảy, bắt buộc gate xác nhận lời nói. |
| `_danhBoDtmfInvited` | Đã mời bấm phím — hết lượt đọc giọng nói. |

---

## 3. Luồng tổng quan (happy path)

```
Khách đọc số ──▶ session-ws.js nhận transcript
                    │  (noteDanhBoTranscript → biến 2 += chữ số)
                    ▼
              _maybeVerifyDanhBo() debounce (1.5s nếu đủ 11 số, 9s nếu thiếu)
                    ▼
              verifyDanhBoFromSession() [tools.js] — chạy NỀN, không chặn tool
                    │
        ┌───────────┴────────────┐
        ▼                        ▼
  (a) verify API ~40ms     (b) trọng tài gpt-5.1 (song song, hạn 10s)
        └───────────┬────────────┘
                     ▼
        Quyết định theo 3 nhánh (§5) → lưu callState.danhBo = {value, confirmed:false}
                     ▼
        session-ws.js tự đọc câu xác nhận qua _speakVerbatim (KHÔNG chờ model)
                     ▼
        Khách nói "đúng rồi" (lượt khách THẬT, regex khẳng định)
                     ▼
        session-ws.js set confirmed = true, gỡ mọi lock, nhờ model gọi tool tra cứu
                     ▼
        Model gọi get_bill/compare_usage/... → resolveDanhBo() thấy đã confirmed
        → trả { ok: true, value } ngay, KHÔNG hỏi lại
```

Nếu bất kỳ bước nào thất bại lặp lại (khách đọc sai 3 lượt, model bịa số ≥2
lần...), hệ thống **leo thang sang bấm phím DTMF** rồi cuối cùng **chuyển máy
tổng đài viên** — xem §8.

---

## 4. `resolveDanhBo()` — cổng không chặn cho mọi tool tra cứu

`tools.js:resolveDanhBo(rawArg, callState)` là hàm **duy nhất** mọi handler tra
cứu (`fetchBilling`, `handleCompareUsage`, `handleGetOutages`...) gọi để lấy mã
danh bộ dùng tra cứu. Nó **không** làm việc gom số hay gọi trọng tài — đó là
việc của đường nền (`verifyDanhBoFromSession`, do `session-ws.js` gọi). Mục
tiêu phản hồi ≤ 2 giây, vì đây là bên trong một tool call của model.

Thứ tự kiểm tra (đọc đúng theo code, không đảo):

1. **Đã có `danhBo.confirmed === true`** → nếu khách vừa đọc một dãy 11 số
   **khác hẳn** số đã confirmed trong phiên hiện tại, coi là đổi danh bộ — mở
   lại vòng xác nhận cho số mới. Ngược lại trả `{ ok: true, value }` ngay.
2. **Có `danhBo.value` nhưng chưa `confirmed`** → **luôn** trả về yêu cầu xác
   nhận lại (không tra cứu), bất kể arg model truyền vào là gì — arg không
   được phép ghi đè ứng viên đang chờ.
3. **Chưa có gì** — theo thứ tự ưu tiên:
   - Arg model khớp `knownDanhBo` (tra theo SĐT) → tin ngay, `confirmed: true`.
   - Chưa đọc số nào trong phiên + có `historyDanhBo` + chưa từng đề xuất →
     đề xuất ứng viên từ lịch sử, **vẫn phải qua gate xác nhận lời nói**.
   - Ghi nhận arg model vào kho quan sát (`noteModelHeardDanhBo` →
     `classifyModelArg`, xem §7) — **không** dùng để tra cứu hay đếm.
   - Model bịa số ≥ 2 lần **và** khách đã từng đọc số → mời bấm phím DTMF luôn.
   - Theo số chữ số đã gom trong phiên hiện tại (biến 2): `0` → xin số;
     `1..10` → "đang nghe" (`dangGomSoResponse`); `≥11` → "đang xác minh"
     (`dangXacMinhResponse`, câu xác nhận thật do đường nền phát sau).

Mọi nhánh ở đây đều trả về **ngay lập tức** — không có `await` việc gom số hay
gọi trọng tài bên trong `resolveDanhBo`. Đây là quy ước "không để tool call
treo quá ~2 giây" (xem `CLAUDE.md`): một lần treo 21 giây từng khiến model tự
bịa 2 số danh bộ đọc cho khách nghe 4 lần trong lúc chờ.

---

## 5. `verifyDanhBoFromSession()` — luồng xác minh chạy nền

`tools.js:verifyDanhBoFromSession(callState, { chapNhanThieuSo })`, được
`session-ws.js` gọi (qua `_maybeVerifyDanhBo`, debounce sau khi khách ngưng
đọc) chứ **không** gọi từ bên trong một tool call của model.

Nguyên tắc cốt lõi: **transcript ra đúng 11 số vẫn phải qua trọng tài** —
ASR có thể nghe sai mà vẫn cho ra đủ 11 chữ số "sạch mắt" nhưng sai giá trị.

Hai kênh chạy **song song** (`Promise.race`, không nối tiếp):

- **(a) verify API** (~40ms) — hỏi thẳng backend (`getThongTinKhachHang`) xem
  dãy số từ lượt đọc đơn gần nhất (`latestSessionDanhBo`, phải ra đúng 11 số
  trong MỘT lượt) có tồn tại không. Đây là "trọng tài rẻ nhất và chắc nhất" —
  dùng để phân xử ứng viên thay vì bắt LLM tự chịu trách nhiệm chọn duy nhất
  một đáp án (nguyên tắc ghi trong `CLAUDE.md`).
- **(b) trọng tài `gpt-5.1`** (`runDanhBoArbiter` → `danh-bo-arbiter.js`, hạn
  `DANH_BO_VERIFY_WAIT_MS`, mặc định 10s) — đối chiếu MỌI quan sát (§6).

Sau khi có kết quả, code **guard chống dữ liệu lỗi thời** trước khi dùng: nếu
trong lúc chờ, `callState.danhBo` đã được set bởi đường khác, hoặc
`requestNo`/`digits` của phiên đã đổi (khách đọc thêm / mở phiên mới) → bỏ kết
quả, trả `{ action: "none" }`.

Ba nhánh quyết định cuối cùng:

1. **Lượt đơn ra đúng 11 số VÀ tồn tại trong API** → chốt luôn theo transcript
   (`_danhBoResolvedBy = "transcript_11"`), **không** cần gate xác nhận lời
   nói bổ sung (khách tự đọc thẳng, đã có API bảo chứng) — nhưng vẫn phải qua
   vòng đọc lại xác nhận thông thường trước khi tra cứu (bước 2 của
   `resolveDanhBo`).
2. **Transcript không tồn tại trong API (hoặc không có lượt đơn 11 số)** →
   dùng ứng viên của trọng tài, đi qua `tryProposeArbiterCandidate` (xem §6) —
   nếu đạt chuẩn thì set `_danhBoNeedsVerbalYes = true` (bắt buộc gate xác
   nhận lời nói vì đây là suy luận, rủi ro cao hơn).
3. **Cả hai kênh đều không ra ứng viên hợp lệ** → mời đọc lại hoặc leo thang
   DTMF tuỳ `requestNo` (`danhBoReReadOrEscalate`, §8).

---

## 6. Trọng tài `gpt-5.1` (`danh-bo-arbiter.js`)

`arbitrateDanhBo({ reads, transcripts, latestTranscripts, knownDanhBo, rejected })`
gửi một prompt duy nhất tới `gpt-5.1` (đổi được qua `DANH_BO_ARBITER_MODEL`),
yêu cầu trả về structured output:

```json
{ "ma_danh_bo": "11 chữ số hoặc null", "do_tin_cay": 0.0, "ly_do": "..." }
```

Nguồn quan sát đưa vào prompt, theo thứ tự ưu tiên khi mâu thuẫn (ghi rõ trong
prompt): **lần đọc mới nhất** (`latestTranscripts`, tách riêng khỏi các lần
trước để không bị pha loãng bởi dữ liệu cũ) > **các lần đọc trước** (đối chiếu
theo từng vị trí chữ số, kiểu "bỏ phiếu") > **danh bộ theo SĐT** (gợi ý, không
ép) > **bản nghe của model thoại** (kém tin cậy nhất, chỉ phá thế hoà) — và
tuyệt đối không được đề xuất lại các dãy đã nằm trong `rejected`.

Bài toán được đóng khung rõ trong prompt là "bỏ phiếu theo từng vị trí" (mỗi
lần đọc là một *bản đầy đủ* của cùng một mã, không phải các mảnh nối tiếp
nhau) — tránh trọng tài hiểu nhầm nhiều lượt đọc là các đoạn cần ghép nối.

`tools.js:tryProposeArbiterCandidate` quyết định có dùng verdict của trọng tài
hay không, theo **hai mức tin cậy** (`docs/fix` 26/07/2026):

- `do_tin_cay ≥ ARBITER_MIN_CONFIDENCE` (mặc định 0.7) → dùng thẳng.
- `do_tin_cay ≥ ARBITER_LOW_CONFIDENCE` (mặc định 0.3) **và** API xác nhận
  DỨT KHOÁT (`chacChan: true`) là số đó **có thật** → vẫn dùng. Lý do: trọng
  tài có thể tự chấm điểm tin cậy thấp một cách khiêm tốn dù suy luận đúng
  (phải ghép qua nhiều mảnh nhiễu), trong khi việc gọi API xác nhận "số này có
  tồn tại" chỉ tốn ~40ms và là bằng chứng chắc hơn hẳn con số tự đánh giá của
  một LLM. API vẫn luôn được hỏi **trước** khi xét ngưỡng tin cậy — không bao
  giờ chốt một ứng viên chưa qua API.

Mỗi ứng viên chỉ được đề xuất tối đa 2 lần / cuộc gọi
(`_danhBoProposeCount`), và không bao giờ đề xuất lại một dãy đã có trong
`_danhBoRejected`.

### Tự sửa khi tra cứu chết ở `CUSTOMER_NOT_FOUND`

`danhBoNotFoundSelfCorrect` (gọi từ `fetchBilling` khi backend trả
`CUSTOMER_NOT_FOUND`): đẩy số hiện tại vào `rejected`, rồi gọi lại
`verifyDanhBoFromSession(callState, { chapNhanThieuSo: true })` — nếu co-pilot
nền đã âm thầm suy ra một dãy khác đúng hơn (ví dụ model nghe
`22273240168` nhưng transcript thật là `23273240168`), đọc lại ứng viên đó cho
khách thay vì báo chung chung "không tìm thấy, đọc lại từ đầu".

---

## 7. Chống model bịa số (`classifyModelArg`)

Trường `ma_danh_bo` là **`required`** trong schema của các tool tra cứu (ép
buộc bởi structured output) — model **buộc phải điền một giá trị** kể cả khi
chưa nghe được gì. Vì vậy mọi arg model gửi lên đều phải được phân loại trước
khi tin dùng làm quan sát:

```
R1 — phiên (biến 2) chưa có chữ số nào     → BỊA (bắt trọn ca bịa hoàn toàn)
R2 — arg là substring của phiên            → nghe đúng
R3 — Levenshtein ≤ max(1, ⌊len*0.2⌋)       → nghe lệch, vẫn nhận làm quan sát
R4 — còn lại                                → BỊA
```

`noteModelHeardDanhBo` gọi hàm này: verdict `"bia"` → tăng
`_hallucinationCount`, **không** đưa vào `_danhBoReads` (không vào kho quan
sát, không đếm, không tra cứu). Verdict khác → đẩy vào `_danhBoReads` (tối đa
20 phần tử) làm thêm một "quan sát" cho trọng tài.

Song song, `session-ws.js:_checkBotSpokenDigits` giám sát **chiều ngược lại**
— bot có lỡ *đọc ra loa* một dãy số không nằm trong tập được phép (số đang
chờ/đã chốt, hoặc số trong câu code vừa yêu cầu đọc) không. Bắt được thì
**không** cancel response đang chạy (số đã phát ra loa, cancel không rút lại
được — bài học trả giá 2 lần bằng bot câm 24-28 giây), mà nói đè lại đúng câu
của bước đang chờ (`_reAssertDanhBoStep`).

---

## 8. Leo thang: đọc lại → DTMF → chuyển máy

`danhBoReReadOrEscalate(callState, heardLen)` (`tools.js`) là điểm quyết định
duy nhất "mời đọc lại hay đã đến lúc bấm phím", dựa **hoàn toàn** vào
`requestNo` của biến 2 (đếm đúng số lần khách *cảm nhận* phải đọc lại):

```
requestNo < DANH_BO_MAX_READS (mặc định 3)  → invalidDanhBoResponse (mời đọc lại)
requestNo ≥ DANH_BO_MAX_READS                → danhBoDtmfInviteResponse (mời bấm phím)
đã mời DTMF rồi mà vẫn không xong             → danhBoEscalationResponse (mời chuyển máy / tạo phiếu)
```

**DTMF** (`input_audio_buffer.dtmf_event_received`, `session-ws.js`): nhận
phím ở **bất kỳ lúc nào** trong cuộc gọi, không cần đợi bot mời — khách sốt
ruột bấm luôn cũng được. Phím `*` xoá buffer nhập lại từ đầu; đủ 11 chữ số →
lưu thẳng `callState.danhBo = { value, confirmed: false }` với
`_danhBoResolvedBy = "dtmf"`, huỷ mọi việc gom số bằng giọng nói đang treo, và
tự đọc câu xác nhận. DTMF là dữ liệu **chính xác tuyệt đối** (không qua "tai"
model) nên không cần gate xác nhận lời nói của trọng tài — chỉ cần vòng xác
nhận thường (khách vẫn phải nói "đúng"/"sai").

**Watchdog tổng** (`_armDanhBoWatchdog`, `DANH_BO_WATCHDOG_MS` mặc định 90s,
`session-ws.js`): lưới an toàn cuối nếu mọi cơ chế khác không tự leo thang kịp
— hết hạn mà chưa `confirmed` và chưa mời DTMF thì tự mời bấm phím ngay.

**Chuyển tổng đài viên** (`_escalateDanhBoToDtmf` khi `_danhBoDtmfInvited`
đã `true` mà vẫn bỏ cuộc): nghĩa là **cả hai kênh tự động đã thất bại**
(giọng nói lẫn DTMF/đọc lại xác nhận DTMF) — không còn kênh nào khác để mời,
chuyển máy ngay thay vì để khách chờ trong im lặng.

---

## 9. Xác nhận bằng lời nói (gate quan trọng nhất)

`session-ws.js` xử lý mọi transcript khách nói tại
`conversation.item.input_audio_transcription.completed`. Khi đang có
`callState.danhBo` **chưa** `confirmed`:

- `_isAffirmative(text)` — khẳng định. Cẩn trọng nhiều lớp (đọc kỹ trước khi
  sửa regex `_KHANG_DINH_RE`/`_KHANG_DINH_TU_DON_RE`):
  - Câu có dấu `?` → **không bao giờ** tính là xác nhận (khách hỏi xen vào,
    không phải đang trả lời đúng/sai).
  - Từ đệm một âm tiết ("ừ", "ờ") chỉ tính khi là **cả câu** (≤2 từ) — dùng
    `\b` ngây thơ từng khớp nhầm bên trong các từ khác chứa "ờ" như "dời",
    "giờ", "chờ" (mọi ký tự có dấu bị JS coi là word-boundary).
  - `_PHU_DINH_RE` được kiểm **trước** — câu vừa có ý phủ định vừa lỡ chứa từ
    khẳng định thì tính là phủ định.
- Bắt được khẳng định ở lượt khách **thật** (không phải model tự gọi tool) →
  `danhBo.confirmed = true`, dọn phiên đọc số, tắt mọi watchdog/timer đang
  treo, rồi chủ động nhờ model gọi tool tra cứu (§10).
- Bắt được phủ định (`_PHU_DINH_RE`) → `noteDanhBoRejected` (đẩy vào
  `_danhBoRejected`, xoá `callState.danhBo`), chạy lại đường nền ngay để trọng
  tài đề xuất phương án khác.
- Khách đọc lại một dãy số khác trong lúc đang chờ xác nhận (không nói rõ
  đúng/sai) → coi là **phủ định ngầm** ứng viên cũ, mở phiên đọc mới — **trừ**
  khi dãy đọc lại **trùng y hệt** ứng viên đang chờ, khi đó coi là **củng cố**
  (không đẩy nhầm số ĐÚNG vào `rejected`, tránh khoá chết mã đúng cho phần còn
  lại cuộc gọi — sự cố đã xảy ra thật, `docs/fix` 04/08/2026 đợt 15).

Đây là "gate xác nhận lời nói" mà bộ nhớ dự án nhấn mạnh chỉ áp dụng cho danh
bộ đến từ suy luận trọng tài / lịch sử — **không** mở rộng gate này sang các
luồng khác nếu chưa có yêu cầu tường minh.

---

## 10. MỨC C — khoá model trong giai đoạn thu số (`DANH_BO_MODE`)

### VAD hai chế độ (`_setVadMode`, `session-ws.js`)

- **`"digits"`**: `server_vad`, `silence_duration_ms` dài hơn (mặc định
  2000ms, `DANH_BO_VAD_SILENCE_MS`) để chịu được khách đọc số tách nhiều hơi.
  `semantic_vad` (chế độ bình thường) chốt lượt theo *ngữ nghĩa* nên cắt vụn
  từng hơi đọc số thành nhiều "lượt hoàn chỉnh" riêng biệt — đây là lý do
  không dùng semantic_vad khi đang thu số.
- **`"normal"`**: `semantic_vad`, `eagerness: "low"`.

### `create_response: false` — MỨC C

Trong VAD mode `"digits"`, mặc định (`DANH_BO_MODE=locked`) đặt
`create_response: false`: audio khách vẫn được commit và transcribe bình
thường, nhưng **model vật lý không tự sinh response**. Đổi lại, **CODE phải
chịu trách nhiệm phát MỌI câu thoại** trong giai đoạn này qua `_speakVerbatim`
— mỗi lượt khách nói phải rơi đúng vào MỘT nhánh có phát lời trong bảng quyết
định tại `conversation.item.input_audio_transcription.completed` (§9 và đoạn
mã ~dòng 1710-1845 của `session-ws.js`): đọc số / xác nhận / phủ định / đổi
chủ đề / xin nhắc lại / trả lời không rõ khi đang chờ xác nhận.

Đây là lưới an toàn **đã kiểm chứng qua nhiều đợt fix và cuộc gọi thật** cho
model không có (hoặc yếu) reasoning — xem
`docs/fix/fix_migrate_gpt_realtime_21_20260730.md`. Rủi ro lớn nhất của MỨC C:
code quên phát lời ở một nhánh nào đó → bot im lặng tới khi khách tự cúp máy.
Vì vậy có thêm **lưới an toàn chống câm** (`_armMuteWatchdog`,
`DANH_BO_MUTE_WATCHDOG_MS` mặc định 15s): bot im lặng quá lâu sau khi khách
nói → tự mở khoá model và nhờ nó trả lời tự do. **Mỗi sự kiện `mute_watchdog`
trong log là một nhánh code còn thiếu, cần bịt riêng — không phải hiện tượng
bình thường.**

> **Nguyên tắc:** bot câm tệ hơn bot trả lời sai.

### Ba chế độ `DANH_BO_MODE`

Biến môi trường, đọc ở nhiều chỗ trong `session-ws.js` (không cache thành một
hằng số — cẩn thận khi refactor, so trực tiếp chuỗi ở từng nơi dùng):

| Giá trị | Giai đoạn gom số thô | Giai đoạn xác nhận |
|---|---|---|
| `locked` (**mặc định**) | Khoá (`create_response:false`) | Khoá — code đọc nguyên văn qua `_speakVerbatim` |
| `unlocked` (thử nghiệm — **đã test thật 30/07, THẤT BẠI**) | Mở (`create_response:true`) | Mở — model tự trả lời |
| `confirm_tool` (thử nghiệm hẹp hơn) | Khoá y hệt `locked` | Mở — model tự đọc câu xác nhận **qua tool `confirm_danh_bo`** (ép bằng `tool_choice`), không phải free-form |

`confirm_tool` là hướng thử nghiệm hiện tại: thu hẹp phạm vi "thả" model chỉ
còn đúng bước đọc câu xác nhận, và ngay cả ở đó cũng ép model gọi một tool cụ
thể (`_openDanhBoConfirmTurn`) thay vì để nó tự do phát ngôn — giảm rủi ro so
với `unlocked` (đã thất bại khi thử toàn bộ hai giai đoạn).

**Bug lịch sử đáng nhớ khi sửa vùng này** (`docs/fix` 30/07/2026): công thức
`create_response` từng viết `!_DANHBO_UNLOCKED` — ngược dấu so với đúng ý định
— khiến `locked` (mặc định) **thực ra không khoá gì** trong giai đoạn gom số
suốt một khoảng thời gian không rõ đã ảnh hưởng bao nhiêu cuộc gọi thật. Luôn
viết lại test / gọi thử thật sau khi đổi bất kỳ biểu thức boolean nào quanh
`create_response`.

---

## 11. Tool `confirm_danh_bo` (mới, `DANH_BO_MODE=confirm_tool`)

Khác **hoàn toàn** tool `confirm_danh_bo` cũ đã gỡ 23/07/2026 (tool cũ **nhận**
dãy số từ model làm nguồn ghi nhận — rủi ro, vì tin "tai" model). Tool mới
**không nhận tham số nào** (`handleConfirmDanhBo(callState)`, `tools.js`), chỉ
đọc lại `callState.danhBo` đã được CODE xác minh (API + trọng tài) và trả
đúng một trường model cần tin:

```json
{ "trang_thai_danh_bo": "chua_co" | "dang_cho_xac_nhan" | "da_xac_nhan", "ma_danh_bo": "..." }
```

`session-ws.js:_openDanhBoConfirmTurn` mở lượt cho model gọi tool này bằng
cách **ép `tool_choice: { type: "function", name: "confirm_danh_bo" }`** — cơ
chế ép cấu trúc của API, không phụ thuộc việc model có tuân theo hướng dẫn
bằng lời hay không.

Có **gate chống spam** (`danhBoConfirmSpamGate`, `DANH_BO_CONFIRM_SPAM_MAX`
mặc định 3): nếu model tự gọi lại tool này liên tục cho **cùng một trạng thái**
mà không có lượt khách thật nào xen giữa, tool trả `action: "no_reply"` (không
tạo thêm response) rồi vượt ngưỡng thì báo `_danhBoConfirmSpamEscalate: true`
để `session-ws.js` tự khoá lại và đọc câu xác nhận bằng cơ chế cũ
(`_speakVerbatim`) — **không** mời bấm DTMF ở đây (mã đã đúng, chỉ là model
hỏi lặp — DTMF sai ngữ cảnh, gây khó hiểu cho khách).
`noteDanhBoConfirmNewTurn` (gọi mỗi khi có lượt khách thật) mở lại "cửa sổ"
này — tránh coi nhầm một lượt xác nhận/phủ định hợp lệ của khách là "model tự
spam".

Trường `message` trong mọi payload JSON của luồng danh bộ **nằm lại vĩnh viễn**
trong hội thoại (nó là nội dung `function_call_output`) — tuyệt đối không đặt
mệnh lệnh kiểu "đọc NGUYÊN VĂN doc_cho_khach" vào đó, vì model sẽ bám vào chỉ
dẫn đó ở MỌI lượt sau, kể cả khi code đã gửi `instructions` mới cho response
hiện tại. `message` chỉ nên **mô tả trạng thái**; mệnh lệnh ép đọc nguyên văn
luôn đặt trong `instructions` của `response.create` — chỉ có hiệu lực cho
đúng response đó rồi biến mất. Đọc kỹ các đoạn code xây payload trong
`tools.js` (`danhBoPayload` và các hàm gọi nó) trước khi thêm câu chữ mới vào
`message`.

---

## 12. `_speakVerbatim` — ép model đọc đúng nguyên văn, có kiểm chứng

Vì không thể tin model tuân thủ prompt 100% (ngay cả khi bị `tool_choice:
"none"`), `session-ws.js:_speakVerbatim(text, tag, attempt, opts)` là cơ chế
chung để CODE tự phát một câu:

1. Gửi `response.create` với `instructions` yêu cầu đọc nguyên văn +
   `tool_choice: "none"` (cấm model nhân dịp này gọi tool).
2. Nếu `opts.verify: true`, lưu lại `_expectedSpeak = { text, tag, core, gen, ... }`
   để đối chiếu với những gì bot **thực sự nói ra** ở
   `conversation.item.done` (`_checkExpectedSpeak`).
3. Lệch → gửi lại tối đa 2 lần; nếu lần lệch **giống hệt** lần lệch trước
   (cùng lỗi phát âm mang tính hệ thống, ví dụ TTS hay đọc lặp một chữ số liền
   kề) → bỏ cuộc sớm thay vì đợi đủ 3 lần.
4. Bỏ cuộc ở đúng bước đọc lại xác nhận danh bộ → tự động leo thang DTMF
   (`_escalateDanhBoToDtmf`).

Cơ chế `gen` (thế hệ) chống race giữa nhiều lời gọi `_speakVerbatim`/
`_openDanhBoConfirmTurn` cùng tranh nhau một "khe" response: mỗi **ý định nói
mới** được cấp `gen` tăng dần, các lần **retry** mang theo `gen` cũ — nếu một
ý định mới hơn đã chiếm quyền trong lúc retry đang chờ, retry đó tự nhận ra
mình "mồ côi" và huỷ, không gửi đè lên câu đang thật sự cần nói. Đọc kỹ đoạn
comment "đợt 28" trong `session-ws.js` nếu cần sửa vùng này — đây là một race
condition tinh vi đã từng gây bot lặp sai câu chờ vô nghĩa.

---

## 13. Chuẩn hoá & đọc số

- `normalizeDanhBo(raw)` (`tools.js`): bỏ mọi ký tự không phải chữ số. Nếu
  rỗng, thử ghép từ **chữ số đọc bằng lời tiếng Việt** (`viDigitsFromWords`) —
  cần thiết vì model đôi khi echo lại bản đọc thành chữ ("Hai - Hai - Không...")
  thay vì chữ số thô. `viDigitsFromWords` tìm **chuỗi liên tục dài nhất** gồm
  toàn token chữ số (≥3 token), bỏ qua từ khung câu xen giữa ("Số danh bộ LÀ
  hai hai không...") — bản cũ yêu cầu cả câu toàn chữ số nên gần như luôn thất
  bại khi khách kèm câu dẫn tự nhiên.
- `danhBoSpoken(s)` (`tools.js`, export cho `session-ws.js` dùng lại khi đọc
  số DTMF): đọc từng chữ số tiếng Việt, nối bằng " - " (`"Hai - Hai - Không..."`)
  — **luôn** đọc theo cách này khi xác nhận lại cho khách, không đọc thành số
  nguyên (dễ nhầm "hai mươi hai" với "hai, hai").

Luôn gọi `normalizeDanhBo` trước khi so sánh/lưu bất kỳ chuỗi số nào lấy từ
model hoặc transcript — không tự viết lại logic strip ký tự ở nơi khác.

---

## 14. Biến môi trường liên quan

| Biến | Mặc định | Ảnh hưởng |
|---|---|---|
| `DANH_BO_MODE` | `locked` | `locked`\|`unlocked`\|`confirm_tool` — xem §10. |
| `DANH_BO_ARBITER_MODEL` | `gpt-5.1` | Model trọng tài. |
| `DANH_BO_ARBITER_TIMEOUT_MS` | `20000` | Hạn gọi API trọng tài (an toàn vì luôn chạy nền). |
| `DANH_BO_ARBITER_REASONING_EFFORT` | `low` | Reasoning effort của trọng tài — thấp vì khách đang chờ trong lúc trọng tài "nghĩ". |
| `DANH_BO_ARBITER_MIN_CONFIDENCE` | `0.7` | Ngưỡng tin cậy dùng thẳng verdict trọng tài. |
| `DANH_BO_ARBITER_LOW_CONFIDENCE` | `0.3` | Ngưỡng thấp — chỉ dùng khi API xác nhận dứt khoát số có thật. |
| `DANH_BO_VERIFY_WAIT_MS` | `10000` | Hạn chờ trọng tài trong luồng xác minh nền (không chặn tool call). |
| `DANH_BO_DEBOUNCE_DU_MS` | `1500` | Debounce trước khi verify khi ĐÃ đủ 11 số. |
| `DANH_BO_DEBOUNCE_THIEU_MS` | `9000` | Debounce khi CHƯA đủ số (chờ khách đọc tiếp). |
| `DANH_BO_VAD_SILENCE_MS` | `2000` | `silence_duration_ms` của VAD `"digits"`. |
| `DANH_BO_VAD_THRESHOLD` | `0.6` | Ngưỡng VAD `"digits"`. |
| `DANH_BO_VAD_RESTORE_MS` | `90000` | Lưới an toàn: tự trả VAD về `"normal"` nếu quên. |
| `DANH_BO_MUTE_WATCHDOG_MS` | `15000` | Lưới an toàn chống bot câm khi model bị khoá (MỨC C). |
| `DANH_BO_WATCHDOG_MS` | `90000` | Watchdog tổng cho bước lấy danh bộ — hết hạn thì mời DTMF. |
| `DANH_BO_CONFIRM_SPAM_MAX` | `3` | Ngưỡng gate chống model tự gọi lặp `confirm_danh_bo`. |
| `DANH_BO_TOOL_PROMPT_DELAY_MS` | `900` | Độ trễ trước khi phát câu tool (để kiểm tra lại câu có lỗi thời chưa). |

Đầy đủ hơn: xem bảng trong `README.md` (mục cấu hình `.env`) và
`.env.example`.

---

## 15. Bẫy thường gặp khi sửa code vùng này

- **Không dùng biến 1 (`_danhBoTranscripts`) để đếm đủ/thiếu.** Chỉ biến 2
  (`_danhBoSession.digits`) mới được dùng cho việc đó.
- **Không cho `resolveDanhBo` (hoặc bất kỳ hàm nào bên trong một tool call)
  `await` việc gom số hay gọi trọng tài.** Việc đó thuộc về đường nền
  (`verifyDanhBoFromSession`, gọi từ `session-ws.js`).
- **Không đặt mệnh lệnh ép đọc nguyên văn vào trường `message`** của payload
  tool — trường này tồn tại vĩnh viễn trong hội thoại. Ép đọc nguyên văn chỉ
  đặt trong `instructions` của `response.create`.
- **Không tin việc model gọi tool là bằng chứng khách đã xác nhận.** Chỉ
  transcript thật của khách (qua `_isAffirmative`) hoặc DTMF/`knownDanhBo` mới
  được set `confirmed = true`.
- **Không coi `historyDanhBo` giống `knownDanhBo`.** `historyDanhBo` là dữ
  liệu cũ (SĐT có thể đã đổi chủ) — luôn phải qua gate xác nhận lời nói thật,
  không tin ngay dù model echo đúng số.
- **Khi sửa biểu thức boolean quanh `create_response`/`_DANHBO_UNLOCKED`,
  test lại bằng cuộc gọi thật** — đã có một lần viết ngược dấu (`!`) khiến chế
  độ mặc định `locked` không khoá gì trong nhiều ngày, không có test tự động
  nào bắt được (xem §10).
- **Mọi bước quan trọng phải có lối đi không phụ thuộc việc model gọi tool.**
  Một lần tắt nhầm đường nền đã biến model mini thành điểm lỗi đơn cho cả
  luồng danh bộ (`docs/fix` 25/07/2026).
- **Ngưỡng leo thang phải tính theo trải nghiệm khách** (số lượt đã đọc, số
  giây đã trôi) — không theo số lần code chạy qua một nhánh nội bộ. Đây là lý
  do `requestNo` thay thế các bộ đếm nội bộ cũ.
- **Trước khi coi một rule/workaround (MỨC C, nới VAD, trọng tài gpt-5.1) là
  "không cần thiết nữa" vì model mới tuân lệnh tốt hơn** — đọc
  `docs/fix/fix_migrate_gpt_realtime_21_20260730.md`. Phần lớn các rule này là
  lưới an toàn có chủ đích, không phải tàn dư quên dọn; `unlocked` (bỏ MỨC C
  hoàn toàn) đã được test thật và **thất bại**.
- **`test_case/danh_bo_verify_flow.test.mjs`** (và các file `.test.mjs` khác
  trong `test_case/`) kiểm tra một số cụm câu thoại cố định (ví dụ "đọc lại
  đầy đủ" trong `invalidDanhBoResponse`) — đổi câu chữ nhớ chạy `npm test`.

---

## 16. Đọc thêm

Trong cùng thư mục:

- [`fetchBilling.md`](./fetchBilling.md) — nội dung trả về chi tiết của
  `fetchBilling()`/`handleGetBill()` (tool `get_bill`), kèm bảng các trạng
  thái `ok:false` có thể gặp.
- [`vi_du_doc_danh_bo.md`](./vi_du_doc_danh_bo.md) — 13 ví dụ minh hoạ các
  trường hợp đọc mã danh bộ (đọc liền mạch, đọc rời rạc, thiếu/thừa số, model
  nghe lệch/bịa số, mã có sẵn theo SĐT/lịch sử, DTMF, leo thang...).

Lịch sử quyết định thiết kế chi tiết, kèm log cuộc gọi thật minh hoạ từng sự
cố, nằm trong `docs/fix/`:

- `fix_confirm_danh_bo_20260718.md`, `fix_danh_bo_nghe_sai_escalation_dtmf_20260718.md`
- `fix_danh_bo_443_tu_dau_20260719.md`, `fix_danh_bo_trong_tai_20260719.md`,
  `fix_danh_bo_copilot_dtmf_20260719.md`
- `fix_danh_bo_hai_bien_muc_b_20260726.md` — nguồn gốc thiết kế "hai biến tích
  luỹ" (§1) và luồng xác minh nền (§5).
- `fix_migrate_gpt_realtime_21_20260730.md` — quyết định giữ MỨC C khi
  migrate model, thêm `confirm_danh_bo`/`wait_for_user`/`DANH_BO_MODE` (§10-11).
