/**
 * audio-utils.js
 * Chuyển đổi audio PCM16 giữa Asterisk (8kHz/16kHz) và OpenAI Realtime (24kHz).
 * Dùng linear interpolation — đủ chất lượng cho voice telephony.
 */

/**
 * Resample PCM16 LE buffer từ srcRate Hz sang dstRate Hz.
 * @param {Buffer} buf - PCM16 Little Endian samples
 * @param {number} srcRate - Tần số nguồn (vd: 16000)
 * @param {number} dstRate - Tần số đích (vd: 24000)
 * @returns {Buffer}
 */
export function resamplePCM16(buf, srcRate, dstRate) {
  if (srcRate === dstRate) return buf;

  const srcSamples = buf.length / 2;
  const dstSamples = Math.round((srcSamples * dstRate) / srcRate);
  const out = Buffer.alloc(dstSamples * 2);

  for (let i = 0; i < dstSamples; i++) {
    const srcPos = (i * srcRate) / dstRate;
    const lo = Math.floor(srcPos);
    const hi = Math.min(lo + 1, srcSamples - 1);
    const frac = srcPos - lo;
    const sLo = buf.readInt16LE(lo * 2);
    const sHi = buf.readInt16LE(hi * 2);
    out.writeInt16LE(Math.round(sLo + frac * (sHi - sLo)), i * 2);
  }

  return out;
}

/**
 * Convert PCM16 Buffer → base64 string (dùng để gửi lên OpenAI).
 */
export function pcm16ToBase64(buf) {
  return buf.toString("base64");
}

/**
 * Convert base64 string → PCM16 Buffer (nhận từ OpenAI).
 */
export function base64ToPCM16(b64) {
  return Buffer.from(b64, "base64");
}
