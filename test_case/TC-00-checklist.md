# Danh sách Test Cases – Voice Bot Tổng đài AI Cấp nước Trung An

> **Môi trường test:** Node.js server chạy local, kết nối Asterisk SIP trunk → OpenAI SIP  
> **Cách gọi test:** Dùng máy điện thoại/soft phone gọi vào số điện thoại tổng đài đã cấu hình trên Asterisk

---

## Tổng quan các nhóm test

| Nhóm | File | Số TC | Ưu tiên |
|------|------|:-----:|:-------:|
| Kết nối & Khởi động | TC-01-connection.md | 4 | 🔴 Critical |
| Chào hỏi & Định tuyến | TC-02-greeting.md | 5 | 🔴 Critical |
| Xác thực khách hàng | TC-03-auth.md | 5 | 🔴 Critical |
| Tra cứu tiền nước | TC-04-bill.md | 4 | 🔴 Critical |
| Tra cứu lượng nước | TC-05-water-usage.md | 4 | 🟡 High |
| Thông báo cúp nước | TC-06-outage.md | 3 | 🟡 High |
| Tiếp nhận sự cố | TC-07-incident.md | 4 | 🔴 Critical |
| Hướng dẫn thủ tục | TC-08-procedure.md | 5 | 🟡 High |
| Chuyển tổng đài viên | TC-09-transfer.md | 4 | 🔴 Critical |
| Kịch bản đặc biệt | TC-10-special.md | 5 | 🟡 High |

**Tổng: 43 test cases**

---

## Quy ước ký hiệu

- ✅ Pass — hành vi đúng như mong muốn
- ❌ Fail — hành vi sai, cần fix
- ⏭ Skip — chưa test được (phụ thuộc môi trường)
- 🔴 Critical — phải pass trước khi go-live
- 🟡 High — phải pass trong sprint này
- 🟢 Medium — có thể defer

## Cách ghi kết quả test

Ghi vào cột **Kết quả thực tế** sau khi test, ví dụ:
```
✅ AI nói câu chào đúng trong 2 giây
❌ AI không nhận diện được yêu cầu "tra tiền nước"
```
