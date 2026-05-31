# TC-08 – Hướng dẫn thủ tục hành chính

---

## TC-08-01: Hỏi thủ tục đăng ký định mức nước – hộ thường trú HCM

**Mức độ:** 🟡 High

**Các bước thực hiện:**
1. Gọi vào tổng đài
2. Nói: "Tôi muốn đăng ký định mức nước cho hộ gia đình, có hộ khẩu ở TP.HCM"

**Kết quả mong muốn:**
- AI **không** yêu cầu mã khách hàng
- AI hướng dẫn: cần cung cấp photo CCCD hoặc khai sinh có số định danh của tất cả nhân khẩu, hoặc app VNeID
- AI đề cập các kênh nộp hồ sơ: app SAWACO CSKH, website, hoặc văn phòng giao dịch (địa chỉ cụ thể)
- Thông tin đúng, không thiếu sót

**Kết quả thực tế:** _(ghi sau khi test)_

---

## TC-08-02: Hỏi thủ tục lắp đặt đồng hồ nước – doanh nghiệp đi thuê

**Mức độ:** 🟡 High

**Các bước thực hiện:**
1. Gọi vào tổng đài
2. Nói: "Công ty tôi đang thuê mặt bằng, muốn đăng ký lắp đồng hồ nước riêng"

**Kết quả mong muốn:**
- AI nhận diện đúng: doanh nghiệp + địa chỉ đi thuê
- AI hướng dẫn cần: giấy chứng nhận quyền sử dụng đất, giấy phép kinh doanh, hợp đồng thuê, giấy cam kết của chủ nhà
- AI đề cập điều khoản ký quỹ 20 triệu nếu không có giấy cam kết
- Không nhầm sang case "sở hữu"

**Kết quả thực tế:** _(ghi sau khi test)_

---

## TC-08-03: Hỏi thủ tục sang tên đồng hồ

**Mức độ:** 🟡 High

**Các bước thực hiện:**
1. Gọi vào tổng đài
2. Nói: "Tôi mua nhà mới, đồng hồ nước vẫn đứng tên người cũ, cần làm gì?"

**Kết quả mong muốn:**
- AI nhận diện đây là yêu cầu sang tên đồng hồ
- AI hướng dẫn cần: hóa đơn tiền nước kỳ mới nhất, sao y giấy chứng nhận quyền sử dụng đất
- AI đề cập thêm về đăng ký định mức nếu cần

**Kết quả thực tế:** _(ghi sau khi test)_

---

## TC-08-04: Hỏi thủ tục nâng/dời đồng hồ

**Mức độ:** 🟢 Medium

**Các bước thực hiện:**
1. Gọi vào tổng đài
2. Nói: "Nhà tôi cần dời đồng hồ nước sang vị trí khác, thủ tục như thế nào?"

**Kết quả mong muốn:**
- AI thông báo không cần giấy tờ trước
- AI hướng dẫn đăng ký qua app SAWACO CSKH, website, hoặc đến văn phòng
- AI nói nhân viên sẽ liên hệ hướng dẫn sau khi đăng ký

**Kết quả thực tế:** _(ghi sau khi test)_

---

## TC-08-05: Hỏi thủ tục mơ hồ – AI hỏi làm rõ

**Mức độ:** 🟢 Medium

**Các bước thực hiện:**
1. Gọi vào tổng đài
2. Nói: "Tôi cần làm thủ tục về đồng hồ nước"

**Kết quả mong muốn:**
- AI hỏi làm rõ: đăng ký mới, sang tên, hay nâng/dời?
- AI **không** tự giả định là loại thủ tục nào
- Sau khi khách chọn → AI hướng dẫn đúng thủ tục

**Kết quả thực tế:** _(ghi sau khi test)_
