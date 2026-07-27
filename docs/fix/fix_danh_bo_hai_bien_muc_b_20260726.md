# Fix mã danh bộ — hai biến tích luỹ + mức B (26/07/2026)

Triển khai [kế hoạch v3](../fix_plan/ke_hoach_v3_danh_bo_20260726.md).
Cuộc gọi gốc: `rtc_u2_E5eDfB96UnJE6iDWfPbRX` (26/07 04:29–04:32), mã đúng `22023251775`.
Phân tích đầy đủ: [`phan_tich_loi_danh_bo_20260726.md`](../fix_plan/phan_tich_loi_danh_bo_20260726.md).

Chạy test: `npm test`

---

## Lỗi gốc

Khách đọc **đúng trọn vẹn** `22023251775` lúc 04:32:06 — transcript ghi đúng 11 chữ số — nhưng
**không dòng code nào xử lý nó**. Fix 25/07 đã tắt đường nền (`session-ws.js:630`), nên toàn bộ luồng
danh bộ chỉ chạy *bên trong* `resolveDanhBo`, tức chỉ khi model chịu gọi tool. Lúc đó model đang bận
"chờ kết quả" tưởng tượng → dữ liệu vàng rơi vào hư không, khách cúp máy sau 3 phút 32 giây.

Kèm theo 5 lỗi phụ: tool treo 21 giây, arg model bịa được dùng làm dữ liệu, `_danhBoReads` chết từ
23/07, ghép mù toàn buffer làm hỏng đầu vào trọng tài, và không bao giờ leo thang tới DTMF.

---

## Thay đổi

### 1. Hai biến tích luỹ tách vai trò (`tools.js`)

| Biến | Phạm vi | Vai trò |
|---|---|---|
| `_danhBoTranscripts` (biến 1) | TOÀN cuộc gọi, tối đa 20 lượt | Kho quan sát cho gpt-5.1. **Không bao giờ** dùng để đếm |
| `_danhBoSession` (biến 2) | MỘT lượt yêu cầu khách đọc | Biến **duy nhất** dùng để xác định đủ / chưa đủ / vượt 11 số |

`_danhBoSession = { requestNo, startedAt, turns[], digits }`, reset mỗi khi code mời khách đọc lại
toàn bộ mã. API mới: `ensureDanhBoSession`, `startDanhBoRequest`, `noteDanhBoTranscript`,
`danhBoSessionDigits`.

Biến 1 **không còn bị xoá** khi khách xác nhận — việc đếm đã do biến 2 lo và prompt trọng tài đã tách
"lần đọc mới nhất" riêng, nên giữ kho quan sát vừa an toàn vừa cần thiết cho `danhBoNotFoundSelfCorrect`.

`startDanhBoRequest` **không tăng `requestNo`** nếu lượt trước chưa nghe được chữ số nào — model hay
bắn liên tiếp nhiều tool call trước khi khách kịp nói, nếu tăng thì 3 tool call là đã mời bấm phím oan.

### 2. Mức B — tool không còn chặn (`tools.js`)

`resolveDanhBo` thành **cổng không chặn**, trả trong ~1ms (đo bằng test; trước là 21 giây):

| Trạng thái | Trả về |
|---|---|
| Đã xác nhận | `{ok:true, value}` |
| Đang chờ xác nhận | câu đọc lại xác nhận |
| Phiên chưa có số | `invalid_danh_bo` — xin mã |
| Phiên `<11` số | `dang_gom_so` — "Dạ, em đang nghe ạ." (không hướng dẫn gì, xem đợt 3) |
| Phiên `>=11` số | `dang_xac_minh` — "em ghi nhận rồi ạ, chờ em một chút" |

Đã xoá: vòng chờ `DANH_BO_WAIT_MS` (15s), cache `_danhBoLastResolveSig/Resp`, và code chết
`handleConfirmDanhBo`, `acceptFullDanhBo`, `danhBoAlreadyConfirmedResponse`, `fireBackgroundArbiter`,
`awaitBackgroundVerdict`, `reReadRequestResponse`, `latestTranscriptDanhBo`, `proactiveAssembleDanhBo`,
`checkDanhBo`.

`danhBoNotFoundSelfCorrect` cũng hết chặn — giờ đi qua luồng xác minh dùng chung (hạn 10s thay vì 20s).

### 3. Luồng xác minh song song (`tools.js: verifyDanhBoFromSession`)

Chạy ở **đường nền** (session-ws gọi sau khi khách ngưng đọc — xem hai mức chờ ở đợt 3). Transcript ra đúng 11 số **vẫn phải
qua gpt-5.1** — ASR hoàn toàn có thể nghe sai mà vẫn cho ra đủ 11 chữ số, con số trông "sạch" nhưng sai.

Hai kênh chạy **song song**: (a) verify API ~40ms, (b) trọng tài gpt-5.1, chờ tối đa
`DANH_BO_VERIFY_WAIT_MS` = 10s. Khách không phải chờ im lặng — code phát ngay
*"Dạ, em ghi nhận rồi ạ, Quý Khách chờ em một chút."*

| Verify API | Trọng tài | Hành động |
|---|---|---|
| Tồn tại | bất kỳ | chốt số transcript (`by: transcript_11`) |
| Không tồn tại | ra số khác, verify API OK | chốt số trọng tài (`by: arbiter`, bật gate xác nhận lời nói) |
| Không tồn tại | bí | mời đọc lại / leo thang — **không chốt bừa** |

Guard: bỏ kết quả nếu trong lúc chờ đã có ứng viên khác (DTMF) hoặc `requestNo` đã sang phiên mới.

### 4. Prompt trọng tài 2 tầng + bỏ phiếu theo vị trí (`danh-bo-arbiter.js`)

Tách `LẦN ĐỌC MỚI NHẤT` (biến 2) khỏi `CÁC LẦN ĐỌC TRƯỚC ĐÓ`. Trước đây trọng tài nhận một cục 31 chữ
số trộn 5 lượt rác rồi từ chối — **nó từ chối rất đúng đắn, dữ liệu VÀO mới là thứ sai**.

Đợt 3 nói rõ thêm bản chất bài toán: mọi lần đọc đều là khách đọc **trọn vẹn cùng một mã**, nên đây là
bài toán **bỏ phiếu theo từng vị trí chữ số** — xem chi tiết ở phần đợt 3 bên dưới.

### 5. Phát hiện model bịa số (`tools.js`, `session-ws.js`)

`ma_danh_bo` **giữ nguyên `required`** (quyết định của anh Lộc) — nó là nguồn nghe thứ hai cho trọng tài,
khôi phục `_danhBoReads` vốn đã chết từ 23/07. Đổi lại phải lọc số bịa:

`classifyModelArg(arg, sessionDigits)`:

| Luật | Điều kiện | Kết luận |
|---|---|---|
| R1 | phiên chưa có chữ số nào | **BỊA** — bắt trọn ca `725625` |
| R2 | arg là substring của phiên | nghe đúng |
| R3 | Levenshtein ≤ `max(1, ⌊len*0.2⌋)` | nghe lệch — vẫn giữ làm quan sát |
| R4 | còn lại | **BỊA** — bắt ca `320325175` |

BỊA → bỏ hoàn toàn (không vào `_danhBoReads`, không đếm, không tra cứu) + `_hallucinationCount++`.
Đủ 2 lần **và khách đã từng đọc số** → mời bấm phím.

Lớp 2 (`_checkBotSpokenDigits`): bóc mọi cụm ≥4 chữ số trong lời bot (cả dạng chữ *"Hai - Hai - Không"*),
đối chiếu tập được phép nói. Lệch → ghi `bot_hallucinated_digits` + nói đè bằng `_reAssertDanhBoStep`.
**KHÔNG cancel response** — repo đã trả giá 2 lần cho việc đó (bot câm 24s/28s).

### 6. Nới VAD giai đoạn đọc số (`session-ws.js`)

`_setVadMode('digits'|'normal')` gửi `session.update` giữa cuộc gọi.
Chế độ `digits`: `server_vad`, `silence_duration_ms: 2000`, `threshold: 0.6`, `prefix_padding_ms: 500`,
và từ đợt 5 là `create_response: false` (mức C — model bị khoá, code phát mọi câu).

`semantic_vad` chốt lượt theo ngữ nghĩa nên mỗi hơi đọc số trông như một lượt hoàn chỉnh — đó là lý do
log có 6 lượt transcript rời rạc cho cùng một mã.

Điểm vào: khách bắt đầu đọc số, hoặc tool trả `invalid_danh_bo`/`dang_gom_so`/`dang_xac_minh`.
Điểm ra: khách xác nhận · DTMF đủ số · mời bấm phím · `end_call` · `transfer_to_agent` ·
**watchdog 90s tự khôi phục** (lưới an toàn chống bot câm).

### 7. Leo thang + watchdog (`session-ws.js`)

`requestNo` là bộ đếm leo thang **duy nhất** — nó đếm đúng thứ khách cảm nhận được. Đạt 3 → mời bấm phím.
Thay cho 2 bộ đếm cũ (`_danhBoResolveTries`, `_danhBoAssembleTries`) vốn đếm theo nhánh code nội bộ nên
cuộc gọi mẫu chạy 3,5 phút mà chưa lần nào khách được mời bấm phím.

Watchdog 90 giây: quá hạn chưa chốt được mã → mời bấm phím ngay, bất kể `requestNo`.

### 8. Graceful shutdown (`server.js`, `session-ws.js`)

Cuộc gọi lỗi nặng nhất lại **không có file log** — tiến trình thoát trước khi `_saveOnce` ghi xong.
Thêm registry `_activeSessions` + `flushAllSessions()`; `SIGINT`/`SIGTERM` flush tối đa 5s rồi
`closeDb()` rồi mới exit. Ctrl+C lần 2 thoát ngay. `uncaughtException` cũng cố flush.

### 9. Đo lường (`conversation-logger.js`)

`stats` có thêm: `danh_bo_resolved_by` (`transcript_11`|`arbiter`|`dtmf`|`known_tel`|`null`),
`danh_bo_value`, `danh_bo_request_count`, `danh_bo_seconds`, `hallucination_count`.
`danh_bo_resolved_by = null` chính là ca hỏng cần đếm.

### 10. Dọn log

`normalizeDanhBo` chạy hàng chục lần mỗi cuộc gọi, in 2 dòng `console.log` mỗi lần → log mẫu có hơn 40
khối che hết dòng quan trọng. Hạ xuống `log.debug`. Các `console.*` khu vực danh bộ + prompt/response
trọng tài cũng chuyển sang logger có level.

---

## Biến môi trường mới

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `DANH_BO_VERIFY_WAIT_MS` | 10000 | Hạn chờ trọng tài trong luồng xác minh |
| `DANH_BO_DEBOUNCE_DU_MS` | 1500 | Đã đủ 11 số → chờ ngắn rồi xác minh |
| `DANH_BO_DEBOUNCE_THIEU_MS` | 9000 | Chưa đủ số → chờ lâu (khách còn đang đọc) |
| `DANH_BO_ARBITER_LOW_CONFIDENCE` | 0.3 | Ngưỡng thấp — chỉ dùng khi API xác nhận dứt khoát |
| `DANH_BO_WATCHDOG_MS` | 90000 | Quá hạn chưa chốt mã → mời bấm phím |
| `DANH_BO_VAD_SILENCE_MS` | 2000 | `silence_duration_ms` khi đang đọc số |
| `DANH_BO_VAD_THRESHOLD` | 0.6 | `threshold` khi đang đọc số |
| `DANH_BO_VAD_RESTORE_MS` | 90000 | Tự trả VAD về `semantic_vad` |
| `DANH_BO_MUTE_WATCHDOG_MS` | 15000 | Lưới an toàn chống bot câm (mức C) |

Đã bỏ: `DANH_BO_WAIT_MS`.

---

## Test

`test_case/danh_bo_20260726.test.mjs` — 11 test thuần logic (classifyModelArg, hai biến tích luỹ).
`test_case/danh_bo_verify_flow.test.mjs` — 19 test dựng lại các cuộc gọi hỏng, giả lập `fetch`
(API + gpt-5.1), gồm kiểm tra tool trả về dưới 2 giây và toàn bộ ca của đợt 2 + đợt 3
(đọc tách 3 hơi, không reset phiên giữa chừng, không hướng dẫn "đọc tiếp", bỏ phán quyết lỗi thời).

`test_case/speak_verbatim.test.mjs` — 7 test cho cơ chế kiểm chứng lời bot (đợt 4).
`test_case/muc_c_khong_cam.test.mjs` — 14 test bảng quyết định chống bot câm (đợt 5).

Tổng **53 test**, chạy bằng `npm test`.

Kịch bản chính: khách đọc tách 3 hơi (13 số) → trọng tài từ chối → mời đọc lại → khách đọc liền
`22023251775` → **chốt đúng**. Đây chính là cuộc gọi mà code cũ làm hỏng.

---

## Cần theo dõi sau khi lên production

1. **`server_vad` nhạy nhiễu SIP hơn `semantic_vad`** — theo dõi `vadTurnCount` vs `customerTurns`.
   Phantom turn tăng → nâng `DANH_BO_VAD_THRESHOLD` lên 0.7 (vấn đề đã gặp ở fix 08/07 đợt 3).
2. **Ngưỡng 0.2 của luật R3** là điểm khởi đầu — chỉnh lại bằng dữ liệu thật sau vài ngày.
3. **`silence_duration_ms: 2000`** làm phản hồi trong giai đoạn đọc số chậm thêm ~2 giây. Khách thấy
   bot "đơ" thì hạ về 1500.
4. Gate `_danhBoNeedsVerbalYes` giờ được **thực thi bằng cấu trúc** (`confirmed` chỉ do lượt khách thật
   đặt), chặt hơn trước — cần test riêng nhánh này vì hỏng là bot đọc thông tin người khác.
5. Trọng tài chạy nền hoàn toàn → có thể nâng `DANH_BO_ARBITER_REASONING_EFFORT` `low` → `medium`.

---

## Đợt 2 — sửa theo cuộc gọi test `rtc_u1_E5hSj6jwK5jeMHvCZV7yx` (26/07 07:57)

Cuộc test đầu tiên sau khi lên code. Phần lớn cơ chế mới chạy đúng: hai biến tích luỹ, leo thang
`requestNo` → DTMF ở lượt 3, DTMF + xác nhận lời nói, phát hiện bot bịa số (`78802023511`), watchdog
VAD, và log được lưu đầy đủ. Nhưng lộ ra 4 lỗi.

### Đ2.1 — `ma_danh_bo: undefined` làm model tự kết luận tra cứu hỏng ⚠️ nghiêm trọng nhất

`fetchBilling` có dòng `// ma_danh_bo: rs.value,` **bị comment từ trước** → `f.ma_danh_bo` là `undefined`
→ tool output là:

```
message: 'Mã danh bộ undefined, Kỳ 7/2026: 18 m³, thành tiền ba trăm lẻ chín nghìn bảy trăm đồng.'
```

Model đọc thấy chữ `undefined` liền **kết luận mã danh bộ sai**, rồi nói với khách:

> *"hệ thống vẫn trả về mã danh bộ không đúng nên em chưa thể đọc số khối nước ạ"*

**mặc dù tool đã trả `success: true` kèm dữ liệu thật.** Khách bấm DTMF đúng 2 lần, xác nhận 2 lần,
vẫn bị bảo là sai số rồi cúp máy. Một dòng bị comment làm hỏng trọn nửa sau cuộc gọi.

Fix: trả `ma_danh_bo: rs.value`. Có test chặn hồi quy (`không để lọt chữ 'undefined'`).

### Đ2.2 — Trọng tài suy ra ĐÚNG mã nhưng bị ngưỡng tin cậy loại

Lúc 07:58:46 gpt-5.1 trả về chính xác `22023251775` — nhưng tự chấm `do_tin_cay = 0.4` (nó phải ghép
qua nhiều mảnh nên khiêm tốn), dưới ngưỡng cứng `0.7` → **loại thẳng**, khách phải bấm DTMF.

Trong khi chỉ cần **40ms gọi API** là biết chắc số đó có thật.

Fix — **hai mức tin cậy, API là trọng tài cuối**:

| Điều kiện | Chấp nhận khi |
|---|---|
| `conf >= 0.7` | API không phủ định (lỗi mạng vẫn cho qua — hành vi cũ) |
| `0.3 <= conf < 0.7` | API xác nhận **dứt khoát** là có thật (`chacChan`) |
| `conf < 0.3` | loại |

`checkDanhBoApi` trả `{coThat, chacChan}` — cần `chacChan` để phân biệt "API bảo có" với "API lỗi nên
tạm coi là có"; nếu không thì lúc backend sập, số tin cậy thấp sẽ lọt. Khách vẫn phải xác nhận bằng
lời trước khi tra cứu nên rủi ro được chặn hai lớp.

Thêm `DANH_BO_ARBITER_LOW_CONFIDENCE` (mặc định `0.3`).

### Đ2.3 — Hạn chờ trọng tài quá gấp

gpt-5.1 mất **7,3s / 8,2s / 9,3s** (reasoning ~1000 token) → bị cắt cả 3 lần ở hạn 6s. Lần cuối nó
trả đúng đáp án chỉ **2 giây sau hạn chờ**.

Bắt khách đọc lại trọn 11 số tốn 30+ giây — đắt hơn nhiều so với chờ thêm 4 giây (đã có câu lấp
khoảng lặng). `DANH_BO_VERIFY_WAIT_MS`: **6000 → 10000**.

Đồng thời sửa **cảnh báo timeout giả**: `_sleep().then()` vẫn log "quá 6000ms" sau khi `Promise.race`
đã ngã ngũ với verdict về kịp — thêm cờ `xong`.

### Đ2.4 — Debounce quá ngắn + dương tính giả khi bot đọc năm

- Khách đọc `"…220203251"` rồi **ngừng 4,5 giây** mới đọc tiếp `"bảy bảy năm"`. Debounce 1,5s làm
  trọng tài chạy khi mới có 9 số → từ chối (đúng), rồi lượt sau bị chặn bởi khoảng nghỉ tối thiểu.
  `DANH_BO_DEBOUNCE_MS`: **1500 → 2800** (phải dài hơn `silence_duration_ms` 2000ms của `server_vad`).
- `_checkBotSpokenDigits` báo nhầm *"bot đọc số lạ 2026"* khi bot đọc "kỳ 7 **năm 2026**". Giờ chỉ
  giám sát khi **chưa chốt** được danh bộ, và bỏ qua chuỗi 4 số dạng năm `19xx`/`20xx`.

---

## Đợt 3 — sửa theo 2 cuộc test `rtc_u2_E5hhmAHqS8cDGvUnCph0x` + `rtc_u1_E5hjMiVA0XScMkqyxxkLP` (26/07 08:12)

Cả hai cuộc hỏng **cùng một kiểu**: khách đọc mã theo nhịp tự nhiên thành nhiều hơi, hệ thống cắt ngang
giữa chừng rồi bắt đọc lại từ đầu. Khách đọc lại, lại bị cắt, 3 lần rồi cúp máy.

### Dòng thời gian cuộc 1 — phiên bị reset giữa lúc khách đang đọc

Mã đúng `22023251775`, khách đọc 3 hơi `2202` → `3251` → `7755`:

```
08:13:07.4  KH "2202"     → phiên #1: 4/11   → hẹn verify lúc ~08:13:10.2
08:13:10.2  verify CHẠY với đúng 4 số                        ← chạy quá sớm
08:13:11.7  KH "3251"     → phiên #1: 8/11   → BỊ BỎ QUA (_danhBoVerifyRunning)
08:13:13.4  trọng tài trả null (nó chỉ thấy 4 số) → RESET phiên, mời đọc lại
08:13:16.1  KH "7755"     → phiên #2: 4/11                   ← mảnh CUỐI rơi sang phiên mới
08:13:23.3  trọng tài lại null → lượt #3 → khách cúp máy
```

Bốn lỗi chồng nhau:

| # | Lỗi | Hậu quả |
|---|---|---|
| Đ3.1 | Verify chạy khi mới có 4/11 số | Trọng tài chắc chắn trả `null`, vừa tốn token vừa kéo theo Đ3.4 |
| Đ3.2 | Transcript đến giữa lúc verify chạy bị `return` thẳng | Mảnh số thứ 2 biến mất khỏi mọi quyết định |
| Đ3.3 | Phán quyết dựa trên snapshot CŨ được áp lên trạng thái MỚI | Trọng tài thấy 4 số, lúc trả kết quả phiên đã 8 số, vẫn reset |
| Đ3.4 | "Chưa đủ số" bị xử lý y như "đọc sai, đọc lại từ đầu" | Reset phiên → mất sạch các mảnh đã gom |

### Sửa

**"Chưa đủ" ≠ "sai" — nhưng cũng KHÔNG nhắc "đọc tiếp".**

Bản đầu của đợt này nhắc khách *"đọc tiếp bốn số còn lại"*. Sai về trải nghiệm: **khách không biết hệ
thống nghe được tới đâu**, mà chỗ nối giữa hai hơi đọc lại chính là chỗ ASR hay nghe sai nhất — bảo
đọc tiếp từ đó là nhân đôi rủi ro.

Cách đúng: khi khách đang đọc dở thì bot chỉ báo hiệu *"Dạ, em đang nghe ạ."* (không hướng dẫn gì).
Khi thật sự cần thì mời khách đọc lại **TRỌN VẸN** cả mã. Mỗi lần đọc đầy đủ là một **quan sát độc
lập về cùng một mã**, và biến 1 giữ lại tất cả → gpt-5.1 có thể đối chiếu **theo từng vị trí chữ số**.

**Hai mức chờ ở đường nền:**

| Trạng thái | Chờ | Hành động khi hết giờ |
|---|---|---|
| Đủ 11 số | `DANH_BO_DEBOUNCE_DU_MS` = 1500 | Xác minh ngay (API + gpt-5.1 song song) |
| Chưa đủ | `DANH_BO_DEBOUNCE_THIEU_MS` = 9000 | Khách đã ngưng đọc → trọng tài thử ghép; không ra thì mời đọc lại TRỌN VẸN |

9 giây là mấu chốt: trong cuộc gọi mẫu hai hơi đọc cách nhau 4,3s và 4,4s, nên hẹn giờ liên tục được
đặt lại và **không bao giờ cắt ngang** khách.

**Prompt trọng tài đổi hẳn cách đặt bài toán.** Trước đây coi các lần đọc trước là "có thể lẫn nhiễu
của lần đọc khác, đừng ghép chung". Giờ nói rõ: *mọi lần đọc đều là khách đọc TRỌN VẸN cùng một mã* →
đây là bài toán **bỏ phiếu theo từng vị trí**, căn các lần đọc lại rồi chọn chữ số xuất hiện nhiều
nhất ở mỗi vị trí. Kèm ví dụ cụ thể và danh sách lỗi ASR thường gặp (rơi số đầu/cuối, nhân đôi,
nhầm 1↔7, 3↔2, 5↔9). Lần đọc thiếu số vẫn dùng được — căn phần khớp vào đúng vị trí thay vì loại bỏ.

**Guard `digitsAtStart`**: khách đọc thêm trong lúc trọng tài chạy → bỏ phán quyết lỗi thời, để lượt
verify mới xử lý.

**`_danhBoVerifyPending`**: transcript đến giữa lúc đang chạy được ghi nhận và chạy lại ngay khi xong,
thay vì bị bỏ rơi.

**Dọn hẹn giờ khi WS đóng** + `_speakVerbatim` kiểm tra `ws.readyState`: watchdog cuộc 1 nổ **43 giây
sau khi khách đã cúp máy** và vẫn cố phát câu mời bấm phím vào hư không.

### Biến môi trường

`DANH_BO_DEBOUNCE_MS` (một mức) → tách thành `DANH_BO_DEBOUNCE_DU_MS` (1500) và
`DANH_BO_DEBOUNCE_THIEU_MS` (9000).

---

## Đợt 4 — sửa theo 2 cuộc test `rtc_u2_E5i8v8eJhYoeHOlPEIgiW` + `rtc_u1_E5iAEYIr6WXOZvgtds2e5` (26/07 08:40)

### Đ4.1 — Code chốt đúng mã trong 5 giây nhưng khách KHÔNG BAO GIỜ nghe được ⚠️

```
08:41:14.6  KH "Mã danh bộ là 2202 3251 775."  → 11/11 số
08:41:15.2  tool trả dang_xac_minh → bot đọc "Dạ, em ghi nhận rồi ạ, chờ em một chút."
08:41:19.4  Trọng tài conf 0.88 + API OK → CHỐT ĐÚNG 22023251775      ← chỉ mất 5 giây
08:41:19.4  _speakVerbatim gửi "…Hai-Hai-Không-…-Bảy-Năm. Đúng không ạ?"
08:41:21.2  bot LẶP LẠI "Dạ, em ghi nhận rồi ạ, chờ em một chút."     ← đọc nhầm câu cũ
08:41:28    KH "Xin chào." (bối rối) → cúp máy
```

Toàn bộ chuỗi xử lý chạy **hoàn hảo** — hai biến tích luỹ, verify API song song, trọng tài đồng ý,
chốt đúng mã. Rồi hỏng ở bước cuối cùng: câu xác nhận không ra được tới khách.

Nguyên nhân: `function_call_output` của lượt trước còn nằm trong hội thoại kèm chỉ dẫn
*'Đọc NGUYÊN VĂN "doc_cho_khach"'*, model mini bám vào đó thay vì `instructions` của
`response.create` mới.

**Sửa — KHÔNG tin model tuân thủ, CODE tự kiểm:**

- `_speakVerbatim(text, tag, 0, { verify: true })` ghi lại "dấu hiệu" của câu cần đọc
  (`_speakCore`): câu có số → lấy **dãy chữ số** (kể cả dạng chữ *"Hai - Hai - Không"*);
  câu không số → lấy 24 ký tự đầu đã chuẩn hoá.
- `_checkExpectedSpeak` đối chiếu lời bot vừa nói ở `conversation.item.done`. Lệch → **gửi lại**,
  tối đa 2 lần, rồi ghi `speak_verbatim_mismatch_giveup`.
- Instructions thêm tiền tố *"BỎ QUA mọi hướng dẫn đọc trước đó trong hội thoại"*.
- Tool output tạm (`dang_gom_so`, `dang_xac_minh`) nói rõ: *"đây là câu TẠM THỜI, chỉ đọc MỘT LẦN —
  ngay sau đó hệ thống sẽ gửi câu khác, khi đó phải đọc câu MỚI NHẤT"*.

Bật kiểm chứng cho các câu quan trọng: đọc lại xác nhận, xác nhận DTMF, mời đọc lại, mời bấm phím.

### Đ4.2 — Khách đổi chủ đề, hệ thống vẫn ép đọc số

```
08:42:35  KH "2223251." → 7/11 số, bot "Dạ, em đang nghe ạ."
08:42:43  KH "Xin lỗi, cho tôi hỏi về thủ tục sang tên đồng hồ nước."   ← CÂU HỎI MỚI
08:42:44  bot "Dạ, em đang nghe ạ. Quý khách cứ đọc tiếp khi nào xong nhé."
08:42:48  đường nền vẫn nổ → "đọc lại đầy đủ 11 số"                     ← chen ngang
```

Khách hỏi thủ tục, bot đáp chuyện đọc số. Hai lỗi: chỉ dẫn tồn dư của tool output (đã xử lý ở Đ4.1)
và đường nền không biết khách đã chuyển chủ đề.

**Sửa:** lượt khách **không phải đọc số** và cũng không phải xác nhận/phủ định → **hoãn** đường nền
(`clearTimeout(_danhBoVerifyTimer)`), để model trả lời câu hỏi của khách. **Không xoá số đã gom** —
khách quay lại đọc số thì gom tiếp bình thường; watchdog 90 giây vẫn là lưới an toàn.

### Test

Thêm `test_case/speak_verbatim.test.mjs` — 7 test cho logic so khớp, trong đó có test tái hiện đúng
lỗi thật: câu chờ *"Dạ, em ghi nhận rồi ạ…"* phải bị nhận là **không khớp** với câu xác nhận chứa
dãy `22023251775`.

---

## Đợt 5 — MỨC C: khoá model trong giai đoạn thu mã danh bộ

### Vì sao chuyển sang mức C

Bốn đợt trước, lỗi cứ dịch dần về cuối chuỗi: *không xử lý dữ liệu* → *xử lý sai* → *xử lý đúng nhưng
nói sai*. Đợt 4 dừng ở chỗ **code chốt đúng mã trong 5 giây nhưng bot đọc nhầm câu cũ**, và cách chữa
là đi kiểm chứng-rồi-gửi-lại.

Chừng nào model còn được tự nói giữa lúc thu số thì còn phải chạy theo sau nó. Mức C cắt gốc:
**model không được nói, code phát mọi câu.**

### Thay đổi

Chế độ `digits` giờ dùng `create_response: false`:

```js
turn_detection: {
  type: "server_vad", threshold: 0.6, prefix_padding_ms: 500,
  silence_duration_ms: 2000,
  create_response: false,      // ← MỨC C: model KHÔNG tự sinh response
  interrupt_response: true,
}
```

Audio vẫn được commit và transcribe bình thường (biến 1 + biến 2 vẫn đầy đủ), chỉ là model không nói.

**Lợi ích ngay lập tức:**

- Không còn `function_call_output` cạnh tranh với câu code muốn đọc → hết lỗi Đ4.1.
- Model không gọi tool trong giai đoạn này → **không còn `ma_danh_bo` bịa** (lỗi Đ2 biến mất tận gốc).
- Nhiễu/tạp âm không kích hoạt model → hết phantom turn trong lúc khách đọc số.

### Cái giá: code phải chịu trách nhiệm phát MỌI câu

Rủi ro lớn nhất là **bot câm** — tệ hơn cả trả lời sai. Ba lớp bảo vệ:

**1. Bảng quyết định — mọi lượt khách nói phải rơi vào đúng một nhánh CÓ phát lời:**

| Lượt khách | Nhánh | Ai phát lời |
|---|---|---|
| Đọc số | `GOM_SO` | Đường nền (`verifyDanhBoFromSession` → `_speakVerbatim`) |
| "đúng rồi" (đang chờ xác nhận) | `XAC_NHAN` | `_requestModelReply` → model đi tra cứu |
| "sai rồi" (đang chờ xác nhận) | `PHU_DINH` | `_maybeVerifyDanhBo` → đề xuất dãy khác |
| Chuyện khác / "vâng" ngoài ngữ cảnh | `DOI_CHU_DE` | Mở khoá + `_requestModelReply` |

Hàm mới `_requestModelReply(lyDo, instructions?)` — nhờ model tự trả lời một lượt (không ép đọc
nguyên văn), có retry khi đang có response chạy.

Kẽ hở đã bịt: *"vâng"/"ừ"* khi **không** có ứng viên nào đang chờ. Trước đây không nhánh nào chạy →
khách phải chờ tới lưới an toàn. Giờ từ khẳng định/phủ định chỉ có nghĩa khi `_dangChoXacNhan`.

**2. Lưới an toàn chống câm** (`_armMuteWatchdog`, `DANH_BO_MUTE_WATCHDOG_MS` = 15000): sau mỗi lượt
khách nói, nếu quá 15 giây mà bot chưa nói gì (và không đang xác minh, không đang chờ `_expectedSpeak`)
→ **mở khoá model** + tạo response. Ghi event `mute_watchdog` để đếm số lần lọt lưới.

**3. Các lối thoát cụ thể** (đã có từ đợt 3, vẫn giữ): khách xác nhận · DTMF đủ số · mời bấm phím ·
`end_call` · `transfer_to_agent` · watchdog VAD 90s · dọn timer khi WS đóng.

### Test

`test_case/muc_c_khong_cam.test.mjs` — 14 test duyệt bảng quyết định với mọi loại lượt khách nói,
khẳng định không lượt nào rơi vào im lặng.

### Cần theo dõi kỹ trên production

1. **`mute_watchdog` trong log** — mỗi lần xuất hiện là một nhánh code chưa phát lời, cần bịt riêng.
2. **`speak_verbatim_mismatch`** — nếu về 0 thì cơ chế kiểm chứng của đợt 4 đã thành dư thừa (giữ lại
   làm lưới an toàn).
3. **Khách ngắt lời bot** giữa lúc bot đọc lại 11 số — `interrupt_response: true` vẫn bật, cần xem
   trải nghiệm có mượt không.
4. Nếu thấy bot phản ứng chậm ở đầu giai đoạn thu số, cân nhắc chỉ khoá model **sau** khi khách bắt đầu
   đọc chữ số đầu tiên, thay vì ngay khi bot vừa hỏi xin mã.

---

## Đợt 6 — sửa theo cuộc test `rtc_u2_E66X1bhQIrBrwtqeHkOau` (27/07 10:43)

Cuộc đầu tiên chạy mức C. Kết quả: **mức C gần như không có tác dụng** — model vẫn nói, vẫn gọi tool
trong giai đoạn thu số. Nhưng nguyên nhân không nằm ở `create_response: false`, mà ở **chính response
do code tạo ra**.

```
10:43:40.5  KH "2202"       → VAD → digits (create_response:false đã gửi)
10:43:45.2  KH "3251 775"   → 11/11 số
10:43:46.8  code gửi _speakVerbatim(câu chờ)                  ← response DO CODE tạo
10:43:48.8  AI "Ok, em sẽ kiểm tra hóa đơn..."                ← model nói câu của nó
10:43:48.8  get_bill({"ma_danh_bo":"3251802"})                ← BỊA, code chặn đúng
10:43:48.9  get_bill({"ma_danh_bo":"3251775"})                ← tool THỨ HAI cùng response
            → code gửi 2 response.create → conversation_already_has_active_response
10:43:54.9  Trọng tài 0.78 + API OK → CHỐT ĐÚNG 22023251775
10:43:57.8  bot nói lung tung 3 lượt liền → gửi lại 3 lần → bỏ cuộc
10:44:54.9  KH "Đọc lại đi." → xếp nhầm vào "đổi chủ đề" → bế tắc → khách cúp máy
```

### Đ6.1 — Response do code tạo vẫn cho phép model gọi tool ⚠️ gốc của mọi thứ

`create_response: false` chỉ chặn VAD tự tạo response. Nhưng `_speakVerbatim` **chủ động** gửi
`response.create` — và trong response đó model được tự do gọi tool. Nó gọi `get_bill` hai lần với số
bịa thay vì đọc câu được giao.

**Sửa:** mọi response code tạo để ép đọc nguyên văn đều thêm `tool_choice: "none"`. Tương tự cho
response đọc `doc_cho_khach` của các payload danh bộ (`dang_gom_so`, `dang_xac_minh`,
`invalid_danh_bo`, `moi_bam_phim`, `cho_khach_xac_nhan`). Cắt hẳn vòng xoáy tool-call.

### Đ6.2 — Một `response.done` chứa nhiều `function_call` → gửi nhiều `response.create`

Vòng lặp xử lý tool gửi một `response.create` cho **mỗi** tool call. Model phát ra 2 `get_bill` trong
cùng một response → cái thứ hai lỗi `conversation_already_has_active_response`, và cuộc gọi trượt dài
từ đó.

**Sửa:** gom kết quả trong vòng lặp, chỉ tạo **ĐÚNG MỘT** response sau khi xử lý xong toàn bộ
`function_call` của `response.done` đó. (`function_call_output` vẫn gửi đủ một cái cho mỗi `call_id`.)

### Đ6.3 — Không có cách nào biết `create_response` có hiệu lực

Log chỉ ghi `session.updated OK`, nên khi model vẫn nói thì không phân biệt được "OpenAI bỏ qua tham
số" với "code tự tạo response". **Sửa:** log cấu hình VAD **thật sự đang áp dụng** lấy từ
`event.session.audio.input.turn_detection`:

```
session.updated OK — VAD đang áp dụng: server_vad create_response=false silence=2000 eagerness=-
```

### Đ6.4 — "Đọc lại đi" bị xếp vào "đổi chủ đề"

Khách xin nghe lại mã, code lại nhờ model tự trả lời → model nói câu chờ cũ → bế tắc. **Sửa:** thêm
nhánh `NHAC_LAI` — khớp *"đọc/nói/nhắc lại"*, *"chưa nghe rõ"* → code **đọc lại đúng
`_danhBoLastPrompt`**, không hỏi model. Code đã có sẵn câu cần đọc, không lý gì phải nhờ model.

### Test

`muc_c_khong_cam.test.mjs` thêm nhánh `NHAC_LAI` (2 test). `danh_bo_verify_flow.test.mjs` nới lại
khẳng định về `ma_danh_bo` — handler đã bỏ đọc lại mã trong mỗi câu trả lời, nhưng `fetchBilling`
vẫn phải trả `ma_danh_bo` để chuỗi `"Mã danh bộ undefined"` không quay lại.

Tổng **53 test**.

---

## Còn hoãn (kế hoạch v3 §8)

Tra danh bộ theo SĐT từ `voicebot_calllog` · ràng buộc cấu trúc mã danh bộ · xác nhận bằng tên khách hàng.
