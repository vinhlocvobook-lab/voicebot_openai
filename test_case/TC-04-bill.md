# TC-04 – Tra cứu tiền nước

> **Dữ liệu mock (mã danh bộ 11 chữ số):**
> - `12345678901` (Nguyễn Văn An): 185.000đ tháng 04/2026 – **chưa nộp**, hạn 25/05/2026
> - `98765432100` (Trần Thị Bích): 320.000đ tháng 04/2026 – **đã nộp**
> - `11122334455` (Lê Minh Cường): 95.000đ tháng 04/2026 – **chưa nộp**, hạn 25/05/2026

---

## TC-04-01: Tra cứu tiền nước thành công – chưa nộp

**Mức độ:** 🔴 Critical

**Các bước thực hiện:**
1. Gọi vào tổng đài
2. Nói: "Tôi muốn biết tiền nước tháng này"
3. Cung cấp mã: **12345678901**
4. Lắng nghe kết quả

**Kết quả mong muốn:**
- AI đọc kết quả rõ ràng: "Hóa đơn tháng 4 năm 2026 là một trăm tám mươi lăm nghìn đồng, chưa thanh toán, hạn nộp ngày hai mươi lăm tháng năm năm hai nghìn không trăm hai mươi sáu"
- Số tiền đúng: 185.000đ
- Trạng thái đúng: chưa nộp, có hạn nộp
- AI **không** tự tính toán hay suy đoán số tiền

**Kết quả thực tế:** _(ghi sau khi test)_

---

## TC-04-02: Tra cứu tiền nước – đã nộp

**Mức độ:** 🟡 High

**Các bước thực hiện:**
1. Gọi vào tổng đài → tra cứu tiền nước
2. Cung cấp mã: **98765432100**

**Kết quả mong muốn:**
- AI thông báo: "Hóa đơn tháng 4 năm 2026 là ba trăm hai mươi nghìn đồng, **đã thanh toán**"
- Không đề cập hạn nộp (vì đã nộp rồi)

**Kết quả thực tế:** _(ghi sau khi test)_

---

## TC-04-03: AI không tính tiền thay backend

**Mức độ:** 🔴 Critical

**Các bước thực hiện:**
1. Gọi vào tổng đài → xác thực 12345678901 thành công
2. Hỏi: "Tiền nước tháng này tại sao lại cao vậy? Tính như thế nào?"

**Kết quả mong muốn:**
- AI trả lời chỉ dựa trên dữ liệu backend trả về
- AI **không** tự tính toán đơn giá, định mức hay suy luận con số
- AI có thể giải thích chung chung hoặc đề nghị khách liên hệ nhân viên để được giải thích chi tiết

**Kết quả thực tế:** _(ghi sau khi test)_

---

## TC-04-04: Khách hỏi tiền nước nhiều tháng liên tiếp trong 1 cuộc gọi

**Mức độ:** 🟡 High

**Các bước thực hiện:**
1. Gọi vào tổng đài → xác thực 12345678901
2. Hỏi tiền nước tháng này
3. Sau khi nghe kết quả, hỏi thêm: "Lượng nước tháng này dùng bao nhiêu?"

**Kết quả mong muốn:**
- AI **không** yêu cầu xác thực lại mã khách hàng
- AI **không** gọi lại tool — sản lượng nước đã có sẵn trong kết quả `get_bill` ở
  bước 2 (từ 05/08/2026, `get_bill` trả đủ tiền + trạng thái thanh toán + sản
  lượng trong 1 lần gọi), chỉ cần đọc lại từ dữ liệu đã có
- Kết quả hiển thị lượng nước tháng hiện tại

**Kết quả thực tế:** _(ghi sau khi test)_
