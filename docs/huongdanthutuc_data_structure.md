# Cấu Trúc Dữ Liệu Các Trường Trong File `huongdanthutuc-data.js`

Tài liệu này giải thích chi tiết cấu trúc dữ liệu và ý nghĩa của các trường (fields) trong file `src/huongdanthutuc-data.js` thuộc dự án Voice Bot. File này định nghĩa đối tượng `PROCEDURES` chứa thông tin về các thủ tục hành chính để AI (Voice Bot) tra cứu và hướng dẫn cho khách hàng thông qua công cụ `get_procedure_info`.

---

## 1. Cấu Trúc Tổng Quan

Dữ liệu được tổ chức dưới dạng một đối tượng (Object) lớn mang tên `PROCEDURES`. Trong đó, mỗi thuộc tính đại diện cho một thủ tục hành chính riêng biệt:
- `dinh_muc_nuoc`: Thủ tục đăng ký định mức nước.
- `lap_dat_dong_ho`: Thủ tục đăng ký lắp đặt đồng hồ nước mới.
- `sang_ten_dong_ho`: Thủ tục sang tên đồng hồ nước.
- `nang_doi_dong_ho`: Thủ tục nâng/dời vị trí đồng hồ nước.

---

## 2. Chi Tiết Các Trường Trong Mỗi Thủ Tục (Procedure Object)

Mỗi đối tượng thủ tục (ví dụ: `PROCEDURES.dinh_muc_nuoc`) chứa các trường cấu hình sau:

| Tên Trường | Kiểu Dữ Liệu | Trạng Thái | Ý Nghĩa & Vai Trò |
| :--- | :--- | :--- | :--- |
| `id` | `String` | Bắt buộc | ID định danh duy nhất của thủ tục (ví dụ: `"dinh_muc_nuoc"`). Được sử dụng trong logic code (`tools.js`) để đối chiếu và truy vấn. |
| `title` | `String` | Bắt buộc | Tên hiển thị chính thức của thủ tục bằng tiếng Việt. AI dùng trường này để trả lời tên thủ tục cho khách hàng. |
| `purpose` | `String` | Bắt buộc | Mô tả ngắn gọn về mục đích hoặc định nghĩa của thủ tục để AI tóm tắt cho khách hàng hiểu. |
| `apDung` | `String` | Tùy chọn | Đối tượng áp dụng của thủ tục (ví dụ: `"ho_gia_dinh"`). Hỗ trợ kiểm tra điều kiện (ví dụ: phân biệt Hộ gia đình và Doanh nghiệp). |
| `quyDinh` | `String` | Tùy chọn | Các quy tắc, quy chuẩn hành chính hoặc chính sách áp dụng riêng cho thủ tục này (ví dụ: điều kiện cư trú để được đăng ký định mức nước). |
| `thuatNgu` | `String` | Tùy chọn | Giải thích chi tiết các thuật ngữ chuyên môn hoặc biểu mẫu viết tắt (ví dụ: CT07, CT08 là gì, làm sao để xin cấp). Giúp AI trả lời khi khách thắc mắc. |
| `channels` | `String` | Tùy chọn | Các kênh tiếp nhận hồ sơ hợp lệ của thủ tục (ví dụ: app SAWACO CSKH, website, hoặc nộp trực tiếp tại các địa chỉ cụ thể). |
| `cases` | `Array` | Bắt buộc | Mảng chứa danh sách các trường hợp/đối tượng con chi tiết của thủ tục đó. |

---

## 3. Chi Tiết Các Trường Trong Mỗi Trường Hợp (Case Object)

Mảng `cases` chứa các đối tượng đại diện cho từng phân loại hồ sơ (ví dụ: phân biệt giữa *CCCD TP.HCM* và *CCCD tỉnh khác*, hoặc *Hộ gia đình* và *Doanh nghiệp*). Mỗi đối tượng trong `cases` gồm:

| Tên Trường | Kiểu Dữ Liệu | Trạng Thái | Ý Nghĩa & Vai Trò |
| :--- | :--- | :--- | :--- |
| `id` | `String` | Bắt buộc | ID định danh duy nhất của trường hợp (ví dụ: `"cccd_tphcm"`, `"ho_gia_dinh"`, `"doanh_nghiep"`). |
| `label` | `String` | Bắt buộc | Nhãn mô tả chi tiết bằng tiếng Việt của trường hợp (ví dụ: `"Có CCCD tại TP.HCM"`, `"Doanh nghiệp, công ty"`). |
| `transferToAgent` | `Boolean` | Tùy chọn | Nếu là `true`, biểu thị trường hợp này cần chuyển tiếp cuộc gọi đến Tổng đài viên (Human Agent) do quy trình phức tạp (ví dụ: doanh nghiệp đăng ký lắp đặt/sang tên). |
| `requiredDocs` | `Object` | Tùy chọn | Đối tượng chứa cấu trúc các loại giấy tờ cần chuẩn bị cho trường hợp tương ứng. |

---

## 4. Chi Tiết Các Trường Trong Đối Tượng Giấy Tờ (`requiredDocs`)

Đối tượng `requiredDocs` dùng để định nghĩa quy ước giấy tờ cần nộp. Để AI có thể hướng dẫn chính xác khách hàng cần những gì, hệ thống chia nhỏ thành các thuộc tính sau:

| Tên Trường | Kiểu Dữ Liệu | Trạng Thái | Ý Nghĩa & Vai Trò |
| :--- | :--- | :--- | :--- |
| `required` | `Array<String>` | Tùy chọn | Danh sách các giấy tờ **bắt buộc phải có đầy đủ** (ví dụ: bản sao CCCD chính chủ, số danh bạ...). |
| `options` | `Array<String>` | Tùy chọn | Danh sách các giấy tờ thay thế (khách hàng chỉ cần có **một trong số các giấy tờ** này). Ví dụ: sổ hồng hoặc giấy phép xây dựng. |
| `optional` | `Array<String>` | Tùy chọn | Danh sách các giấy tờ bổ sung, chỉ nộp **tùy trường hợp hoặc tùy nhu cầu** (ví dụ: hồ sơ định mức nước đi kèm). |
| `note` | `String` | Tùy chọn | Ghi chú hoặc hướng dẫn chung về mặt giấy tờ (ví dụ: `"Không cần chuẩn bị giấy tờ trước"`). |

---

## 5. Quy Ước Logic Xử Lý Trong Hệ Thống

Dựa trên cấu trúc dữ liệu trên, Voice Bot (`tools.js` / `call-manager.js`) sẽ áp dụng các logic xử lý sau:
1. **Chuyển tiếp (Transfer):** Nếu phát hiện case tương ứng có thuộc tính `transferToAgent: true`, bot sẽ không đọc danh sách giấy tờ mà ngay lập tức thực hiện chuyển hướng cuộc gọi đến tổng đài viên hoặc tạo phiếu hỗ trợ.
2. **Tổng hợp giấy tờ:** Khi hướng dẫn hồ sơ, AI sẽ kết hợp:
   - Các mục trong `required` (liệt kê tất cả).
   - Các mục trong `options` (nêu rõ khách hàng chọn 1 trong các loại giấy tờ này).
   - Các mục trong `optional` (nhắc nhở nộp thêm nếu có nhu cầu phát sinh).
   - Đọc thêm phần `note` nếu các mục trên không có dữ liệu.

---

## 6. So Sánh và Cơ Chế Hoạt Động Của Trường `apDung`

Trường `apDung` được thiết kế để **chặn sớm và từ chối xử lý** khi đối tượng yêu cầu thủ tục không phù hợp, giúp bot hoạt động chính xác theo quy chuẩn nghiệp vụ mà không cần hỏi thêm thông tin hoặc hướng dẫn sai lệch.

### So Sánh Việc Sử Dụng `apDung` Giữa Các Thủ Tục

| Tên Thủ Tục | Giá Trị `apDung` | Cơ Chế Hoạt Động & Phân Biệt Đối Tượng |
| :--- | :--- | :--- |
| **Đăng ký định mức nước** (`dinh_muc_nuoc`) | `"ho_gia_dinh"` | **Chặn cứng ở cấp độ thủ tục:**<br>Thủ tục này chỉ dành cho hộ gia đình. Nếu khách hàng khai báo hoặc AI nhận diện `doi_tuong === "doanh_nghiep"`, bot sẽ chặn ngay lập tức dựa trên trường `apDung` và báo lỗi "Thủ tục chỉ áp dụng cho hộ gia đình..." mà không cần đi tiếp vào mảng `cases`. |
| **Lắp đặt đồng hồ nước** (`lap_dat_dong_ho`) | *Không cấu hình* (`undefined`) | **Phân nhánh ở cấp độ `cases`:**<br>Thủ tục này hỗ trợ cả hộ gia đình và doanh nghiệp. Nếu không truyền `doi_tuong`, bot sẽ yêu cầu hỏi làm rõ. Nếu là hộ gia đình (`ho_gia_dinh`) -> trả về danh sách giấy tờ. Nếu là doanh nghiệp (`doanh_nghiep`) -> trả về yêu cầu chuyển tổng đài viên (`transferToAgent: true`). |
| **Sang tên đồng hồ nước** (`sang_ten_dong_ho`) | *Không cấu hình* (`undefined`) | **Phân nhánh ở cấp độ `cases`:**<br>Tương tự thủ tục lắp đặt đồng hồ nước, phân nhánh xử lý khác nhau giữa hộ gia đình (hướng dẫn hồ sơ) và doanh nghiệp (chuyển tổng đài viên). |
| **Nâng/Dời đồng hồ nước** (`nang_doi_dong_ho`) | *Không cấu hình* (`undefined`) | **Áp dụng chung (`default`):**<br>Thủ tục áp dụng chung cho mọi đối tượng nên không cần chặn hay phân biệt đối tượng sử dụng. |

### Cách Code Sử Dụng Trường `apDung` (`src/tools.js`)

Trong file [tools.js](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/tools.js), logic kiểm tra `apDung` được thực hiện ở các dòng đầu của hàm `get_procedure_info`:

```javascript
// Nếu thủ tục có giới hạn đối tượng áp dụng (ví dụ: apDung: "ho_gia_dinh")
// và đối tượng của khách hàng truyền vào khác với đối tượng áp dụng đó:
if (procedure.apDung && doi_tuong && doi_tuong !== procedure.apDung) {
  return JSON.stringify({
    success: true,
    thuTuc: procedure.title,
    message: `Thủ tục ${procedure.title} CHỈ áp dụng cho hộ gia đình, KHÔNG áp dụng cho doanh nghiệp hay công ty. Nếu khách là doanh nghiệp cần hỗ trợ khác, mời chuyển tổng đài viên hoặc tạo phiếu ghi nhận.`,
  });
}
```

* **Tại sao không dùng `apDung: "ho_gia_dinh"` cho Lắp đặt và Sang tên?**
  Bởi vì thủ tục Lắp đặt và Sang tên **vẫn áp dụng cho doanh nghiệp** (nhưng quy trình nghiệp vụ yêu cầu doanh nghiệp phải gặp trực tiếp tổng đài viên để hỗ trợ). Do đó, ta không chặn từ đầu bằng `apDung` mà để đi vào phần khớp `cases` để bot biết đường chuyển cuộc gọi cho tổng đài viên (`transferToAgent: true`).

---

## 7. Đánh Giá & Đề Xuất Cải Tiến Cấu Trúc Dữ Liệu

Cấu trúc hiện tại đã đáp ứng tốt yêu cầu kịch bản hiện tại và dễ đọc nhờ viết bằng file JS có kèm comment rõ ràng. Tuy nhiên, nếu dự án mở rộng thêm các thủ tục mới hoặc cần thay đổi kịch bản đàm thoại của AI thường xuyên, cấu trúc này có một số điểm hạn chế và cần được cải tiến như sau:

### 1. Đồng nhất và tách biệt dữ liệu "Mô tả" với "Lưu ý nghiệp vụ"
* **Vấn đề:** Hiện tại, trường `purpose` của thủ tục Lắp đặt đồng hồ chứa cả thông tin bổ trợ về mặt giấy tờ: *"Đăng ký gắn đồng hồ nước mới tại địa chỉ sử dụng nước. Giấy tờ cần sao y còn hiệu lực trong vòng 6 tháng hoặc có bản chính để đối chiếu."*.
* **Đề xuất:** Nên tách thông tin thời hạn giấy tờ thành một trường riêng (ví dụ: `documentValidity: "Giấy tờ sao y phải còn hiệu lực trong vòng 6 tháng..."`) để AI tóm tắt chính xác hơn, tránh việc đọc gộp mục đích sử dụng với yêu cầu kỹ thuật của hồ sơ.

### 2. Chuẩn hóa cơ chế phân biệt đối tượng (`doi_tuong`)
* **Vấn đề:** Trong [tools.js](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/tools.js), hệ thống kiểm tra thủ tục có phân biệt đối tượng hay không bằng cách dùng hàm `.some(c => c.id === "doanh_nghiep")`. Cách kiểm tra dựa trên giá trị chuỗi (hardcoded string) này khá mong manh, dễ lỗi nếu sau này đổi ID của case hoặc thêm đối tượng mới (ví dụ: cơ quan hành chính, tổ chức tôn giáo...).
* **Đề xuất:** Cấu hình rõ ràng thuộc tính phân biệt đối tượng ở cấp thủ tục. Ví dụ:
  ```javascript
  // Khai báo rõ ràng các đối tượng được hỗ trợ
  doiTuongHoTro: ["ho_gia_dinh", "doanh_nghiep"]
  ```

### 3. Đưa các thông điệp thoại (Prompts/Messages) từ Code vào Data
* **Vấn đề:** Các câu hỏi thoại như *"Quý Khách đăng ký cho hộ gia đình hay doanh nghiệp ạ?"* hay thông điệp chuyển máy *"Thủ tục... đối với doanh nghiệp do tổng đài viên hỗ trợ..."* đang bị viết cứng (hardcoded) trong file logic [tools.js](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/tools.js). Nếu muốn đổi văn phong thoại hoặc tùy chỉnh theo từng thủ tục, lập trình viên sẽ phải sửa code logic thay vì chỉ sửa data cấu hình.
* **Đề xuất:** Chuyển các câu thoại này vào data cấu hình của từng thủ tục. Ví dụ:
  ```javascript
  messages: {
    clarifySubject: "Quý khách đăng ký cho hộ gia đình hay doanh nghiệp công ty ạ?",
    transferNotice: "Thủ tục này đối với doanh nghiệp sẽ do tổng đài viên hỗ trợ trực tiếp..."
  }
  ```

### 4. Định nghĩa cấu trúc giấy tờ (Required Documents Schema) chi tiết hơn
* **Vấn đề:** Danh sách giấy tờ trong `requiredDocs` đang là các chuỗi văn bản tự do dài dòng (ví dụ: *"Bản sao có chứng thực giấy chứng nhận số nhà (nếu địa chỉ có thay đổi so với địa chỉ trên hóa đơn tiền nước)"*). Việc này làm bot khó quản lý trạng thái kiểm tra (checklist) xem khách hàng đã cung cấp đủ giấy tờ nào hay chưa nếu cuộc hội thoại diễn ra qua nhiều bước.
* **Đề xuất:** Chuyển danh sách giấy tờ thành mảng các Object có ID và nội dung rõ ràng:
  ```javascript
  requiredDocs: {
    required: [
      { id: "cccd", name: "Căn cước công dân chính chủ" },
      { id: "giay_to_nha_dat", name: "Giấy chứng nhận quyền sở hữu nhà đất" }
    ]
  }
  ```

### 5. Ràng buộc kiểu dữ liệu bằng TypeScript hoặc JSON Schema
* **Vấn đề:** Do cấu trúc dữ liệu hiện tại là file Javascript thuần, khi người khác cập nhật dữ liệu, họ có thể quên khai báo một số trường bắt buộc (như thiếu `cases` hay viết sai tên trường `apDung` thành `apdung`) dẫn đến lỗi runtime của bot.
* **Đề xuất:** Nếu dự án dùng TypeScript, có thể định nghĩa Interface `ProcedureConfig`. Hoặc nếu dùng Javascript, viết một đoạn code unit test ngắn để validate cấu trúc schema của file `huongdanthutuc-data.js` trước khi deploy.


