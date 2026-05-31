# TC-07 – Tiếp nhận phản ánh sự cố

---

## TC-07-01: Báo sự cố rò rỉ nước trong giờ hành chính

**Mức độ:** 🔴 Critical

**Các bước thực hiện:**
1. Gọi vào tổng đài
2. Nói: "Tôi muốn báo sự cố, đường ống trước nhà tôi bị vỡ, nước chảy tràn ra đường"
3. Cung cấp địa chỉ khi AI hỏi: "47 Nguyễn Trãi, phường 2, Gò Vấp"
4. Xác nhận khi AI tóm tắt lại thông tin

**Kết quả mong muốn:**
- AI hỏi xác nhận thông tin trước khi tạo phiếu
- AI tạo phiếu và thông báo mã phiếu: "Phiếu tiếp nhận TK...... đã được ghi nhận"
- Log server: `Tool call: create_ticket({loai: "su_co", mo_ta: "...", khu_vuc: "..."})`
- AI **không** đánh giá đúng/sai về sự cố

**Kết quả thực tế:** _(ghi sau khi test)_

---

## TC-07-02: Báo sự cố sau 22h (kịch bản đặc biệt)

**Mức độ:** 🔴 Critical  
**Điều kiện:** Test vào sau 22h hoặc tạm thời hardcode `isAfterHours = true` trong `server.js`

**Các bước thực hiện:**
1. Gọi vào tổng đài sau 22h
2. Nói: "Tôi muốn gặp nhân viên vì đường ống bị vỡ"

**Kết quả mong muốn:**
- AI **không** cố gắng chuyển sang tổng đài viên (vì ngoài giờ)
- AI tiếp nhận thông tin sự cố và tạo phiếu loại `khan_cap`
- AI thông báo: "Đội kỹ thuật sẽ xử lý trong thời gian sớm nhất"
- Log: `Tool call: create_ticket({loai: "khan_cap", ...})`

**Kết quả thực tế:** _(ghi sau khi test)_

---

## TC-07-03: Khách phản ánh không có nước (áp lực yếu)

**Mức độ:** 🟡 High

**Các bước thực hiện:**
1. Gọi vào tổng đài
2. Nói: "Nhà tôi từ sáng đến giờ không có nước, vòi chảy rất yếu"
3. Cung cấp thông tin địa chỉ
4. Khi AI hỏi có muốn tạo phiếu không → nói "Có"

**Kết quả mong muốn:**
- AI phân loại là `phan_anh` (phản ánh)
- AI tóm tắt lại trước khi tạo: "Quý khách phản ánh không có nước tại địa chỉ..., tôi ghi nhận và tạo phiếu nhé?"
- Sau khi xác nhận → tạo phiếu thành công

**Kết quả thực tế:** _(ghi sau khi test)_

---

## TC-07-04: Khách phản ánh nhưng từ chối tạo phiếu

**Mức độ:** 🟢 Medium

**Các bước thực hiện:**
1. Gọi vào tổng đài → báo sự cố rò rỉ nước
2. Khi AI hỏi xác nhận tạo phiếu → nói: "Thôi không cần, để tôi tự xử"

**Kết quả mong muốn:**
- AI **không** tạo phiếu khi khách từ chối
- AI hỏi có cần hỗ trợ thêm gì không
- Không có log `create_ticket` trong server

**Kết quả thực tế:** _(ghi sau khi test)_
