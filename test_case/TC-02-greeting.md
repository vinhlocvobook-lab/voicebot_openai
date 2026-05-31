# TC-02 – Chào hỏi & Định tuyến ban đầu

## TC-02-01: AI chủ động chào hỏi khi cuộc gọi kết nối

**Mức độ:** 🔴 Critical

**Các bước thực hiện:**
1. Gọi vào tổng đài
2. Sau khi nghe tiếng Bíp/kết nối, **im lặng hoàn toàn** trong 5 giây
3. Lắng nghe xem AI có tự nói không

**Kết quả mong muốn:**
- AI tự động nói câu chào trong vòng **3 giây** sau khi kết nối, không cần khách nói trước
- Nội dung câu chào đúng ngữ nghĩa: giới thiệu là AI của Công ty Cấp nước Trung An, hỏi cần hỗ trợ gì
- Giọng nói rõ ràng, không bị ngắt quãng giữa chừng

**Kết quả thực tế:** _(ghi sau khi test)_

---

## TC-02-02: AI nhận diện yêu cầu tra cứu tiền nước

**Mức độ:** 🔴 Critical

**Các bước thực hiện:**
1. Gọi vào tổng đài, đợi AI chào
2. Nói: **"Tôi muốn tra cứu tiền nước tháng này"**
3. Quan sát phản hồi của AI

**Kết quả mong muốn:**
- AI nhận diện đúng yêu cầu tra cứu tiền nước
- AI hỏi mã danh bộ/mã khách hàng để xác thực
- AI **không** cung cấp thông tin ngẫu nhiên khi chưa xác thực

**Kết quả thực tế:** _(ghi sau khi test)_

---

## TC-02-03: AI nhận diện yêu cầu không rõ ràng

**Mức độ:** 🟡 High

**Các bước thực hiện:**
1. Gọi vào tổng đài, đợi AI chào
2. Nói: **"Ừm... tôi muốn hỏi về... à thôi"** (nói lẫn lộn, không rõ ý)
3. Quan sát phản hồi của AI

**Kết quả mong muốn:**
- AI hỏi lại lịch sự để làm rõ: "Quý khách cần hỗ trợ gì ạ? Tôi có thể giúp tra cứu tiền nước, thông báo cúp nước..."
- AI **không** tự bịa đặt yêu cầu của khách
- AI **không** chuyển ngay sang tổng đài viên khi chưa thử hỏi lại

**Kết quả thực tế:** _(ghi sau khi test)_

---

## TC-02-04: Khách yêu cầu gặp người thật ngay khi bắt đầu

**Mức độ:** 🔴 Critical

**Các bước thực hiện:**
1. Gọi vào tổng đài, đợi AI chào
2. Nói ngay: **"Gặp tổng đài viên"** hoặc **"Gặp người thật"**
3. Quan sát phản hồi

**Kết quả mong muốn:**
- AI xác nhận đang chuyển máy: "Vâng, Quý khách vui lòng chờ, tôi đang chuyển đến tổng đài viên..."
- Log server hiện: `Tool call: transfer_to_agent`
- Cuộc gọi được SIP REFER đến hàng đợi tổng đài viên (`AGENT_QUEUE_URI`)

**Kết quả thực tế:** _(ghi sau khi test)_

---

## TC-02-05: Khách im lặng hoàn toàn trong 5+ giây

**Mức độ:** 🟡 High

**Các bước thực hiện:**
1. Gọi vào tổng đài, đợi AI chào
2. **Không nói gì** trong ít nhất 8 giây
3. Lắng nghe phản hồi của AI

**Kết quả mong muốn:**
- AI hỏi lại một lần sau khoảng 5-7 giây im lặng: "Quý khách có cần hỗ trợ gì không ạ?"
- Nếu tiếp tục im lặng thêm 5 giây → AI thông báo chuyển sang tổng đài viên hoặc kết thúc lịch sự

**Kết quả thực tế:** _(ghi sau khi test)_
