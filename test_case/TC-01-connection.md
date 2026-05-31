# TC-01 – Kết nối & Khởi động hệ thống

## TC-01-01: Server khởi động thành công

**Mức độ:** 🔴 Critical  
**Điều kiện tiên quyết:** File `.env` đã cấu hình đầy đủ `OPENAI_API_KEY`, `OPENAI_WEBHOOK_SECRET`, `OPENAI_PROJECT_ID`

**Các bước thực hiện:**
1. Chạy `npm start` trong thư mục `voice_bot`
2. Quan sát log terminal

**Kết quả mong muốn:**
```
[INFO] [Server] Voice Bot đang chạy tại port 8000
[INFO] [Server] Webhook endpoint: POST http://0.0.0.0:8000/webhook
[INFO] [Server] SIP endpoint: sip:proj_...@sip.api.openai.com;transport=tls
```
- Không có error log khi khởi động
- Server lắng nghe đúng port theo `.env`

**Kết quả thực tế:** _(ghi sau khi test)_

---

## TC-01-02: Webhook nhận event từ OpenAI hợp lệ

**Mức độ:** 🔴 Critical  
**Điều kiện tiên quyết:** Server đang chạy, webhook đã đăng ký trên platform.openai.com

**Các bước thực hiện:**
1. Gọi điện vào số tổng đài từ máy điện thoại bất kỳ
2. Quan sát log server

**Kết quả mong muốn:**
```
[INFO] [Webhook] 1.Nhận event: realtime.call.incoming (id: evt_...)
[INFO] [Webhook] 3.Incoming call rtc_... from <sip:...>
[INFO] [CallMgr] Accepting call rtc_...
[INFO] [CallMgr] Call rtc_... accepted
[INFO] [WS][rtc_...] Kết nối WebSocket thành công
```
- Không có log `[WARN] Chữ ký không hợp lệ`
- Không có lỗi 404 WebSocket

**Kết quả thực tế:** _(ghi sau khi test)_

---

## TC-01-03: WebSocket kết nối và cấu hình session thành công

**Mức độ:** 🔴 Critical  
**Điều kiện tiên quyết:** TC-01-02 pass

**Các bước thực hiện:**
1. Gọi vào tổng đài
2. Đợi 3 giây sau khi kết nối
3. Quan sát log

**Kết quả mong muốn:**
```
[INFO] [WS][rtc_...] ← session.updated OK
[INFO] [WS][rtc_...] ← response.created
[INFO] [WS][rtc_...] ← output_audio_buffer.started
```
- Không có log `Missing required parameter: 'session.type'`
- Có `output_audio_buffer.started` → AI đang phát audio

**Kết quả thực tế:** _(ghi sau khi test)_

---

## TC-01-04: Kết thúc cuộc gọi – WebSocket đóng sạch

**Mức độ:** 🟡 High  
**Điều kiện tiên quyết:** Đang trong cuộc gọi active

**Các bước thực hiện:**
1. Cúp máy từ phía khách hàng
2. Quan sát log server

**Kết quả mong muốn:**
```
[INFO] [WS][rtc_...] WebSocket đóng: 1006
```
- Không có error log sau khi đóng
- Cuộc gọi tiếp theo vẫn hoạt động bình thường (server không crash)

**Kết quả thực tế:** _(ghi sau khi test)_
