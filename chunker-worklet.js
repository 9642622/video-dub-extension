// Копит вход в куски по 1600 сэмплов (100 мс при 16 кГц — рекомендация Live API).
class ChunkerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(1600);
    this.pos = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.pos++] = ch[i];
        if (this.pos === this.buf.length) {
          this.port.postMessage(this.buf.slice(0));
          this.pos = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('chunker', ChunkerProcessor);
