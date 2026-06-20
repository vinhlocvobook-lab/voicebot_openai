-- =============================================================================
--  Voice Bot CSKH – Cấp nước Trung An
--  Schema RÚT GỌN (4 bảng) — MariaDB / MySQL
--
--  Thiết kế theo docs/thietke_db.md:
--    price            : giá model (giữ lịch sử giá / versioned)
--    prompt_logs      : phiên bản system prompt (dedupe bằng hash)
--    voicebot_calllog : 1 dòng / cuộc gọi (trích từ file JSON log)
--    ticket           : bản lưu nội bộ phiếu báo sự cố / khiếu nại
--
--  Nguyên tắc: DB chỉ giữ trường cần để tra cứu / xem chi phí / nghe lại ghi âm /
--  đọc transcript / quản lý prompt. Chi tiết debug (timeline, tool call, lỗi từng
--  bước) vẫn nằm trong file JSON gốc — trỏ qua cột json_log_filepath.
--
--  Quy ước: InnoDB, utf8mb4; DATETIME theo giờ VN (GMT+7).
--  (Bản phức tạp cũ đã lưu ở db/schema_full_backup.sql.)
-- =============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 1;

-- Tùy chọn: tạo & dùng database riêng (bỏ comment nếu cần)
-- CREATE DATABASE IF NOT EXISTS voicebot
--   CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
-- USE voicebot;


-- =============================================================================
--  1) PRICE — giá model (giữ lịch sử giá)
--     Thay cho openai_pricing.json. Đổi giá = thêm dòng mới, KHÔNG sửa dòng cũ.
-- =============================================================================
CREATE TABLE IF NOT EXISTS llm_price (
  id                        INT UNSIGNED   NOT NULL AUTO_INCREMENT,
  model_key                 VARCHAR(100)   NOT NULL COMMENT 'Tên model trong code, vd gpt-realtime-mini',
  model_type                ENUM('realtime','text','transcription') NOT NULL,
  description               VARCHAR(255)   NULL,

  -- Giá model dạng TEXT (Chat Completions) — USD / 1M tokens
  input_price               DECIMAL(12,6)  NULL,
  cached_input_price        DECIMAL(12,6)  NULL,
  output_price              DECIMAL(12,6)  NULL,

  -- Giá model dạng REALTIME (voice + text) — USD / 1M tokens
  text_input_price          DECIMAL(12,6)  NULL,
  cached_text_input_price   DECIMAL(12,6)  NULL,
  text_output_price         DECIMAL(12,6)  NULL,
  audio_input_price         DECIMAL(12,6)  NULL,
  cached_audio_input_price  DECIMAL(12,6)  NULL,
  audio_output_price        DECIMAL(12,6)  NULL,

  -- Giá model TRANSCRIPTION tính theo PHÚT (vd whisper-1) — USD / phút
  per_minute_price          DECIMAL(12,6)  NULL,

  -- Tham khảo: chi phí ước tính / phút (chỉ realtime)
  approx_cost_per_min_usd   DECIMAL(10,4)  NULL,

  -- Versioning (giữ lịch sử giá)
  currency                  CHAR(3)        NOT NULL DEFAULT 'USD',
  unit                      VARCHAR(32)    NOT NULL DEFAULT 'per_1M_tokens',
  effective_from            DATETIME       NOT NULL COMMENT 'Giá có hiệu lực từ thời điểm này',
  effective_to              DATETIME       NULL     COMMENT 'NULL = còn hiệu lực',
  is_current                TINYINT(1)     NOT NULL DEFAULT 1 COMMENT '1 = bản giá đang áp dụng',
  source                    VARCHAR(255)   NULL     COMMENT 'Nguồn giá (link docs)',
  note                      VARCHAR(255)   NULL,

  created_at                DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_price_model (model_key),
  KEY idx_price_current (model_key, is_current)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Giá model theo phiên bản (giữ lịch sử giá)';


-- =============================================================================
--  2) PROMPT_LOGS — phiên bản system prompt
--     Lưu THEO PHIÊN BẢN. Nhiều cuộc gọi cùng prompt trỏ chung 1 dòng (dedupe hash).
--     Nội dung lấy từ call_params.accept.instructions trong file JSON.
-- =============================================================================
CREATE TABLE IF NOT EXISTS prompt_logs (
  id            INT UNSIGNED   NOT NULL AUTO_INCREMENT,
  prompt_hash   CHAR(64)       NOT NULL COMMENT 'SHA-256 của noi_dung — dùng dedupe',
  version       VARCHAR(50)    NULL     COMMENT 'Nhãn phiên bản (tùy chọn), vd v1.3',
  noi_dung      MEDIUMTEXT     NOT NULL COMMENT 'Toàn bộ system instructions',
  created_at    DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Lần đầu thấy phiên bản này',

  PRIMARY KEY (id),
  UNIQUE KEY uq_prompt_hash (prompt_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Phiên bản system prompt đã dùng';


-- =============================================================================
--  3) VOICEBOT_CALLLOG — 1 dòng / cuộc gọi
--     Trích từ conversation_summary/yyyy/mm/dd/{tel}_{callId}.json
-- =============================================================================
CREATE TABLE IF NOT EXISTS voicebot_calllog (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Định danh & liên hệ
  voicebot_callid       VARCHAR(128)    NOT NULL COMMENT 'OpenAI call ID (meta.callId)',
  customer_tel          VARCHAR(32)     NULL     COMMENT 'SĐT khách thật (SIP From). Test giả lập bằng extension nội bộ',
  ma_danh_bo            VARCHAR(20)     NULL     COMMENT 'Mã danh bộ KH — khóa tra cứu chính',
  ho_ten                VARCHAR(255)    NULL     COMMENT 'Tên khách (nếu tra được)',
  prompt_logs_id        INT UNSIGNED    NULL     COMMENT 'FK prompt_logs — phiên bản prompt đã dùng',

  -- Thời gian & kết quả
  start_time            DATETIME        NULL     COMMENT 'meta.startTime',
  end_time              DATETIME        NULL     COMMENT 'meta.endTime',
  call_duration         INT UNSIGNED    NULL     COMMENT 'Số giây (meta.durationSec)',
  outcome               ENUM('completed','transferred','after_hours','disconnected') NULL COMMENT 'meta.outcome',

  -- Asterisk (nghe lại ghi âm)
  uniqueid              VARCHAR(64)     NULL     COMMENT 'meta.asterisk.uniqueid',
  recordpath            VARCHAR(512)    NULL     COMMENT 'meta.asterisk.recordPath',

  -- Tên model đã dùng (để đọc nhanh không cần join)
  voice_model_name      VARCHAR(100)    NULL     COMMENT 'Model realtime (meta.model)',
  summary_model_name    VARCHAR(100)    NULL     COMMENT 'Model tóm tắt, vd gpt-4o-mini',
  transcript_model_name VARCHAR(100)    NULL     COMMENT 'Model phiên âm',

  -- Chi phí — tách 3 thành phần (mỗi cuộc gọi dùng 3 model). Đã CHỐT tại thời điểm gọi.
  cost_realtime         DECIMAL(12,6)   NULL,
  cost_summary          DECIMAL(12,6)   NULL,
  cost_transcript       DECIMAL(12,6)   NULL,
  cost_total            DECIMAL(12,6)   NULL,

  -- Bản giá ĐÃ ÁP DỤNG (truy ngược giá lịch sử dù sau này đổi giá)
  price_realtime_id     INT UNSIGNED    NULL     COMMENT 'FK price — bản giá realtime đã dùng',
  price_summary_id      INT UNSIGNED    NULL     COMMENT 'FK price — bản giá summary đã dùng',
  price_transcript_id   INT UNSIGNED    NULL     COMMENT 'FK price — bản giá transcription đã dùng',

  -- Đánh giá chất lượng
  danh_gia_cuoc_goi     TEXT            NULL     COMMENT 'Đánh giá do AI tạo (summary.danh_gia_cuoc_goi)',
  manual_rating         TINYINT         NULL     COMMENT 'Người chấm 1-5 (NULL = chưa chấm)',
  manual_note           TEXT            NULL     COMMENT 'Ghi chú chấm thủ công',

  -- Nội dung & thống kê nhanh
  transcript            MEDIUMTEXT      NULL     COMMENT 'Toàn bộ hội thoại gộp 1 cột (conversation[])',
  total_turns           INT UNSIGNED    NULL     COMMENT 'stats.totalTurns',
  tool_call_count       INT UNSIGNED    NULL     COMMENT 'stats.toolCallCount',
  error_count           INT UNSIGNED    NULL     COMMENT 'stats.errorCount',

  -- Nguồn đầy đủ
  json_log_filepath     VARCHAR(512)    NULL     COMMENT 'Đường dẫn file JSON log gốc',

  created_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_callid (voicebot_callid),
  KEY idx_call_danhbo (ma_danh_bo),
  KEY idx_call_tel (customer_tel),
  KEY idx_call_start (start_time),
  KEY idx_call_outcome (outcome),
  KEY idx_call_voice_model (voice_model_name),
  KEY idx_call_prompt (prompt_logs_id),
  KEY idx_call_price_rt (price_realtime_id),
  KEY idx_call_price_sum (price_summary_id),
  KEY idx_call_price_tr (price_transcript_id),

  CONSTRAINT fk_call_prompt FOREIGN KEY (prompt_logs_id)
    REFERENCES prompt_logs (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_call_price_rt FOREIGN KEY (price_realtime_id)
    REFERENCES llm_price (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_call_price_sum FOREIGN KEY (price_summary_id)
    REFERENCES llm_price (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_call_price_tr FOREIGN KEY (price_transcript_id)
    REFERENCES llm_price (id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Bản ghi mỗi cuộc gọi (trích từ file JSON log)';


-- =============================================================================
--  4) TICKET — bản lưu nội bộ phiếu báo sự cố / khiếu nại
--     Gửi remote qua POST /bao-su-co {danhba, noidung}; remote không kiểm soát
--     được → lưu thêm bản nội bộ để đối soát.
-- =============================================================================
CREATE TABLE IF NOT EXISTS ticket (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ticket_code         VARCHAR(40)     NULL COMMENT 'Mã phiếu nội bộ (tự sinh), vd TK-20260620-0001',

  -- Liên kết cuộc gọi
  voicebot_calllog_id BIGINT UNSIGNED NULL COMMENT 'FK voicebot_calllog (nếu phát sinh từ cuộc gọi)',
  voicebot_callid     VARCHAR(128)    NULL COMMENT 'OpenAI call ID (lưu thẳng để tiện đối chiếu)',

  -- Thông tin khách & nội dung
  ma_danh_bo          VARCHAR(20)     NULL,
  customer_tel        VARCHAR(32)     NULL,
  ho_ten              VARCHAR(255)    NULL,
  loai                VARCHAR(64)     NULL COMMENT 'ro_ri, ap_luc, khieu_nai, su_co...',
  mo_ta               TEXT            NULL COMMENT 'Mô tả chi tiết do khách cung cấp',
  noi_dung_gui        TEXT            NULL COMMENT 'Nội dung thực gửi remote: [loai] mo_ta',

  -- Kết quả gửi remote
  remote_success      TINYINT(1)      NULL COMMENT '1 = remote nhận thành công',
  remote_message      TEXT            NULL COMMENT 'message remote trả về',
  remote_ref          VARCHAR(128)    NULL COMMENT 'Mã/ID phiếu remote trả (nếu có)',
  remote_raw          JSON            NULL COMMENT 'Toàn bộ response remote (phòng khi cần)',

  -- Trạng thái nội bộ
  trang_thai          ENUM('moi','da_gui','gui_loi','dang_xu_ly','hoan_thanh','huy')
                      NOT NULL DEFAULT 'moi',

  created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_ticket_code (ticket_code),
  KEY idx_ticket_danhbo (ma_danh_bo),
  KEY idx_ticket_tel (customer_tel),
  KEY idx_ticket_status (trang_thai),
  KEY idx_ticket_created (created_at),
  KEY idx_ticket_call (voicebot_calllog_id),
  CONSTRAINT fk_ticket_call FOREIGN KEY (voicebot_calllog_id)
    REFERENCES voicebot_calllog (id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Bản lưu nội bộ phiếu báo sự cố / khiếu nại';


-- =============================================================================
--  VIEWS tiện tra cứu
-- =============================================================================

-- Giá hiện hành của từng model (thay việc đọc openai_pricing.json)
CREATE OR REPLACE VIEW v_current_price AS
SELECT model_key, model_type, description,
       input_price, cached_input_price, output_price,
       text_input_price, cached_text_input_price, text_output_price,
       audio_input_price, cached_audio_input_price, audio_output_price,
       per_minute_price, approx_cost_per_min_usd,
       currency, unit, effective_from
FROM llm_price
WHERE is_current = 1;

-- Tổng quan cuộc gọi (cho dashboard đánh giá / chi phí)
CREATE OR REPLACE VIEW v_call_overview AS
SELECT
  c.id,
  c.voicebot_callid,
  c.start_time,
  c.call_duration,
  c.customer_tel,
  c.ma_danh_bo,
  c.ho_ten,
  c.voice_model_name,
  c.outcome,
  c.total_turns,
  c.tool_call_count,
  c.error_count,
  c.cost_total,
  ROUND(c.cost_total / NULLIF(c.call_duration, 0) * 60, 6) AS cost_usd_per_min,
  c.danh_gia_cuoc_goi,
  c.manual_rating,
  c.recordpath,
  c.json_log_filepath
FROM voicebot_calllog c;


-- =============================================================================
--  SEED GIÁ MODEL — khớp openai_pricing.json (updated 2026-06)
--  effective_from = 2026-06-01, is_current = 1. Đơn vị: USD / 1M tokens
--  (trừ whisper-1 tính theo phút).
-- =============================================================================

-- Model TEXT (Chat Completions) — dùng cho bước tóm tắt
INSERT INTO llm_price
  (model_key, model_type, description, input_price, cached_input_price, output_price,
   effective_from, is_current, source, note) VALUES
  ('gpt-4o-mini', 'text', 'GPT-4o mini - Chat Completions (text only)',
   0.150000, 0.075000, 0.600000, '2026-06-01 00:00:00', 1,
   'https://developers.openai.com/api/docs/pricing', 'updated 2026-06'),
  ('gpt-4o', 'text', 'GPT-4o - Chat Completions (text only)',
   2.500000, 1.250000, 10.000000, '2026-06-01 00:00:00', 1,
   'https://developers.openai.com/api/docs/pricing', 'updated 2026-06'),
  ('gpt-4o-2024-08-06', 'text', 'GPT-4o (2024-08-06) - Chat Completions',
   2.500000, 1.250000, 10.000000, '2026-06-01 00:00:00', 1,
   'https://developers.openai.com/api/docs/pricing', 'updated 2026-06');

-- Model REALTIME (voice + text)
INSERT INTO llm_price
  (model_key, model_type, description,
   text_input_price, cached_text_input_price, text_output_price,
   audio_input_price, cached_audio_input_price, audio_output_price,
   approx_cost_per_min_usd, effective_from, is_current, source, note) VALUES
  ('gpt-4o-mini-realtime-preview', 'realtime', 'GPT-4o mini Realtime API - voice + text',
   0.600000, 0.300000, 2.400000, 10.000000, 0.300000, 20.000000,
   0.3300, '2026-06-01 00:00:00', 1,
   'https://developers.openai.com/api/docs/pricing', 'updated 2026-06'),
  ('gpt-realtime-mini', 'realtime', 'gpt-realtime-mini (alias: gpt-4o-mini-realtime-preview)',
   0.600000, 0.300000, 2.400000, 10.000000, 0.300000, 20.000000,
   0.3300, '2026-06-01 00:00:00', 1,
   'https://developers.openai.com/api/docs/pricing', 'updated 2026-06'),
  ('gpt-4o-realtime-preview', 'realtime', 'GPT-4o Realtime API - voice + text (full model)',
   4.000000, 0.400000, 24.000000, 32.000000, 0.400000, 64.000000,
   1.6300, '2026-06-01 00:00:00', 1,
   'https://developers.openai.com/api/docs/pricing', 'updated 2026-06'),
  ('gpt-realtime-2', 'realtime', 'gpt-realtime-2 (alias: gpt-4o-realtime-preview)',
   4.000000, 0.400000, 24.000000, 32.000000, 0.400000, 64.000000,
   1.6300, '2026-06-01 00:00:00', 1,
   'https://developers.openai.com/api/docs/pricing', 'updated 2026-06');

-- Model TRANSCRIPTION
--  - gpt-4o(-mini)-transcribe: tính theo TOKEN (audio_input + text_output)
--  - whisper-1: tính theo PHÚT
INSERT INTO llm_price
  (model_key, model_type, description,
   audio_input_price, text_output_price, per_minute_price,
   effective_from, is_current, source, note) VALUES
  ('gpt-4o-mini-transcribe', 'transcription',
   'GPT-4o mini Transcribe - Speech-to-text (Realtime input audio)',
   1.250000, 5.000000, NULL, '2026-06-01 00:00:00', 1,
   'https://developers.openai.com/api/docs/pricing', 'updated 2026-06'),
  ('gpt-4o-transcribe', 'transcription',
   'GPT-4o Transcribe - Speech-to-text (chất lượng cao hơn)',
   2.500000, 10.000000, NULL, '2026-06-01 00:00:00', 1,
   'https://developers.openai.com/api/docs/pricing', 'updated 2026-06'),
  ('whisper-1', 'transcription',
   'Whisper-1 - Speech-to-text (tính theo phút)',
   NULL, NULL, 0.006000, '2026-06-01 00:00:00', 1,
   'https://developers.openai.com/api/docs/pricing', 'updated 2026-06');


-- =============================================================================
--  GỢI Ý — ĐỔI GIÁ model (giữ lịch sử). Chạy 2 lệnh trong 1 transaction:
--
--    UPDATE price SET is_current = 0, effective_to = NOW()
--     WHERE model_key = 'gpt-realtime-mini' AND is_current = 1;
--
--    INSERT INTO price (model_key, model_type, text_input_price, ..., effective_from, is_current)
--    VALUES ('gpt-realtime-mini', 'realtime', <giá mới> ..., NOW(), 1);
-- =============================================================================
