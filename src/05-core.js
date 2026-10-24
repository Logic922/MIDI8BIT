/* ==================================================================
   3. 播放核心 —— 离线渲染成音频，交给 <audio> 播放
   ------------------------------------------------------------------
   为什么放弃"实时 Web Audio 合成"？
   WebKit 官方 bug 263627《[iOS] AudioContext is not consistently resumed
   when page is brought to foreground》与 276687 记载：
     iOS 上页面进后台时 AudioContext 无法可靠工作 ——
     要么 state 仍报 running 但 currentTime 不再前进（回前台就卡成慢动作），
     要么干脆不出声；只有 HTML 媒体元素才能在后台持续播放。
   所以改成：用 OfflineAudioContext 预先把整首渲染成音频，
   再交给 <audio> 元素播 —— 后台播放、锁屏控制、进度条全部原生支持。
   ================================================================== */
/* 真正可用的元素由 AUDIO/pidx 管理，见下方"双缓冲"一节 */
try { window.__t0 = performance.now(); } catch(e){}
/* ---- 采样率 / 预渲染深度 ---（RENDER_RATE / PRERENDER_AHEAD 见文件顶部 CONFIG 区）---- */

/* ------------------------------------------------------------------ */
const App = {
  songs: [],          // 播放列表：[{name, song, ...每首歌的状态(entry，见 C 类)}]
  cur: -1,            // 当前曲目下标，-1 = 没有
  playing: false,     // 播放中？（由 <audio> 事件写，供界面读）
  crush: 6,           // 当前位深（0/4/6/8）
  renderRate: 44100,  // 渲染采样率（进缓存键，见 CONFIG 区）
  renderPct: -1,      // 渲染进度（-1 = 无进度；>=0 是 0..1，-2 = 块级心跳）
/* 以下字段在别处按需创建（不在这里初始化，读时都要判空）： */
};

/* ---- 提示 / 进度：只写状态；绘制通过下面这两个钩子由 UI 注册 ----
   为什么要钩子：页面不可见时 rAF 会停，光靠 tick 对账会让提示/hud 停在旧值。
   写入时同步调一次（钩子为空就跳过），tick 再兜一次。 */
const UIPaint = { info: null, hud: null };
const AudioHooks = { held: null, sweep: null, release: null };   // 播放层注册的 URL 持有查询
let flashT = 0;
function paintNow(){ try { if(UIPaint.info) UIPaint.info(); if(UIPaint.hud) UIPaint.hud(); } catch(e){} }
function setInfoText(msg){ App.infoText = msg || null; paintNow(); }
function flashInfo(text, ms){
  const ms2 = ms || 5000;
  App.renderMsg = text || null;
  App.renderMsgUntil = performance.now() + ms2;
  paintNow();
  // 定时器只负责"到点清掉自己"；连续写会重置它，旧消息不会清掉新消息。
  // （后台 setTimeout 会被节流，但时间戳让 tick 在恢复时也能一次清干净）
  clearTimeout(flashT);
  flashT = setTimeout(() => {
    if(App.renderMsgUntil && performance.now() >= App.renderMsgUntil - 50){
      App.renderMsg = null; App.renderMsgUntil = 0;
      paintNow();
    }
  }, ms2 + 30);
}
function setRenderHud(name, done, total, pct, sec){
  App.hud = name ? { name, done, total, pct, sec } : null;
  paintNow();
}

function curSong(){
  if(App.cur < 0 || !App.songs[App.cur]) return null;
  return App.songs[App.cur].song;
}
function curEntry(){ return App.cur >= 0 ? App.songs[App.cur] : null; }

/* ── entry.intent：每首歌的"待执行一次性动作"（换源/渲染完成后补做） */
function intentOf(e){ return e.intent || (e.intent = { play: false, seekAt: null }); }
/** 设置意图。o.play 覆盖 play；o.seekAt 覆盖 seek（null = 清掉）。 */
function intentSet(e, o){
  const it = intentOf(e);
  if(!o) return it;
  if("play" in o) it.play = !!o.play;
  if("seekAt" in o) it.seekAt = (o.seekAt == null ? null : o.seekAt);
  return it;
}
/** 撤销意图。不传 what = 全撤（用户按停止）。 */
function intentCancel(e, what){
  if(!e || !e.intent) return;
  if(!what || what === "play") e.intent.play = false;
  if(!what || what === "seek") e.intent.seekAt = null;
}
/** 消费"起播"意图：有则取走并返回 true（只能被消费一次）。 */
function intentTakePlay(e){
  if(!e || !e.intent || !e.intent.play) return false;
  e.intent.play = false;
  return true;
}
function intentPeekSeek(e){ return (e && e.intent) ? e.intent.seekAt : null; }
function intentTakeSeek(e){
  if(!e || !e.intent || e.intent.seekAt == null) return null;
  const v = e.intent.seekAt;
  e.intent.seekAt = null;
  return v;
}

/* ---------------- 离线渲染 ---------------- */
const RENDER_MASTER_GAIN = 0.57;      // = 0.62 * 0.92，把输出增益并进 master，方便量化在末端做

/* 复刻 WaveShaperNode(oversample:"none") 的线性插值 */
function crushAt(curve, x){
  if(x <= -1) return curve[0];
  if(x >= 1) return curve[curve.length - 1];
  const p = (x + 1) * 0.5 * (curve.length - 1);
  const i0 = p | 0, frac = p - i0;
  return frac ? curve[i0] + (curve[i0+1] - curve[i0]) * frac : curve[i0];
}
/* 取一个音符区间内的弯音点，返回相对音符起点的 [{dt, v}]。
   以前只在音符起始采一次值，长音中间的滑音/颤音全丢了。 */
function bendPointsFor(song, ch, start, dur){
  const tl = song.bends && song.bends[ch];
  if(!tl || !tl.length) return null;
  const end = start + dur;
  let lo = 0, hi = tl.length - 1, base = -1;        // 二分找 start 之前最后一个点
  while(lo <= hi){ const m = (lo + hi) >> 1; if(tl[m].t <= start){ base = m; lo = m + 1; } else hi = m - 1; }
  const out = [];
  out.push({dt: 0, v: base >= 0 ? tl[base].v : 0});
  for(let i = base + 1; i < tl.length; i++){
    const e = tl[i];
    if(e.t >= end) break;
    out.push({dt: Math.max(0, e.t - start), v: e.v});
  }
  return out.length >= 2 ? out : null;              // 一个点等于没有自动化
}
function voiceInto(eng, song, note, at){
  const vel = note.vel / 127;
  if(note.ch === 9){
    eng.playDrum({start: at, note: note.note, ch: note.ch, gain: 0.58 * Math.pow(vel,1.2)});
  } else {
    const wave = song.wave[note.ch] || "auto";
    const expK = (note.exp == null ? 127 : note.exp) / 127;
    const vk = note.vol / 127;
    const gain = 0.30 * Math.pow(vel, 1.25) * (0.45 + 0.55 * vk) * Math.min(1, vk * 8) * expK;
    eng.playTone({start: at, dur: note.dur, note: note.note, ch: note.ch,
                  prog: note.prog, wave, shape: autoShape(note.prog), gain,
                  bend: note.bend || 0,
                  bendAt: bendPointsFor(song, note.ch,
                            note.bendFrom != null ? note.bendFrom : note.start, note.dur)});
  }
}
function wavHeaderBlob(frames, ch, rate){
  const ab = new ArrayBuffer(44), v = new DataView(ab);
  const ws = (o,s) => { for(let i=0;i<s.length;i++) v.setUint8(o+i, s.charCodeAt(i)); };
  ws(0,"RIFF"); v.setUint32(4, 36 + frames*ch*2, true); ws(8,"WAVE");
  ws(12,"fmt "); v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,ch,true);
  v.setUint32(24,rate,true); v.setUint32(28,rate*ch*2,true); v.setUint16(32,ch*2,true);
  v.setUint16(34,16,true); ws(36,"data"); v.setUint32(40, frames*ch*2, true);
  return new Blob([ab], {type:"audio/wav"});
}
/* 每块输出 CHUNK 秒（按内存预算自适应：立体声 44.1k 下 63 秒，超 7 分钟转单声道后 134 秒），
   渲染窗左右各留 TAIL 秒余量：保证跨块的延音不被截断，
   又不会把整首的 PCM 同时堆在内存里 */
async function renderMaster(song, onProgress){
  const rate = App.renderRate || RENDER_RATE, TAIL = 4;
  const totalSec = song.duration + 0.35;
  const frames = Math.ceil(totalSec * rate);
  const nch = totalSec > 420 ? 1 : 2;          // 超长曲降为单声道，控制内存
  const CHUNK_BUDGET = 24 * 1024 * 1024;
  const perSec = rate * nch * 4;               // Float32 每秒字节数
  const CHUNK = Math.max(60, Math.min(240, Math.floor(CHUNK_BUDGET / perSec - 2 * TAIL)));
  const scopeRate = Math.round(rate / 4);
  const scopeBuf = new Int16Array(Math.ceil(totalSec * scopeRate));
  const parts = [];
  const notes = song.notes.filter(n => !song.mute[n.ch] && n.ch < 16);
  const chunkTotal = Math.max(1, Math.ceil(totalSec / CHUNK));
  let chunkNo = 0;
  let written = 0, sw = 0, lastYield = performance.now();

  for(let t0 = 0; t0 < totalSec - 1e-6; t0 += CHUNK){
    chunkNo++;
    const outSec = Math.min(CHUNK, totalSec - t0);
    const outFrames = Math.round(outSec * rate);
    const preF = Math.round(TAIL * rate);
    const off = new OfflineAudioContext(nch, preF + outFrames, rate);
    const eng = new ChipEngine(off);
    eng.master.gain.value = RENDER_MASTER_GAIN;
    eng.crush.curve = null;                    // 干声：不量化
    eng.out.gain.value = 1.0;
    const wStart = t0 - TAIL;
/* ★ 按"是否与窗口重叠"取音符，窗口边界做裁剪。 */
    const winEnd = t0 + outSec + TAIL;
    for(const n of notes){
      const nEnd = n.start + n.dur;
      if(nEnd <= wStart) continue;          // 已在窗口之前结束
      if(n.start >= winEnd) break;           // 还没进窗（notes 按 start 排序，可 break）
      const sBeg = n.start > wStart ? n.start : wStart;
      const sEnd = nEnd < winEnd ? nEnd : winEnd;
      if(sEnd - sBeg <= 0.01) continue;
      // bendFrom：弯音要从"实际发声的起点"算，不是原音符起点
      voiceInto(eng, song, Object.assign({}, n, {dur: sEnd - sBeg, bendFrom: sBeg}), sBeg - wStart);
    }
    // 块内进度：startRendering 一跑就是好几秒，光靠"块完成"事件几乎看不到动静
    let beat = null;
    if(onProgress){
      const t0c = performance.now();
      const beatLimit = renderBudgetMs(song) + 15000;
      beat = setInterval(() => {
        if(performance.now() - t0c > beatLimit){ clearInterval(beat); beat = null; return; }
        onProgress(-2, chunkNo, chunkTotal, (performance.now() - t0c) / 1000);
      }, 400);
    }
    let buf;
    try { buf = await off.startRendering(); }
    finally { if(beat){ clearInterval(beat); beat = null; } }
    const L = buf.getChannelData(0);
    const R = nch > 1 ? buf.getChannelData(1) : L;
    const pcm = new Int16Array(outFrames * nch);
    for(let i=0;i<outFrames;i++){
      const s = preF + i;
      const l = Math.max(-1, Math.min(1, L[s] || 0));
      const r = Math.max(-1, Math.min(1, R[s] || 0));
      pcm[i*nch] = (l * 32767) | 0;
      if(nch > 1) pcm[i*nch+1] = (r * 32767) | 0;
      if(((written + i) & 3) === 0 && sw < scopeBuf.length)
        scopeBuf[sw++] = (((l + r) * 0.5) * 32767) | 0;
    }
    parts.push(pcm.buffer);
    written += outFrames;
    if(onProgress) onProgress(written / frames, chunkNo, chunkTotal);
    const budget = document.hidden ? 1200 : 150;
    if(performance.now() - lastYield > budget){
      lastYield = performance.now();
      await new Promise(r => setTimeout(r, 0));
    }
  }
  return {
    pcm: new Blob(parts, {type:"application/octet-stream"}),   // 无头 PCM
    // ★ frames 必须是 written（各块 round 累加的真实帧数），不能用上面那个 ceil 预估值：
    //   两者在浮点尾巴 <0.5 时会差 1 帧，WAV 头就会多声明 4 字节（data 长度 > 实际数据）。
    frames: written, nch, rate,
    scopeBuf: scopeBuf.subarray(0, sw), scopeRate,
    // bytes 是缓存预算的记账口径：PCM + 音轨缩略图缓冲都要算进去。
    // 以前只算 PCM，短曲少记 12.5%、30 分钟单声道曲子少记 25%（2-E）
    bytes: written * nch * 2 + sw * 2
  };
}
/* 干声 + 位深 → 成品 WAV（分片处理，内存只有几 MB） */
async function makeVariant(entry, bits){
  const m = entry.master;
  const curve = bits ? makeCrushCurve(bits) : null;
  const bpf = m.nch * 2;
  const step = Math.floor(m.rate * 20);         // 每次处理 20 秒（减少 blob 读取往返）
  const parts = [wavHeaderBlob(m.frames, m.nch, m.rate)];
  // 响度归一化（复刻 EasyEffects Auto Gain）：按 LUFS 而非峰值算增益，
  // 这样各首歌的响度一致 —— 峰值归一化做不到这点。
  const gDb = await loudnessGainFor(m);
  const g = Math.pow(10, gDb / 20);
  const fz1 = new Float64Array(m.nch), fz2 = new Float64Array(m.nch);   // 滤波器状态
  let lastYield = performance.now();
  for(let f=0; f<m.frames; f+=step){
    const n = Math.min(step, m.frames - f);
    const ab = await m.pcm.slice(f*bpf, (f+n)*bpf).arrayBuffer();
    const src = new Int16Array(ab);
    const nc = m.nch;
    for(let i=0;i<src.length;i++){
      const x = (src[i] / 32767) * g;            // 放大到峰值 ~0.92
      // 母带限幅 + 补偿增益：波峰压回 0.92，拐点以下整体抬高
      let xl = limitAt(x) * LIM_MAKEUP;
      if(xl >  0.995) xl =  0.995;               // 兜底，防止个别样本溢出 Int16
      if(xl < -0.995) xl = -0.995;
      if(curve){
        const q = crushAt(curve, xl);
        const p = xl < 0 ? -xl : xl;
        const w = p >= HARD_LEVEL ? 1 : p / HARD_LEVEL;
        src[i] = ((q * w + xl * (1 - w)) * 32767) | 0;
      } else {
        src[i] = (xl * 32767) | 0;               // bit0：不量化，但一样限幅归一
      }
    }
    // 量化之后再过一道低通：压掉台阶带来的"丝丝"底噪。
    // （放在量化之前没用 —— 噪声是量化本身产生的）
    const fl = curve ? (BITS_LP[bits] || 0) : 0;
    if(fl){
      const k = biquadLP(m.rate, fl, 0.7071);
      for(let i=0;i<src.length;i++){
        const c = i % nc;                        // 交错立体声要分开滤波
        const x = src[i], y = k.b0*x + fz1[c];
        fz1[c] = k.b1*x - k.a1*y + fz2[c];
        fz2[c] = k.b2*x - k.a2*y;
        src[i] = y | 0;
      }
    }
    parts.push(ab);
    const budget = document.hidden ? 1200 : 150;
    if(performance.now() - lastYield > budget){
      lastYield = performance.now();
      await new Promise(r => setTimeout(r, 0));
    }
  }
  return new Blob(parts, {type:"audio/wav"});
}

/* 声道活动网格：每 1/20 秒一格，记录哪些声道在发声（用于面板高亮） */
function buildActivityGrid(song){
  const res = 20, n = Math.ceil(song.duration * res) + 2;
  const grid = new Uint16Array(n);
  for(const nt of song.notes){
    if(song.mute[nt.ch] || nt.ch > 15) continue;
    const a = Math.max(0, Math.floor(nt.start * res));
    const b = Math.min(n-1, Math.floor((nt.start + nt.dur) * res));
    const bit = 1 << nt.ch;
    for(let i=a;i<=b;i++) grid[i] |= bit;
  }
  return {grid, res, n};
}

