# TC-06 – Thông báo gián đoạn cung cấp nước / Cúp nước

> **Dữ liệu mock:**
> - TB001: Quận 12, phường Thạnh Lộc – bảo trì 30/05/2026 từ 8h đến 17h
> - TB002: Gò Vấp, phường 12 – sự cố đường ống 29/05/2026 từ 14h đến 22h

---

## TC-06-01: Hỏi về lịch cúp nước

**Mức độ:** 🟡 High

**Các bước thực hiện:**
1. Gọi vào tổng đài
2. Nói: "Khu vực tôi có bị cúp nước không?"
3. *Lưu ý: không cần xác thực mã khách hàng cho kịch bản này*

**Kết quả mong muốn:**
- AI **không** yêu cầu mã khách hàng
- AI đọc danh sách thông báo hiện có từ mock data
- AI đọc đầy đủ: khu vực, lý do, thời gian từ-đến
- AI đề xuất nếu cần chi tiết hơn thì liên hệ nhân viên

**Kết quả thực tế:** _(ghi sau khi test)_

---

## TC-06-02: Không có thông báo cúp nước

**Mức độ:** 🟡 High

**Chuẩn bị:** Tạm thời xóa dữ liệu mock trong `mock-api.js` → `OUTAGES = []`

**Các bước thực hiện:**
1. Gọi vào tổng đài
2. Hỏi: "Hôm nay có cúp nước khu vực nào không?"

**Kết quả mong muốn:**
- AI trả lời: "Hiện tại không có thông báo gián đoạn cung cấp nước nào"
- AI **không** bịa thông tin

**Kết quả thực tế:** _(ghi sau khi test)_

---

## TC-06-03: Khách hỏi về khu vực cụ thể không có trong danh sách

**Mức độ:** 🟢 Medium

**Các bước thực hiện:**
1. Gọi vào tổng đài
2. Nói: "Quận Bình Thạnh có bị cúp nước không?"

**Kết quả mong muốn:**
- AI thông báo không có thông tin cúp nước cho khu vực đó trong danh sách hiện tại
- AI **không** xác nhận "không bị cúp" một cách chắc chắn (vì dữ liệu có thể chưa đầy đủ)
- AI đề nghị khách theo dõi thông báo qua app SAWACO CSKH

**Kết quả thực tế:** _(ghi sau khi test)_
