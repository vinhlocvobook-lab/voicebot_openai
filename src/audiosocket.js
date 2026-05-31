/**
 * audiosocket.js
 * Xử lý giao thức Asterisk AudioSocket (TCP).
 *
 * Giao thức AudioSocket:
 *   - Mỗi message gồm: 1 byte type | 2 bytes length (BE) | N bytes payload
 *   - Type 0x00: Hangup (payload rỗng)
 *   - Type 0x01: UUID của call (payload = 16 bytes UUID)
 *   - Type 0x10: Audio frame (payload = PCM16 audio)
 *
 * Asterisk dialplan:
 *   AudioSocket(<uuid>,<host>:<port>)
 */

import net from "net";
import { EventEmitter } from "events";

const MSG_TYPE = {
  HANGUP: 0x00,
  UUID: 0x01,
  AUDIO: 0x10,
};

const HEADER_SIZE = 3; // 1 byte type + 2 bytes length

export class AudioSocketSession extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.uuid = null;
    this._buf = Buffer.alloc(0);

    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("close", () => this.emit("hangup"));
    socket.on("error", (err) => this.emit("error", err));
  }

  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);

    while (this._buf.length >= HEADER_SIZE) {
      const type = this._buf[0];
      const len = this._buf.readUInt16BE(1);

      if (this._buf.length < HEADER_SIZE + len) break; // chờ thêm data

      const payload = this._buf.slice(HEADER_SIZE, HEADER_SIZE + len);
      this._buf = this._buf.slice(HEADER_SIZE + len);

      switch (type) {
        case MSG_TYPE.UUID:
          // 16 bytes UUID dạng binary → hex string
          this.uuid = [
            payload.slice(0, 4).toString("hex"),
            payload.slice(4, 6).toString("hex"),
            payload.slice(6, 8).toString("hex"),
            payload.slice(8, 10).toString("hex"),
            payload.slice(10, 16).toString("hex"),
          ].join("-");
          this.emit("uuid", this.uuid);
          break;

        case MSG_TYPE.AUDIO:
          if (payload.length > 0) {
            this.emit("audio", payload);
          }
          break;

        case MSG_TYPE.HANGUP:
          this.emit("hangup");
          this.socket.destroy();
          break;

        default:
          // Bỏ qua các type không biết
          break;
      }
    }
  }

  /**
   * Gửi audio PCM16 xuống Asterisk.
   * @param {Buffer} audioBuf - PCM16 buffer
   */
  sendAudio(audioBuf) {
    if (!this.socket.writable) return;
    const header = Buffer.alloc(HEADER_SIZE);
    header[0] = MSG_TYPE.AUDIO;
    header.writeUInt16BE(audioBuf.length, 1);
    this.socket.write(Buffer.concat([header, audioBuf]));
  }

  /**
   * Đóng kết nối (khi cần chuyển tổng đài viên hoặc kết thúc).
   * Asterisk sẽ tiếp tục dialplan ở priority tiếp theo.
   */
  hangup() {
    if (!this.socket.writable) return;
    const buf = Buffer.alloc(HEADER_SIZE);
    buf[0] = MSG_TYPE.HANGUP;
    buf.writeUInt16BE(0, 1);
    this.socket.write(buf);
    this.socket.destroy();
  }
}

/**
 * Tạo TCP server lắng nghe kết nối từ Asterisk AudioSocket.
 * @param {object} options - { host, port }
 * @param {function} onSession - callback(session: AudioSocketSession)
 * @returns {net.Server}
 */
export function createAudioSocketServer({ host, port }, onSession) {
  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    const session = new AudioSocketSession(socket);
    onSession(session);
  });

  server.listen(port, host, () => {
    console.log(`[AudioSocket] Listening on ${host}:${port}`);
  });

  return server;
}
