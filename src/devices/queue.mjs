export class AsyncQueue {
  constructor(limit = 256) { this.limit = limit; this.items = []; this.ended = false; }
  push(value) {
    if (this.ended) return false;
    if (this.items.length >= this.limit) throw new Error('数据处理过慢，请重新录音');
    this.items.push(value); this.wake?.(); return true;
  }
  end(clear = false) { if (clear) this.items = []; this.ended = true; this.wake?.(); }
  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.items.length) yield this.items.shift();
      else if (this.ended) return;
      else await new Promise(resolve => { this.wake = resolve; });
    }
  }
}
export class PcmPackets {
  constructor(output) { this.output = output; this.tail = Buffer.alloc(0); this.bytes = 0; }
  write(buffer) {
    if (buffer.length % 2) throw new Error('鼠标音频格式无效');
    this.bytes += buffer.length;
    if (this.bytes > 19_200_000) throw new Error('单次录音最长 10 分钟');
    const bytes = Buffer.concat([this.tail, buffer]);
    let offset = 0;
    while (offset + 3200 <= bytes.length) { this.output(bytes.subarray(offset, offset + 3200).toString('base64')); offset += 3200; }
    this.tail = Buffer.from(bytes.subarray(offset));
  }
  flush() {
    if (this.tail.length) { const tail = Buffer.alloc(Math.max(82, this.tail.length)); this.tail.copy(tail); this.output(tail.toString('base64')); }
    this.tail = Buffer.alloc(0);
  }
}
