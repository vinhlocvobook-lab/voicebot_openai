# TC-05 – Tra cứu lượng nước sử dụng

> **Dữ liệu mock `12345678901` (Nguyễn Văn An):**
> - 04/2026: 14 m³ (tăng 2 m³ so với tháng 3)
> - 03/2026: 12 m³
> - 02/2026: 11 m³

---

## TC-05-01: Tra cứu lượng nước tháng hiện tại

**Mức độ:** 🟡 High

**Các bước thực hiện:**
1. Gọi vào tổng đài
2. Nói: "Tháng này tôi dùng bao nhiêu mét khối nước?"
3. Cung cấp mã: **12345678901**

**Kết quả mong muốn:**
- AI đọc: "Tháng 4 năm 2026 Quý khách sử dụng 14 mét khối nước"
- Số liệu đúng với mock data
- AI **không** đọc lịch sử chi tiết theo ngày giờ

**Kết quả thực tế:** _(ghi sau khi test)_

---

## TC-05-02: So sánh tăng giảm so với tháng trước

**Mức độ:** 🟡 High

**Các bước thực hiện:**
1. Gọi vào tổng đài → xác thực 12345678901
2. Nói: "Tháng này dùng nhiều hơn hay ít hơn tháng trước?"

**Kết quả mong muốn:**
- AI thông báo: "Tháng 4 dùng 14 m³, tháng 3 dùng 12 m³, **tăng 2 m³** so với tháng trước"
- Xu hướng đúng: tăng
- AI **không** tự tính thêm % hay chi phí tăng thêm

**Kết quả thực tế:** _(ghi sau khi test)_

---

## TC-05-03: Khách hỏi tại sao dùng nhiều nước hơn

**Mức độ:** 🟡 High

**Các bước thực hiện:**
1. Gọi vào tổng đài → xác thực 12345678901
2. Hỏi: "Tại sao tháng này tôi dùng nhiều nước hơn vậy?"

**Kết quả mong muốn:**
- AI **không** tự đoán lý do (mùa hè, rò rỉ...)
- AI thông báo chỉ cung cấp được số liệu, không thể phân tích nguyên nhân
- AI đề nghị nếu nghi ngờ rò rỉ → báo sự cố hoặc liên hệ nhân viên

**Kết quả thực tế:** _(ghi sau khi test)_

---

## TC-05-04: Khách yêu cầu xem lịch sử 6 tháng

**Mức độ:** 🟢 Medium

**Các bước thực hiện:**
1. Gọi vào tổng đài → xác thực 12345678901
2. Nói: "Cho tôi xem lịch sử dùng nước 6 tháng gần đây"

**Kết quả mong muốn:**
- AI cung cấp được tối đa 3 tháng (giới hạn mock data)
- AI thông báo rõ chỉ có dữ liệu 3 tháng gần nhất
- AI **không** bịa số liệu cho các tháng không có dữ liệu

**Kết quả thực tế:** _(ghi sau khi test)_
