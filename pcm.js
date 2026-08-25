// Конвертация звука для Gemini Live API: PCM 16-bit LE <-> Float32.

export function floatTo16BitPCM(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export function int16ToBase64(i16) {
  const bytes = new Uint8Array(i16.buffer, i16.byteOffset, i16.byteLength);
  let binary = '';
  const CHUNK = 0x8000; // ponytail: кусками, иначе String.fromCharCode падает на больших буферах
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToInt16(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer, 0, bytes.length >> 1);
}

export function base64ToFloat32(b64) {
  const i16 = base64ToInt16(b64);
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 0x8000;
  return f32;
}

// Моно Float32 -> WAV-байты: так звук уходит на расшифровку файлом.
export function floatToWavBytes(f32, sampleRate) {
  const i16 = floatTo16BitPCM(f32);
  const buf = new ArrayBuffer(44 + i16.length * 2);
  writeWavHeader(new DataView(buf), i16.length * 2, sampleRate);
  new Int16Array(buf, 44).set(i16);
  return new Uint8Array(buf);
}

function writeWavHeader(dv, dataSize, sampleRate) {
  const s = (off, str) => { for (let i = 0; i < str.length; i++) dv.setUint8(off + i, str.charCodeAt(i)); };
  s(0, 'RIFF');
  dv.setUint32(4, 36 + dataSize, true);
  s(8, 'WAVE');
  s(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);          // PCM
  dv.setUint16(22, 1, true);          // моно
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  s(36, 'data');
  dv.setUint32(40, dataSize, true);
}

// Моно 16-bit PCM -> WAV (44-байтовый заголовок) -> base64, для generateContent.
export function int16ToWavBase64(i16, sampleRate) {
  const dataSize = i16.length * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(buf);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  dv.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  dv.setUint32(16, 16, true);          // размер fmt-блока
  dv.setUint16(20, 1, true);           // PCM
  dv.setUint16(22, 1, true);           // моно
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true); // байт/сек
  dv.setUint16(32, 2, true);           // выравнивание блока
  dv.setUint16(34, 16, true);          // бит на сэмпл
  writeStr(36, 'data');
  dv.setUint32(40, dataSize, true);
  new Int16Array(buf, 44).set(i16);
  return int16ToBase64(new Int16Array(buf, 0, (44 + dataSize) >> 1));
}
