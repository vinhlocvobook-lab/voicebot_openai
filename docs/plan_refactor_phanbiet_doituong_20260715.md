# Đề xuất refactor: phân biệt đối tượng (hộ gia đình / doanh nghiệp) trong `get_procedure_info` & `check_missing_docs` — 15/07/2026

Trạng thái: **ĐANG ĐỀ XUẤT — CHƯA TRIỂN KHAI.** Tài liệu này để bạn xem trước,
duyệt hướng rồi mới code. Không có dòng code nào bị đổi khi tạo file này.

**Mục tiêu:** đây là **refactor thuần** (dọn code) — sau khi làm xong, với
cùng một input, `get_procedure_info` và `check_missing_docs` phải trả về
**JSON giống hệt bây giờ**, không đổi câu trả lời AI đọc cho khách. Mục 6 mô
tả cách kiểm chứng điều đó.

---

## 1. Hiện trạng — vì sao đang "rối"

Toàn bộ logic nằm trong `src/tools.js`. Có 2 hàm xử lý phần thủ tục, cả hai
đều nhận `loai_thu_tuc` + `doi_tuong` (đã chuẩn hoá qua `normalizeProcedureArgs`,
dòng 322-374 — phần này **không liên quan** đến vấn đề đang bàn, giữ nguyên):

- `handleGetProcedureInfo` (dòng 376-536) — trả hướng dẫn giấy tờ.
- `handleCheckMissingDocs` (dòng 570-~650) — đối chiếu giấy tờ khách đã có.

Cả hai hàm tự lặp lại **3 bước giống nhau**, viết 2 lần ở 2 nơi:

```js
// (a) Thủ tục này có phân biệt hộ gia đình/doanh nghiệp không?
const coPhanBietDoiTuong = procedure.cases.some((c) => c.id === "doanh_nghiep");
if (!doi_tuong && coPhanBietDoiTuong) { ... return can_hoi_doi_tuong ... }

// (b) Lọc case theo đối tượng
let relevantCases = procedure.cases;
if (doi_tuong) {
  const matched = procedure.cases.filter((c) => c.id.includes(doi_tuong) || c.id === "default");
  if (matched.length > 0) relevantCases = matched;
}

// (c) Case đó có phải "chuyển tổng đài viên" không?
if (relevantCases.length > 0 && relevantCases.every((c) => c.transferToAgent)) {
  ... return can_chuyen_tong_dai ...
}
```

Xuất hiện ở dòng 409-442 (`handleGetProcedureInfo`) và dòng 584-609
(`handleCheckMissingDocs`), gần như copy-paste. Ba vấn đề cụ thể:

**Vấn đề 1 — lặp code 2 lần.** Sửa quy tắc (a)/(b)/(c) phải nhớ sửa cả 2 hàm.
Nếu quên 1 chỗ, `get_procedure_info` và `check_missing_docs` sẽ ứng xử khác
nhau cho cùng một thủ tục — bug khó phát hiện vì mỗi tool được gọi ở thời
điểm khác nhau trong hội thoại.

**Vấn đề 2 — bước (a) suy luận bằng chuỗi "ma thuật".**
`procedure.cases.some((c) => c.id === "doanh_nghiep")` — không có field nào
trong data nói thẳng "thủ tục này phân biệt đối tượng", code phải *đoán* qua
việc có case nào đặt `id` đúng chữ `"doanh_nghiep"` hay không. Nếu sau này
thêm case doanh nghiệp mà đặt `id` khác (vd `"cong_ty"`, `"khach_doanh_nghiep"`),
code sẽ **âm thầm** coi thủ tục đó là không phân biệt đối tượng — không lỗi,
không cảnh báo, chỉ sai kết quả và rất khó bắt lỗi khi review.

**Vấn đề 3 — bước (b) dùng khớp chuỗi con, và field `id` bị dùng cho 2 việc
khác nhau.** `c.id.includes(doiTuong)` so khớp theo kiểu "chuỗi con nằm
trong chuỗi", trong khi field `id` của case đang gánh 2 vai trò không liên
quan nhau:

| Thủ tục | `cases[].id` hiện tại | Ý nghĩa thật |
|---|---|---|
| `dinh_muc_nuoc` | `cccd_tphcm`, `cccd_tinh_khac` | phân loại theo **nơi cấp CCCD** — không liên quan hộ gia đình/doanh nghiệp |
| `lap_dat_dong_ho` | `ho_gia_dinh`, `doanh_nghiep` | phân loại theo **đối tượng khách hàng** |
| `sang_ten_dong_ho` | `ho_gia_dinh`, `doanh_nghiep` | phân loại theo **đối tượng khách hàng** |
| `nang_doi_dong_ho` | `default` | không phân loại |

Người đọc `huongdanthutuc-data.js` không thể biết `id` là "đối tượng" hay
"loại giấy tờ theo tình huống" nếu không lật sang `tools.js` đọc cách nó
được dùng. Đây là nguồn gốc chính của cảm giác "rối".

Ngoài ra, thủ tục `dinh_muc_nuoc` dùng field riêng `apDung: "ho_gia_dinh"`
(dòng 397 `tools.js`) để chặn doanh nghiệp — **khác cơ chế** với
`lap_dat_dong_ho`/`sang_ten_dong_ho` dùng case `transferToAgent: true`. Hai
thủ tục cùng ý nghĩa nghiệp vụ ("không tự phục vụ đối tượng X qua bot")
nhưng biểu diễn bằng 2 cách khác nhau. Mục 5 nói rõ hơn — đề xuất **không
đụng vào phần này** trong đợt refactor này vì nó đổi hành vi (dinh_muc_nuoc
từ chối thẳng chứ không hỏi lại như lap_dat/sang_ten), cần bàn riêng.

---

## 2. Đề xuất điều chỉnh

### Mục 1 — Thêm field tường minh vào data (`src/huongdanthutuc-data.js`)

**1a.** Thêm field `phanBietDoiTuong: true` ở cấp procedure cho
`lap_dat_dong_ho` và `sang_ten_dong_ho` — thay cho việc code phải đoán qua
`cases.some(id === "doanh_nghiep")`:

```js
lap_dat_dong_ho: {
  id: "lap_dat_dong_ho",
  title: "Đăng ký lắp đặt đồng hồ nước",
  purpose: "...",
  phanBietDoiTuong: true,   // MỚI — khai báo tường minh
  cases: [ ... ],
},
```

Tương tự cho `sang_ten_dong_ho`. `dinh_muc_nuoc` và `nang_doi_dong_ho`
**không** thêm field này (giữ `undefined` = không phân biệt qua cơ chế
`cases`, đúng hiện trạng).

**1b.** Thêm field `doiTuong` riêng cho các case thực sự phân theo đối
tượng khách hàng (tách khỏi `id`, để `id` chỉ còn vai trò định danh case):

```js
cases: [
  {
    id: "ho_gia_dinh",
    doiTuong: "ho_gia_dinh",   // MỚI
    label: "Hộ gia đình",
    requiredDocs: { ... },
  },
  {
    id: "doanh_nghiep",
    doiTuong: "doanh_nghiep",  // MỚI
    label: "Doanh nghiệp, công ty",
    transferToAgent: true,
  },
],
```

Case của `dinh_muc_nuoc` (`cccd_tphcm`, `cccd_tinh_khac`) và `nang_doi_dong_ho`
(`default`) **không** thêm field `doiTuong` — đúng bản chất, chúng không
phân theo đối tượng khách hàng.

### Mục 2 — Gộp logic dùng chung (`src/tools.js`)

Viết 1 hàm helper duy nhất, thay cho việc lặp 2 lần bước (a)(b)(c):

```js
// Trạng thái xử lý case theo đối tượng — dùng chung cho get_procedure_info
// và check_missing_docs, thay vì lặp logic ở 2 hàm.
function resolveCasesByDoiTuong(procedure, doiTuong) {
  if (procedure.phanBietDoiTuong && !doiTuong) {
    return { status: "need_doi_tuong" };
  }
  let cases = procedure.cases;
  if (doiTuong) {
    const matched = procedure.cases.filter(
      (c) => c.doiTuong === doiTuong || c.id === "default"
    );
    if (matched.length > 0) cases = matched;
  }
  if (cases.length > 0 && cases.every((c) => c.transferToAgent)) {
    return { status: "transfer", cases };
  }
  return { status: "ok", cases };
}
```

`handleGetProcedureInfo` và `handleCheckMissingDocs` gọi hàm này, rồi tự
build câu `message` riêng theo văn phong hiện tại của từng hàm (không đổi
nội dung message — chỉ đổi **nơi** tính toán trạng thái):

```js
// Trong handleGetProcedureInfo, thay đoạn dòng 409-442:
const resolved = resolveCasesByDoiTuong(procedure, doi_tuong);
if (resolved.status === "need_doi_tuong") {
  return JSON.stringify({
    success: true,
    thuTuc: procedure.title,
    can_hoi_doi_tuong: true,
    message: `Thủ tục ${procedure.title} có hướng dẫn KHÁC NHAU cho hộ gia đình và doanh nghiệp. ...`, // giữ nguyên văn hiện tại
  });
}
if (resolved.status === "transfer") {
  return JSON.stringify({
    success: true,
    thuTuc: procedure.title,
    can_chuyen_tong_dai: true,
    message: `Thủ tục ${procedure.title} đối với doanh nghiệp/công ty do tổng đài viên hỗ trợ trực tiếp, ...`, // giữ nguyên văn hiện tại
  });
}
const relevantCases = resolved.cases;
// ... phần build spokenItems giữ nguyên, dùng relevantCases thay vì tự lọc lại
```

`handleCheckMissingDocs` sửa tương tự (dòng 584-609), dùng đúng
`resolveCasesByDoiTuong` thay vì đoạn lặp riêng của nó.

### Mục 3 — Không đổi

- `normalizeProcedureArgs` (dòng 322-374): giữ nguyên 100%, không liên quan.
- Toàn bộ nội dung `requiredDocs`, `purpose`, `channels`, `quyDinh`,
  `thuatNgu`, cách build `spokenItems`/`doc_cho_khach`: giữ nguyên 100%.
- Văn phong từng câu `message` trả về AI: giữ nguyên 100% (copy y nguyên
  chuỗi hiện tại vào 2 nhánh mới, chỉ chuyển vị trí tính toán).

---

## 3. Cam kết hành vi không đổi — bảng đối chiếu

Với input `(loai_thu_tuc, doi_tuong)`, output (field nào xuất hiện trong
JSON) phải giống hệt trước/sau refactor:

| `loai_thu_tuc` | `doi_tuong` | `can_hoi_doi_tuong` | `can_chuyen_tong_dai` | Case dùng để trả `doc_cho_khach` |
|---|---|---|---|---|
| `dinh_muc_nuoc` | (không truyền) | — | — | cả 2 case (`cccd_tphcm` + `cccd_tinh_khac`) |
| `dinh_muc_nuoc` | `ho_gia_dinh` | — | — | cả 2 case (không case nào có `doiTuong` field → không lọc được gì) |
| `dinh_muc_nuoc` | `doanh_nghiep` | — | — | chặn sớm bởi `apDung` (dòng 397), trả message "CHỈ áp dụng hộ gia đình" — **không đổi, ngoài phạm vi refactor này** |
| `lap_dat_dong_ho` | (không truyền) | ✅ true | — | — |
| `lap_dat_dong_ho` | `ho_gia_dinh` | — | — | case `ho_gia_dinh` |
| `lap_dat_dong_ho` | `doanh_nghiep` | — | ✅ true | — |
| `sang_ten_dong_ho` | (không truyền) | ✅ true | — | — |
| `sang_ten_dong_ho` | `ho_gia_dinh` | — | — | case `ho_gia_dinh` |
| `sang_ten_dong_ho` | `doanh_nghiep` | — | ✅ true | — |
| `nang_doi_dong_ho` | (không truyền / bất kỳ) | — | — | case `default` |

Dòng "dinh_muc_nuoc + doanh_nghiep" xác nhận: refactor **không đụng** vào
check `apDung` (dòng 395-403 `tools.js`) — nhánh đó tách biệt, chạy **trước**
`resolveCasesByDoiTuong` và không đổi.

---

## 4. Kịch bản test (kiểm chứng sau khi code)

### 4a. Test tự động (khuyến nghị chạy trước, nhanh và chắc chắn hơn gọi thoại)

Không cần gọi thoại thật — `dispatchTool(name, args)` (`src/tools.js` dòng
707, đã export) gọi trực tiếp được bằng 1 script Node nhỏ. Cách kiểm chứng
refactor không đổi hành vi:

1. Trước khi sửa code: chạy toàn bộ tổ hợp bên dưới, lưu output JSON ra file
   (`before.json`).
2. Sau khi sửa theo Mục 2: chạy lại đúng tổ hợp đó (`after.json`).
3. `diff before.json after.json` — phải **rỗng** (không khác biệt).

**Tổ hợp cần chạy cho `get_procedure_info`** (10 case, khớp bảng Mục 3):

```
{ loai_thu_tuc: "dinh_muc_nuoc" }
{ loai_thu_tuc: "dinh_muc_nuoc", doi_tuong: "ho_gia_dinh" }
{ loai_thu_tuc: "dinh_muc_nuoc", doi_tuong: "doanh_nghiep" }
{ loai_thu_tuc: "lap_dat_dong_ho" }
{ loai_thu_tuc: "lap_dat_dong_ho", doi_tuong: "ho_gia_dinh" }
{ loai_thu_tuc: "lap_dat_dong_ho", doi_tuong: "doanh_nghiep" }
{ loai_thu_tuc: "sang_ten_dong_ho" }
{ loai_thu_tuc: "sang_ten_dong_ho", doi_tuong: "ho_gia_dinh" }
{ loai_thu_tuc: "sang_ten_dong_ho", doi_tuong: "doanh_nghiep" }
{ loai_thu_tuc: "nang_doi_dong_ho" }
```

**Tổ hợp cho `check_missing_docs`** (thêm `giay_to_da_co`, lặp lại đúng 9 tổ
hợp `loai_thu_tuc`/`doi_tuong` trên trừ `nang_doi_dong_ho` vì không có giấy
tờ để đối chiếu), vd:

```
{ loai_thu_tuc: "lap_dat_dong_ho", doi_tuong: "ho_gia_dinh", giay_to_da_co: ["căn cước công dân"] }
{ loai_thu_tuc: "sang_ten_dong_ho", doi_tuong: "ho_gia_dinh", giay_to_da_co: ["sổ hồng"] }
```

**Không đổi (giữ nguyên test, không kỳ vọng khác biệt trước/sau):**
- Các case chuẩn hoá tham số sai trong `normalizeProcedureArgs` (key có dấu,
  cờ boolean...) — không nằm trong phạm vi Mục 2, nhưng nên chạy chung 1 lượt
  cho chắc, vd `{ "loại_thu_tuc": "lap_dat_dong_ho" }`, `{ lap_dat_dong_ho: true }`.
- Thủ tục ngoài 4 loại (`loai_thu_tuc: "abc"`) → `ngoai_pham_vi: true`.

### 4b. Test bằng gọi thoại thật (sau khi test tự động pass — xác nhận trải nghiệm thực tế)

Bổ sung vào `test_case/TC-08-procedure.md` (giữ format hiện có):

- TC-08-06: Hỏi lắp đồng hồ, không nói rõ đối tượng → AI hỏi lại đúng 1 câu
  "hộ gia đình hay doanh nghiệp", không tự đoán.
- TC-08-07: Trả lời "doanh nghiệp" cho câu hỏi lắp đồng hồ → AI mời chuyển
  tổng đài viên/tạo phiếu, không đọc danh sách giấy tờ.
- TC-08-08: Hỏi sang tên đồng hồ cho công ty ngay từ đầu ("công ty tôi mua
  lại nhà xưởng, cần sang tên đồng hồ") → AI nhận diện `doanh_nghiệp` ngay,
  không hỏi lại, chuyển tổng đài viên.
- TC-08-09: Hỏi định mức nước cho công ty → AI từ chối thẳng ("chỉ áp dụng
  hộ gia đình"), không hỏi lại đối tượng (khác hành vi TC-08-06/07 — xác
  nhận `apDung` không bị ảnh hưởng bởi refactor).
- TC-08-10: Hỏi nâng/dời đồng hồ → không hỏi đối tượng, hướng dẫn thẳng
  (case `default`).

---

## 5. Ngoài phạm vi đợt này (cần bàn riêng nếu muốn làm)

`apDung` (dinh_muc_nuoc) và `phanBietDoiTuong` + case `transferToAgent`
(lap_dat/sang_ten) là 2 cơ chế khác nhau để diễn đạt cùng ý nghĩa "thủ tục
này bot không tự phục vụ đối tượng X". Có thể gộp thành 1 pattern duy nhất
(vd mỗi procedure khai báo hành vi theo từng đối tượng trong 1 object thay
vì rải rác `apDung` + `cases`), nhưng việc này **đổi hành vi thực tế**:
hiện `dinh_muc_nuoc` từ chối thẳng ngay khi biết là doanh nghiệp, còn
`lap_dat_dong_ho`/`sang_ten_dong_ho` hỏi lại đối tượng trước rồi mới chuyển
tổng đài viên. Gộp cơ chế có thể vô tình đổi 1 trong 2 hành vi này — nên để
riêng, bàn kỹ với bạn trước khi làm, không gộp chung vào refactor thuần lần
này.
