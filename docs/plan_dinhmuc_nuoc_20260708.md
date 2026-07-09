# Plan cải thiện trả lời thủ tục ĐĂNG KÝ ĐỊNH MỨC NƯỚC — 08/07/2026

Trạng thái: **ĐÃ TRIỂN KHAI 08/07/2026** (Mục 3 chọn phương án A) —
chi tiết xem [changelog](changelog_fix_callquality_20260708.md), phần Đợt 5.

## Bối cảnh

Chủ dự án cung cấp tài liệu hướng dẫn chính thức về đăng ký định mức nước,
kèm quy tắc nghiệp vụ quan trọng mà data hiện tại **chưa có**:

> Hộ khẩu thường trú và tạm trú ĐỀU đăng ký định mức được, miễn có giấy tờ
> chứng minh. Người KHÔNG chứng minh được (không hộ khẩu, không tạm trú)
> thì KHÔNG được đăng ký.
>
> Ví dụ: nhà 8 người — 4 có hộ khẩu + 2 có tạm trú đầy đủ giấy tờ + 2 không
> có tạm trú → đăng ký được 6 người (4 + 2). 2 người không tạm trú: không.
>
> Chứng minh tạm trú bằng: (a) giấy đăng ký tạm trú, hoặc (b) VNeID hiển thị
> nơi ở hiện tại tại địa chỉ đăng ký định mức.

Hệ quả của việc data thiếu quy tắc này: cuộc gọi 11:12 AI bịa "đăng ký được
tất cả" (sai — 2 người không tạm trú không được); sau khi vá bằng quy tắc
"không suy diễn" (đợt 4), cuộc gọi 11:30 AI từ chối trả lời và đòi chuyển
tổng đài viên 4 lần — đúng an toàn nhưng không "mượt", vì đây là câu hỏi
rất phổ biến mà giờ ta ĐÃ có đáp án chính thức.

**Hướng xử lý: đưa quy tắc vào DATA (nguồn sự thật), rồi NỚI prompt cho phép
trả lời dựa trên quy tắc đó.** Không hardcode logic vào code — giữ nguyên
tắc transcript/AI chỉ đọc từ kết quả tool.

---

## Mục 1 — Bổ sung quy định đối tượng vào data (`src/huongdanthutuc-data.js`)

1a. Thêm field mới `quyDinh` cho `dinh_muc_nuoc` (trước phần cases):

```js
quyDinh:
  "Người có hộ khẩu thường trú TẠI ĐỊA CHỈ đăng ký, hoặc có đăng ký tạm trú " +
  "tại địa chỉ đó (chứng minh bằng giấy đăng ký tạm trú, hoặc ứng dụng VNeID " +
  "hiển thị nơi ở hiện tại đúng địa chỉ đăng ký) ĐỀU được đăng ký định mức nước. " +
  "Người KHÔNG chứng minh được thường trú/tạm trú tại địa chỉ thì KHÔNG được " +
  "tính định mức. Số người đăng ký được = số người có giấy tờ chứng minh. " +
  "Ví dụ: nhà 8 người, 4 có hộ khẩu, 2 có tạm trú đầy đủ giấy tờ, 2 không có " +
  "tạm trú → đăng ký được 6 người (4 hộ khẩu + 2 tạm trú); 2 người không có " +
  "tạm trú không được đăng ký, nên đi đăng ký tạm trú trước rồi bổ sung sau.",
```

1b. Cập nhật giấy tờ 2 case theo đúng tài liệu chính thức:

- Case "Có hộ khẩu thường trú tại TP.HCM" (giữ cấu trúc `options` một-trong):
  - "Photo Căn cước công dân (CCCD) hoặc giấy khai sinh có số định danh cá
    nhân của tất cả nhân khẩu cần đăng ký"
  - "Ứng dụng VNeID thể hiện thông tin nơi thường trú / nơi ở hiện tại của
    khách hàng và các thành viên trong hộ"
  - "Nếu chưa được cấp CCCD: liên hệ Công an phường/xã để được cấp 'Thông báo
    số định danh cá nhân và thông tin trong cơ sở dữ liệu quốc gia về dân cư'"

- Case "Không có thường trú tại TP.HCM" (`options` một-trong):
  - "Xác nhận tạm trú tại địa chỉ đăng ký của tất cả nhân khẩu (có đóng dấu
    của cơ quan có thẩm quyền) KÈM photo CCCD của tất cả nhân khẩu"
  - "Ứng dụng VNeID thể hiện nơi ở hiện tại của các nhân khẩu đúng địa chỉ
    đăng ký định mức"

1c. Địa chỉ văn phòng: bổ sung tên phường theo tài liệu (áp dụng chung ở
`channels` trong `tools.js`):
- 873A Quang Trung, **phường An Hội Tây**, TP.HCM
- 540 Hà Huy Giáp, **phường An Phú Đông**, TP.HCM

1d. `src/tools.js` — `handleGetProcedureInfo` đưa `quyDinh` vào kết quả:

```js
return JSON.stringify({
  success: true,
  thuTuc: procedure.title,
  quy_dinh: procedure.quyDinh ?? undefined,   // model đọc để trả lời câu "được mấy người"
  message: `${procedure.purpose} ${procedure.quyDinh ?? ""} Giấy tờ cần thiết: ${docsText}. ${channels}`,
});
```

---

## Mục 2 — Nới prompt cho phép trả lời theo quy định trong data

`src/system-prompt.js`, section "# Hướng dẫn thủ tục":

2a. Quy tắc đợt 4 ("không suy diễn quy định/định lượng") GIỮ NGUYÊN — nhưng
giờ câu "đăng ký được mấy người" đã CÓ trong kết quả tool (field `quy_dinh`),
nên không còn bị chặn. Thêm 1 dòng làm rõ:

```
- Kết quả tool có trường "quy_dinh" → dùng nó để trả lời các câu về đối tượng
  được đăng ký (ai được/không được, được mấy người). Được phép đếm/cộng theo
  đúng quy định đó (vd 4 người hộ khẩu + 2 người tạm trú = 6 người được đăng
  ký). Ngoài phạm vi quy định thì vẫn áp dụng quy tắc không suy diễn.
```

2b. Theo kịch bản chính thức, nhắc khách quyền gặp người thật — thêm:

```
- Sau khi hướng dẫn xong một thủ tục, nhắc khách 1 LẦN (không lặp lại):
  Quý Khách có thể yêu cầu gặp tổng đài viên để được tư vấn trực tiếp
  bất cứ lúc nào.
```

---

## Mục 3 — Thống nhất cách viết/đọc tên riêng (VNeID, SAWACO, website)

**Hiện trạng lẫn lộn:** data viết phiên âm "Vi eN i ai Đi" (AI đọc lại thành
"VnID"), `channels` trong tools.js đã đổi thành "www chấm cấp nước Trung An
chấm Vi En", trong khi tài liệu chính thức dùng "VNeID", "SAWACO CSKH",
"www.capnuoctrungan.vn".

**Đề xuất (khuyến nghị phương án A):**

- **A. Data viết CHỮ CHUẨN, dạy cách đọc trong SYSTEM_PROMPT** — data/log/
  summary sạch, một chỗ duy nhất quản lý cách phát âm:

  ```
  # Cách đọc tên riêng
  - "VNeID" đọc là "Vi-en-e-ai-đi".
  - "SAWACO CSKH" đọc là "Sa-oa-cô Xê-ét-ka-hát".
  - "www.capnuoctrungan.vn" đọc là "vê kép vê kép vê kép chấm cấp nước
    trung an chấm vi-en".
  ```

  Kèm việc đổi lại chuỗi phiên âm trong `huongdanthutuc-data.js` và
  `channels` (tools.js) về dạng chuẩn.

- B. Giữ phiên âm trong data như hiện tại (không khuyến nghị: log xấu, AI
  đã đọc sai "VnID", summary khó dùng).

---

## Thứ tự thực hiện & kiểm chứng

1. Mục 1 (data + tools.js) → Mục 2 (prompt) → Mục 3 (nếu chọn A).
2. `node --check` + test nhanh `dispatchTool("get_procedure_info",
   {loai_thu_tuc:"dinh_muc_nuoc"})` xem `quy_dinh` xuất hiện trong output.
3. Kịch bản gọi test:
   - "Nhà 8 người, 4 có hộ khẩu, 2 có tạm trú, 2 không có gì — đăng ký được
     mấy người?" → AI phải trả lời **6 người**, giải thích 2 người còn lại
     cần đăng ký tạm trú trước.
   - "Chưa đăng ký tạm trú thì sao?" → AI: cần đăng ký tạm trú trước (hoặc
     VNeID thể hiện nơi ở hiện tại), rồi bổ sung.
   - Hỏi câu định lượng NGOÀI data (vd "định mức mỗi người bao nhiêu khối?")
     → AI vẫn phải từ chối suy diễn, mời chuyển máy (quy tắc đợt 4 còn hiệu lực).
   - Nghe AI đọc "VNeID", "SAWACO", website có tự nhiên không (Mục 3).

## Ghi chú ngoài phạm vi plan này

- Đề xuất tăng VAD threshold 0.6 → 0.7 (phantom 4 lần/cuộc ở cuộc gọi 11:30)
  vẫn đang CHỜ DUYỆT — plan v2 Mục 1b.
- Prompt caching = 0: chưa điều tra (plan v2 Mục 5).
