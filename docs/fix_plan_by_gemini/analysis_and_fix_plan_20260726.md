# Báo Cáo Phân Tích Logic Lỗi & Đề Xuất Giải Pháp Tối Ưu Cho Voice Bot Danh Bộ

**Ngày phân tích:** 26/07/2026  
**Mã cuộc gọi phân tích:** `rtc_u2_E5eDfB96UnJE6iDWfPbRX`  
**Tác giả:** Antigravity AI  

---

## 1. TỔNG QUAN VẤN ĐỀ

Trong cuộc gọi `rtc_u2_E5eDfB96UnJE6iDWfPbRX`, hệ thống gặp hiện tượng chập chờn: lúc hoạt động đúng, lúc bị lỗi nặng. Cụ thể:
1. Khách hàng hỏi tiền nước nhưng chưa đọc mã danh bộ, **Bot tự động bịa ra các "chữ số ma"** (`725625`, `320325175`) và tự phát biểu với khách: *"Quý khách vừa cho em số danh bộ 725625 đúng rồi phải không ạ?"*.
2. Khách đọc đúng mã danh bộ ngắt làm nhiều lượt (`2200`... `325`... `167775`), nhưng hệ thống **bị nghẽn 15 giây** do vòng lặp `while (digitsAvailable() < 11)` trong `resolveDanhBo`.
3. Trọng tài GPT-5.1 bị nhiễu do **dữ liệu transcript cũ tích tụ quá nhiều** (`2200` ở lượt 1 mâu thuẫn với `2202` ở lượt cuối), dẫn đến ghép sai ra mã `22003251775` (không có trên hệ thống API).
4. Ở lượt cuối khách đọc trọn vẹn 11 số chuẩn `22023251775`, Bot không kích hoạt tra cứu mà lại lặp lại câu thoại báo lỗi cũ.

---

## 2. PHÂN TÍCH CHI TIẾT LOGIC PHÁT SINH LỖI (ROOT CAUSES)

### Nguyên nhân 1: Vòng lặp chờ 15s (`DANH_BO_WAIT_MS`) gây tắc nghẽn WebSocket & Race Condition
* **Vị trí code:** `src/tools.js` (Hàm `resolveDanhBo`, dòng 697-708)
  ```javascript
  const DANH_BO_WAIT_MS = Number(process.env.DANH_BO_WAIT_MS || 15000);
  const DANH_BO_POLL_MS = 700;
  let waited = 0;
  while (digitsAvailable() < DANH_BO_LENGTH && waited < DANH_BO_WAIT_MS) {
    await _sleep(DANH_BO_POLL_MS);
    waited += DANH_BO_POLL_MS;
  }
  ```
* **Logic lỗi:** 
  - Khi Model thoại gọi tool với mã bịa 6 số (`725625`), `digitsAvailable()` đếm được 6 (< 11).
  - Code thực thi vòng lặp `while` và **treo ngầm toàn bộ hàm xử lý tool trong 15 GIÂY** để chờ khách đọc thêm số.
  - **Hậu quả:** Việc `await _sleep` 15 giây bên trong một luồng xử lý WebSocket Realtime là **rất nguy hiểm**. OpenAI Realtime API không nhận được phản hồi tool ngay, dẫn đến việc VAD và Model Realtime tự động sinh ra các câu thoại suy đoán (speculative audio) lặp lại chính tham số bịa `725625` của nó.

---

### Nguyên nhân 2: Schema Tool ép buộc `required: ["ma_danh_bo"]` khiến Model tự bịa số
* **Vị trí code:** `src/system-prompt.js` (Các định nghĩa tool `get_bill`, `get_payment_status`, `get_water_usage`)
  ```javascript
  parameters: {
    type: "object",
    properties: {
      ma_danh_bo: { type: "string", description: "mã danh bộ" },
      ...
    },
    required: ["ma_danh_bo"],
  }
  ```
* **Logic lỗi:**
  - Khi khách nói: *"Em xem giúp anh tiền nước tháng này bao nhiêu?"*, người dùng chưa cung cấp mã danh bộ.
  - Tuy nhiên, do field `ma_danh_bo` nằm trong danh sách `required`, Model Realtime cảm thấy bắt buộc phải gọi tool ngay lập tức và buộc phải **"bịa" một chuỗi ngẫu nhiên** (như `"725625"`, `"02020202"`, `"320325175"`) để đáp ứng schema JSON.

---

### Nguyên nhân 3: Buffer Transcript (`_danhBoTranscripts`) bị tích tụ rác và nhiễu
* **Vị trí code:** `src/session-ws.js`
  ```javascript
  if (_looksLikeDigitTurn(khText)) {
    (_toolCallState._danhBoTranscripts ??= []).push({ at: Date.now(), text: khText });
    if (_toolCallState._danhBoTranscripts.length > 10) _toolCallState._danhBoTranscripts.shift();
  }
  ```
* **Logic lỗi:**
  - Mọi lượt đọc có chứa số đều bị lưu dồn dập vào mảng `_danhBoTranscripts` (tối đa 10 lượt).
  - Khi khách qua nhiều lần đọc sai/đọc lại (`2200` -> `325` -> `167775` -> `31717575` -> `0223251775`), mảng này chứa tới hơn 30 chữ số hỗn loạn.
  - Khi gửi mảng này sang Trọng tài GPT-5.1, GPT-5.1 bị "rối" giữa lượt 1 (`2200`) và lượt 5 (`0223251775`), dẫn đến việc chọn nhầm `22003251775` (mã không có trong CSDL).

---

### Nguyên nhân 4: Thiếu quy tắc cứng ngăn Model phát biểu các "chữ số ma"
* **Vị trí code:** `src/system-prompt.js`
* **Logic lỗi:**
  - Khi tool trả về `invalid_danh_bo: true` cùng câu `doc_cho_khach`, System Prompt chưa đủ nghiêm ngặt để cấm Model thoại nhắc đến tham số `ma_danh_bo` do chính nó tạo ra.
  - Model thoại lấy tham số `725625` hoặc `320325175` trong context để tự chèn vào lời nói với khách.

---

## 3. ĐỀ XUẤT GIẢI PHÁP TỐI ƯU (FIX PLAN)

Để giải quyết triệt để các vấn đề trên, hệ thống cần được tối ưu theo 4 trụ cột chính:

```mermaid
flowchart TD
    A[Khách hỏi tra cứu / Đọc số] --> B{Đã có 11 số?}
    B -- Chưa đủ / Chưa có -- C[Bỏ sleep 15s - Trả ngay doc_cho_khach xin số]
    B -- Đã đủ 11 số -- D[Gọi Arbiter GPT-5.1 On-Demand]
    D --> E{API Check danh bộ}
    E -- Hợp lệ -- F[Đọc lại xác nhận / Trả kết quả]
    E -- Không tồn tại -- G[Báo rõ 'Mã danh bộ không có trên hệ thống']
    G --> H[Reset Buffer Transcript nhiễu]
```

### 🎯 Giải pháp 1: Bỏ vòng lặp Sleep 15s nghẽn luồng trong `resolveDanhBo`
* **Hành động:** 
  - Loại bỏ hoàn toàn vòng lặp `while (digitsAvailable() < DANH_BO_LENGTH && waited < DANH_BO_WAIT_MS)` gây delay 15s.
  - Nếu tổng số chữ số đếm thô chưa đủ 11 số và chưa từng có transcript: trả về ngay phản hồi xin số (`invalidDanhBoResponse`) để giải phóng luồng Tool Call lập tức.
  - Nếu khách đang đọc dở (có transcript nhưng thiếu số): Gọi Arbiter GPT-5.1 kiểm tra 1 nhịp nhanh; nếu Arbiter cũng xác nhận thiếu thì trả về câu mời đọc tiếp ngay, không bắt WebSocket phải `_sleep` chờ đợi.

### 🎯 Giải pháp 2: Làm sạch & Quản lý Buffer Transcript (`_danhBoTranscripts`)
* **Hành động:**
  - Thêm logic tự động làm sạch buffer:
    1. Khi một ứng viên danh bộ bị API trả về `CUSTOMER_NOT_FOUND` (danh bộ sai/không tồn tại) $\rightarrow$ **Xóa hoặc đánh dấu mảng `_danhBoTranscripts`** để lượt sau không bị dính số cũ.
    2. Khi khách đọc một lượt transcript đơn chứa **trọn vẹn 11 chữ số mới** (vd: `"22023251775"`) $\rightarrow$ Tự động **reset toàn bộ các lượt rác phía trước**, chỉ giữ lại lượt 11 số mới này.

### 🎯 Giải pháp 3: Xử lý chuẩn UX khi Danh bộ không có trên hệ thống API
* **Hành động:**
  - Khi Arbiter ghép được 11 số nhưng API `GET /thong-tin-khach-hang` trả về `CUSTOMER_NOT_FOUND`:
  - **KHÔNG** rơi về câu thoại mặc định *"Dạ em nghe được 8/9 số..."*.
  - **THAY VÀO ĐÓ**, trả về câu thoại minh bạch: *"Dạ, em ghi nhận mã danh bộ [ĐỌC_MÃ_11_SỐ], nhưng mã này hiện chưa có trên hệ thống cấp nước. Quý khách vui lòng kiểm tra lại trên hóa đơn giúp em ạ."*

### 🎯 Giải pháp 4: Siết chặt Prompt ngăn Model phát ngôn số bịa
* **Hành động:** 
  - Bổ sung chỉ thị nguyên tắc vào `SYSTEM_PROMPT`:
  > *"CRITICAL RULE: Khi các hàm tra cứu trả về lỗi `invalid_danh_bo: true` hoặc yêu cầu xin mã danh bộ, bạn BẮT BUỘC phải đọc NGUYÊN VĂN câu trong `doc_cho_khach`. KHÔNG ĐƯỢC tự ý lấy mã danh bộ trong tham số tool call (ví dụ các số ngẫu nhiên) để hỏi hay đọc lại cho khách hàng nghe."*

---

## 4. KẾ HOẠCH THỰC THI (ACTION ITEMS)

1. **Tệp `src/tools.js`**:
   - Refactor `resolveDanhBo`: Bỏ `DANH_BO_WAIT_MS` sleep loop.
   - Cập nhật logic reset `_danhBoTranscripts` khi gặp `CUSTOMER_NOT_FOUND` hoặc khi có transcript 11 số mới.
   - Thêm câu phản hồi rõ ràng khi danh bộ 11 số không tồn tại trên CSDL API.
2. **Tệp `src/system-prompt.js`**:
   - Thêm quy tắc cấm Model tự nhắc lại tham số `ma_danh_bo` bịa.
3. **Kiểm thử**:
   - Chạy test mô phỏng cuộc gọi đọc số ngắt hơi & đọc sai mã để xác nhận Bot không còn phát ngôn số ma và không bị lag 15s.
