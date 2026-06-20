# Thiết kế DB — Voice Bot CSKH Cấp nước Trung An

Mục tiêu: giữ DB **đơn giản, dễ kiểm soát**. Chỉ trích ra DB những trường cần để
*tra cứu / xem chi phí / nghe lại ghi âm / đọc transcript / quản lý phiên bản prompt*.
Phần chi tiết debug (timeline, tool call, lỗi từng bước) vẫn nằm trong file JSON gốc
ở `conversation_summary/yyyy/mm/dd/{tel}_{callId}.json` — DB chỉ lưu đường dẫn tới file đó.

Nguồn dữ liệu: file JSON log (xem các key `meta`, `stats`, `summary`, `call_params`).

---

## Tổng quan: 4 bảng

| Bảng | Vai trò | 1 dòng = |
|------|---------|----------|
| `price` | Giá model (giữ lịch sử giá) | 1 phiên bản giá của 1 model |
| `prompt_logs` | Phiên bản system prompt đã dùng | 1 phiên bản prompt (nhiều cuộc gọi trỏ vào) |
| `voicebot_calllog` | Bản ghi mỗi cuộc gọi | 1 cuộc gọi |
| `ticket` | Báo sự cố/khiếu nại lưu nội bộ | 1 phiếu |

> Đã chốt (theo trao đổi): **không multi-tenant** (1 khách hàng) → bỏ `project_id` /
> bảng `project`. **Giữ bảng `ticket`**. **Giữ giá versioned**. **`customer_tel` là SĐT
> khách thật** (trong môi trường test đang giả lập bằng extension nội bộ).

Quan hệ:

```
price ──┐ (3 FK: realtime / summary / transcript)
        ├──< voicebot_calllog >── prompt_logs
        │                    └──< ticket
```

---

## 1. Bảng `price` — giá model

Thay cho `openai_pricing.json`. **Giữ lịch sử giá**: khi đổi giá thì thêm dòng mới,
không sửa dòng cũ → log cũ vẫn truy ra đúng giá tại thời điểm đó.

| Cột | Kiểu | Ghi chú |
|-----|------|---------|
| `id` | PK | |
| `model_key` | VARCHAR | Tên model trong code, vd `gpt-realtime-mini`, `gpt-4o-mini`, `whisper-1` |
| `model_type` | ENUM | `realtime` / `text` / `transcription` |
| `input_price` | DECIMAL | (text) USD / 1M input tokens |
| `cached_input_price` | DECIMAL | (text) |
| `output_price` | DECIMAL | (text) |
| `text_input_price` … `audio_output_price` | DECIMAL | (realtime) 6 cột giá token text/audio |
| `per_minute_price` | DECIMAL | (transcription tính theo phút, vd whisper-1) |
| `effective_from` | DATETIME | Giá có hiệu lực từ khi nào |
| `effective_to` | DATETIME NULL | NULL = còn hiệu lực |
| `is_current` | TINYINT | 1 = bản giá đang áp dụng |
| `source` / `note` | VARCHAR | Nguồn giá, ghi chú |

> **Lưu ý:** `voicebot_calllog` đã lưu **số tiền đã chốt** (`cost_*`) nên xem lại chi phí
> luôn đúng. Versioning (`effective_from/to`, `is_current`) thêm khả năng *tính lại* chi
> phí từ token theo đúng giá tại thời điểm cuộc gọi — đã chốt **giữ versioning**.
> Khi đổi giá: KHÔNG sửa dòng cũ; set dòng cũ `is_current=0`, `effective_to=NOW()` rồi
> INSERT dòng giá mới `is_current=1`.

---

## 2. Bảng `prompt_logs` — phiên bản prompt

Lưu **theo phiên bản** (không log lại mỗi cuộc gọi). Nhiều cuộc gọi dùng cùng 1 prompt
sẽ trỏ chung 1 dòng — gom trùng bằng `prompt_hash`.
Nội dung lấy từ `call_params.accept.instructions` trong JSON.

| Cột | Kiểu | Ghi chú |
|-----|------|---------|
| `id` | PK | |
| `prompt_hash` | CHAR(64) | SHA-256 của `noi_dung` — để dedupe, UNIQUE |
| `version` | VARCHAR | Nhãn phiên bản (tùy chọn), vd `v1.3` |
| `noi_dung` | TEXT | Toàn bộ system instructions |
| `created_at` | DATETIME | Lần đầu thấy phiên bản này |

Cách dùng: trước khi insert call log → tính hash của instructions → tìm trong
`prompt_logs`, có rồi thì lấy `id`, chưa có thì insert mới → gán vào `voicebot_calllog.prompt_logs_id`.

---

## 3. Bảng `voicebot_calllog` — bản ghi mỗi cuộc gọi

Một dòng / cuộc gọi. Transcript lưu **gộp 1 cột text** (đủ để đọc lại); cần chi tiết
từng lượt thì mở file JSON.

### Định danh & liên hệ
| Cột | Kiểu | Nguồn JSON | Ghi chú |
|-----|------|-----------|---------|
| `id` | PK | | |
| `voicebot_callid` | VARCHAR | `meta.callId` | OpenAI call ID, UNIQUE |
| `customer_tel` | VARCHAR | SIP `From` header | **SĐT khách thật.** Môi trường test đang giả lập bằng extension nội bộ (vd `6302`), thực tế là số KH |
| `ma_danh_bo` | VARCHAR NULL | (từ tool/hội thoại) | Mã danh bộ KH — khóa tra cứu chính, nên index |
| `ho_ten` | VARCHAR NULL | | Tên khách nếu tra được |
| `prompt_logs_id` | FK NULL | | Phiên bản prompt đã dùng |

### Thời gian & kết quả
| Cột | Kiểu | Nguồn | Ghi chú |
|-----|------|-------|---------|
| `start_time` | DATETIME | `meta.startTime` | |
| `end_time` | DATETIME | `meta.endTime` | |
| `call_duration` | INT (giây) | `meta.durationSec` | |
| `outcome` | ENUM | `meta.outcome` | `completed`/`transferred`/`after_hours`/`disconnected` |

### Asterisk (nghe lại ghi âm)
| Cột | Kiểu | Nguồn |
|-----|------|-------|
| `uniqueid` | VARCHAR | `meta.asterisk.uniqueid` |
| `recordpath` | VARCHAR | `meta.asterisk.recordPath` |

### Model đã dùng (tên — để đọc nhanh không cần join)
| Cột | Kiểu | Nguồn |
|-----|------|-------|
| `voice_model_name` | VARCHAR | `meta.model` (realtime) |
| `summary_model_name` | VARCHAR | model tóm tắt (vd `gpt-4o-mini`) |
| `transcript_model_name` | VARCHAR | model phiên âm |

### Chi phí — tách 3 thành phần (mỗi cuộc gọi dùng 3 model)
| Cột | Kiểu | Ghi chú |
|-----|------|---------|
| `cost_realtime` | DECIMAL | Chi phí model realtime |
| `cost_summary` | DECIMAL | Chi phí model tóm tắt |
| `cost_transcript` | DECIMAL | Chi phí model phiên âm |
| `cost_total` | DECIMAL | Tổng (đã chốt tại thời điểm gọi) |
| `price_realtime_id` | FK `price` NULL | Bản giá realtime đã áp dụng |
| `price_summary_id` | FK `price` NULL | Bản giá summary đã áp dụng |
| `price_transcript_id` | FK `price` NULL | Bản giá transcription đã áp dụng |

> So với note cũ: bổ sung **model/chi phí summary** (note cũ thiếu, nhưng thực tế
> luôn có bước tóm tắt bằng gpt-4o-mini).

### Đánh giá chất lượng
| Cột | Kiểu | Nguồn | Ghi chú |
|-----|------|-------|---------|
| `danh_gia_cuoc_goi` | TEXT NULL | `summary.danh_gia_cuoc_goi` | Đánh giá do AI tạo (tốt/TB/kém + lý do) |
| `manual_rating` | TINYINT NULL | (người chấm) | 1–5, NULL = chưa chấm |
| `manual_note` | TEXT NULL | | Ghi chú chấm thủ công |

> Các trường summary khác (`yeu_cau_chinh`, `da_xu_ly`…) để trong JSON cho gọn;
> chỉ kéo ra cột những gì cần lọc/dashboard.

### Nội dung & nguồn đầy đủ
| Cột | Kiểu | Nguồn | Ghi chú |
|-----|------|-------|---------|
| `transcript` | TEXT | `conversation[]` | Gộp cả cuộc thoại 1 cột |
| `total_turns` / `tool_call_count` / `error_count` | INT NULL | `stats.*` | Thống kê nhanh |
| `json_log_filepath` | VARCHAR | | Đường dẫn file JSON gốc (nguồn đầy đủ) |
| `created_at` / `updated_at` | DATETIME | | |

### Index gợi ý
`voicebot_callid` (UNIQUE), `ma_danh_bo`, `customer_tel`, `start_time`, `outcome`,
`voice_model_name`.

---

## 4. Bảng `ticket`

Lưu nội bộ phiếu báo sự cố/khiếu nại gửi lên remote (`POST /bao-su-co {danhba, noidung}`),
vì remote không kiểm soát được → giữ bản nội bộ để đối soát.

Cột tối thiểu: `id`, `voicebot_calllog_id` (FK NULL), `ma_danh_bo`, `loai`, `mo_ta`,
`remote_success`, `remote_message`, `trang_thai` (ENUM), `created_at`.

---

## Quyết định — đã chốt

1. **Multi-tenant:** Không (1 khách hàng) → bỏ `project_id` và bảng `project`.
2. **Bảng `ticket`:** Có — giữ.
3. **Giá versioned:** Có — giữ (`effective_from/to`, `is_current`) để tính lại chi phí
   từ token theo đúng giá tại thời điểm cuộc gọi.
4. **`customer_tel`:** Là SĐT khách thật từ SIP `From`. Test hiện giả lập bằng extension
   nội bộ (vd `6302`); thực tế là số KH.

---

## Khác biệt so với note cũ (tóm tắt)

- Tách `cost` → `cost_realtime` / `cost_summary` / `cost_transcript` / `cost_total`.
- Thêm **model + giá summary** (gpt-4o-mini tóm tắt) — note cũ thiếu.
- `tel` → `customer_tel` (SĐT khách thật, từ SIP `From`).
- Thêm `ma_danh_bo` (khóa tra cứu nghiệp vụ).
- Thêm `outcome`, `danh_gia_cuoc_goi`, `manual_rating` (phục vụ đánh giá chất lượng).
- `prompt_logs` ghi rõ: lưu **theo phiên bản** + dedupe bằng `prompt_hash`.
- Giữ `ticket`; bỏ multi-tenant/`project`.
