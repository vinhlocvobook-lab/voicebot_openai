# TC-10 – Kịch bản đặc biệt & Edge Cases

---

## TC-10-01: Cuộc gọi đồng thời nhiều khách

**Mức độ:** 🔴 Critical

**Các bước thực hiện:**
1. Dùng 2 máy điện thoại, gọi vào tổng đài gần như đồng thời (cách nhau < 5 giây)
2. Trên mỗi máy thực hiện các yêu cầu khác nhau:
   - Máy 1: tra cứu tiền nước 12345678901
   - Máy 2: hỏi thủ tục lắp đồng hồ
3. Quan sát log server và phản hồi trên từng máy

**Kết quả mong muốn:**
- Mỗi cuộc gọi được xử lý độc lập, không lẫn lộn
- Log server hiện 2 `call_id` khác nhau hoạt động song song
- Thông tin tra cứu máy 1 không xuất hiện trên máy 2

**Kết quả thực tế:** _(ghi sau khi test)_

---

## TC-10-02: Khách nói tiếng Anh xen lẫn tiếng Việt

**Mức độ:** 🟡 High

**Các bước thực hiện:**
1. Gọi vào tổng đài
2. Nói: "Hello, I want to check my water bill. Mã tôi là 12345678901"

**Kết quả mong muốn:**
- AI hiểu được yêu cầu dù pha trộn ngôn ngữ
- AI phản hồi bằng **tiếng Việt** (theo system prompt)
- AI xử lý đúng mã 12345678901

**Kết quả thực tế:** _(ghi sau khi test)_

---

## TC-10-03: Khách nói thông tin sai nhiều lần, thái độ gay gắt

**Mức độ:** 🟡 High

**Các bước thực hiện:**
1. Gọi vào tổng đài
2. Nói với giọng bực bội: "Tại sao tiền nước tháng này cao vậy? Tôi muốn khiếu nại! Mấy anh tính sai rồi!"

**Kết quả mong muốn:**
- AI không bị "kích động" theo
- AI vẫn giữ giọng lịch sự, thân thiện
- AI **không** tranh luận hay bào chữa
- AI đề nghị chuyển sang tổng đài viên để xử lý khiếu nại

**Kết quả thực tế:** _(ghi sau khi test)_

---

## TC-10-04: Khách test thử nói những yêu cầu ngoài phạm vi

**Mức độ:** 🟡 High

**Các bước thực hiện:**
1. Gọi vào tổng đài
2. Nói: "Hôm nay thời tiết thế nào?" (hoặc câu hỏi ngoài chủ đề cấp nước)

**Kết quả mong muốn:**
- AI lịch sự từ chối: "Tôi chỉ có thể hỗ trợ các vấn đề liên quan đến dịch vụ cấp nước..."
- AI không trả lời về thời tiết hay các chủ đề khác
- AI hỏi lại khách có cần hỗ trợ gì về nước không

**Kết quả thực tế:** _(ghi sau khi test)_

---

## TC-10-05: Server restart giữa cuộc gọi

**Mức độ:** 🟢 Medium

**Các bước thực hiện:**
1. Gọi vào tổng đài, đang trong cuộc hội thoại
2. Restart Node.js server (`npm run dev` tự restart sau khi save file)
3. Quan sát điều gì xảy ra với cuộc gọi đang active

**Kết quả mong muốn:**
- Cuộc gọi bị ngắt (WebSocket đóng) – đây là hành vi chấp nhận được
- Asterisk xử lý BYE từ OpenAI khi WS đóng
- Server mới khởi động sẵn sàng nhận cuộc gọi tiếp theo
- **Không** crash hay bị treo mãi

**Kết quả thực tế:** _(ghi sau khi test)_
