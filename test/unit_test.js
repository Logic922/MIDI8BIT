/* midi8bit 纯函数单测（零依赖，node test/unit_test.js）
   目标：给"改一处、坏另一处"最容易发生的那批纯逻辑建网 ——
   URL/缓存键/量化/限幅/弯音/活动网格/淘汰顺序。
   从 index.html 抽函数（测的就是交付产物），不是从 src 抽。 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const code = (html.match(/<script[^>]*>([\s\S]*?)<\/script>/) || [])[1];
if (!code) { console.error("FATAL: 找不到内联脚本"); process.exit(1); }

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  PASS  " + name + (extra ? "  " + extra : "")); }
  else { fail++; console.log("  FAIL  " + name + (extra ? "  " + extra : "")); }
};

/* ---------- 从脚本里切一个平衡括号块 ---------- */
function matchBalanced(src, i) {
  const open = src[i], close = { "{": "}", "[": "]", "(": ")" }[open];
  if (!close) throw new Error("not a delimiter at " + i);
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      for (i++; i < src.length; i++) {
        if (src[i] === "\\") { i++; continue; }
        if (src[i] === q) break;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); continue; }
    if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i) + 1; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return i;
  }
  throw new Error("unbalanced");
}
function grabConst(name) {
  // 允许等号两边有多余空格（CONFIG 区里有对齐写法：`const TONE_LP   = 10000;`）
  const re = new RegExp("const\\s+" + name + "\\s*=");
  const m = re.exec(code);
  if (!m) throw new Error("找不到常量 " + name);
  const at = m.index;
  let i = m.index + m[0].length;
  while (/\s/.test(code[i])) i++;
  if ("{[(".includes(code[i])) {
    const end = matchBalanced(code, i);
    return code.slice(at, code.indexOf(";", end) + 1);
  }
  const semi = code.indexOf(";", i);
  return code.slice(at, semi + 1);
}
function grabFn(name) {
  const at = code.indexOf("function " + name + "(");
  if (at < 0) throw new Error("找不到函数 " + name);
  const pStart = code.indexOf("(", at);
  const pEnd = matchBalanced(code, pStart);
  const bStart = code.indexOf("{", pEnd);
  const bEnd = matchBalanced(code, bStart);
  return code.slice(at, bEnd + 1);
}

const wantConsts = ["RENDER_RATE", "TONE_LP", "HP_HZ", "SHELF_LOW_HZ",
  "SHELF_HI_HZ", "MIX_VER", "LIM_KNEE", "LIM_CEIL", "LIM_RATIO",
  "LIM_MAKEUP", "GM_WAVE", "GM_SHAPE", "SHAPES", "CACHE_BYTES", "CACHE_LOW",
  "LUFS_ABS_GATE"];   // 同一行还声明了 LUFS_REL_GATE，由它一并带出
// 注：SHELF_LOW_DB / SHELF_HI_DB 与 *_HZ 在同一条 const 声明里（逗号分隔），
// 由 grabConst("SHELF_LOW_HZ") 一次性带出，故不单独列出（否则重复声明）。
const wantFns = ["quickHash", "masterKey", "makeCrushCurve", "crushAt", "limitAt",
  "wavHeaderBlob", "bendPointsFor", "buildActivityGrid", "tailLevel", "autoWave",
  "autoShape", "evictCache", "heldUrlsOf", "retireUrl", "sweepZombies",
  "dropVariants", "releaseEntryElements", "intentOf", "intentSet",
  "intentCancel", "intentTakePlay", "intentPeekSeek", "intentTakeSeek",
  "on", "emit", "applyReadyFromIndex",
  // 2026-10-24 新增：干声挂载 / 内存释放 / 响度门限
  "attachMaster", "sweepMasters", "gatedLoudness", "lufsOfEnergy"];

const src = [
  // 沙箱里补上这些模块级状态/桩：被测函数会引用它们
  "const Bus = Object.create(null);\nconst IDB_KEYS = new Set();\nfunction checkCacheInvariant(){}\nfunction updatePlaylistBadges(){}",
  ...wantConsts.map(grabConst),
  ...wantFns.map(grabFn),
  `return {${wantFns.join(",")}, ${wantConsts.join(",")}, IDB_KEYS};`
].join("\n");

const App = { renderRate: 44100, songs: [], cur: 0 };
let IDB_IDX = [];
const curEntry = () => (App.cur >= 0 ? App.songs[App.cur] : null);
/* 假的 <audio> 元素与 URL 注册表：只验证"谁被 revoke、什么时候"，
   不碰真实媒体。元素要有 dataset 和 pause/removeAttribute/load。 */
const mkEl = () => ({ dataset: {}, paused: true, muted: false,
  pause() {}, removeAttribute() {}, load() {} });
const AUDIO = [mkEl(), mkEl()];
const revokes = [];
const FakeURL = {
  createObjectURL: () => "blob:new",
  revokeObjectURL: u => revokes.push(u)
};
const AudioHooks = { held: null, sweep: null, release: null };
const box = new Function("App", "IDB_IDX", "curEntry", "AUDIO", "URL", "AudioHooks", '"use strict";\n' + src)(
  App, IDB_IDX, curEntry, AUDIO, FakeURL, AudioHooks
);
// 和产品里一样：播放层把 URL 持有查询注册进来
AudioHooks.held = box.heldUrlsOf;
AudioHooks.sweep = box.sweepZombies;
AudioHooks.release = box.releaseEntryElements;

const mkSong = (dur, notes, chans) => ({
  duration: dur, noteCount: notes, srcHash: "h1",
  channels: (chans || [0]).map(ch => ({ ch })),
  wave: {}, mute: {}, notes: []
});
const mkEntry = (name, dur, notes, chans) => ({
  name, song: mkSong(dur, notes, chans)
});

console.log("-- 缓存键与指纹 --");
ok("quickHash 稳定", box.quickHash(new Uint8Array([1, 2, 3]).buffer) ===
  box.quickHash(new Uint8Array([1, 2, 3]).buffer));
ok("quickHash 区分内容", box.quickHash(new Uint8Array([1, 2, 3]).buffer) !==
  box.quickHash(new Uint8Array([1, 2, 4]).buffer));
{
  const a = new Uint8Array(9000).fill(7), b = new Uint8Array(9000).fill(7);
  b[8500] = 9;   // 第 8KB 之后，不应影响指纹
  ok("quickHash 只看前 8KB", box.quickHash(a.buffer) === box.quickHash(b.buffer));
}
{
  const e = mkEntry("a.mid", 10, 100, [0]);
  const k0 = box.masterKey(e);
  ok("masterKey 稳定", k0 === box.masterKey(e));
  e.song.wave[0] = "pulse25";
  const k1 = box.masterKey(e);
  e.song.mute[0] = true;
  const k2 = box.masterKey(e);
  e.song.srcHash = "h2";
  const k3 = box.masterKey(e);
  ok("波形/静音/内容都进键", k0 !== k1 && k1 !== k2 && k2 !== k3);
}

console.log("\n-- 位深量化 --");
{
  const c = box.makeCrushCurve(6);
  ok("曲线长度 2048", c.length === 2048);
  const levels = new Set(Array.from(c).map(v => Math.round(v * 1e6)));
  ok("6bit 台阶数合理", levels.size >= 32 && levels.size <= 66, "levels=" + levels.size);
  ok("端点夹紧", box.crushAt(c, -2) === c[0] && box.crushAt(c, 2) === c[c.length - 1]);
  ok("中点过零", Math.abs(box.crushAt(c, 0)) < 1e-6);
}

console.log("\n-- 母带限幅 --");
{
  let mono = true, cap = true;
  let prev = -Infinity;
  for (let x = -1; x <= 1; x += 0.001) {
    const y = box.limitAt(x);
    if (y < prev) mono = false;
    prev = y;
    if (Math.abs(y) > box.LIM_CEIL + 1e-9) cap = false;
    if (Math.abs(x) <= box.LIM_KNEE && Math.abs(y - x) > 1e-9) mono = false;
  }
  ok("单调不减且拐点以下透明", mono);
  ok("输出不超过天花板", cap);
  ok("补偿增益让峰值回到天花板", Math.abs(box.limitAt(box.LIM_CEIL) * box.LIM_MAKEUP - box.LIM_CEIL) < 1e-9);
}

console.log("\n-- WAV 头 --");
(async () => {
  const blob = box.wavHeaderBlob(1000, 2, 44100);
  ok("头长度 44 字节", blob.size === 44, "size=" + blob.size);
  const dv = new DataView(await blob.arrayBuffer());
  const tag = o => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  ok("RIFF/WAVE/data 标记", tag(0) === "RIFF" && tag(8) === "WAVE" && tag(36) === "data");
  ok("声道/采样率/位宽", dv.getUint16(22, true) === 2 && dv.getUint32(24, true) === 44100 && dv.getUint16(34, true) === 16);
  ok("字节数一致", dv.getUint32(40, true) === 1000 * 2 * 2 && dv.getUint32(4, true) === 36 + 4000);

  console.log("\n-- 弯音时间线 --");
  {
    const song = { bends: { 0: [{ t: 1, v: 0.5 }, { t: 3, v: -0.25 }] } };
    ok("无事件返回 null", box.bendPointsFor(song, 1, 0, 2) === null);
    const b = box.bendPointsFor(song, 0, 2, 2);   // 起点在第一个事件之后
    ok("起点取样 + 区间内点", b && b[0].dt === 0 && b[0].v === 0.5 && b.length === 2 && b[1].v === -0.25);
    const early = box.bendPointsFor(song, 0, 0, 1.5); // 起点早于所有事件
    ok("起点早于首事件时补 0", early && early[0].v === 0 && early[1].dt === 1);
    ok("只有一个点等于没有", box.bendPointsFor({ bends: { 0: [{ t: 5, v: 1 }] } }, 0, 0, 2) === null);
  }

  console.log("\n-- 声道活动网格 --");
  {
    const song = { duration: 2, mute: {}, notes: [
      { ch: 0, start: 0, dur: 0.5 }, { ch: 3, start: 0.5, dur: 0.3 }, { ch: 1, start: 1.9, dur: 1 }] };
    song.mute[1] = true;
    const g = box.buildActivityGrid(song);
    ok("格子数 = 时长×20 + 2", g.n === Math.ceil(2 * 20) + 2, "n=" + g.n);
    ok("ch0 在第 0 格", (g.grid[0] & 1) === 1);
    ok("ch3 在第 12 格", (g.grid[12] & (1 << 3)) !== 0);
    ok("静音声道不入网格", (g.grid[39] & (1 << 1)) === 0);
    ok("越界夹紧（不抛）", g.grid[g.n - 1] === 0);
  }

  console.log("\n-- 音色映射 --");
  {
    let all = true, low = true;
    for (let p = 0; p < 128; p++) {
      if (!box.GM_WAVE.includes(box.autoWave(p))) all = false;
      if (!box.GM_SHAPE.includes(box.autoShape(p))) all = false;
    }
    ok("128 个音色都能映射", all);
    ok("越界回退到 0 号", box.autoWave(-1) === box.autoWave(0) && box.autoShape(999) === box.autoShape(0));
    ok("低音余音更足", box.tailLevel(box.SHAPES.perc, 36) > box.tailLevel(box.SHAPES.perc, 84));
    ok("余音不超过 0.92", box.tailLevel(box.SHAPES.bell, 24) <= 0.92);
  }

  console.log("\n-- 缓存淘汰 --");
  {
    const MB = 1024 * 1024;
    const songs = [
      mkEntry("A", 100, 10), mkEntry("B", 100, 10), mkEntry("C", 100, 10), mkEntry("D", 100, 10)
    ];
    App.songs = songs; App.cur = 2;                       // 当前 = C
    // ★ 必须原地改：evictCache 拿到的是 IDB_IDX 的**引用**，重新赋值不会影响沙箱内。
    IDB_IDX.splice(0, IDB_IDX.length,
      { key: box.masterKey(songs[0]), t: 1, b: 400 * MB },   // 之前，最旧
      { key: box.masterKey(songs[1]), t: 2, b: 400 * MB },   // 之前
      { key: box.masterKey(songs[2]), t: 3, b: 400 * MB },   // 当前
      { key: box.masterKey(songs[3]), t: 4, b: 400 * MB },   // 之后
      { key: "ghost-no-b", t: 0 }                            // 字节未知
    );
    const drop = box.evictCache();
    const keys = drop.map(x => x.key);
    ok("当前曲目豁免", !keys.includes(box.masterKey(songs[2])));
    ok("字节数未知的先清", keys.includes("ghost-no-b"));
    ok("至少保留一条（不会删空）", drop.length < IDB_IDX.length);
    ok("先清当前位置之前的", keys.includes(box.masterKey(songs[0])) && keys.includes(box.masterKey(songs[1])));
    ok("不碰当前位置之后的（还有余量时）", !keys.includes(box.masterKey(songs[3])));
  }

  console.log("\n-- URL 生命周期 --");
  {
    const e = mkEntry("x.mid", 10, 10, [0]);
    AUDIO[0].dataset.for = "u1";
    e.variants = { "6": "u1" }; e.variantBlobs = { "6": {} }; e.audioUrl = "u1";
    box.dropVariants(e);
    ok("被持有的移出 variants", Object.keys(e.variants).length === 0);
    ok("被持有的进 zombie", (e.zombie || []).indexOf("u1") >= 0);
    ok("被持有的不立即 revoke", revokes.indexOf("u1") < 0);
    delete AUDIO[0].dataset.for;
    box.sweepZombies(e);
    ok("解除持有后回收", revokes.indexOf("u1") >= 0 && !e.zombie);

    e.variants = { "4": "u2" }; e.variantBlobs = { "4": {} };
    box.dropVariants(e);
    ok("未被持有立即回收", revokes.indexOf("u2") >= 0);

    AUDIO[1].dataset.for = "u3"; e.audioUrl = "u3"; e.variants = { "8": "u3" };
    box.releaseEntryElements(e);
    ok("删除曲目时释放空闲元素", AUDIO[1].dataset.for === undefined && !AUDIO[1].getAttribute);
  }

  console.log("\n-- 解析器 fuzz --");
  {
    // 解析器区段从源码读：产物 index.html 已剥离注释，[PARSE-*] 标记不在产物里
    const midiSrc = fs.readFileSync(path.join(ROOT, "src", "02-midi.js"), "utf8");
    const ia = midiSrc.indexOf("[PARSE-BEGIN]"), ib = midiSrc.indexOf("[PARSE-END]");
    const psrc = midiSrc.slice(midiSrc.lastIndexOf("/*", ia), midiSrc.indexOf("*/", ib) + 2);
    const parseMidi = new Function('"use strict";\n' + psrc + "\n;return parseMidi;")();
    let bad = 0, threw = 0;
    let seed = 20261024;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let n = 0; n < 300; n++) {
      const len = (rnd() * 200) | 0;
      const u8 = new Uint8Array(len);
      for (let i = 0; i < len; i++) u8[i] = (rnd() * 256) | 0;
      try { parseMidi(u8.buffer); }
      catch (err) {
        threw++;
        if (!(err instanceof Error) || !err.message) bad++;
      }
    }
    ok("随机字节只抛明确 Error", bad === 0, `threw=${threw}/300`);
    const real = fs.readFileSync(path.join(ROOT, "test-song.mid"));
    const cut = real.buffer.slice(real.byteOffset, real.byteOffset + 60);
    let msg = "";
    try { parseMidi(cut); } catch (err) { msg = String(err && err.message || ""); }
    ok("截断文件给出可读错误", !!msg && !/Out of bounds/i.test(msg), msg.slice(0, 30));
  }

  console.log("\n-- 待执行意图（intent）--");
  {
    const e = {};
    box.intentSet(e, { play: true, seekAt: 12.5 });
    ok("设置后可见", box.intentPeekSeek(e) === 12.5 && box.intentTakePlay(e) === true);
    ok("起播意图只能消费一次", box.intentTakePlay(e) === false);
    ok("跳转意图消费后清空", box.intentTakeSeek(e) === 12.5 && box.intentPeekSeek(e) === null);
    box.intentSet(e, { seekAt: 0 });                 // 0 是合法值，不能被当成"没有"
    ok("0 秒跳转不丢", box.intentTakeSeek(e) === 0);
    box.intentSet(e, { play: true, seekAt: 7 });
    box.intentCancel(e, "play");
    ok("只撤起播不动跳转", e.intent.play === false && box.intentPeekSeek(e) === 7);
    box.intentCancel(e);
    ok("全撤", e.intent.play === false && e.intent.seekAt === null);
    box.intentSet(e, { play: true }); box.intentSet(e, { play: false });
    ok("覆盖语义（selectSong 用）", e.intent.play === false);
    ok("空 entry 不抛", box.intentTakePlay(null) === false && box.intentTakeSeek(undefined) === null);
  }

  console.log("\n-- 事件层 --");
  {
    let hits = 0, order = [];
    box.on("t", () => { hits++; order.push(1); });
    box.on("t", () => { order.push(2); });
    box.emit("t");
    ok("同步触发全部订阅", hits === 1 && order.join(",") === "1,2");
    let after = 0;
    box.on("t", () => { throw new Error("boom"); });
    box.on("t", () => { after++; });
    const w = console.warn; console.warn = () => {};
    box.emit("t");
    console.warn = w;
    ok("单个订阅抛错不影响其他", after === 1);
    ok("无订阅的事件不报错", (() => { try { box.emit("nobody"); return true; } catch(e) { return false; } })());
  }

  console.log("\n-- 缓存淘汰边界 --");
  {
    const MB = 1024 * 1024;
    const OLD = box.CACHE_LOW;
    // 恰好等于预算：不淘汰
    App.songs = [mkEntry("A", 10, 10, [0])]; App.cur = 0;
    IDB_IDX.splice(0, IDB_IDX.length,
      { key: box.masterKey(App.songs[0]), t: 1, b: OLD });
    ok("恰好等于预算不淘汰", box.evictCache().length === 0);
    // 单条超预算：仍至少留一条
    App.cur = -1;
    IDB_IDX.splice(0, IDB_IDX.length, { key: "huge", t: 1, b: OLD * 3 });
    ok("单条超预算也留一条", box.evictCache().length === 0);
    // 全部字节未知：先清未知（既有语义）
    IDB_IDX.splice(0, IDB_IDX.length, { key: "u1", t: 1 }, { key: "u2", t: 2 });
    ok("未知字节的条目会被清", box.evictCache().length === 2);
  }

  console.log("\n-- 绿灯判据 --");
  {
    const e = mkEntry("r.mid", 10, 10, [0]);
    App.songs = [e]; App.cur = 0;
    box.IDB_KEYS.clear(); box.IDB_KEYS.add(box.masterKey(e));
    box.applyReadyFromIndex();
    ok("磁盘有 → 绿灯", e.ready === true);
    e.badKey = box.masterKey(e);
    box.applyReadyFromIndex();
    ok("黑名单 → 绿灯灭", e.ready === false);
    e.badKey = "other-key";
    box.applyReadyFromIndex();
    ok("别的坏键不影响这盏灯", e.ready === true);
    box.IDB_KEYS.clear();
    box.applyReadyFromIndex();
    ok("索引没有 → 绿灯灭", e.ready === false);
  }

  console.log("\n-- 钩子缺失时保守 --");
  {
    const e = mkEntry("z.mid", 10, 10, [0]);
    const savedHeld = AudioHooks.held, savedSweep = AudioHooks.sweep;
    AudioHooks.held = null; AudioHooks.sweep = null;
    e.variants = { "6": "u9" }; e.variantBlobs = { "6": {} };
    revokes.length = 0;
    box.dropVariants(e);
    ok("钩子未注册时不 revoke", revokes.indexOf("u9") < 0 && (e.zombie || []).indexOf("u9") >= 0);
    AudioHooks.held = savedHeld; AudioHooks.sweep = savedSweep;
  }

  console.log("\n-- 干声挂载：键必须由调用方定死 --");
  {
    const e = mkEntry("k.mid", 10, 100, [0]);
    const genKey = box.masterKey(e) + "|GEN";
    box.attachMaster(e, {pcm: null, frames: 100, nch: 2, rate: 44100, bytes: 400}, false, genKey);
    ok("attachMaster 采用传入的键", e.masterKey === genKey, e.masterKey);
    e.song.wave[0] = "saw";                       // 模拟渲染途中用户改了波形
    ok("设置改过之后现算的键确实不同", box.masterKey(e) !== genKey);
    ok("旧键没有被现算覆盖", e.masterKey === genKey);
  }

  console.log("\n-- 内存释放：写盘未确认的 PCM 不能丢 --");
  {
    const savedCur = App.cur, savedSongs = App.songs;
    App.songs = [mkEntry("m0.mid", 10, 10, [0]), mkEntry("m1.mid", 10, 10, [0]),
                 mkEntry("m2.mid", 10, 10, [0])];
    App.cur = 0;
    App.songs.forEach(e => { e.master = { pcm: null }; });
    App.songs[1].storing = true;
    box.sweepMasters();
    ok("storing（写盘未确认）的曲目保留 PCM", !!App.songs[1].master);
    ok("其它非当前曲目已释放", !App.songs[2].master);
    ok("当前曲目豁免", !!App.songs[0].master);
    App.songs[1].storing = false;
    App.songs = savedSongs; App.cur = savedCur;
  }

  console.log("\n-- 响度门限（BS.1770-4 双门限） --");
  {
    const zFor = lufs => Math.pow(10, (lufs + 0.691) / 10);
    ok("全静音 → 不归一（null）", box.gatedLoudness([0, 0, 0, 0]) === null);
    ok("空数组 → null", box.gatedLoudness([]) === null);
    const steady = box.gatedLoudness([zFor(-20), zFor(-20), zFor(-20)]);
    ok("稳态 -20 LUFS 测得 -20", Math.abs(steady + 20) < 0.01, String(steady));
    const gated = box.gatedLoudness([zFor(-20), zFor(-20), zFor(-40)]);
    ok("相对门限剔除 -40 LUFS 的弱块", Math.abs(gated + 20) < 0.6, String(gated));
    ok("绝对门限剔除 -75 LUFS 的块",
       box.gatedLoudness([zFor(-20), zFor(-75)]) !== null &&
       Math.abs(box.gatedLoudness([zFor(-20), zFor(-75)]) + 20) < 0.01);
  }

  console.log("\nRESULT: " + (fail ? "FAIL" : "PASS") + "  (" + pass + " passed, " + fail + " failed)");
  process.exit(fail ? 1 : 0);
})();
