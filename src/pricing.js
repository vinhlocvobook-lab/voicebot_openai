/**
 * pricing.js
 * Tra cứu bảng giá OpenAI và tính chi phí từ token usage.
 *
 * Nguồn giá: openai_pricing.json (cùng thư mục gốc với server.js)
 * Tài liệu:  https://developers.openai.com/api/docs/pricing
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRICING_FILE = path.join(__dirname, "..", "openai_pricing.json");

let _pricing = null;

function _getPricing() {
  if (!_pricing) {
    try {
      _pricing = JSON.parse(readFileSync(PRICING_FILE, "utf-8"));
    } catch (e) {
      _pricing = { models: {} };
    }
  }
  return _pricing;
}

/**
 * Tính chi phí từ usage object của OpenAI Realtime API (response.done event).
 *
 * Cấu trúc usage mong đợi:
 * {
 *   input_tokens, output_tokens,
 *   input_token_details:  { text_tokens, audio_tokens, cached_text_tokens, cached_audio_tokens },
 *   output_token_details: { text_tokens, audio_tokens }
 * }
 *
 * @param {object} usage     - usage object tổng hợp (đã cộng dồn từ nhiều response.done)
 * @param {string} modelName - tên model, vd: "gpt-realtime-mini"
 * @returns {{ cost_usd: number, breakdown: object } | null}
 */
export function calcRealtimeCost(usage, modelName) {
  const pricing = _getPricing();
  const mp = pricing.models?.[modelName];
  if (!mp || mp.type !== "realtime") return null;

  const d   = usage?.input_token_details  ?? {};
  const od  = usage?.output_token_details ?? {};

  const textIn            = d.text_tokens           ?? 0;
  const audioIn           = d.audio_tokens          ?? 0;
  const cachedTextIn      = d.cached_text_tokens    ?? 0;
  const cachedAudioIn     = d.cached_audio_tokens   ?? 0;
  const textOut           = od.text_tokens          ?? 0;
  const audioOut          = od.audio_tokens         ?? 0;

  // Chỉ tính phần không được cache (cached đã có giá riêng thấp hơn)
  const billTextIn        = textIn  - cachedTextIn;
  const billAudioIn       = audioIn - cachedAudioIn;

  const M = 1_000_000;
  const costs = {
    text_input:         billTextIn    * (mp.text_input        ?? 0) / M,
    audio_input:        billAudioIn   * (mp.audio_input       ?? 0) / M,
    cached_text_input:  cachedTextIn  * (mp.cached_text_input ?? 0) / M,
    cached_audio_input: cachedAudioIn * (mp.cached_audio_input?? 0) / M,
    text_output:        textOut       * (mp.text_output       ?? 0) / M,
    audio_output:       audioOut      * (mp.audio_output      ?? 0) / M,
  };

  const totalCost = Object.values(costs).reduce((a, b) => a + b, 0);

  return {
    cost_usd: +totalCost.toFixed(6),
    breakdown: {
      text_input:         { tokens: billTextIn,    unit_price: mp.text_input,         cost: +costs.text_input.toFixed(6) },
      audio_input:        { tokens: billAudioIn,   unit_price: mp.audio_input,        cost: +costs.audio_input.toFixed(6) },
      cached_text_input:  { tokens: cachedTextIn,  unit_price: mp.cached_text_input ?? 0, cost: +costs.cached_text_input.toFixed(6) },
      cached_audio_input: { tokens: cachedAudioIn, unit_price: mp.cached_audio_input ?? 0, cost: +costs.cached_audio_input.toFixed(6) },
      text_output:        { tokens: textOut,       unit_price: mp.text_output,        cost: +costs.text_output.toFixed(6) },
      audio_output:       { tokens: audioOut,      unit_price: mp.audio_output,       cost: +costs.audio_output.toFixed(6) },
    },
  };
}

/**
 * Tính chi phí từ usage của OpenAI Chat Completions API.
 *
 * Cấu trúc usage mong đợi:
 * { prompt_tokens, completion_tokens, prompt_tokens_details?: { cached_tokens } }
 *
 * @param {object} usage     - usage từ chat completions response
 * @param {string} modelName - tên model, vd: "gpt-4o-mini"
 * @returns {{ cost_usd: number, breakdown: object } | null}
 */
export function calcChatCost(usage, modelName) {
  const pricing = _getPricing();
  const mp = pricing.models?.[modelName];
  if (!mp || mp.type !== "text") return null;

  const promptTokens      = usage?.prompt_tokens     ?? 0;
  const completionTokens  = usage?.completion_tokens ?? 0;
  const cachedTokens      = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const billableInput     = promptTokens - cachedTokens;

  const M = 1_000_000;
  const costs = {
    input:        billableInput    * (mp.input        ?? 0) / M,
    cached_input: cachedTokens     * (mp.cached_input ?? 0) / M,
    output:       completionTokens * (mp.output       ?? 0) / M,
  };

  const totalCost = Object.values(costs).reduce((a, b) => a + b, 0);

  return {
    cost_usd: +totalCost.toFixed(6),
    breakdown: {
      input:        { tokens: billableInput,    unit_price: mp.input,               cost: +costs.input.toFixed(6) },
      cached_input: { tokens: cachedTokens,     unit_price: mp.cached_input ?? 0,   cost: +costs.cached_input.toFixed(6) },
      output:       { tokens: completionTokens, unit_price: mp.output,              cost: +costs.output.toFixed(6) },
    },
  };
}

/**
 * Tính chi phí từ usage của model transcription (gpt-4o-mini-transcribe, gpt-4o-transcribe).
 *
 * Usage đến từ event: conversation.item.input_audio_transcription.completed
 * Cấu trúc:
 * {
 *   input_tokens,
 *   input_token_details:  { audio_tokens, text_tokens },
 *   output_tokens,
 *   output_token_details: { text_tokens, audio_tokens }
 * }
 *
 * @param {object} usage     - usage tổng hợp (đã cộng dồn từ nhiều transcription events)
 * @param {string} modelName - vd: "gpt-4o-mini-transcribe"
 * @returns {{ cost_usd: number, breakdown: object } | null}
 */
export function calcTranscribeCost(usage, modelName) {
  const pricing = _getPricing();
  const mp = pricing.models?.[modelName];
  if (!mp || mp.type !== "transcribe") return null;

  const d  = usage?.input_token_details  ?? {};
  const od = usage?.output_token_details ?? {};

  // Input: chủ yếu là audio tokens (tiếng khách nói)
  const audioIn = d.audio_tokens ?? usage?.input_tokens ?? 0;
  // Output: text tokens (transcript text)
  const textOut = od.text_tokens ?? usage?.output_tokens ?? 0;

  const M = 1_000_000;
  const costs = {
    audio_input:  audioIn * (mp.audio_input  ?? 0) / M,
    text_output:  textOut * (mp.text_output  ?? 0) / M,
  };

  const totalCost = costs.audio_input + costs.text_output;

  return {
    cost_usd: +totalCost.toFixed(6),
    breakdown: {
      audio_input: { tokens: audioIn, unit_price: mp.audio_input ?? 0, cost: +costs.audio_input.toFixed(6) },
      text_output: { tokens: textOut, unit_price: mp.text_output ?? 0, cost: +costs.text_output.toFixed(6) },
    },
  };
}

/** Lấy toàn bộ bảng giá (để hiển thị/debug). */
export function getPricingTable() {
  return _getPricing();
}
