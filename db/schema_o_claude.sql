-- =============================================================================
--  Voice Bot Tổng đài CSKH – CNTA
--  Schema MariaDB cho: (1) Bảng giá model (versioned),
--                      (2) Log cuộc gọi phục vụ đánh giá chất lượng/prompt/chi phí,
--                      (3) Ticket / khiếu nại / báo sự cố (bản lưu nội bộ).
--
--  Mục tiêu khi thiết kế:
--    - Tra cứu & cập nhật giá dễ dàng, GIỮ LỊCH SỬ giá (log cũ vẫn tính đúng chi phí).
--    - Đánh giá chất lượng trả lời của model & chất lượng prompt.
--    - Xem được chi phí từng cuộc gọi.
--    - Nghe lại file ghi âm (lưu đường dẫn record của Asterisk).
--    - Xem toàn bộ transcript KH ↔ AI.
--    - Debug được "vấn đề đang ở đâu" (tool calls, errors, timeline sự kiện).
--
--  Quy ước:
--    - Engine InnoDB, charset utf8mb4 (hỗ trợ tiếng Việt đầy đủ).
--    - Thời gian lưu DATETIME theo giờ VN (GMT+7) — khớp với log hiện tại.
--    - File JSON trong conversation_summary/ vẫn là nguồn ĐẦY ĐỦ; DB trích các
--      trường cần cho tra cứu/đánh giá và lưu thêm đường dẫn file gốc.
-- =============================================================================

-- Tùy chọn: tạo database riêng. Bỏ comment nếu cần.
-- CREATE DATABASE IF NOT EXISTS voicebot
--   CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
-- USE voicebot;

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 1;


-- =============================================================================
--  PHẦN 1 — BẢNG GIÁ MODEL (versioned)
--  Thay thế cho openai_pricing.json. Có lịch sử giá theo effective_from/to.
-- =============================================================================

-- 1.1 Danh mục model -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_model (
  id                       INT UNSIGNED      NOT NULL AUTO_INCREMENT,
  model_key                VARCHAR(100)      NOT NULL COMMENT 'Tên model dùng trong code, vd: gpt-realtime-2',
  description              VARCHAR(255)      NULL     COMMENT 'Mô tả ngắn',
  model_type              ENUM('text','realtime') NOT NULL COMMENT 'text = Chat Completions; realtime = voice+text',
  approx_cost_per_min_usd  DECIMAL(10,4)     NULL     COMMENT 'Ước tính chi phí/phút (chỉ realtime), tham khảo',
  is_active                TINYINT(1)        NOT NULL DEFAULT 1 COMMENT '1 = đang dùng',
  created_at               DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ai_model_key (model_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Danh mục các model AI sử dụng trong Voice Bot';


-- 1.2 Giá theo phiên bản (per 1M tokens) --------------------------------------
--  Tất cả cột giá để NULL được: model text chỉ dùng input/cached_input/output;
--  model realtime dùng các cột *_input / *_output. Lưu đúng theo nguồn giá.
CREATE TABLE IF NOT EXISTS ai_model_price (
  id                       INT UNSIGNED      NOT NULL AUTO_INCREMENT,
  model_id                 INT UNSIGNED      NOT NULL,
  currency                 CHAR(3)           NOT NULL DEFAULT 'USD',
  unit                     VARCHAR(32)       NOT NULL DEFAULT 'per_1M_tokens',

  -- Giá cho model dạng TEXT (Chat Completions)
  input_price              DECIMAL(12,6)     NULL COMMENT 'USD / 1M input tokens',
  cached_input_price       DECIMAL(12,6)     NULL COMMENT 'USD / 1M cached input tokens',
  output_price             DECIMAL(12,6)     NULL COMMENT 'USD / 1M output tokens',

  -- Giá cho model dạng REALTIME (voice + text)
  text_input_price         DECIMAL(12,6)     NULL,
  cached_text_input_price  DECIMAL(12,6)     NULL,
  text_output_price        DECIMAL(12,6)     NULL,
  audio_input_price        DECIMAL(12,6)     NULL,
  cached_audio_input_price DECIMAL(12,6)     NULL,
  audio_output_price       DECIMAL(12,6)     NULL,

  effective_from           DATETIME          NOT NULL COMMENT 'Giá có hiệu lực từ thời điểm này',
  effective_to             DATETIME          NULL     COMMENT 'NULL = còn hiệu lực',
  is_current               TINYINT(1)        NOT NULL DEFAULT 1 COMMENT '1 = bản giá đang áp dụng',
  source                   VARCHAR(255)      NULL     COMMENT 'Nguồn giá, vd link docs OpenAI',
  note                     VARCHAR(255)      NULL,
  created_at               DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_price_model (model_id),
  KEY idx_price_current (model_id, is_current),
  CONSTRAINT fk_price_model FOREIGN KEY (model_id)
    REFERENCES ai_model (id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Bảng giá model theo phiên bản (giữ lịch sử giá)';


-- =============================================================================
--  PHẦN 2 — LOG CUỘC GỌI (phục vụ đánh giá & debug)
--  Trích từ conversation_summary/yyyy/mm/dd/{tel}_{callId}.json
-- =============================================================================

-- 2.1 Bản ghi cuộc gọi (1 dòng / cuộc gọi) ------------------------------------
CREATE TABLE IF NOT EXISTS call_log (
  id                       BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  call_id                  VARCHAR(128)      NOT NULL COMMENT 'OpenAI call ID, vd rtc_u0_...',
  tel                      VARCHAR(32)       NULL     COMMENT 'SĐT khách (từ SIP From)',
  ma_danh_bo               VARCHAR(20)       NULL     COMMENT 'Mã danh bộ (nếu xác định được)',
  ho_ten                   VARCHAR(255)      NULL     COMMENT 'Tên khách (nếu tra được)',

  -- Thời gian & kết quả
  start_time               DATETIME          NULL,
  end_time                 DATETIME          NULL,
  duration_sec             INT UNSIGNED      NULL,
  outcome                  ENUM('completed','transferred','after_hours','disconnected') NULL,

  -- Cấu hình phiên
  model                    VARCHAR(100)      NULL COMMENT 'Model realtime dùng cho cuộc gọi',
  voice                    VARCHAR(50)       NULL,

  -- Thông tin Asterisk (đối chiếu & NGHE LẠI ghi âm)
  asterisk_uniqueid        VARCHAR(64)       NULL,
  record_path              VARCHAR(512)      NULL COMMENT 'Đường dẫn file ghi âm trên Asterisk',
  phone_number             VARCHAR(32)       NULL,

  -- Thống kê nhanh (đánh giá độ dài / mức độ tương tác)
  total_turns              INT UNSIGNED      NULL,
  ai_turns                 INT UNSIGNED      NULL,
  customer_turns           INT UNSIGNED      NULL,
  tool_call_count          INT UNSIGNED      NULL,
  error_count              INT UNSIGNED      NULL,

  -- Token usage — REALTIME (đã cộng dồn trong cuộc gọi)
  rt_model                 VARCHAR(100)      NULL,
  rt_response_count        INT UNSIGNED      NULL,
  rt_input_tokens          INT UNSIGNED      NULL,
  rt_output_tokens         INT UNSIGNED      NULL,
  rt_text_input_tokens     INT UNSIGNED      NULL,
  rt_audio_input_tokens    INT UNSIGNED      NULL,
  rt_cached_text_input_tokens  INT UNSIGNED  NULL,
  rt_cached_audio_input_tokens INT UNSIGNED  NULL,
  rt_text_output_tokens    INT UNSIGNED      NULL,
  rt_audio_output_tokens   INT UNSIGNED      NULL,

  -- Token usage — SUMMARY (gpt-4o-mini tóm tắt cuộc gọi)
  sum_model                VARCHAR(100)      NULL,
  sum_prompt_tokens        INT UNSIGNED      NULL,
  sum_completion_tokens    INT UNSIGNED      NULL,
  sum_total_tokens         INT UNSIGNED      NULL,

  -- Chi phí (USD) — chốt lại tại thời điểm cuộc gọi
  cost_total_usd           DECIMAL(12,6)     NULL,
  cost_realtime_usd        DECIMAL(12,6)     NULL,
  cost_summary_usd         DECIMAL(12,6)     NULL,

  -- Đánh giá do AI tạo (chất lượng trả lời / xử lý cuộc gọi)
  eval_yeu_cau_chinh       TEXT              NULL COMMENT 'Yêu cầu chính của khách',
  eval_da_xu_ly            TEXT              NULL COMMENT 'Đã xử lý/cung cấp gì',
  eval_chua_xu_ly          TEXT              NULL COMMENT 'Chưa giải quyết được gì',
  eval_hanh_dong_tiep_theo TEXT              NULL COMMENT 'Hành động tiếp theo / follow-up',
  eval_diem_noi_bat        TEXT              NULL COMMENT 'Điểm đáng chú ý (thái độ KH, lỗi AI...)',
  eval_danh_gia_cuoc_goi   TEXT              NULL COMMENT 'Đánh giá: tốt/trung bình/kém + lý do',

  -- Đánh giá thủ công (con người chấm lại — phục vụ đánh giá chất lượng)
  manual_rating            TINYINT           NULL COMMENT 'Điểm 1-5 do người chấm (NULL = chưa chấm)',
  manual_note              TEXT              NULL COMMENT 'Ghi chú đánh giá thủ công',

  -- Nguồn dữ liệu đầy đủ
  json_file_path           VARCHAR(512)      NULL COMMENT 'Đường dẫn file JSON log gốc',

  created_at               DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_call_id (call_id),
  KEY idx_call_tel (tel),
  KEY idx_call_danhbo (ma_danh_bo),
  KEY idx_call_start (start_time),
  KEY idx_call_model (model),
  KEY idx_call_outcome (outcome)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Bản ghi tổng hợp mỗi cuộc gọi (trích từ file JSON log)';


-- 2.2 Transcript (toàn bộ lượt thoại KH ↔ AI) --------------------------------
CREATE TABLE IF NOT EXISTS call_transcript (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  call_log_id   BIGINT UNSIGNED NOT NULL,
  seq           INT UNSIGNED    NOT NULL COMMENT 'Thứ tự lượt trong cuộc gọi (1,2,3...)',
  turn_time     DATETIME        NULL,
  speaker       ENUM('AI','KH') NOT NULL,
  content       TEXT            NOT NULL COMMENT 'Nội dung lượt nói',
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_tr_call_seq (call_log_id, seq),
  CONSTRAINT fk_tr_call FOREIGN KEY (call_log_id)
    REFERENCES call_log (id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Transcript đầy đủ từng lượt thoại của cuộc gọi';


-- 2.3 Tool calls (đầu vào/đầu ra function call — debug & đánh giá) ------------
CREATE TABLE IF NOT EXISTS call_tool_call (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  call_log_id   BIGINT UNSIGNED NOT NULL,
  seq           INT UNSIGNED    NOT NULL,
  tool_time     DATETIME        NULL,
  tool_name     VARCHAR(64)     NOT NULL COMMENT 'get_bill, create_ticket, transfer_to_agent...',
  args          JSON            NULL COMMENT 'Tham số gọi tool',
  output        JSON            NULL COMMENT 'Kết quả trả về (JSON đã parse nếu được)',
  success       TINYINT(1)      NULL COMMENT 'Lấy từ field success của output nếu có',
  duration_ms   INT UNSIGNED    NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_tc_call_seq (call_log_id, seq),
  KEY idx_tc_name (tool_name),
  CONSTRAINT fk_tc_call FOREIGN KEY (call_log_id)
    REFERENCES call_log (id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Các function call trong cuộc gọi (debug tool / đánh giá)';


-- 2.4 Lỗi phát sinh trong cuộc gọi (debug "vấn đề ở đâu") ---------------------
CREATE TABLE IF NOT EXISTS call_error (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  call_log_id   BIGINT UNSIGNED NOT NULL,
  err_time      DATETIME        NULL,
  where_at      VARCHAR(128)    NULL COMMENT 'Nơi phát sinh lỗi',
  message       TEXT            NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_err_call (call_log_id),
  CONSTRAINT fk_err_call FOREIGN KEY (call_log_id)
    REFERENCES call_log (id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Lỗi phát sinh trong cuộc gọi';


-- 2.5 Timeline sự kiện kỹ thuật (debug diễn tiến cuộc gọi) --------------------
CREATE TABLE IF NOT EXISTS call_event (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  call_log_id   BIGINT UNSIGNED NOT NULL,
  ev_time       DATETIME        NULL,
  stage         VARCHAR(64)     NULL COMMENT 'call_accepted, ws_open, greeting, tool_call, error...',
  detail        TEXT            NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ev_call (call_log_id),
  CONSTRAINT fk_ev_call FOREIGN KEY (call_log_id)
    REFERENCES call_log (id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Timeline sự kiện kỹ thuật của cuộc gọi (debug)';


-- =============================================================================
--  PHẦN 3 — TICKET / KHIẾU NẠI / BÁO SỰ CỐ (bản lưu nội bộ)
--  Hiện gửi lên remote server qua POST /bao-su-co {danhba, noidung}.
--  Remote không kiểm soát được → lưu thêm bản ghi nội bộ ở đây.
-- =============================================================================
CREATE TABLE IF NOT EXISTS ticket (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ticket_code     VARCHAR(40)     NULL COMMENT 'Mã phiếu nội bộ (tự sinh), vd TK-20260606-0001',

  -- Liên kết cuộc gọi
  call_log_id     BIGINT UNSIGNED NULL COMMENT 'FK tới call_log (nếu phát sinh từ cuộc gọi)',
  call_id         VARCHAR(128)    NULL COMMENT 'OpenAI call ID (lưu thẳng để tiện đối chiếu)',

  -- Thông tin khách & nội dung
  ma_danh_bo      VARCHAR(20)     NULL,
  tel             VARCHAR(32)     NULL,
  ho_ten          VARCHAR(255)    NULL,
  loai            VARCHAR(64)     NULL COMMENT 'Loại: ro_ri, ap_luc, khieu_nai, su_co...',
  mo_ta           TEXT            NULL COMMENT 'Mô tả chi tiết do khách cung cấp',
  noi_dung_gui    TEXT            NULL COMMENT 'Nội dung thực gửi lên remote: [loai] mo_ta',

  -- Kết quả gửi remote
  remote_success  TINYINT(1)      NULL COMMENT '1 = remote nhận thành công',
  remote_message  TEXT            NULL COMMENT 'message trả về từ remote',
  remote_ref      VARCHAR(128)    NULL COMMENT 'Mã/ID phiếu do remote trả (nếu có)',
  remote_raw      JSON            NULL COMMENT 'Toàn bộ response remote (lưu phòng khi cần)',

  -- Trạng thái nội bộ
  trang_thai      ENUM('moi','da_gui','gui_loi','dang_xu_ly','hoan_thanh','huy')
                  NOT NULL DEFAULT 'moi',

  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_ticket_code (ticket_code),
  KEY idx_ticket_danhbo (ma_danh_bo),
  KEY idx_ticket_tel (tel),
  KEY idx_ticket_created (created_at),
  KEY idx_ticket_status (trang_thai),
  KEY idx_ticket_call (call_log_id),
  CONSTRAINT fk_ticket_call FOREIGN KEY (call_log_id)
    REFERENCES call_log (id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Bản lưu nội bộ của ticket/khiếu nại/báo sự cố';


-- =============================================================================
--  PHẦN 4 — VIEWS tiện cho tra cứu & đánh giá
-- =============================================================================

-- 4.1 Giá hiện hành của từng model (thay cho việc đọc openai_pricing.json) -----
CREATE OR REPLACE VIEW v_current_model_price AS
SELECT
  m.model_key,
  m.model_type,
  m.description,
  m.approx_cost_per_min_usd,
  p.currency,
  p.unit,
  p.input_price,
  p.cached_input_price,
  p.output_price,
  p.text_input_price,
  p.cached_text_input_price,
  p.text_output_price,
  p.audio_input_price,
  p.cached_audio_input_price,
  p.audio_output_price,
  p.effective_from
FROM ai_model m
JOIN ai_model_price p
  ON p.model_id = m.id AND p.is_current = 1
WHERE m.is_active = 1;

-- 4.2 Tổng quan chất lượng & chi phí cuộc gọi (cho dashboard đánh giá) --------
CREATE OR REPLACE VIEW v_call_overview AS
SELECT
  c.id,
  c.call_id,
  c.start_time,
  c.duration_sec,
  c.tel,
  c.ma_danh_bo,
  c.ho_ten,
  c.model,
  c.outcome,
  c.total_turns,
  c.tool_call_count,
  c.error_count,
  c.cost_total_usd,
  ROUND(c.cost_total_usd / NULLIF(c.duration_sec,0) * 60, 6) AS cost_usd_per_min,
  c.eval_danh_gia_cuoc_goi,
  c.manual_rating,
  c.record_path,
  c.json_file_path
FROM call_log c;


-- =============================================================================
--  PHẦN 5 — SEED DỮ LIỆU GIÁ (từ openai_pricing.json, updated 2026-06)
--  Giá per 1M tokens (USD). effective_from = 2026-06-01, is_current = 1.
-- =============================================================================

INSERT INTO ai_model (model_key, description, model_type, approx_cost_per_min_usd, is_active) VALUES
  ('gpt-4o-mini',                  'GPT-4o mini - Chat Completions (text only)',        'text',     NULL, 1),
  ('gpt-4o',                       'GPT-4o - Chat Completions (text only)',             'text',     NULL, 1),
  ('gpt-4o-2024-08-06',            'GPT-4o (2024-08-06) - Chat Completions',            'text',     NULL, 1),
  ('gpt-4o-mini-realtime-preview', 'GPT-4o mini Realtime API - voice + text',           'realtime', 0.33, 1),
  ('gpt-realtime-mini',            'gpt-realtime-mini (alias: gpt-4o-mini-realtime-preview)', 'realtime', 0.33, 1),
  ('gpt-4o-realtime-preview',      'GPT-4o Realtime API - voice + text (full model)',   'realtime', 1.63, 1),
  ('gpt-realtime-2',               'gpt-realtime-2 (alias: gpt-4o-realtime-preview)',   'realtime', 1.63, 1)
ON DUPLICATE KEY UPDATE
  description = VALUES(description),
  model_type  = VALUES(model_type),
  approx_cost_per_min_usd = VALUES(approx_cost_per_min_usd);

-- Giá cho model TEXT
INSERT INTO ai_model_price
  (model_id, input_price, cached_input_price, output_price,
   effective_from, is_current, source, note)
SELECT id, 0.150000, 0.075000, 0.600000, '2026-06-01 00:00:00', 1,
       'https://developers.openai.com/api/docs/pricing', 'updated 2026-06'
  FROM ai_model WHERE model_key = 'gpt-4o-mini';

INSERT INTO ai_model_price
  (model_id, input_price, cached_input_price, output_price,
   effective_from, is_current, source, note)
SELECT id, 2.500000, 1.250000, 10.000000, '2026-06-01 00:00:00', 1,
       'https://developers.openai.com/api/docs/pricing', 'updated 2026-06'
  FROM ai_model WHERE model_key = 'gpt-4o';

INSERT INTO ai_model_price
  (model_id, input_price, cached_input_price, output_price,
   effective_from, is_current, source, note)
SELECT id, 2.500000, 1.250000, 10.000000, '2026-06-01 00:00:00', 1,
       'https://developers.openai.com/api/docs/pricing', 'updated 2026-06'
  FROM ai_model WHERE model_key = 'gpt-4o-2024-08-06';

-- Giá cho model REALTIME (mini)
INSERT INTO ai_model_price
  (model_id, text_input_price, cached_text_input_price, text_output_price,
   audio_input_price, cached_audio_input_price, audio_output_price,
   effective_from, is_current, source, note)
SELECT id, 0.600000, 0.300000, 2.400000, 10.000000, 0.300000, 20.000000,
       '2026-06-01 00:00:00', 1,
       'https://developers.openai.com/api/docs/pricing', 'updated 2026-06'
  FROM ai_model WHERE model_key = 'gpt-4o-mini-realtime-preview';

INSERT INTO ai_model_price
  (model_id, text_input_price, cached_text_input_price, text_output_price,
   audio_input_price, cached_audio_input_price, audio_output_price,
   effective_from, is_current, source, note)
SELECT id, 0.600000, 0.300000, 2.400000, 10.000000, 0.300000, 20.000000,
       '2026-06-01 00:00:00', 1,
       'https://developers.openai.com/api/docs/pricing', 'updated 2026-06'
  FROM ai_model WHERE model_key = 'gpt-realtime-mini';

-- Giá cho model REALTIME (full)
INSERT INTO ai_model_price
  (model_id, text_input_price, cached_text_input_price, text_output_price,
   audio_input_price, cached_audio_input_price, audio_output_price,
   effective_from, is_current, source, note)
SELECT id, 4.000000, 0.400000, 24.000000, 32.000000, 0.400000, 64.000000,
       '2026-06-01 00:00:00', 1,
       'https://developers.openai.com/api/docs/pricing', 'updated 2026-06'
  FROM ai_model WHERE model_key = 'gpt-4o-realtime-preview';

INSERT INTO ai_model_price
  (model_id, text_input_price, cached_text_input_price, text_output_price,
   audio_input_price, cached_audio_input_price, audio_output_price,
   effective_from, is_current, source, note)
SELECT id, 4.000000, 0.400000, 24.000000, 32.000000, 0.400000, 64.000000,
       '2026-06-01 00:00:00', 1,
       'https://developers.openai.com/api/docs/pricing', 'updated 2026-06'
  FROM ai_model WHERE model_key = 'gpt-realtime-2';

-- =============================================================================
--  GỢI Ý: Khi ĐỔI GIÁ model (giữ lịch sử) — chạy 2 lệnh sau trong 1 transaction:
--
--    UPDATE ai_model_price
--       SET is_current = 0, effective_to = NOW()
--     WHERE model_id = (SELECT id FROM ai_model WHERE model_key = 'gpt-realtime-2')
--       AND is_current = 1;
--
--    INSERT INTO ai_model_price (model_id, text_input_price, ... , effective_from, is_current)
--    SELECT id, <giá mới> ..., NOW(), 1
--      FROM ai_model WHERE model_key = 'gpt-realtime-2';
-- =============================================================================
