/** Mutable interim text, immutable ordered sentence boundaries. No draft writes. */
export class Transcript {
  sentences = new Map();
  interim = '';
  update(event) {
    if (event.final) {
      this.sentences.set(`${event.begin}:${event.end}`, { begin: event.begin, end: event.end, text: event.text });
      this.interim = '';
    } else {
      if ([...this.sentences.values()].some(sentence => sentence.begin === event.begin)) return;
      this.interim = event.text;
    }
  }
  finalText() { return [...this.sentences.values()].sort((a, b) => a.begin - b.begin || a.end - b.end).map(item => item.text).join(''); }
  preview() { return this.finalText() + this.interim; }
}
