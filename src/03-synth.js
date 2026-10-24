/* ==================================================================
   2. 芯片合成引擎 —— 波形 / 包络 / 鼓机
   NES 风格脉宽波 / 三角 / 锯齿 / 噪声 + 简化鼓机 + 位深量化
   ------------------------------------------------------------------
   本区段只放**逻辑与算法**：可调常量（低通/搁架/高通/限幅/响度归一/
   各波形音量…）已全部集中到文件顶部的 CONFIG 区，调参去那儿找。
   ================================================================== */
/* 面板里的紧凑显示名 */

function biquadHS(rate, f0, Q, gainDb){
  const A = Math.pow(10, gainDb/40), w0 = 2*Math.PI*f0/rate, cs = Math.cos(w0), sn = Math.sin(w0);
  const alpha = sn/(2*Q), sq = 2*Math.sqrt(A)*alpha;
  const b0 =    A*((A+1)+(A-1)*cs+sq), b1 = -2*A*((A-1)+(A+1)*cs), b2 =    A*((A+1)+(A-1)*cs-sq);
  const a0 =       (A+1)-(A-1)*cs+sq,  a1 =    2*((A-1)-(A+1)*cs),  a2 =       (A+1)-(A-1)*cs-sq;
  return {b0:b0/a0, b1:b1/a0, b2:b2/a0, a1:a1/a0, a2:a2/a0};
}
function biquadHP(rate, f0, Q){
  const w0 = 2*Math.PI*f0/rate, cs = Math.cos(w0), sn = Math.sin(w0), alpha = sn/(2*Q);
  const b0 = (1+cs)/2, b1 = -(1+cs), b2 = (1+cs)/2, a0 = 1+alpha, a1 = -2*cs, a2 = 1-alpha;
  return {b0:b0/a0, b1:b1/a0, b2:b2/a0, a1:a1/a0, a2:a2/a0};
}

/* 测整首的积分响度（LUFS），顺带给出要应用到目标所需的分贝数。 */
async function measureLoudness(m){
  const bpf = m.nch * 2, step = Math.floor(m.rate * 20);
  const hs = biquadHS(m.rate, 1681.97, 0.7071, 3.999);
  const hp = biquadHP(m.rate, 38.13, 0.5);
  const z1 = new Float64Array(m.nch), z2 = new Float64Array(m.nch);
  const z3 = new Float64Array(m.nch), z4 = new Float64Array(m.nch);
  /* ★ 分块门控（BS.1770 原本的样子）。以前是"整首一起平均"：
     一首前奏 30 秒静音、尾奏 20 秒静音的曲子，静音把均值拉低 →
     算出 -37 LUFS → 整首被抬 +21 dB，有声段直接撞限幅器、动态压平。
     现在按 400ms 块算能量，先过绝对门限（-70 LUFS），再以"通过绝对门槛的
     整体响度 -10 LU"作为相对门限，只对通过两块门限的块求平均。
     门限以下（纯静音/极轻的尾巴）不参与，归一化只跟着真正有声的部分走。 */
  /* ★ 块必须**重叠**：BS.1770-4 规定 400ms 窗、100ms 步进（75% 重叠）。
     以前是首尾相接切 400ms 块，稳态音乐差别很小，但鼓点稀疏、长渐弱的曲子上
     门限命中的块集合不同，增益能差 0.5–1 dB。现在按 100ms 累 hop，每 4 个 hop
     组成一个 400ms 窗（滑动和，仍是 O(n)）。 */
  const blkFrames = Math.max(1, Math.round(m.rate * 0.4));
  const hopFrames = Math.max(1, Math.round(m.rate * 0.1));
  const hopPerWin = Math.max(1, Math.round(blkFrames / hopFrames));   // 4
  const hopSq = new Float64Array(m.nch);
  const hops = [];                   // 每个 hop 的 Σ_声道 均方
  const blocks = [];                 // 每个 400ms 窗的能量（由 hopPerWin 个 hop 相加）
  let hopN = 0;
  const closeHop = () => {
    const n = hopN;
    let z = 0;
    for(let ch=0; ch<m.nch; ch++) z += hopSq[ch] / n;   // Σ G_i·z_i，G=1
    hopSq.fill(0); hopN = 0;
    if(n >= Math.floor(hopFrames * 0.5)){               // 不足半个 hop 的尾巴不计
      hops.push(z);
      if(hops.length >= hopPerWin){
        let s = 0;
        for(let k = hops.length - hopPerWin; k < hops.length; k++) s += hops[k];
        blocks.push(s / hopPerWin);
      }
    }
  };
  for(let f=0; f<m.frames; f+=step){
    const n = Math.min(step, m.frames - f);
    const ab = await m.pcm.slice(f*bpf, (f+n)*bpf).arrayBuffer();
    const src = new Int16Array(ab);
    for(let i=0;i<src.length;i++){
      const ch = i % m.nch;
      let x = src[i] / 32768;
      let y = hs.b0*x + z1[ch]; z1[ch] = hs.b1*x - hs.a1*y + z2[ch]; z2[ch] = hs.b2*x - hs.a2*y; x = y;
      y = hp.b0*x + z3[ch]; z3[ch] = hp.b1*x - hp.a1*y + z4[ch]; z4[ch] = hp.b2*x - hp.a2*y;
      hopSq[ch] += y*y;
      if(ch === m.nch - 1 && ++hopN >= hopFrames) closeHop();
    }
  }
  if(hopN) closeHop();

  // 门限与打分见下面的 gatedLoudness()（抽成纯函数，便于单测）
  const lufs = gatedLoudness(blocks);
  // ★ 整首都在绝对门限之下（静音或极轻）→ 没有"有效响度"可归一。
  //   硬算会得到 -120 LUFS，被夹到 LUFS_MIN(-40) 后变成 +24dB 的增益，
  //   把底噪整个抬起来再去撞限幅器。这里一律按"不归一"处理。
  return lufs == null ? TARGET_LUFS : lufs;
}
/* 综合响度的门限部分（纯函数，方便单测）：BS.1770-4 的双门限。
   先按绝对门限 -70 LUFS 剔除静音块，再以通过者的整体响度 -10 LU 作相对门限。
   返回 LUFS；没有一块通过绝对门限时返回 null。 */
const LUFS_ABS_GATE = -70, LUFS_REL_GATE = -10;
function lufsOfEnergy(z){ return -0.691 + 10 * Math.log10(Math.max(1e-12, z)); }
function gatedLoudness(blocks){
  if(!blocks || !blocks.length) return null;
  const abs = blocks.filter(z => lufsOfEnergy(z) > LUFS_ABS_GATE);
  if(!abs.length) return null;
  let gz = 0;
  for(const z of abs) gz += z;
  gz /= abs.length;
  const relThr = lufsOfEnergy(gz) + LUFS_REL_GATE;
  let sum = 0, n = 0;
  for(const z of abs) if(lufsOfEnergy(z) > relThr){ sum += z; n++; }
  sum = n ? sum / n : gz;
  return lufsOfEnergy(sum);
}
/* 返回该干声应施加的线性增益（响度归一化 + 限幅天花板兜底） */
async function loudnessGainFor(m){
  if(m.gainDb != null) return m.gainDb;
  let lufs = TARGET_LUFS;
  try { lufs = await measureLoudness(m); } catch(e){
    // 失败时保持 TARGET_LUFS（即 db = 0，不做任何归一）。
    // 旧注释写"退回峰值"与代码相反 —— 这里根本没有峰值那条路。
    console.warn('[响度] 测量失败，本曲不做响度归一', e);
  }
  // 防呆：把测量值夹进合理范围，避免畸形 MIDI 算出离谱增益。
  // （这两个常量以前定义了却从未被使用，夹紧用的是另一处硬编码 ±24）
  lufs = Math.max(LUFS_MIN, Math.min(LUFS_MAX, lufs));
  m.loudness = lufs;
  const db = Math.max(-24, Math.min(24, TARGET_LUFS - lufs));
  m.gainDb = db;
  // 诊断信息走 console.warn（App 内的信息栏是给用户看的，不适合放这种调试数字）
  if(lufs !== TARGET_LUFS && window.console && console.warn)
    console.warn('[响度] 实测', lufs.toFixed(1), 'LUFS → 修正', db.toFixed(1), 'dB');
  return db;
}

/* ---- 母带限幅 ---（LIM_KNEE / LIM_CEIL / LIM_RATIO 见文件顶部 CONFIG 区） */
function limitAt(x){
  const a = x < 0 ? -x : x;
  if(a <= LIM_KNEE) return x;
  const db = 20 * Math.log10(a / LIM_KNEE);
  const out = LIM_KNEE * Math.pow(10, db * (1 / LIM_RATIO) / 20);
  const o = out > LIM_CEIL ? LIM_CEIL : out;
  return x < 0 ? -o : o;
}
// 补偿增益：让限幅后的峰值仍然达到 LIM_CEIL
const LIM_MAKEUP = LIM_CEIL / limitAt(LIM_CEIL);

/* ---- 导出/位深量化 ---（MIX_VER / BITS_LP / HARD_LEVEL 见文件顶部 CONFIG 区）---- */
/* RBJ 双二阶低通 */
function biquadLP(fs, f0, Q){
  const w = 2*Math.PI*f0/fs, cs = Math.cos(w), sn = Math.sin(w);
  const al = sn/(2*(Q||0.7071));
  const b0 = (1-cs)/2, b1 = 1-cs, b2 = (1-cs)/2;
  const a0 = 1+al, a1 = -2*cs, a2 = 1-al;
  return {b0:b0/a0, b1:b1/a0, b2:b2/a0, a1:a1/a0, a2:a2/a0};
}
const WAVE_SHORT = {pulse12:"12.5%", pulse25:"25%", pulse50:"50%", square:"方波",
                    triangle:"三角", saw:"锯齿", sine:"正弦", noise:"噪声"};
const WAVE_LABELS = [
  ["auto","自动"],
  ["pulse12","脉冲 12.5%"],
  ["pulse25","脉冲 25%"],
  ["pulse50","方波 50%"],
  ["triangle","三角波"],
  ["saw","锯齿波"],
  ["square","裸方波"],
  ["sine","正弦"],
  ["noise","噪声"]
];

/* ---- GM 128 音色逐个映射（不是按 16 个族一刀切）----
   每 8 个一行，行号就是 GM 的族号，方便对照。 */
const GM_WAVE = [
  // 0-7 钢琴
  "pulse25","pulse25","pulse25","pulse25","triangle","triangle","pulse25","pulse25",
  // 8-15 色彩打击乐
  "triangle","triangle","triangle","sine","triangle","triangle","sine","pulse25",
  // 16-23 风琴
  "pulse50","pulse50","pulse50","pulse50","pulse25","pulse25","pulse25","pulse25",
  // 24-31 吉他
  "pulse25","pulse25","pulse25","pulse25","pulse25","saw","saw","sine",
  // 32-39 贝斯
  "triangle","triangle","triangle","sine","pulse50","pulse50","triangle","saw",
  // 40-47 弦乐
  "pulse50","pulse50","pulse50","pulse50","pulse25","pulse25","triangle","noise",
  // 48-55 合奏
  "pulse50","pulse50","pulse50","pulse50","sine","sine","sine","noise",
  // 56-63 铜管
  "pulse25","pulse25","pulse25","pulse25","pulse25","pulse25","saw","saw",
  // 64-71 簧管
  "pulse25","pulse25","pulse25","pulse25","triangle","pulse25","pulse25","sine",
  // 72-79 管乐
  "triangle","triangle","triangle","triangle","sine","triangle","sine","sine",
  // 80-87 合成主音
  "pulse50","saw","pulse25","pulse25","saw","sine","pulse25","pulse25",
  // 88-95 合成铺底
  "pulse50","pulse50","pulse50","sine","pulse50","pulse25","sine","pulse50",
  // 96-103 音效
  "noise","noise","sine","noise","pulse25","noise","noise","noise",
  // 104-111 民族
  "pulse25","pulse25","pulse25","pulse25","triangle","pulse25","pulse50","pulse25",
  // 112-119 打击乐
  "sine","pulse50","pulse25","pulse25","noise","triangle","noise","noise",
  // 120-127 合成特效
  "noise","noise","noise","sine","pulse12","noise","noise","noise"
];
/* 包络（决定"怎么发音"，波形决定"音色"）：
   perc 敲击 / pluck 拨弦 / bell 铃类 / wind 管乐铜管 / lead 合成主音 / sus 持续 */
/* 带 hit/strike 的是"敲击类"：包络 = 起音 → 瞬态落到 strike → 线性衰减到 sus */
const SHAPES = {
  perc:  {strike:0.42, sus:0.20, hit:0.10, rel:0.11, boost:1.95, ring:1.00},
  pluck: {strike:0.50, sus:0.25, hit:0.08, rel:0.09, boost:1.85, ring:0.80},
  bell:  {strike:0.46, sus:0.16, hit:0.20, rel:0.34, boost:1.55, ring:1.30},
  wind:  {sus:0.72, dec:0.055, rel:0.09, boost:1.10},
  lead:  {sus:0.78, dec:0.045, rel:0.07, boost:0.92},
  sus:   {sus:0.88, dec:0.035, rel:0.10, boost:0.68}
};
/* 音符结束时应该还有多响：低音更足，高音更短 */
/* 低音余音补偿。原来是 0.45（低音尾巴抬高 45%），加上脉冲波本身低音就厚，
   混出来会"低音吵" —— 降到 0.12，只留一点点厚度感。 */
function tailLevel(sh, note){
  const lo = Math.max(0, Math.min(1, (72 - note) / 36));      // C5→0, C3→1
  return Math.min(0.92, sh.sus * (1 + 0.12 * lo * (sh.ring || 0)));
}
const GM_SHAPE = [
  "perc","perc","perc","perc","perc","perc","pluck","pluck",
  "bell","bell","bell","bell","bell","bell","bell","pluck",
  "sus","sus","sus","sus","sus","wind","wind","wind",
  "pluck","pluck","pluck","pluck","pluck","lead","lead","bell",
  "pluck","pluck","pluck","pluck","pluck","pluck","lead","lead",
  "sus","sus","sus","sus","wind","pluck","pluck","perc",
  "sus","sus","sus","sus","sus","sus","sus","perc",
  "wind","wind","wind","wind","wind","wind","lead","lead",
  "wind","wind","wind","wind","wind","wind","wind","wind",
  "wind","wind","wind","wind","wind","wind","wind","wind",
  "lead","lead","lead","lead","lead","lead","lead","lead",
  "sus","sus","sus","sus","sus","sus","sus","sus",
  "perc","sus","bell","sus","sus","perc","sus","sus",
  "pluck","pluck","pluck","pluck","bell","wind","sus","wind",
  "bell","bell","bell","perc","perc","perc","perc","sus",
  "perc","wind","sus","bell","perc","sus","sus","perc"
];
function autoWave(prog){
  const p = prog | 0;
  return GM_WAVE[p >= 0 && p < 128 ? p : 0];
}
function autoShape(prog){
  const p = prog | 0;
  return GM_SHAPE[p >= 0 && p < 128 ? p : 0];
}

/* ---- 各波形音量 / 包络基线 ---（WAVE_GAIN / SUSTAIN 见文件顶部 CONFIG 区）---- */

function ChipEngine(existing){
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = existing || new AC({latencyHint:"interactive"});
  this.ctx = ctx;
  // ★ 记住"正在发声的那个上下文"，供 resumeIfWanted 在打断后恢复（离线上下文不算）。
  if(!existing) window.__m8OutCtx = ctx;
  this.offline = !!existing;          // 离线渲染时不要 analyser

  // --- 输出链: chanBus -> master -> crush -> (analyser) -> out ---
  this.chanBus = ctx.createGain();
  this.master  = ctx.createGain();  this.master.gain.value = 0.7;
  this.crush   = ctx.createWaveShaper();
  this.crush.curve = makeCrushCurve(6);
  this.crush.oversample = "none";
  this.out = ctx.createGain(); this.out.gain.value = 0.9;

  /* 两级串联低通（24dB/oct）削掉方波最扎耳的高次谐波。
     想更亮/更闷改这一个数就行：3500 更闷、7000 更亮。 */
  this.lp = ctx.createBiquadFilter();
  this.lp.type = "lowpass";
  this.lp.frequency.value = TONE_LP;
  this.lp.Q.value = 0.55;
  this.lp2 = ctx.createBiquadFilter();
  this.lp2.type = "lowpass";
  this.lp2.frequency.value = TONE_LP;
  this.lp2.Q.value = 0.55;
  // 频段平衡：低架（压低频）→ 高架（提亮度）→ 两级低通
  this.ls = ctx.createBiquadFilter();
  this.ls.type = "lowshelf";
  this.ls.frequency.value = SHELF_LOW_HZ;
  this.ls.gain.value = SHELF_LOW_DB;
  this.hp = ctx.createBiquadFilter();
  this.hp.type = "highpass";
  this.hp.frequency.value = HP_HZ;
  this.hp.Q.value = 0.7;
  this.hs = ctx.createBiquadFilter();
  this.hs.type = "highshelf";
  this.hs.frequency.value = SHELF_HI_HZ;
  this.hs.gain.value = SHELF_HI_DB;
  this.chanBus.connect(this.master);
  this.master.connect(this.hp);
  this.hp.connect(this.ls);
  this.ls.connect(this.hs);
  this.hs.connect(this.lp);
  this.lp.connect(this.lp2);
  this.lp2.connect(this.crush);
  if(this.offline){
    this.analyser = null;
    this.crush.connect(this.out);
  } else {
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.6;
    this.crush.connect(this.analyser);
    this.analyser.connect(this.out);
  }
  this.out.connect(ctx.destination);

  this.chanGain = [];  this.chanPan = [];  this.chanMute = [];
  for(let i=0;i<16;i++){
    const g = ctx.createGain(); g.gain.value = 1;
    const pn = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if(pn){ g.connect(pn); pn.connect(this.chanBus); }
    else g.connect(this.chanBus);
    this.chanGain.push(g); this.chanPan.push(pn); this.chanMute.push(false);
  }

  // --- 脉冲波 PeriodicWave ---
/* 脉冲波：对理想 0/1 方波在 [0,duty) 上做傅里叶展开，系数是精确解 —— */
  this.pw = {};
  for(const duty of [0.125, 0.25, 0.5]){
    const N = 64, real = new Float32Array(N), imag = new Float32Array(N);
    for(let n=1;n<N;n++){
      const w = 2*Math.PI*n*duty;
      real[n] = Math.sin(w) / (Math.PI*n);
      imag[n] = (1 - Math.cos(w)) / (Math.PI*n);
    }
    this.pw[duty] = ctx.createPeriodicWave(real, imag, {disableNormalization:false});
  }
  // 噪声缓冲（2 秒白噪声，可循环）—— 样本数据走缓存，不再逐块重算
  const nb = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 2), ctx.sampleRate);
  nb.getChannelData(0).set(noiseSamples(ctx.sampleRate));
  this.noiseBuf = nb;
  this.active = [];            // 正在发声的节点，用于 stop
}

function makeCrushCurve(bits){
  const n = Math.pow(2, bits) / 2;
  const N = 2048, c = new Float32Array(N);
  for(let i=0;i<N;i++){
    const x = (i/(N-1)) * 2 - 1;
    c[i] = Math.round(x * n) / n;
  }
  return c;
}

/* 白噪声样本按采样率缓存。 */
/* 白噪声样本缓存（状态清单 A 类）：key = 采样率，value = Float32Array。只增不删。 */
const NOISE_DATA = new Map();
function noiseSamples(sr){
  const k = Math.floor(sr);
  let d = NOISE_DATA.get(k);
  if(d) return d;
  const nlen = Math.floor(k * 2);
  d = new Float32Array(nlen);
  let seed = 12345;
  for(let i=0;i<nlen;i++){
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    d[i] = ((seed >> 8) & 0xffff) / 32768 - 1;
  }
  NOISE_DATA.set(k, d);
  return d;
}
ChipEngine.prototype.noteFreq = function(midi){
  return 440 * Math.pow(2, (midi - 69) / 12);
};

/* ---------------- 旋律 / 和声声部 ---------------- */
ChipEngine.prototype.playTone = function(o){
  const ctx = this.ctx, t0 = Math.max(o.start, ctx.currentTime);
  const dur  = Math.max(0.04, o.dur);
  const wave = o.wave === "auto" ? autoWave(o.prog) : o.wave;
  const dest = this.chanGain[o.ch] || this.chanBus;
  const sh = SHAPES[o.shape] || null;
  const keep = [];
  /* 音量直接折进包络的每个取值里 —— 少建一个中间增益节点，
     整首少几千个节点，渲染明显更快（听感完全一样）。 */
  let amp = Math.max(0.0005, o.gain || 0.3);
  let end = t0 + dur;

  if(wave === "noise"){
    amp *= 0.35 * (sh ? sh.boost : 1) * (WAVE_GAIN[wave] || 1);
    const s = ctx.createBufferSource();
    s.buffer = this.noiseBuf; s.loop = true;
    // 噪声类音色靠 playbackRate 控音高；弯音也要跟着走，否则长音上的滑音会消失
    const clampRate = r => Math.max(0.25, Math.min(4, r));
    const baseRate = clampRate(this.noteFreq(o.note) / 440);
    s.playbackRate.setValueAtTime(baseRate, t0);
    if(o.bendAt && o.bendAt.length){
      for(const b of o.bendAt)
        s.playbackRate.linearRampToValueAtTime(clampRate(baseRate * Math.pow(2, b.v * BEND_SEMI / 12)), t0 + b.dt);
    } else if(o.bend){
      s.playbackRate.setValueAtTime(clampRate(baseRate * Math.pow(2, o.bend * BEND_SEMI / 12)), t0);
    }
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass";
    bp.frequency.value = Math.max(200, Math.min(6000, this.noteFreq(o.note) * 4));
    bp.Q.value = 1.2;
    const g = ctx.createGain();
    const rel = sh ? sh.rel : 0.06; end = t0 + dur + rel;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(amp, t0 + 0.004);
    if(sh && sh.strike != null){
      const d1 = Math.min(sh.hit, Math.max(0.015, dur * 0.3));
      g.gain.linearRampToValueAtTime(amp * sh.strike, t0 + 0.004 + d1);
      g.gain.linearRampToValueAtTime(amp * tailLevel(sh, o.note),
                                     t0 + Math.max(0.004 + d1 + 0.02, dur));
    } else {
      const lv = sh ? Math.max(0.05, sh.sus) : 0.6;
      g.gain.linearRampToValueAtTime(amp * lv, t0 + (sh ? sh.dec : 0.05));
      g.gain.setValueAtTime(amp * lv, t0 + dur);
    }
    g.gain.linearRampToValueAtTime(0.0001, end);
    s.connect(bp); bp.connect(g); g.connect(dest);
    s.start(t0); s.stop(end + 0.02);
    keep.push(s);
  } else {
    const atk = 0.004;
    const rel = sh ? sh.rel : 0.055;
    let sus = sh ? sh.sus : (SUSTAIN[wave] || 0.7);
    amp *= (sus > 0.8 ? 0.50 : 0.42) * (sh ? sh.boost : 1) * (WAVE_GAIN[wave] || 1);
    end = t0 + dur + rel;

    const osc = ctx.createOscillator();
    if(wave === "saw") osc.type = "sawtooth";
    else if(wave === "triangle") osc.type = "triangle";
    else if(wave === "sine") osc.type = "sine";
    else if(wave === "square") osc.type = "square";
    else osc.setPeriodicWave(this.pw[wave === "pulse12" ? 0.125 : wave === "pulse50" ? 0.5 : 0.25]);

    // 弯音：±BEND_SEMI 个半音 → 频率乘以 2^(半音/12)
    // 弯音：用 detune（音分）叠加 —— 不动 frequency，免得和下面的尾部下滑打架
    if(o.bendAt && o.bendAt.length){
      osc.detune.setValueAtTime(o.bendAt[0].v * BEND_SEMI * 100, t0);
      for(const b of o.bendAt) osc.detune.linearRampToValueAtTime(b.v * BEND_SEMI * 100, t0 + b.dt);
    } else if(o.bend){
      osc.detune.setValueAtTime(o.bend * BEND_SEMI * 100, t0);
    }
    const f = this.noteFreq(o.note);
    osc.frequency.setValueAtTime(f, t0);
    const d = Math.max(0.02, dur - 0.05);
    osc.frequency.setValueAtTime(f, t0 + d);             // 尾部轻微下滑，芯片味
    osc.frequency.exponentialRampToValueAtTime(f * 0.994, t0 + dur + 0.05);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(amp, t0 + atk);
    if(sh && sh.strike != null){
      // 敲击类：瞬态 → 一路衰减到音符结束（低音余音更长）
      const d1 = Math.min(sh.hit, Math.max(0.015, dur * 0.3));
      sus = tailLevel(sh, o.note);
      g.gain.linearRampToValueAtTime(amp * sh.strike, t0 + atk + d1);
      g.gain.linearRampToValueAtTime(amp * sus, t0 + Math.max(atk + d1 + 0.02, dur));
    } else {
      const dec = sh ? sh.dec : ((wave === "triangle") ? 0.02 : 0.075);
      g.gain.linearRampToValueAtTime(amp * sus, t0 + atk + dec);
      g.gain.setValueAtTime(amp * sus, t0 + dur);
    }
    g.gain.linearRampToValueAtTime(0.0001, end);
    osc.connect(g); g.connect(dest);
    osc.start(t0); osc.stop(end + 0.02);
    keep.push(osc);
  }

  // 离线渲染不需要活动追踪（本引擎只有离线渲染这一种用法，
  // 唯一的构造点 renderMaster 传的就是 OfflineAudioContext → offline 恒为 true）
  if(!this.offline) this.active.push({stop: end + 0.05, nodes: keep, ch: o.ch});
};

/* ---------------- 鼓机：覆盖 GM 打击乐 35~81 全部音高 ---------------- */
const DRUMS = {
  35:[["t",175,42,0.16,1.00,"sine"]],                              // 低音大鼓
  36:[["t",180,42,0.16,1.00,"sine"]],                              // 大鼓 1
  37:[["n",0.055,"bandpass",2600,2.0,0.55],["t",1200,900,0.04,0.18,"triangle"]], // 边击
  38:[["n",0.17,"highpass",1400,0.8,0.55],["t",230,170,0.07,0.30,"triangle"]],   // 小鼓
  39:[["n",0.19,"bandpass",1700,1.1,0.60]],                        // 拍手
  40:[["n",0.14,"highpass",2000,0.8,0.50],["t",280,200,0.06,0.28,"triangle"]],   // 电子小鼓
  41:[["t",95,52,0.28,0.85,"sine"]],                               // 低音落地鼓
  42:[["n",0.045,"highpass",7500,0.7,0.42]],                       // 闭镲
  43:[["t",120,66,0.26,0.82,"sine"]],                              // 高音落地鼓
  44:[["n",0.06,"highpass",6200,0.7,0.36]],                        // 踏镲
  45:[["t",150,82,0.25,0.80,"sine"]],                              // 低音桶鼓
  46:[["n",0.34,"highpass",6800,0.7,0.36]],                        // 开镲
  47:[["t",185,100,0.23,0.78,"sine"]],                             // 中低桶鼓
  48:[["t",225,124,0.21,0.76,"sine"]],                             // 中高桶鼓
  49:[["n",0.85,"highpass",5200,0.6,0.50]],                        // 强音镲 1
  50:[["t",270,150,0.19,0.74,"sine"]],                             // 高音桶鼓
  51:[["n",0.45,"highpass",6000,0.9,0.30]],                        // 叮叮镲 1
  52:[["n",0.70,"bandpass",4200,0.7,0.45]],                        // 中国镲
  53:[["t",830,830,0.14,0.26,"square"],["t",1240,1240,0.11,0.20,"square"],
      ["n",0.35,"highpass",6000,0.8,0.18]],                        // 叮叮镲铃
  54:[["n",0.11,"highpass",5000,1.0,0.42]],                        // 铃鼓
  55:[["n",0.30,"highpass",8000,0.6,0.40]],                        // 水镲
  56:[["t",830,830,0.14,0.30,"square"],["t",1240,1240,0.11,0.22,"square"]],      // 牛铃
  57:[["n",0.95,"highpass",4600,0.6,0.48]],                        // 强音镲 2
  58:[["n",0.25,"bandpass",1800,1.4,0.45]],                        // 响板/震音器
  59:[["n",0.55,"highpass",5400,0.9,0.30]],                        // 叮叮镲 2
  60:[["t",400,300,0.12,0.60,"sine"]],                             // 高音邦戈
  61:[["t",300,220,0.13,0.58,"sine"]],                             // 低音邦戈
  62:[["t",330,280,0.14,0.60,"sine"]],                             // 闷高音康加
  63:[["t",300,250,0.20,0.62,"sine"]],                             // 开高音康加
  64:[["t",220,180,0.24,0.64,"sine"]],                             // 低音康加
  65:[["t",420,300,0.18,0.58,"sine"]],                             // 高音定音鼓
  66:[["t",320,230,0.22,0.56,"sine"]],                             // 低音定音鼓
  67:[["t",900,900,0.09,0.30,"square"]],                           // 高音阿哥哥
  68:[["t",660,660,0.11,0.28,"square"]],                           // 低音阿哥哥
  69:[["n",0.08,"highpass",6500,0.9,0.34]],                        // 沙锤
  70:[["n",0.06,"highpass",7000,0.9,0.32]],                        // 沙铃
  71:[["t",2200,2200,0.12,0.22,"sine"]],                           // 短哨
  72:[["t",2100,2100,0.35,0.20,"sine"]],                           // 长哨
  73:[["n",0.10,"bandpass",3000,1.6,0.34]],                        // 短刮胡
  74:[["n",0.28,"bandpass",2600,1.6,0.32]],                        // 长刮胡
  75:[["n",0.05,"bandpass",2500,2.2,0.45]],                        // 响棒
  76:[["n",0.05,"bandpass",1800,2.0,0.45]],                        // 高音木鱼
  77:[["n",0.06,"bandpass",1200,2.0,0.45]],                        // 低音木鱼
  78:[["t",400,250,0.12,0.45,"sine"]],                             // 闷音鼓虫
  79:[["t",350,600,0.25,0.42,"sine"]],                             // 开音鼓虫
  80:[["t",3000,3000,0.50,0.10,"sine"]],                           // 闷音三角铁
  81:[["t",3000,3000,0.85,0.09,"sine"]],                           // 开音三角铁
  __default:[["n",0.14,"bandpass",2200,1.2,0.40]]
};

ChipEngine.prototype.playDrum = function(o){
  const ctx = this.ctx, t0 = Math.max(o.start, ctx.currentTime);
  const ch = o.ch, dest = this.chanGain[ch] || this.chanBus;
  const amp = Math.max(0.0005, o.gain);
  const recipe = DRUMS[o.note] || DRUMS.__default;
  const nodes = [];
  let life = 0.2;

  const toneHit = (f1, f2, dur, peak, type) => {
    const osc = ctx.createOscillator(); osc.type = type || "sine";
    osc.frequency.setValueAtTime(f1, t0);
    if(f2 !== f1) osc.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(dest);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
    nodes.push(osc); life = Math.max(life, dur + 0.05);
  };
  const noiseHit = (dur, type, freq, q, peak) => {
    const s = ctx.createBufferSource(); s.buffer = this.noiseBuf; s.loop = true;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    s.connect(f); f.connect(g); g.connect(dest);
    s.start(t0); s.stop(t0 + dur + 0.02);
    nodes.push(s); life = Math.max(life, dur + 0.05);
  };

  for(const part of recipe){
    if(part[0] === "t") toneHit(part[1], part[2], part[3], part[4]*amp, part[5]);
    else noiseHit(part[1], part[2], part[3], part[4], part[5]*amp);
  }
  if(!this.offline) this.active.push({stop: t0 + life + 0.05, nodes, ch});
};

/* ==================================================================
   MIDI8BIT —— 网页版 8-bit MIDI 播放器
   ------------------------------------------------------------------
   代码分区（按执行顺序）：
     1. MIDI 解析器            parseMidi()、GM 名称表
     2. 芯片合成引擎           ChipEngine：波形 / 包络 / 鼓机
     3. 播放核心               离线渲染 → <audio> 元素播放
     4. 磁盘缓存               唯一的一层存储（IndexedDB）
     5. 后台预渲染             一个常驻循环
     6. 播放控制 + 系统播放器   双缓冲 <audio> + Media Session
     7. 界面                   播放列表 / 声道面板 / 卷帘 / 示波器
   ------------------------------------------------------------------
   关键设计（都是踩坑换来的，改动前请先看这里）：

   · 为什么不用实时 Web Audio？
     WebKit bug 263627/276687：iOS 上页面进后台时 AudioContext
     要么 currentTime 不再前进（回前台卡成慢动作），要么直接不出声。
     只有 HTML 媒体元素能后台播放 → 所以全部离线渲染成音频再交给 <audio>。

   · 两层产物
     干声(master) = 未量化的 PCM，只跟「歌 + 波形/静音设置 + 低通」有关
     成品(variant) = 干声 + 位深量化，切位深只需过一遍数据（~150ms）

   · 唯一一层存储是磁盘（IndexedDB）
     绿灯 = 磁盘索引里有这条；内存里只留当前曲目的 PCM。
     空间不足按缓存时间删最早的。

   · 凡是"可能不返回"的地方都要有超时或看门狗
     try/finally 只能兜住抛异常，兜不住 await 永远不回来。
   ================================================================== */

