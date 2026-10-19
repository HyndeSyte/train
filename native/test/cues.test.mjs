// The bundled cue sounds are generated, deterministic and committed: the generator's tone table equals
// the six cue functions in index.html (parsed from their toneW calls, not hand-copied), the files in the
// app target equal the generator's output, and each is a short 16-bit mono WAV of the cue's duration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CUES, generateCues, SAMPLE_RATE } from '../scripts/gen-cues.mjs';
import { root } from './shell-harness.mjs';

const cuesDir = join(root, 'native', 'ios', 'App', 'App', 'Cues');
const NAMES = ['cueGo', 'cueRelease', 'cueStarted', 'cueLogged', 'cueSessionDone', 'cueNoted'];

// the app's cue bodies: `function cueGo(){ unlockAudio(); toneW(523,0,0.13,0.30,'triangle'); ... buzz(...); }`
function cuesFromIndexHtml() {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const out = {};
  for (const name of NAMES) {
    const m = new RegExp('function ' + name + '\\(\\)\\{([^\\n]*)\\}').exec(html);
    assert.ok(m, name + ' is defined in index.html');
    const tones = [...m[1].matchAll(/toneW\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*'(sine|triangle)'\)/g)]
      .map((x) => [Number(x[1]), Number(x[2]), Number(x[3]), Number(x[4]), x[5]]);
    assert.ok(tones.length, name + ' has toneW calls');
    out[name] = tones;
  }
  return out;
}

test('the generator’s tone table is the app’s: the six cue bodies in index.html parse to the same tones', () => {
  const fromApp = cuesFromIndexHtml();
  assert.deepEqual(Object.keys(CUES).sort(), NAMES.slice().sort());
  for (const name of NAMES) assert.deepEqual(CUES[name], fromApp[name], name + ' tones match index.html');
});

test('the six committed cue files equal the generator output and carry the cue durations', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'train-cues-'));
  const written = generateCues(tmp);
  assert.deepEqual(Object.keys(written).sort(), NAMES.slice().sort());
  const fromApp = cuesFromIndexHtml();
  for (const name of NAMES) {
    const committed = readFileSync(join(cuesDir, name + '.wav'));
    const fresh = readFileSync(join(tmp, name + '.wav'));
    assert.ok(committed.equals(fresh), name + '.wav is the generator output');
    assert.equal(committed.toString('ascii', 0, 4), 'RIFF');
    assert.equal(committed.readUInt32LE(24), SAMPLE_RATE);
    assert.equal(committed.readUInt16LE(22), 1, 'mono');
    assert.equal(committed.readUInt16LE(34), 16, '16-bit');
    const seconds = committed.readUInt32LE(40) / 2 / SAMPLE_RATE;
    const expected = Math.max(...fromApp[name].map(([, start, dur]) => start + dur)) + 0.05;
    assert.ok(Math.abs(seconds - expected) < 0.001, name + ' lasts ' + seconds + 's, the app’s cue ' + expected + 's');
    assert.ok(committed.length < 32 * 1024, name + ' stays small');
  }
});
