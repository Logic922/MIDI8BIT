#!/usr/bin/env node
/* ==================================================================
   parse_test.js —— MIDI 解析器的独立单测（Node，零依赖）
   ------------------------------------------------------------------
   为什么存在：这个项目的播放列表来自 IndexedDB 缓存，所以"脚本语法出错"
   或"少了一行"**不会**让页面报错 —— 页面照常打开、照常显示列表，只有
   真正解析一个 MIDI 时才发现问题。历史上 5 次"文本替换丢/错一行"里有 4 次
   属于这一类。所以回归网必须是"拿真实文件跑真解析"。

   做法：index.html 是单文件零依赖（README 承诺），不能拆。于是解析器在
   文件里被一对标记圈起来（形如 [PARSE-BEGIN] ... [PARSE-END] 的
   注释行，实际写法见 index.html 里的 marker 全文）：

     [PARSE-BEGIN] 纯算法：不依赖 DOM / 音频，可独立测试
     ...
     [PARSE-END] 纯算法区段结束

   本脚本把标记之间的源码原样抽出来，用 new Function 拼成一个沙箱，
   在里面调用 parseMidi —— 不碰 DOM、不碰 AudioContext。
   解析器段内自带它需要的常量（GM_NAMES / MAX_SONG_SEC / MAX_EVENTS / txtDec），
   所以抽出来就能跑；如果哪天有人在段内写了 document.xxx，这里会立刻炸。

   跑法：  cd midi8bit && node test/parse_test.js
   ================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, "src", "02-midi.js");   // 解析器区段在源码里（产物已剥离注释，标记不再保留）
const MARK_A = '[PARSE-BEGIN]', MARK_B = '[PARSE-END]';

let pass = 0, fail = 0;
function ok(name, cond, extra){
  if(cond){ pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
}

/* ---------- 1. 抽出解析器段 ---------- */
const html = fs.readFileSync(HTML, 'utf8');
const ia = html.indexOf(MARK_A), ib = html.indexOf(MARK_B);
if(ia < 0 || ib < 0 || ib <= ia){
  console.error('FATAL: 找不到 [PARSE-BEGIN] / [PARSE-END] 标记（解析器段被改动？）');
  process.exit(1);
}
// 连同标记所在的注释块一起抽（标记本身在注释里，直接切会切出半个注释）
const src = html.slice(html.lastIndexOf('/*', ia), html.indexOf('*/', ib) + 2);
// 标记注释里为了说明"禁止什么"会把这些词写出来，所以校验前先把两侧标记注释去掉
const codeOnly = src
  .replace(/\/\* ==== \[PARSE-BEGIN\][\s\S]*?\*\//, '')
  .replace(/\/\* ==== \[PARSE-END\][\s\S]*?\*\//, '');
ok('抽到解析器段', src.length > 2000, src.length + ' 字节');
ok('段内没有 DOM 引用', !/\bdocument\b|\bwindow\b|AudioContext|canvas|indexedDB/.test(codeOnly));

/* ---------- 2. 建沙箱 ---------- */
function sandbox(code, hook){
  // hook: 可选。(all.length) 在合并事件后回调一次 —— 用来数事件数，
  //       只在沙箱里插桩，绝不改动产品文件。
  let c = code;
  if(hook){
    // ★ 插桩点用前缀匹配，不再匹配整行：产品代码给 sort 加了"同 tick 时
    //   note-off 优先"的第二排序键，整行字符串会随实现微调而失效（测试挂掉
    //   并不代表解析器坏了）。前缀仍能保证"合并事件后、排序前"这个位置存在。
    const anchor = 'all.sort((x,y) =>';
    if(c.indexOf(anchor) < 0) throw new Error('沙箱插桩点丢失：all.sort 不见了');
    c = c.replace(anchor, 'globalThis.__onAll && globalThis.__onAll(all.length);\n' + anchor);
  }
  return new Function('"use strict";\n' + c + '\n;return {parseMidi: parseMidi};')();
}

let box, boxHooked;
try {
  box = sandbox(src);
  ok('new Function 编译通过', true);
} catch(e){
  ok('new Function 编译通过', false, String(e && e.message || e));
  console.log('\nRESULT: FAIL (编译不过，后面的用例无法执行)');
  process.exit(1);
}
boxHooked = sandbox(src, true);
ok('typeof parseMidi === function', typeof box.parseMidi === 'function');

/* ---------- 3. 真实文件端到端 ---------- */
function readAb(file){
  const b = fs.readFileSync(file);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}
const CASES = [
  {file: 'test-song.mid',                    notes: 258,  events: 528,  dur: 10.8},
  {file: 'tianli.mid',                       notes: 3122, events: 7680, dur: 152.471},
  {file: 'TH06_01.赤より紅い夢 - (ZUN).mid',  notes: 1909, events: 5747, dur: 57.306}
];
console.log('\n-- 真实文件 --');
for(const c of CASES){
  const f = path.join(ROOT, c.file);
  if(!fs.existsSync(f)){ ok(c.file, false, '文件不存在'); continue; }
  let song, evs = null;
  try {
    globalThis.__onAll = n => { evs = n; };
    song = boxHooked.parseMidi(readAb(f));
  } catch(e){
    ok(c.file + ' 解析', false, String(e && e.message || e));
    continue;
  } finally { delete globalThis.__onAll; }
  ok(c.file + ' 音符数', song.notes.length === c.notes,
     'got ' + song.notes.length + ', want ' + c.notes);
  ok(c.file + ' 事件数', evs === c.events, 'got ' + evs + ', want ' + c.events);
  ok(c.file + ' 时长', Math.abs(song.duration - c.dur) < 1e-3,
     'got ' + song.duration + ', want ' + c.dur);
}

/* ---------- 4. 纯算法细节（不依赖真实文件） ---------- */
console.log('\n-- 边界与保护 --');
function tinyMidi(){
  // 一个最小可解析的 SMF：format0, 1 track, 1 个 note-on/note-off
  const bytes = [
    0x4D,0x54,0x68,0x64, 0,0,0,6, 0,0, 0,1, 0,96,          // MThd
    0x4D,0x54,0x72,0x6B, 0,0,0,8,                           // MTrk len=8
    0x00,0x90,60,100,                                       // note on
    0x60,0x80,60,64                                         // note off
  ];
  return new Uint8Array(bytes).buffer;
}
try {
  const s1 = box.parseMidi(tinyMidi());
  ok('手工最小 SMF', s1.notes.length === 1, 'notes=' + s1.notes.length);
} catch(e){ ok('手工最小 SMF', false, String(e.message)); }

const throws = (fn, re) => { try { fn(); return false; } catch(e){ return re.test(String(e.message)); } };
ok('空文件报错', throws(() => box.parseMidi(new Uint8Array(4).buffer), /太小/));
ok('非 MIDI 报错', throws(() => box.parseMidi(new Uint8Array([1,2,3,4,5,6,7,8,9,10,11,12,13,14]).buffer), /MThd/));
ok('无音符报错', throws(() => box.parseMidi(new Uint8Array([
  0x4D,0x54,0x68,0x64,0,0,0,6,0,0,0,1,0,96, 0x4D,0x54,0x72,0x6B,0,0,0,4, 0x00,0xFF,0x2F,0x00]).buffer),
  /没有解析到任何音符/));

/* ---------- 4b. 0xF0 段的状态字节处理 ----------
   回归：以前 rs 会记下 meta/sysex 的 0xFF/0xF0，于是"meta 之后的 running status
   数据字节"被当成又一条 meta，按假长度 break → 整轨剩余音符静默消失（1 音符 vs 2）。
   另一条：0xF1/0xF3 等系统消息被当成 2 个数据字节的通道消息，把后面的状态字节吃掉，
   一个合法文件被判成"轨道数据不完整"。 */
function smf(div, fmt, tracks){
  const u16 = n => [(n >> 8) & 255, n & 255];
  const u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const out = [0x4D,0x54,0x68,0x64, ...u32(6), ...u16(fmt), ...u16(tracks.length), ...u16(div)];
  for(const t of tracks){
    out.push(0x4D,0x54,0x72,0x6B, ...u32(t.length));
    // ★ 不能用 out.push(...t)：十五万元素展开成实参会撞 RangeError（测试自身的坑）
    for(let i=0;i<t.length;i++) out.push(t[i]);
  }
  return new Uint8Array(out).buffer;
}
{
  const metaThenRS = smf(480, 0, [[
    0x00,0x90,60,100,                       // note on 60（建立 running status）
    0x0A,0xFF,0x01,0x02,0x68,0x69,          // meta text
    0x0A,62,100,                            // ★ running status 继续：note on 62
    0x0A,60,0, 0x0A,62,0                    // note off ×2
  ]]);
  let n1 = -1;
  try { n1 = box.parseMidi(metaThenRS).notes.length; } catch(e){ n1 = 'ERR ' + e.message.slice(0, 30); }
  ok('meta 之后 running status 仍然有效', n1 === 2, 'notes=' + n1);

  const sysexThenRS = smf(480, 0, [[
    0x00,0x90,60,100,
    0x0A,0xF0,0x03,0x01,0x02,0xF7,          // sysex
    0x0A,62,100,
    0x0A,60,0, 0x0A,62,0
  ]]);
  let n2 = -1;
  try { n2 = box.parseMidi(sysexThenRS).notes.length; } catch(e){ n2 = 'ERR ' + e.message.slice(0, 30); }
  ok('sysex 之后 running status 仍然有效', n2 === 2, 'notes=' + n2);

  // 0xF1 只有 1 个数据字节：多吃一个就会把紧随的 0x90 当数据吃掉
  const sysCommon = smf(480, 0, [[
    0x00,0xF1,0x00, 0x00,0x90,60,100, 0x0A,0x80,60,0
  ]]);
  let n3 = -1, e3 = '';
  try { n3 = box.parseMidi(sysCommon).notes.length; } catch(e){ e3 = e.message; }
  ok('0xF1 之后能继续解析', n3 === 1 && !e3, e3 ? e3.slice(0, 40) : 'notes=' + n3);

  // EOT 之后的填充字节：以前会被当事件读，撞上假 meta 长度就截断整轨
  const eotPad = smf(480, 0, [[
    0x00,0x90,60,100, 0x0A,0x80,60,0,
    0x00,0xFF,0x2F,0x00, 0x00,0x00,0x00,0x00
  ]]);
  let n4 = -1, e4 = '';
  try { n4 = box.parseMidi(eotPad).notes.length; } catch(e){ e4 = e.message; }
  ok('EOT 之后不再解析填充字节', n4 === 1 && !e4, e4 ? e4.slice(0, 40) : 'notes=' + n4);

  // 既无 running status 又是数据字节：字节流已不同步，必须明确报错。
  // （试过"跳过这个字节"：下一个 0x90 会被 vl() 当成 delta 高位，把数据全吃掉，
  //   最后静默变成 0 音符或幻音 —— 比报错难查得多。）
  const leadPad = smf(480, 0, [[
    0x00,0x00,0x00, 0x00,0x90,60,100, 0x0A,0x80,60,0
  ]]);
  ok('无 running status 的裸数据字节 → 明确报错',
     throws(() => box.parseMidi(leadPad), /轨道数据异常/));

  // 单通道 15 万音符：以前 channels 汇总里的 Math.max.apply 会栈溢出
  const big = [0x00,0x90,60,100];
  for(let i=0;i<150000;i++){ big.push(0x00,0x90,60 + (i % 12),100, 0x01,0x80,60 + (i % 12),0); }
  let n5 = -1, e5 = '';
  try { n5 = box.parseMidi(smf(480, 0, [big])).notes.length; } catch(e){ e5 = e.message; }
  ok('单通道 15 万音符可解析（apply 上限）', n5 === 150001 && !e5,
     e5 ? e5.slice(0, 50) : 'notes=' + n5);
}

/* MAX_EVENTS 守卫（报告 #23）：把上限在沙箱里改小再喂真实文件，
   既验证"超限必须抛"，又验证"正好等于上限可以通过"。 */
function boxWithCap(cap){
  const patched = src.replace(/const MAX_EVENTS = \d+;/, 'const MAX_EVENTS = ' + cap + ';');
  if(patched === src) throw new Error('沙箱里找不到 MAX_EVENTS 定义');
  return sandbox(patched);
}
{
  const f = path.join(ROOT, 'tianli.mid');
  const ab = readAb(f);                                  // 7680 个事件
  const at = boxWithCap(7680);
  let okAt = false;
  try { at.parseMidi(readAb(f)); okAt = true; } catch(e){ okAt = false; }
  ok('事件数 == 上限时仍可解析', okAt, 'cap=7680');
  const under = boxWithCap(7679);
  ok('事件数超上限时抛错', throws(() => under.parseMidi(ab), /事件数异常/), 'cap=7679');
}

console.log('\nRESULT: ' + (fail === 0 ? 'PASS' : 'FAIL') + '  (' + pass + ' passed, ' + fail + ' failed)');
process.exit(fail === 0 ? 0 : 1);
