# TC-03 – Xác thực khách hàng (Mã danh bộ)

> **Dữ liệu mock có sẵn (mã danh bộ = 11 chữ số):**
> - ✅ Mã hợp lệ: `12345678901` (Nguyễn Văn An), `98765432100` (Trần Thị Bích), `11122334455` (Lê Minh Cường)
> - ❌ Mã sai độ dài: `123` hoặc `123456789012` (không đủ/quá 11 số)
> - ❌ Mã đúng độ dài nhưng không tồn tại: `99999999999`

---

## TC-03-01: Xác thực thành công với mã hợp lệ

**Mức độ:** 🔴 Critical

**Các bước thực hiện:**
1. Gọi vào tổng đài
2. Nói: "Tôi muốn tra cứu tiền nước"
3. Khi AI hỏi mã khách hàng, nói: **"Mã của tôi là một hai ba bốn năm sáu bảy tám chín không một"** (đọc từng chữ số)
4. Quan sát phản hồi

**Kết quả mong muốn:**
- AI ghép đúng thành `12345678901` và gọi verify
- AI xác nhận: "Xác thực thành công, khách hàng Nguyễn Văn An..."
- Log server: `Tool call: verify_customer({"ma_danh_bo":"12345678901"})` → `success: true`

**Kết quả thực tế:** _(ghi sau khi test)_

---

## TC-03-02: Xác thực thất bại lần 1 – mã sai

**Mức độ:** 🔴 Critical

**Các bước thực hiện:**
1. Gọi vào tổng đài → yêu cầu tra cứu tiền nước
2. Khi AI hỏi mã, nói: **"chín chín chín chín chín chín chín chín chín chín chín"** (11 số 9 – không tồn tại)
3. Quan sát phản hồi

**Kết quả mong muốn:**
- AI thông báo mã không hợp lệ, yêu cầu nhập lại
- AI **không** kết thúc cuộc gọi hay chuyển máy ngay lần đầu sai
- Câu phản hồi lịch sự: "Xin lỗi, mã khách hàng không đúng. Quý khách vui lòng kiểm tra lại..."

**Kết quả thực tế:** _(ghi sau khi test)_

---

## TC-03-03: Xác thực thất bại 2 lần – chuyển tổng đài viên

**Mức độ:** 🔴 Critical

**Các bước thực hiện:**
1. Gọi vào tổng đài → yêu cầu tra cứu tiền nước
2. Lần 1: nói mã sai → AI yêu cầu nhập lại
3. Lần 2: nói mã sai lần nữa
4. Quan sát phản hồi

**Kết quả mong muốn:**
- Sau 2 lần sai, AI **không** hỏi thêm lần 3
- AI thông báo: "Mã khách hàng vẫn không đúng, Quý khách sẽ được chuyển đến tổng đài viên để được hỗ trợ..."
- Log server: `Tool call: transfer_to_agent`

**Kết quả thực tế:** _(ghi sau khi test)_

---

## TC-03-04: Khách hàng không nhớ mã – yêu cầu gặp người

**Mức độ:** 🟡 High

**Các bước thực hiện:**
1. Gọi vào tổng đài → yêu cầu tra cứu tiền nước
2. Khi AI hỏi mã, nói: **"Tôi không nhớ mã, cho tôi gặp nhân viên"**

**Kết quả mong muốn:**
- AI không ép nhập mã thêm
- AI chuyển ngay sang tổng đài viên

**Kết quả thực tế:** _(ghi sau khi test)_

---

## TC-03-05: Các kịch bản không cần xác thực (thủ tục hành chính)

**Mức độ:** 🟡 High

**Các bước thực hiện:**
1. Gọi vào tổng đài
2. Nói: **"Tôi muốn hỏi thủ tục lắp đồng hồ nước"**
3. Quan sát xem AI có hỏi mã khách hàng không

**Kết quả mong muốn:**
- AI **không** yêu cầu mã khách hàng cho yêu cầu hướng dẫn thủ tục
- AI trả lời thông tin thủ tục ngay lập tức

**Kết quả thực tế:** _(ghi sau khi test)_
