/* ==================================================================
   7. 界面 —— 播放列表 / 声道面板 / 音符卷帘 / 示波器
   ================================================================== */
/* ---------------- 提示条 / 渲染 HUD 的绘制（状态在 App，钩子在 05-core） ---------------- */
function paintInfoBar(){
  const el = $("info"); if(!el) return;
  if(App.renderMsg && App.renderMsgUntil && performance.now() > App.renderMsgUntil){
    App.renderMsg = null; App.renderMsgUntil = 0;
  }
  const t = App.renderMsg || App.infoText || "";
  if(el.textContent !== t) el.textContent = t;
}
function paintHud(){
  const el = $("renderHud"), tx = $("renderHudTxt");
  if(!el) return;
  const h = App.hud;
  if(!h){ if(el.style.display !== "none") el.style.display = "none"; return; }
  if(el.style.display === "none") el.style.display = "block";
  const d = h.done || 1, t = h.total || 0;
  const p = (h.pct >= 0) ? h.pct : (t ? (d - 1) / t : 0);
  const pc = Math.max(0, Math.min(100, Math.round(p * 100)));
  const seg = t ? (" · " + d + "/" + t + " 块") : "";
  const txt = h.name + seg + " · " + (h.sec > 0 ? Math.round(h.sec) + "s" : pc + "%");
  if(tx && tx.textContent !== txt) tx.textContent = txt;
}
UIPaint.info = paintInfoBar;
UIPaint.hud  = paintHud;

function renderPlaylist(){
  const box = $("playlist");
  $("plCount").textContent = App.songs.length;
  if(!App.songs.length){
    box.innerHTML = '<div class="empty">拖入 .mid / .midi 文件<br>或点击「＋添加」</div>';
    return;
  }
  box.innerHTML = "";
  App.songs.forEach((s, i) => {
    const el = document.createElement("div");
    el.className = "pl-item" + (i === App.cur ? " on" : "");
    el.dataset.i = String(i);                 // dataset 只接受 string（tsc 会提示 number）
    el.innerHTML = '<span class="ix">' + (i+1) + '</span><span class="rdy"></span><span class="nm">' + esc(s.name) +
      '</span><span class="du">' + fmtTime(s.song.duration) + '</span><span class="del">&#215;</span>';
    el.addEventListener("click", e => {
      const tgt = /** @type {Element} */ (e.target);
      if(tgt.classList.contains("del")){
        const dead = App.songs[i];
        releaseEntryElements(dead);
        // ★ 先回收变体再 splice：entry 一旦离场就再也拿不到它的 URL，
        //   createObjectURL 的注册表会一直持有底层数据（revokeObjectURL 全文只在 dropVariants 里）
        dropVariants(dead);
        App.songs.splice(i,1);
        if(App.cur === i){ App.cur = -1; App.playing = false; renderChannels(); buildRoll(); updateMsState(); }
        else if(App.cur > i) App.cur--;
        renderPlaylist(); updateTransport();
        return;
      }
      if(i !== App.cur) selectSong(i, true);
      else togglePlay();
    });
    box.appendChild(el);
  });
  updatePlaylistBadges();
}
/* 从缓存索引里恢复"已渲染"标记：刷新页面后绿点也能立刻亮，
   不用等预渲染链跑一遍。 */
/* 清空所有缓存：磁盘 + 内存标记 */
async function clearAllCache(){
  ++renderJob; ++bitsJob; ++selectToken;
  App.renderingEntry = null;
  setInfoText("正在清空缓存…");                 // 先给反馈：清大缓存可能要几秒
  let why = "";
  try {
    // 还要等写盘队列排空：队列里若还压着 clear 之前排的任务，它们会在
    // clear() 之后才执行，把旧数据写回去。
    await idbQueue;
    const db = await openDB();
    if(!db) why = "打不开数据库";
    else await new Promise(res => {
      let done = false;
      const fin = w => { if(!done){ done = true; if(w) why = w; res(); } };
      try {
        const tx = db.transaction(CACHE_STORE, "readwrite");
        tx.objectStore(CACHE_STORE).clear();
        tx.oncomplete = () => fin("");
        tx.onerror   = () => fin("事务失败（" + ((tx.error && tx.error.name) || "未知") + "）");
        tx.onabort   = () => fin("事务中止（" + ((tx.error && tx.error.name) || "配额或系统回收") + "）");
        setTimeout(() => fin("6 秒未完成，存储可能已不可用"), 6000);
      } catch(e){ fin("clear 抛错（" + ((e && e.name) || e) + "）"); }
    });
  } catch(e){
    why = "异常（" + ((e && e.name) || e) + "）";
  }
  const keepCur = curEntry();
  for(const e of App.songs){
    if(e === keepCur){
      e.ready = false;
      continue;
    }
    e.master = null; e.dirty = true;          // ★ ready 不直写，由 publishIndex 推导
    dropVariants(e); e.audioUrl = null;
  }
  RENDERED.clear();
  publishIndex([]);
  App.cacheEpoch = (App.cacheEpoch || 0) + 1;
  renderPlaylist();
  updatePlaylistBadges();
  flashInfo(why ? ("清缓存未完成：" + why) : "缓存已清空", 9000);
  schedulePrerender();
}
function updatePlaylistBadges(){
  const items = document.querySelectorAll("#playlist .pl-item");
  for(let i=0;i<items.length;i++){
    const el = /** @type {HTMLElement} */ (items[i]);
    const e = App.songs[+el.dataset.i];      // 按 data-i 取，不依赖 DOM 顺序
    if(e){
      // 绿灯 = 磁盘里有缓存。计数不在这里做（tick 的标题栏逻辑自己算，别两处维护）
      el.classList.toggle("ready", !!e.ready);
    }
  }
  const t = document.querySelector("#left .pane-title .grow");
  if(t){
    if(App.songs.length <= 1) t.textContent = "";
  }
}

/* ---------------- 声道面板 ---------------- */
/* 低层只广播"索引/绿点变了"，这里负责重绘 */
on("badges", () => updatePlaylistBadges());
on("ui-refresh", () => { renderPlaylist(); renderChannels(); buildRoll(); });
on("redraw", () => { lastDraw = 0; });

function renderChannels(){
  const box = $("channels");
  const song = curSong();
  if(!song){ box.innerHTML = '<span class="empty" style="padding:8px">未加载文件</span>'; return; }
  box.innerHTML = "";
  song.channels.forEach(c => {
    const el = document.createElement("div");
    el.className = "ch-chip" + (song.mute[c.ch] ? " mute" : "");
    el.dataset.ch = c.ch;
    el.innerHTML = '<b>CH' + String(c.ch+1).padStart(2,"0") + '</b>' +
      '<span title="' + esc(c.name) + '">' + esc(c.name.length > 16 ? c.name.slice(0,15)+"…" : c.name) + '</span>';
    const sel = document.createElement("select");
    WAVE_LABELS.forEach(([v, label]) => {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = c.ch === 9
        ? (v === "auto" ? "自动(鼓)" : label)
        : (v === "auto" ? "自动·" + (WAVE_SHORT[autoWave(c.prog)] || "?") : label);
      if((song.wave[c.ch] || "auto") === v) o.selected = true;
      sel.appendChild(o);
    });
    if(c.ch === 9){
      sel.disabled = true;
    }   // 值已在 registerSong 里定死，这里只禁用
    sel.addEventListener("change", () => { song.wave[c.ch] = sel.value; markDirty("wave", songTimeNow()); });
    el.appendChild(sel);
    if(c.ch !== 9){
      const b = document.createElement("button");
      b.textContent = song.mute[c.ch] ? "MUTE" : "ON";
      if(song.mute[c.ch]) b.classList.add("on");
      b.addEventListener("click", () => {
        song.mute[c.ch] = !song.mute[c.ch];
        renderChannels();
        markDirty("mute", songTimeNow());
      });
      el.appendChild(b);
    }
    box.appendChild(el);
  });
}

/* ---------------- 音符卷帘 ---------------- */
function buildRoll(){
  const song = curSong();
  const cv = $("roll");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  rollW = cv.clientWidth; rollH = cv.clientHeight;
  cv.width = Math.max(1, Math.round(rollW * dpr));
  cv.height = Math.max(1, Math.round(rollH * dpr));
  if(!song){ rollBuf = null; return; }
  const off = document.createElement("canvas");
  off.width = cv.width; off.height = cv.height;
  const g = off.getContext("2d");
  g.scale(dpr, dpr);
  g.fillStyle = "#040704"; g.fillRect(0,0,rollW,rollH);
  // 网格
  g.strokeStyle = "rgba(60,110,55,.22)"; g.lineWidth = 1;
  for(let i=1;i<8;i++){ const x = rollW*i/8; g.beginPath(); g.moveTo(x,0); g.lineTo(x,rollH); g.stroke(); }
  for(let i=1;i<4;i++){ const y = rollH*i/4; g.beginPath(); g.moveTo(0,y); g.lineTo(rollW,y); g.stroke(); }

  const span = Math.max(1, song.hi - song.lo + 1);
  const pad = 4, usable = rollH - pad*2;
  const tScale = rollW / Math.max(0.001, song.duration);
  const rowH = Math.max(1.5, Math.min(6, usable / span));
  g.globalAlpha = 0.95;
  for(const n of song.notes){
    const x = n.start * tScale;
    const w = Math.max(1, n.dur * tScale - 0.6);
    const y = pad + usable - ((n.note - song.lo + 1) / span) * usable;
    g.fillStyle = CH_COLORS[n.ch % CH_COLORS.length];
    g.fillRect(x, y, w, rowH);
  }
  g.globalAlpha = 1;
  rollBuf = off;
}
function drawRoll(){
  const cv = $("roll"), g = cv.getContext("2d");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const now = performance.now();
  if(now - lastRollCheck > 250){
    lastRollCheck = now;
    if(cv.clientWidth !== rollW || cv.clientHeight !== rollH){ buildRoll(); }
  }
  g.setTransform(1,0,0,1,0,0);
  g.clearRect(0,0,cv.width,cv.height);
  const song = curSong();
  if(!rollBuf || !song) return;
  g.drawImage(rollBuf, 0, 0);
  // ★ duration 可能为 0（空曲/损坏曲）→ NaN 坐标，播放头会静默消失；
  //   产物 WAV 又比 song.duration 长约 0.35s，末尾会画出画布右沿被裁。都夹住。
  const f = song.duration > 0 ? Math.max(0, Math.min(1, songTimeNow() / song.duration)) : 0;
  const x = f * rollW * dpr;
  g.fillStyle = "#e9ffd0";
  g.fillRect(x - dpr*0.5, 0, Math.max(1,dpr), cv.height);
  g.fillStyle = "rgba(157,255,157,.18)";
  g.fillRect(x, 0, 10*dpr, cv.height);
}

/* ---------------- 示波器（数据来自离线渲染的波形，不再用 AnalyserNode）----------------
   （SCOPE_SPAN 见文件顶部 CONFIG 区） */
/* 画示波器。这里的每一条防御都是必需的 —— 只要有一个采样是 NaN， */
function drawScope(){
  const cv = $("scope"); if(!cv) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = cv.clientWidth, h = cv.clientHeight;
  // 布局没算好时 clientWidth/Height 会是 0；此时把 canvas 设成 0×0 会让它永久失效
  if(!(w > 0) || !(h > 0)) return;
  const g = cv.getContext("2d"); if(!g) return;

  try {
    const bw = Math.round(w*dpr), bh = Math.round(h*dpr);
    if(cv.width !== bw || cv.height !== bh){ cv.width = bw; cv.height = bh; }
    g.setTransform(dpr,0,0,dpr,0,0);
    g.shadowBlur = 0;                               // 先清干净，别把上一帧的影子带过来
    g.fillStyle = "#040704"; g.fillRect(0,0,w,h);

    // 网格
    g.strokeStyle = "rgba(60,110,55,.25)"; g.lineWidth = 1;
    for(let i=1;i<8;i++){ const x = w*i/8; g.beginPath(); g.moveTo(x,0); g.lineTo(x,h); g.stroke(); }
    for(let i=1;i<4;i++){ const y = h*i/4; g.beginPath(); g.moveTo(0,y); g.lineTo(w,y); g.stroke(); }

    const e = curEntry();
    const buf = e && e.scopeBuf;
    let peak = 0;
    let drew = false;

    // 需要有足够长的缓冲才画波形（span 要能放下整个窗口）
    const span = Math.min(SCOPE_SPAN, Math.floor(((buf && buf.length) || 0) - 2));
    if(buf && span > 8){
      const sr = e.scopeRate || 11025;
      const t = songTimeNow();
      let start = Math.floor((isFinite(t) ? t : 0) * sr);
      if(!isFinite(start) || start < 0) start = 0;

      // 过零触发，让波形不左右乱跑
      let trig = Math.min(start, Math.max(0, buf.length - span - 1));
      const lim = Math.min(buf.length - span - 1, start + Math.round(sr * 0.15));
      for(let i = start; i < lim; i++){
        // ★ i > 0 放在最前面：i 为 0 时 buf[-1] 是 undefined，比较结果同样是 false，
        //   行为不变；写出来只是让"不会读到负下标"这个意图显式可见（报告 #8）。
        if(i > 0 && buf[i-1] < 0 && buf[i] >= 0){ trig = i; break; }
      }
      trig = Math.max(0, Math.min(trig, buf.length - span - 1));

      for(let i=0;i<span;i++){
        const raw = buf[trig + i];
        const v = (typeof raw === "number" && isFinite(raw)) ? raw / 32768 : 0;
        const a = v < 0 ? -v : v;
        if(a > peak) peak = a;
      }
      const gain = (peak > 1e-4) ? Math.min(4, Math.max(1, 0.92 / peak)) : 1;

      g.lineWidth = 1.6;
      g.strokeStyle = "#6fe36f";
      g.beginPath();
      for(let i=0;i<span;i++){
        const raw = buf[trig + i];
        const v0 = (typeof raw === "number" && isFinite(raw)) ? raw / 32768 : 0;
        const v = Math.max(-1, Math.min(1, v0 * gain));   // 夹紧，别画出框
        const x = i / span * w;
        const y = h/2 - v * (h/2 - 5);
        if(!isFinite(x) || !isFinite(y)) continue;
        if(i === 0) g.moveTo(x,y); else g.lineTo(x,y);
      }
      g.lineWidth = 4.5; g.strokeStyle = "rgba(110,230,110,.20)";
      g.stroke();
      g.lineWidth = 1.6; g.strokeStyle = "#6fe36f";
      g.stroke();
      drew = true;
    }

    if(!drew){
      g.lineWidth = 1.4; g.strokeStyle = "#2b4a24";
      g.beginPath(); g.moveTo(0, h/2); g.lineTo(w, h/2); g.stroke();
    }

    const pct = isFinite(peak) ? Math.round(peak*100) : 0;
    g.fillStyle = "#ffb000"; g.font = "10px ui-monospace,Menlo,monospace";
    g.fillText("PEAK " + String(pct).padStart(3," ") + "%", 7, 12);
    g.fillStyle = peak > 0.95 ? "#ff6b6b" : "#4f7748";
    g.fillText("44.1k", 7, h-6);
  } catch(err){
    // 万一还是炸了：把画布恢复成干净状态，别留半张坏图
    try { g.setTransform(1,0,0,1,0,0); g.shadowBlur = 0; g.globalAlpha = 1;
          cv.width = cv.width || 1; g.fillStyle = "#040704"; g.fillRect(0,0,cv.width,cv.height);
    } catch(_){}
    console.warn("[示波器] 绘制异常", err);
  }
}

/* ---------------- 主循环 ---------------- */
/* 状态清单 A 类：主循环的两个节流快照（上一次写进 DOM 的值） */
let lastPct = -1, lastTimeStr = "";
/* 卷帘/示波器/主循环的私有状态（只在本模块用） */
let rollBuf = null, rollW = 0, rollH = 0;      // 音符卷帘的离屏画布
let lastSweep = 0, lastTitle = 0;              // 主循环里的节流时间戳
let rzT = null;                                // resize 防抖
// ★ 画布重绘节流：暂停时不再每帧重画（tick 里用到）
let lastDraw = 0, lastRollCheck = 0;
function tick(){
  requestAnimationFrame(tick);
  // 巡检：任何时刻只允许当前元素发声
  const now = performance.now();
  if(now - lastSweep > 500){
    lastSweep = now;
    const act = P();
    for(const el of AUDIO){
      if(el === act) continue;
      if(!el.paused) { try { el.pause(); } catch(e){} }
      if(!el.muted) el.muted = true;
    }
    if(act.muted) act.muted = false;
  }
  const e = curEntry();
  const t = songTimeNow();
  const dur = songLength();
  const f = dur ? Math.min(1, t/dur) : 0;
  // ★ 只在值真的变了才写样式。暂停/停止后 rAF 仍在跑、f 不再变化，
  //   但每帧都写一次 width 会持续触发 style recalc + 整条 seek 栏的 layout。
  const pct = f * 100;
  if(Math.abs(pct - lastPct) > 0.03){          // 0.03% 在屏幕上不到 0.1px
    lastPct = pct;
    $("seekFill").style.width = pct + "%";
    $("seekHead").style.left = "calc(" + pct + "% - 1px)";
  }
  const tStr = fmtTime(t);                     // 时间的字符串表示只精确到秒，更省
  if(tStr !== lastTimeStr){ lastTimeStr = tStr; $("tCur").textContent = tStr; }
  // 一次性提示到期（时间戳代替定时器：旧消息不会清掉新消息）
  // 低层模块只置脏，这里统一重绘（避免 store 直接调用 UI 函数）
  if(App.transportDirty){ App.transportDirty = false; updateTransport(); }
  if(App.infoDirty){ App.infoDirty = false; updateInfo(); }
  paintInfoBar();      // 内含过期清理与文本对账
  paintHud();
  // 标题栏：n/N 已缓存 + 是否还在预处理（区分"没活干"和"卡住了"）
  if(now - lastTitle > 1000){
    lastTitle = now;
    const tt = document.querySelector("#left .pane-title .grow");
    if(tt && App.songs.length > 1){
      const rd = App.songs.filter(x => x.ready).length;
      const busy = prerun || !!pickPrerenderTarget();
      const txt = rd + "/" + App.songs.length + " 已缓存" + (busy ? " · 预处理中…" : "");
      if(tt.textContent !== txt) tt.textContent = txt;
    }
  }
  const playingNow = App.playing && !P().paused;
  if(playingNow ? (now - lastDraw > 33) : (lastDraw !== -1)){
    lastDraw = playingNow ? now : -1;
    drawScope();
    drawRoll();
  }
  // 声道活动指示（按渲染时预先算好的活动网格）
  if(e && e.activity){
    const {grid, res, n} = e.activity;
    const idx = Math.min(n-1, Math.floor(t * res));
    const mask = grid[idx] | 0;
    const chips = $("channels").children;
    for(let i=0;i<chips.length;i++){
      const c = chips[i], ch = +c.dataset.ch;
      const on = !!(mask & (1 << ch));
      if(on !== c.classList.contains("act")) c.classList.toggle("act", on);
    }
  }
}

/* ---------------- 文件加载 ---------------- */
/* ------------------------------------------------------------------ */
function registerSong(buffer, name){
  const song = parseMidi(buffer);
  song.wave = {}; song.mute = {};
  song.channels.forEach(c => { song.wave[c.ch] = "auto"; song.mute[c.ch] = false; });
  if(song.wave) song.wave[9] = "drum";
  // 内容指纹：同名不同内容的文件必须有不同的缓存键
  song.srcHash = buffer.byteLength + ":" + quickHash(buffer);
  App.songs.push({name, song});
  return App.songs.length - 1;
}
/* ★ 按名称排序（自然序：track2 排在 track10 前，不是字典序 "track10" < "track2"）。 */
function sortSongsByName(){
  if(App.songs.length < 2) return;
  const cur = curEntry();                       // 记对象，不记下标
  const cmpName = a => String(a && a.name || "");
  App.songs.sort((a, b) => {
    const x = cmpName(a), y = cmpName(b);
    const r = x.localeCompare(y, undefined, { numeric: true, sensitivity: "base" });
    return r !== 0 ? r : (x < y ? -1 : (x > y ? 1 : 0));
  });
  if(cur){ const i = App.songs.indexOf(cur); if(i >= 0) App.cur = i; }
}
function refreshAll(selectNew){
  if(selectNew && App.cur < 0) App.cur = 0;
  renderPlaylist(); renderChannels(); buildRoll(); updateTransport(); updateInfo();
  setMsMetadata();
  updateMsState();
  updatePlaylistBadges();
  const e = curEntry();
  if(e && (!e.master || e.dirty)) kickRender(e, {});     // 提前渲染，点播放时就是即时的
  schedulePrerender();                                   // 列表变了就重启预渲染链
}
function loadFromUrl(url, displayName){
  return fetch(url, {cache:"no-store"})
    .then(r => { if(!r.ok) throw new Error("HTTP " + r.status); return r.arrayBuffer(); })
    .then(buf => {
      const rawBase = url.split("/").pop();
      let base = rawBase;
      try { base = decodeURIComponent(rawBase); } catch(e){}
      const name = displayName || base.replace(/\.[^.]+$/, "");
      const i = registerSong(buf, name);
      refreshAll(true);
      return i;
    });
}
function addFiles(files){
  const list = [...files].filter(f => /\.(mid|midi|kar|rmi)$/i.test(f.name) || /midi/i.test(f.type));
  if(!list.length){ flashInfo("没有找到 .mid / .midi 文件", 8000); return; }
  let pending = list.length;
  const done = () => {
    if(--pending === 0){ sortSongsByName(); refreshAll(true); }   // ★ 整批读完排一次
  };
  list.forEach(f => {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        registerSong(fr.result, f.name.replace(/\.(mid|midi|kar|rmi)$/i,""));
        done();
      } catch(err){
        // 底层现在会给出明确原因（"轨道数据不完整…"/"文件数据不完整…"）。
        // 仍保留 Out of bounds 的翻译作为兜底：不同引擎/旧路径可能还是抛出内部错误串。
        const msg = String(err && err.message || err);
        flashInfo("解析失败: " + f.name + "\n" +
              (/Out of bounds/.test(msg)
                ? "文件数据不完整，或不是标准 MIDI（轨道内部声明的长度与实际内容不符）"
                : msg), 8000);
        done();
      }
    };
    fr.onerror = () => { flashInfo("读取失败: " + f.name, 8000); done(); };
    fr.readAsArrayBuffer(f);
  });
}

function updateInfo(){
  const song = curSong(); if(!song) return;
  const firstTempo = (song.tempos && song.tempos.length > 1) ? song.tempos[1].us : 500000;
  const bpm = Math.round(60000000 / firstTempo * 10) / 10;
  App.infoText = "FMT" + song.format + " · " + song.ntrks + "TRK · " +
    song.noteCount + " NOTES · " + song.ppq + "PPQ · " + bpm + " BPM";
  if(!App.renderMsg){ const el = $("info"); if(el && el.textContent !== App.infoText) el.textContent = App.infoText; }
}

/* ---------------- 事件绑定 ---------------- */
$("btnPlay").addEventListener("click", () => { togglePlay(); });
$("btnStop").addEventListener("click", stop);
$("btnPrev").addEventListener("click", () => { if(App.cur > 0) selectSong(App.cur-1, true); else seek(0); });
$("btnNext").addEventListener("click", () => { if(App.cur < App.songs.length-1) selectSong(App.cur+1, true); });

// 两段式确认：第一次点 → 提示"再点一次"，4 秒内再点才真的清。
// 不依赖 confirm()（见 clearAllCache 顶部注释）。
let clearArmT = -Infinity;   // ★ 不能用 0：performance.now() 是"页面加载后"的毫秒数，
                             //   刚载入的 4 秒内 now-0 < 4000，第一次点击会跳过确认直接清空。
$("btnClearCache").addEventListener("click", () => {
  if(performance.now() - clearArmT > 4000){
    clearArmT = performance.now();
    flashInfo("再点一次「清缓存」确认清空", 4000);
    return;
  }
  clearArmT = -Infinity;      // ★ 复位必须用 -Infinity 而不是 0：0 与"页面刚加载"
clearAllCache().catch(err => flashInfo("清缓存异常：" + ((err && err.message) || err), 9000));
});
$("selCrush").addEventListener("change", e => {
  App.crush = +e.target.value;
  markDirty("bits", songTimeNow());            // 位深只影响导出阶段，不必重渲染干声
});
$("volume").addEventListener("input", e => { P().volume = e.target.value/100; });

$("seekWrap").addEventListener("pointerdown", e => {
  const song = curSong(); if(!song) return;
  const wrap = e.currentTarget;
  const r = wrap.getBoundingClientRect();
  const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  seek(f * songLength());
  const move = ev => {
    const r2 = wrap.getBoundingClientRect();      // 用上面捕获的引用，别用 ev/e.currentTarget
    const f2 = Math.max(0, Math.min(1, (ev.clientX - r2.left) / r2.width));
    seek(f2 * songLength());
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  // ★ 必须同时监听 pointercancel：iOS 上拖动被系统手势/来电接管时只派发 cancel，
  //   up 永不执行 → window 上的 move 残留到下次刷新，之后任何 pointermove 都会 seek。
  window.addEventListener("pointercancel", up);
});

$("fileInput").addEventListener("change", e => { addFiles(e.target.files); e.target.value = ""; });

// 拖放
const dropEl = $("drop");
["dragenter","dragover"].forEach(t => document.addEventListener(t, e => {
  e.preventDefault(); dropEl.classList.add("show");
}));
["dragleave","drop"].forEach(t => document.addEventListener(t, e => {
  e.preventDefault();
  if(t === "dragleave" && /** @type {any} */ (e).relatedTarget) return;
  dropEl.classList.remove("show");
}));
document.addEventListener("drop", e => {
  if(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});

// 快捷键
document.addEventListener("keydown", e => {
  const tg = /** @type {any} */ (e.target).tagName;
  // ★ SELECT/TEXTAREA 也要挡：焦点在位深下拉框上时，←/→ 会被当成快进快退，
  //   空格还会被 preventDefault 并切成播放/暂停，用户根本没法用键盘选位深。
  if(tg === "SELECT" || tg === "TEXTAREA") return;
  if(tg === "INPUT" && /** @type {any} */ (e.target).type !== "range") return;
  if(e.code === "Space"){ e.preventDefault(); togglePlay(); }
  else if(e.code === "ArrowLeft"){ seek(songTimeNow() - 5); }
  else if(e.code === "ArrowRight"){ seek(songTimeNow() + 5); }
  else if(e.code === "ArrowUp"){ e.preventDefault(); const v = Math.min(100,+$("volume").value+5); $("volume").value = v; P().volume = v/100; }
  else if(e.code === "ArrowDown"){ e.preventDefault(); const v = Math.max(0,+$("volume").value-5); $("volume").value = v; P().volume = v/100; }
});

window.addEventListener("resize", () => { clearTimeout(rzT); rzT = setTimeout(buildRoll, 150); });

