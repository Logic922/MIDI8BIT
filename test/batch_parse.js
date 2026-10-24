#!/usr/bin/env node
/* ==================================================================
   batch_parse.js —— 拿一整个目录的真实 MIDI 跑解析器，并算出"每首占多少内存"
   ------------------------------------------------------------------
   为什么存在：
   1) 解析健壮性 —— 解析失败必须报出来，而不是静默丢一首（历史上"文件不出现"
      的困惑有一部分就是解析抛错被吞掉）。
   2) **内存占用** —— 渲染后 master 是整首 PCM（Int16 = 帧数×声道×2 字节），
      再加一份 scopeBuf（Int16，rate/4）。磁盘缓存有预算，内存没有，
      所以"渲染到第几首崩"完全由这个数字决定。这个脚本把它量出来。

   跑法：  node test/batch_parse.js <目录>
   ================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const ia = html.indexOf('[PARSE-BEGIN]'), ib = html.indexOf('[PARSE-END]');
if (ia < 0 || ib < 0) { console.error('FATAL: 找不到 PARSE 标记'); process.exit(1); }
const src = html.slice(html.lastIndexOf('/*', ia), html.indexOf('*/', ib) + 2);

const sandbox = new Function(src + '\n; return { parseMidi };');
const { parseMidi } = sandbox();

const RATE = 44100;                       // 默认渲染采样率
const dir = process.argv[2];
if (!dir) { console.error('用法: node test/batch_parse.js <目录>'); process.exit(1); }

const files = fs.readdirSync(dir).filter(f => /\.midi?$/i.test(f)).sort();
if (!files.length) { console.error('该目录没有 .mid/.midi'); process.exit(1); }

let bad = 0;
const rows = [];
for (const f of files) {
  const buf = fs.readFileSync(path.join(dir, f));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  try {
    const song = parseMidi(ab, f);
    const sec = song.duration + 0.35;
    const frames = Math.ceil(sec * RATE);
    // scopeBuf 是 Int16Array(ceil(totalSec * round(rate/4)))
    const scopeBytes = Math.ceil(sec * Math.round(RATE / 4)) * 2;
    const mono = frames * 2 + scopeBytes;          // 单声道
    const stereo = frames * 4 + scopeBytes;        // 立体声
    rows.push({ f, notes: song.notes.length, sec: song.duration,
                events: (song.events && song.events.length) || 0,
                mono, stereo });
  } catch (e) {
    bad++;
    console.log('  FAIL  ' + f + '  →  ' + (e && e.message));
  }
}

const MB = n => (n / 1048576).toFixed(1);
rows.sort((a, b) => a.stereo - b.stereo);
console.log('\n  文件'.padEnd(52) + '音符'.padStart(7) + '时长'.padStart(9) + '单声道'.padStart(9) + '立体声'.padStart(9));
console.log('  ' + '-'.repeat(84));
let tm = 0, ts = 0;
for (const r of rows) {
  tm += r.mono; ts += r.stereo;
  const nm = r.f.length > 46 ? r.f.slice(0, 44) + '..' : r.f;
  console.log('  ' + nm.padEnd(50) + String(r.notes).padStart(7) +
              (r.sec.toFixed(0) + 's').padStart(9) + (MB(r.mono) + 'M').padStart(9) + (MB(r.stereo) + 'M').padStart(9));
}
console.log('  ' + '-'.repeat(84));
console.log('  共 ' + rows.length + ' 首，解析失败 ' + bad + ' 首');
console.log('  全部常驻内存 = 单声道 ' + MB(tm) + ' MB ／ 立体声 ' + MB(ts) + ' MB');
if (rows.length) {
  const avgM = tm / rows.length, avgS = ts / rows.length;
  console.log('  平均每首   = 单声道 ' + MB(avgM) + ' MB ／ 立体声 ' + MB(avgS) + ' MB');
  for (const cap of [256, 384, 512]) {
    console.log('  内存上限 ' + cap + 'MB → 约能常驻 ' +
                Math.floor(cap * 1048576 / avgM) + ' 首（单声道）／ ' +
                Math.floor(cap * 1048576 / avgS) + ' 首（立体声）');
  }
}
process.exit(bad ? 1 : 0);
