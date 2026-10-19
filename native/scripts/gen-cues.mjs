// Generates the six cue sounds the shell plays natively (plan v4, R2 build order 3), as small 16-bit
// mono WAV files, from the same tone parameters the web app's toneW() cues use (frequency, start,
// duration, peak, waveform; a 20 ms exponential rise and an exponential decay to the end), so the
// native cues sound like the PWA's. Deterministic: the committed files equal the generator's output
// (a test checks). No third-party assets.
//
//   node scripts/gen-cues.mjs [outDir]      default native/ios/App/App/Cues
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SAMPLE_RATE = 22050;
// The six locked cues (index.html, "vocabulary fixed 2026-05-24"): [freq, start, dur, vol, type]
export const CUES = {
  cueGo: [[523, 0, 0.13, 0.30, 'triangle'], [784, 0.12, 0.20, 0.34, 'triangle']],              // rest over -> go
  cueRelease: [[784, 0, 0.16, 0.26, 'sine'], [523, 0.16, 0.22, 0.26, 'sine']],                 // hold up -> come off
  cueStarted: [[587, 0, 0.09, 0.20, 'sine'], [740, 0.10, 0.12, 0.22, 'sine']],                 // hold timing started
  cueLogged: [[587, 0, 0.14, 0.24, 'triangle']],                                                // set saved
  cueSessionDone: [[523, 0, 0.14, 0.28, 'triangle'], [659, 0.14, 0.14, 0.30, 'triangle'], [784, 0.30, 0.26, 0.32, 'triangle']], // workout complete
  cueNoted: [[392, 0, 0.16, 0.20, 'sine']]                                                       // skip / issue logged
};

function wave(type, phase) {
  const x = phase - Math.floor(phase);                   // 0..1
  if (type === 'triangle') return 4 * Math.abs(x - 0.5) - 1;
  return Math.sin(2 * Math.PI * x);
}
// toneW's envelope: 0.0001 -> vol over 20 ms, then vol -> 0.0001 at t0 + dur, silent by t0 + dur + 20 ms
function envelope(t, dur, vol) {
  if (t < 0) return 0;
  if (t < 0.02) return 0.0001 * Math.pow(vol / 0.0001, t / 0.02);
  if (t < dur) return vol * Math.pow(0.0001 / vol, (t - 0.02) / (dur - 0.02));
  return 0;
}

export function renderCue(tones, sampleRate = SAMPLE_RATE) {
  const length = Math.max(...tones.map(([, start, dur]) => start + dur)) + 0.05;
  const n = Math.round(length * sampleRate);
  const out = new Float64Array(n);
  for (const [freq, start, dur, vol, type] of tones) {
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate - start;
      if (t < 0 || t >= dur) continue;
      out[i] += envelope(t, dur, vol) * wave(type, freq * t);
    }
  }
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, out[i]));
    pcm.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return wavFile(pcm, sampleRate);
}

export function wavFile(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function generateCues(outDir) {
  mkdirSync(outDir, { recursive: true });
  const written = {};
  for (const [name, tones] of Object.entries(CUES)) {
    const bytes = renderCue(tones);
    writeFileSync(join(outDir, name + '.wav'), bytes);
    written[name] = bytes.length;
  }
  return written;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const out = process.argv[2] ? resolve(process.argv[2]) : join(here, '..', 'ios', 'App', 'App', 'Cues');
  const written = generateCues(out);
  for (const [name, size] of Object.entries(written)) console.log(name + '.wav', size, 'bytes');
}
