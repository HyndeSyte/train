// The bundled cue sounds are generated, deterministic and committed: the files in the app target equal
// the generator's output, and each is a short 16-bit mono WAV matching the web app's cue timing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CUES, generateCues, SAMPLE_RATE } from '../scripts/gen-cues.mjs';
import { root } from './shell-harness.mjs';

const cuesDir = join(root, 'native', 'ios', 'App', 'App', 'Cues');

test('the six committed cue files equal the generator output and carry the cue durations', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'train-cues-'));
  const written = generateCues(tmp);
  assert.deepEqual(Object.keys(written).sort(), ['cueGo', 'cueLogged', 'cueNoted', 'cueRelease', 'cueSessionDone', 'cueStarted']);
  for (const [name, tones] of Object.entries(CUES)) {
    const committed = readFileSync(join(cuesDir, name + '.wav'));
    const fresh = readFileSync(join(tmp, name + '.wav'));
    assert.ok(committed.equals(fresh), name + '.wav is the generator output');
    assert.equal(committed.toString('ascii', 0, 4), 'RIFF');
    assert.equal(committed.readUInt32LE(24), SAMPLE_RATE);
    assert.equal(committed.readUInt16LE(22), 1, 'mono');
    assert.equal(committed.readUInt16LE(34), 16, '16-bit');
    const seconds = committed.readUInt32LE(40) / 2 / SAMPLE_RATE;
    const expected = Math.max(...tones.map(([, start, dur]) => start + dur)) + 0.05;
    assert.ok(Math.abs(seconds - expected) < 0.001, name + ' lasts ' + seconds + 's');
    assert.ok(committed.length < 32 * 1024, name + ' stays small');
  }
});
