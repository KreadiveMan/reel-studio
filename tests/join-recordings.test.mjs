import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {joinFiles} from '../scripts/lib/join-recordings.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
mkdirSync(path.join(ROOT, 'state', 'tmp'), {recursive: true});
const make = (file, args) => execFileSync('ffmpeg', ['-v', 'error', ...args, '-y', file]);
const duration = (file) => Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], {encoding: 'utf8'}).stdout);
const streams = (file) => JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file], {encoding: 'utf8'}).stdout).streams;

test('recordings from one camera are joined without re-encoding, in order, with where each starts', async () => {
  const root = mkdtempSync(path.join(ROOT, 'state', 'tmp', 'join-test-'));
  try {
    for (const [name, f] of [['IMG_1.MOV', 440], ['IMG_2.MOV', 660]]) make(path.join(root, name), ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', `sine=f=${f}`, '-t', name === 'IMG_1.MOV' ? '2' : '3', '-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1', '-c:a', 'aac', '-ar', '48000']);
    const record = await joinFiles(root, ['IMG_1.MOV', 'IMG_2.MOV'], path.join(root, 'out'));
    assert.equal(record.method, 'stream-copy');
    assert.equal(record.joined, 'out/joined.mov');
    assert.deepEqual(record.parts.map((p) => [p.source, Math.round(p.start)]), [['IMG_1.MOV', 0], ['IMG_2.MOV', 2]]);
    assert.ok(Math.abs(duration(path.join(root, 'out', 'joined.mov')) - 5) < 0.2);
    assert.equal(streams(path.join(root, 'out', 'joined.mov')).find((s) => s.codec_type === 'video').codec_name, 'hevc', 'the picture is untouched');
    assert.equal(JSON.parse(readFileSync(path.join(root, 'out', 'join.json'), 'utf8')).totalSeconds > 4.8, true);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('recordings from different cameras are re-encoded to the first one\'s picture, and a silent one gets silence', async () => {
  const root = mkdtempSync(path.join(ROOT, 'state', 'tmp', 'join-test-'));
  try {
    make(path.join(root, 'a.mp4'), ['-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30', '-f', 'lavfi', '-i', 'sine=f=440', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']);
    make(path.join(root, 'b.mov'), ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
    const record = await joinFiles(root, ['a.mp4', 'b.mov'], path.join(root, 'out'));
    assert.equal(record.method, 're-encode');
    const out = path.join(root, 'out', 'joined.mov'), s = streams(out), v = s.find((x) => x.codec_type === 'video');
    assert.deepEqual([v.width, v.height, v.r_frame_rate], [720, 1280, '30/1']);
    assert.ok(s.some((x) => x.codec_type === 'audio'));
    assert.ok(Math.abs(duration(out) - 4) < 0.2);
  } finally { rmSync(root, {recursive: true, force: true}); }
});
