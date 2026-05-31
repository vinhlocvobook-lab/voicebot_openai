# TC-09 – Chuyển tổng đài viên

---

## TC-09-01: Chuyển máy theo yêu cầu – thành công

**Mức độ:** 🔴 Critical  
**Điều kiện:** `AGENT_QUEUE_URI` đã cấu hình và tổng đài viên đang online

**Các bước thực hiện:**
1. Gọi vào tổng đài, đợi AI chào
2. Nói: **"Cho tôi gặp tổng đài viên"**
3. Quan sát phản hồi AI và log server

**Kết quả mong muốn:**
- AI xác nhận đang chuyển máy: "Vâng, Quý khách vui lòng chờ trong giây lát..."
- Log server: `Tool call: transfer_to_agent({ly_do: "Khách yêu cầu"})`
- Log server: `Referring call → sip:200@<asterisk_host>`
- Cuộc gọi được chuyển đến tổng đài viên thật
- Máy của tổng đài viên đổ chuông

**Kết quả thực tế:** _(ghi sau khi test)_

---

## TC-09-02: Chuyển máy khi tổng đài viên bận / không bắt máy

**Mức độ:** 🔴 Critical  
**Điều kiện:** Tổng đài viên không bắt máy hoặc `AGENT_QUEUE_URI` sai

**Các bước thực hiện:**
1. Gọi vào tổng đài
2. Nói: "Gặp tổng đài viên"
3. Đợi xem AI xử lý thế nào khi không chuyển được

**Kết quả mong muốn:**
- AI thông báo không kết nối được tổng đài viên
- AI đề nghị: "Quý khách có thể gửi yêu cầu qua app SAWACO CSKH hoặc website www.capnuoctrungan.vn"
- **Không** để khách bị kẹt trong im lặng kéo dài

**Kết quả thực tế:** _(ghi sau khi test)_

---

## TC-09-03: AI tự chuyển máy khi gặp yêu cầu phức tạp

**Mức độ:** 🟡 High

**Các bước thực hiện:**
1. Gọi vào tổng đài
2. Nói: "Hóa đơn tháng này của tôi sai, tôi muốn khiếu nại điều chỉnh lại"

**Kết quả mong muốn:**
- AI nhận diện đây là khiếu nại hóa đơn – nằm ngoài phạm vi AI
- AI **không** cố xử lý hay thương lượng
- AI chuyển sang tổng đài viên với giải thích: "Yêu cầu này cần nhân viên xử lý trực tiếp"
- Log: `Tool call: transfer_to_agent`

**Kết quả thực tế:** _(ghi sau khi test)_

---

## TC-09-04: Chuyển máy sau 22h – AI từ chối và tiếp nhận sự cố

**Mức độ:** 🟡 High  
**Điều kiện:** Test sau 22h hoặc hardcode `isAfterHours = true`

**Các bước thực hiện:**
1. Gọi vào tổng đài sau 22h
2. Nói: "Cho tôi gặp nhân viên"

**Kết quả mong muốn:**
- AI **không** thực hiện lệnh REFER (không có tổng đài viên trực)
- AI thông báo: "Hiện ngoài giờ làm việc, không có tổng đài viên trực. Quý khách có thể báo sự cố để đội kỹ thuật xử lý hoặc gọi lại vào giờ hành chính."
- AI **không** để cuộc gọi treo vô thời hạn

**Kết quả thực tế:** _(ghi sau khi test)_
