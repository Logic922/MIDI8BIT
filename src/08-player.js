/* ==================================================================
   6. 播放控制 + 系统播放器联动
   ================================================================== */
/* ★ **缓存用满时**，点播前清掉"已走过"的曲目（索引 < App.cur），只留当前及其后已预热的。
   没满就完全不动 —— 绿灯照旧全留。腾地方只从"走过的那头"拿，所以不需要任何 LRU /
   淘汰顺序判断。代价：用满之后往回听要重渲。
   ★ 同一句 filter 顺带清掉**不在当前播放列表里的**条目：keep 只由 App.songs 生成，
     所以"从列表里移除过的曲子"、"上一会话残留的 key"这些幽灵条目也一并扫掉。
   ⚠️ 删除必须经 idbDelOk + publishIndex（IDB_KEYS/IDB_IDX 的唯一写者），并补 idbSetOk("__idx")
   落盘 —— publishIndex 只改内存。RENDERED 不许动（它的语义是"本会话渲过"）。 */
let dropBehindBusy = false;
async function dropCacheBehind(){
  if(dropBehindBusy) return;
  // ★★ 只在**用满**时才清。没满就一个字节都不删 —— 否则预热的绿灯会被无谓地清掉。
  const used = (IDB_IDX || []).reduce((a, x) => a + (x.b || 0), 0);
  // ★ 判据必须是"**真的发生过淘汰**"，不能拿 used 比阈值：淘汰是整条整条丢的，落点可能
  //   远低于任何阈值（复审用 2 万次仿真证明 `CACHE_LOW*0.95` 有 41% 的稳态不可达）。
  if(!cachePressure) return;
  // ★ 自愈：标志可能因"非淘汰式缩小索引"的旁路（clearAllCache、索引自愈）残留成 true。
  //   真没满就复位并返回 —— 否则清完缓存回填后，第一次点播会白删一遍，违背"没满不删"。
  if(used < CACHE_LOW){ cachePressure = false; return; }
  const keep = new Set();
  for(let i = Math.max(0, App.cur); i < App.songs.length; i++) keep.add(masterKey(App.songs[i]));
  const drop = (IDB_IDX || []).filter(x => x && x.key && !keep.has(x.key));
  if(!drop.length) return;
  dropBehindBusy = true;
  try {
    const gone = [];
    for(const d of drop){
      const r = await idbDelOk(d.key);
      if(r && r.ok) gone.push(d.key);
      else flashInfo("缓存删除失败，已跳过：" + ((r && r.why) || "未知原因"), 10000);  // 与 applyEviction 同口径
    }
    if(gone.length){
      publishIndex(IDB_IDX.filter(x => !gone.includes(x.key)));
      // ★ 索引落盘必须走 idbEnqueue 串行队列（本文件对索引写的纪律，见 loadIdbIndex 注释），
      //   并检查结果 —— 否则可能与 storeMaster 的索引写交错，落下一个不含新条目的快照。
      await idbEnqueue(async () => {
        const wi = await idbSetOk("__idx", IDB_IDX);
        if(!wi || !wi.ok) flashInfo("缓存索引写入失败：" + ((wi && wi.why) || "未知原因"), 10000);
      });
      cachePressure = false;   // 本轮已腾过地方 → 解除"用满"标记
    }
  } finally { dropBehindBusy = false; }
}
function play(){
  const e = curEntry(); if(!e) return;
  dropCacheBehind();                           // ★ 清掉当前位置之前的缓存（见上）
  App.wantPlay = true;                         // ★ 用户意图：想听（只有用户操作会改它）
  App.audioChangedAt = performance.now();      // 供预渲染冷却判断
  silenceOthers();                 // 任何时候都只允许一个元素在发声
  if(!e.master){ kickRender(e, {play:true}); return; }          // 还没渲染干声（会先命中缓存）
  // 设置改过但重渲染还没完成：先用手上这份出声，别卡住播放
  if(e.curBits !== App.crush && e.audioUrl && isFinite(P().duration) && P().duration > 0){
    const p = P().play(); if(p && p.catch) p.catch(()=>{});
    kickBits(e, {play: true, seek: P().currentTime});            // 后台补上
    return;
  }
  if(e.curBits !== App.crush || !e.audioUrl){ kickBits(e, {play:true}); return; }
  if(P().error){
    const e2 = curEntry();
    const canRetry = !!(e2 && e2.blob && !e2.usedDataUrl);
    if(canRetry) intentSet(e2, {play: true});    // 由回退的 onload 消费并起播
    fallbackToDataUrl();
    if(!canRetry) flashInfo("音频加载失败，无法播放：" + shortName(e2 ? e2.name : ""), 8000);
    return;
  }
  if(isFinite(P().duration) && P().currentTime >= P().duration - 0.02) P().currentTime = 0;
  const p = P().play();
  if(p && p.catch) p.catch(()=>{});
}
/* 用户按暂停 = 明确取消"渲染完成后自动起播"的意图。 */
function pause(){
  App.wantPlay = false; App.audioChangedAt = performance.now();
  intentCancel(curEntry(), "play");
  try { P().pause(); } catch(e){}
}
function stop(){
  App.wantPlay = false;
  App.audioChangedAt = performance.now();
  intentCancel(curEntry());                     // 停止：起播与待跳转一起撤销
  try { P().pause(); } catch(e){}
  try { P().currentTime = 0; } catch(e){}
  App.playing = false;
  updateTransport(); updateMsState();
}
function seek(t){
  const e = curEntry(); if(!e) return;
  const el = P();
  const sameSrc = !!(el.dataset.for && el.dataset.for === e.audioUrl);
  const lim = (sameSrc && isFinite(el.duration) && el.duration > 0) ? el.duration : e.song.duration;
  t = Math.max(0, Math.min(t, lim || 0));
  if(!sameSrc){
    intentSet(e, {seekAt: t});
    emit("redraw");                   // 暂停中拖动也要补画一次播放头
    updatePositionState(); updateTransport();
    return;
  }
  try { el.currentTime = t; } catch(err){}
  emit("redraw");
  updatePositionState(); updateTransport();
}
function togglePlay(){
  const e = curEntry();
  if(!e) return;
  e.failUntil = 0; e.renderFail = 0;
  if(App.playing) pause(); else play();
}

/* ---------------- 音频元素事件 ---------------- */
/* 双缓冲：两个 <audio> 元素轮换使用。空闲的那个提前把下一首加载好，
   切歌时直接换过去，不会因为 load / 解码而停顿。 */
const AUDIO = [$("player"), $("player-b")];
const P = () => AUDIO[pidx];

/* 把渲染好的成品交给 <audio>（从 06-store 移来：这里全是播放元素的事） */
function useVariant(entry, url){
  if(curEntry() !== entry) return;
  entry.audioUrl = url;
  entry.blob = entry.blob || null;
  applyEntryAudio(entry);
}
/* 把渲染结果交给播放器，并处理"从原位置续播" */
function applyEntryAudio(entry){
  const url = entry.audioUrl;
  const idle = AUDIO[1 - pidx];
  if(idle.dataset.for === url && idle.readyState >= 1){
    // 空闲元素已经预热好这首 → 直接换过去，无缝
    const old = P();
    try { old.pause(); } catch(e){}
    old.muted = true;
    idle.volume = old.volume;
    pidx = 1 - pidx;                 // 切换后 idle 变成活动元素
    silenceOthers();
    setTimeout(() => {
      if(AUDIO[pidx] === old) return;         // 期间又被换回来了，别动
      try { old.removeAttribute("src"); old.load(); } catch(e){}
      delete old.dataset.for;
      sweepZombies();
    }, 1000);
  } else {
    const cur = P();
    if(cur.dataset.for !== url){
      try { cur.pause(); } catch(e){}
      cur.src = url; cur.dataset.for = url; cur.load();
        // ★ 换源之后，其它元素（空闲/预热）里指着的旧 URL 就成了真正的僵尸 ——
        //   旧实现既不换也不清，改动后被保留的旧成品会一直占着内存。
        sweepZombies();
    }
  }
  armLoadWatch(entry);
  App.infoDirty = true;
  App.transportDirty = true;
  {
    const at = intentTakeSeek(entry);
    if(at != null) setPlayerTime(at);
  }
  if(entry.intent && entry.intent.play){
    const el = P();
    // 媒体还没就绪就先别消费意图 —— 留给 loadedmetadata 里的重试，
    // 否则这次 play() 被忽略就再也没人起播了。
    if(el.readyState >= 1 || (isFinite(el.duration) && el.duration > 0)){
      intentCancel(entry, "play");
      play();
    }
  }
  preloadNextEntry();
}
/* 回收僵尸 URL：只有当没有任何元素再指向它时才 revoke。
   入口：dropVariants（重新渲染后）、applyEntryAudio（换源后）、删曲目、清缓存。 */
function sweepZombies(only){
  const list = only ? [only] : App.songs.slice();
  for(const entry of list){
    if(!entry || !entry.zombie || !entry.zombie.length) continue;
    entry.zombie = entry.zombie.filter(u => {
      for(const el of AUDIO){ if(el.dataset.for === u) return true; }
      try { URL.revokeObjectURL(u); } catch(e){}
      return false;
    });
    if(!entry.zombie.length) delete entry.zombie;
  }
}
/* 生成（或复用）某个位深的成品，带缓存 */
/* 某个 entry 的变体 URL 是否仍被 <audio> 元素持有。
   dataset.for 存的就是 URL，所以这是精确判断（当前曲目 / 已预热的下一首）。 */
/* entry 的变体 URL 里，有哪些**正被某个 <audio> 元素持有**。 */
function heldUrlsOf(entry){
  const held = new Set();
  if(!entry || !entry.variants) return held;
  const urls = Object.values(entry.variants);
  if(!urls.length) return held;
  for(const el of AUDIO){
    if(el.dataset.for && urls.indexOf(el.dataset.for) >= 0) held.add(el.dataset.for);
  }
  return held;
}
/* 让所有 <audio> 元素松开对某个 entry 的引用（删曲目 / 清缓存前调用）。 */
function releaseEntryElements(entry){
  if(!entry) return;
  const urls = [];
  if(entry.variants) for(const k of Object.keys(entry.variants)) urls.push(entry.variants[k]);
  if(entry.zombie) for(const u of entry.zombie) urls.push(u);
  if(entry.audioUrl) urls.push(entry.audioUrl);
  if(!urls.length) return;
  for(const el of AUDIO){
    if(!el.dataset.for || urls.indexOf(el.dataset.for) < 0) continue;
    try { el.pause(); } catch(e){}
    try { el.removeAttribute("src"); el.load(); } catch(e){}
    delete el.dataset.for;
  }
}
function urlInUse(entry){ return heldUrlsOf(entry).size > 0; }
AudioHooks.held = heldUrlsOf;
AudioHooks.sweep = sweepZombies;
AudioHooks.release = releaseEntryElements;

function markDirty(kind, atIn){
  const e = curEntry(); if(!e) return;
  const wasPlaying = App.playing;
  const at = (atIn != null ? atIn : 0);   // 位置由调用方（播放层）提供
  if(wasPlaying){ try { P().pause(); } catch(err){} }
  if(kind === "bits"){
    // seek 无条件传：暂停状态下切位深也应该保住播放位置（at 本来就已经取到了）
    kickBits(e, {play: wasPlaying, seek: at});
  } else {
    e.dirty = true;
    kickRender(e, {play: wasPlaying, seek: at});
  }
}

/* 就绪且意图为真 → 起播（原来 store 直接调 play()） */
on("autoplay", (entry) => { if(curEntry() === entry) play(); });

/* 成品就绪：只应用到"当前曲目"，别的曲目等切过去再说（令牌/curEntry 双保险） */
on("variant", (entry, url) => {
  if(curEntry() !== entry) return;
  useVariant(entry, url);
});

function setPlayerTime(t){
  const el = P();                       // 固定住元素，别让换缓冲把它换掉
  try { el.currentTime = t; } catch(e){}
  if(!isFinite(el.duration)){
    el.addEventListener("loadedmetadata", () => {
      try { el.currentTime = t; } catch(e){}
    }, {once:true});
  }
}

/* 当前播放位置/时长 —— 读的是 <audio> 元素，所以归播放层（原来放在 core） */
function songTimeNow(){ return P().currentTime || 0; }
function songLength(){
  if(isFinite(P().duration) && P().duration > 0) return P().duration;
  const e = curEntry();
  return e ? e.song.duration : 0;
}

AUDIO.forEach((el, idx) => {
  el.volume = 0.7;
  el.addEventListener("playing", () => { if(idx !== pidx) return; App.playing = true;  updateTransport(); updateMsState(); });
  el.addEventListener("play",    () => { if(idx !== pidx) return; App.playing = true;  updateTransport(); updateMsState(); });
  el.addEventListener("pause",   () => {
    if(idx !== pidx) return;
    App.playing = false; updateTransport(); updateMsState();
    // ★ 用户主动暂停会先把 App.wantPlay 置 false，所以走到这里且意图仍为真
    //   = 被外部打断（来电 / 别的 App 抢音频会话 / 系统回收）→ 按意图重试恢复。
    noteInterrupt();
  });
  el.addEventListener("timeupdate", () => { if(idx !== pidx) return; updatePositionState(); });
  el.addEventListener("ended", () => {
    if(idx !== pidx) return;
    if($("chkLoop").checked){                       // 循环：重播本首
      try { el.currentTime = 0; el.play(); } catch(e){}
      return;
    }
    if(App.cur >= 0 && App.cur < App.songs.length - 1){
      selectSong(App.cur + 1, true);                // 自动切下一首
    } else {
      App.playing = false; App.wantPlay = false;   // 放完了，别去恢复它
      updateTransport(); updateMsState();
    }
  });
  el.addEventListener("canplay", () => {
    if(idx !== pidx) return;
    if(intentTakePlay(curEntry())) play();          // 兜底重试
  });
  el.addEventListener("loadedmetadata", () => {
    if(idx !== pidx) return;                        // 预热用的那个不用管
    clearTimeout(App.loadWatch); App.loadWatch = null;
    const e = curEntry();
    const at = intentTakeSeek(e);
    if(at != null){
      try { el.currentTime = Math.max(0, Math.min(at, el.duration || at)); } catch(err){}
    }
    if(intentTakePlay(e)) play();
    updateTransport(); updatePositionState();
  });
  el.addEventListener("error", () => {
    if(idx !== pidx) return;
    clearTimeout(App.loadWatch); App.loadWatch = null;
    fallbackToDataUrl();
  });
});
/* ★★ 播放被打断后的自动恢复。 */
function resumeIfWanted(why){
  if(!App.wantPlay) return;
  if(curEntry() !== App.resumeKey) return;      // 已经切歌了，别乱恢复（按下标比会认错人）
  if(document.hidden) return;
  const el = P(); if(!el || !el.src) return;
  if(el.ended) return;                           // 已经放完了
  const oc = window.__m8OutCtx;
  if(oc && oc.state !== "running"){
    try { const rp = oc.resume(); if(rp && rp.catch) rp.catch(()=>{}); } catch(e){}
  }
  if(!el.paused) return;                         // 已经在响
  try { const p = el.play(); if(p && p.catch) p.catch(()=>{}); } catch(err){}
}
function noteInterrupt(){
  if(!App.wantPlay) return;
  App.resumeKey = curEntry();                    // 记下"当时在听的是哪一首"（对象，不是下标）
  App.interruptedAt = performance.now();
}
document.addEventListener("visibilitychange", () => { if(!document.hidden) resumeIfWanted(); });
window.addEventListener("pageshow", () => resumeIfWanted());
window.addEventListener("focus",    () => resumeIfWanted());
window.addEventListener("online",   () => resumeIfWanted());
// 手势兜底：iOS 有些情况下 AudioContext 必须由一次用户手势才能 resume，
// 而上面那些事件都不是手势。不抢会话 —— 只在"没在跑"且页面可见时补一刀。
document.addEventListener("pointerdown", () => {
  const c = window.__m8OutCtx;
  if(c && c.state !== "running" && !document.hidden){
    try { const p = c.resume(); if(p && p.catch) p.catch(()=>{}); } catch(e){}
  }
}, true);
AUDIO.forEach(el => {
  el.addEventListener("webkitbegininterruption", () => noteInterrupt());
  el.addEventListener("webkitendinterruption",  () => resumeIfWanted());
});
/* 提示与 HUD 的实现已上移到 05-core（只写状态），DOM 由 09-ui 的 paintInfoBar/paintHud 负责。 */

/* 把下一首塞进空闲元素预热 */
/* 把"不是当前在播的那个"彻底压住：静音 + 暂停。
   静音是硬保险 —— 就算它被什么逻辑意外启动也发不出声。 */
function silenceOthers(){
  const act = P();
  for(const el of AUDIO){
    if(el === act) continue;
    try { if(!el.paused) el.pause(); } catch(e){}
    el.muted = true;
  }
  act.muted = false;
}
function preloadNextEntry(){
  const nx = App.songs[App.cur + 1];
  if(!nx || !nx.variants) return;
  const url = nx.variants[String(App.crush)];
  if(!url) return;
  const idle = AUDIO[1 - pidx];
  if(!idle.paused) return;                       // 正在出声的元素绝不碰
  if(idle.dataset.for === url) return;
  try {
    idle.src = url;
    idle.volume = P().volume;
    idle.muted = true;                          // 预热期间保持静音
    idle.dataset.for = url;
    idle.load();
    if(!idle.paused) idle.pause();              // 它是"预热"，不是"播放"
  } catch(e){}
}

/* 有些环境（自定义 scheme + WKWebView）对 blob: 媒体加载不稳，
   这里做两件事：加载超时就换 data URL 再试一次；状态显示在信息栏里。 */
function armLoadWatch(entry){
  clearTimeout(App.loadWatch);
  const url = entry && entry.audioUrl;
  App.loadWatch = setTimeout(async () => {
    App.loadWatch = null;
    if(!entry || curEntry() !== entry) return;      // 已经切歌
    if(entry.audioUrl !== url) return;              // 这一首已经换成别的成品
    if(P().dataset.for !== url) return;             // 元素已不指向它
    if(P().readyState >= 1 || P().error) return;
    if(document.hidden) return;          // 后台页面 WebKit 会推迟媒体加载，别误判
    // ★ 走 flashInfo：直写 App.renderMsg 没有自己的定时器，
    //   而 flashInfo 的代次守卫也不会替它清 → 提示永不消失，FMT 行再也回不来
    flashInfo("音频未就绪 · 改用内联数据重试…", 6000);
    fallbackToDataUrl();
  }, 4000);
}
function fallbackToDataUrl(){
  const entry = curEntry();
  if(!entry || entry.usedDataUrl) return;
  if(!entry.blob){
    // 干声刚渲完、变体还在生成的那一瞬间会走到这里。
    // 以前是静默 return —— "音频加载失败"就成了一个没有出口的死状态。
    console.warn("[回退] 变体尚未生成，无法用 data URL 回退：", entry.name);
    flashInfo("音频加载失败：" + shortName(entry.name) + " 的成品还没生成", 5000);
    return;
  }
  entry.usedDataUrl = true;
  const fr = new FileReader();
  fr.onload = () => {
    if(curEntry() !== entry) return;
    const el = P();
    el.src = fr.result;
    // ★ 元素已经换成 data URL，dataset.for 必须跟着改。否则旧 blob URL 永远被判成
    //   "正被 <audio> 持有" → sweepZombies 永不 revoke（≈10MB/分钟常驻内存），
    //   而且 seek() 的 sameSrc 判据也会一直基于这个过期值。
    el.dataset.for = "data:";
    el.load();
    sweepZombies(entry);
    if(App.playing || (entry.intent && entry.intent.play)){ intentCancel(entry, "play"); play(); }
  };
  // 同样的理由：必须走 flashInfo，否则这条提示会永久占住信息栏
  fr.onerror = () => {
    // 回退也失败 → 撤销 play() 里为"回退成功后起播"设置的意图，
    // 否则它会一直挂着，等下一次 loadedmetadata 突然自己播起来。
    if(curEntry() === entry) intentCancel(entry, "play");
    flashInfo("音频加载失败（data URL 回退也失败）", 8000);
  };
  fr.readAsDataURL(entry.blob);
}

/* --- 系统播放器联动（Media Session）：锁屏曲名 / 封面 / 进度 / 按键 --- */
const MS = { ok: ("mediaSession" in navigator) };

/* --- 封面：把音符卷帘画成 512×512 封面 --- */
function buildArtwork(song, name, cb){
  try {
    const S = 512, c = document.createElement("canvas");
    c.width = c.height = S;
    const g = c.getContext("2d");
    g.fillStyle = "#070907"; g.fillRect(0,0,S,S);
    g.strokeStyle = "rgba(60,110,55,.35)"; g.lineWidth = 1;
    for(let i=1;i<8;i++){ const x=S*i/8; g.beginPath(); g.moveTo(x,0); g.lineTo(x,S); g.stroke(); }
    const pad = 34, areaH = 300, span = Math.max(1, song.hi - song.lo + 1);
    const tS = (S - pad*2) / Math.max(0.001, song.duration);
    const rowH = Math.max(1.5, Math.min(6, areaH/span));
    for(const n of song.notes){
      const x = pad + n.start*tS;
      const w = Math.max(1.5, n.dur*tS - 0.6);
      const y = pad + areaH - ((n.note - song.lo + 1)/span) * areaH;
      g.fillStyle = CH_COLORS[n.ch % CH_COLORS.length];
      g.fillRect(x, y, w, rowH);
    }
    g.fillStyle = "#6fe36f"; g.font = "bold 52px ui-monospace,Menlo,monospace";
    g.fillText("MIDI8BIT", pad, S-84);
    g.fillStyle = "#ffb000"; g.font = "26px ui-monospace,Menlo,monospace";
    g.fillText((name||"").slice(0,26), pad, S-44);
    g.fillStyle = "#4f7748"; g.font = "18px ui-monospace,Menlo,monospace";
    g.fillText(song.noteCount + " NOTES · " + fmtTime(song.duration), pad, S-16);
    g.strokeStyle = "#2b4a24"; g.lineWidth = 4; g.strokeRect(2,2,S-4,S-4);
    // 用 data URL 而非 blob：系统进程取封面时 blob: 可能解析不了
    cb(c.toDataURL("image/png"));
  } catch(e){ cb(null); }
}
function setMsMetadata(){
  if(!MS.ok) return;
  const e = curEntry();
  if(!e){ try { navigator.mediaSession.metadata = null; } catch(err){} return; }
  const key = e.name + "|" + e.song.noteCount + "|" + Math.round(e.song.duration);
  const apply = artUrl => {
    const md = { title: e.name, artist: "MIDI8BIT", album: "8-bit MIDI Player" };
    if(artUrl) md.artwork = [{ src: artUrl, sizes: "512x512", type: "image/png" }];
    try { navigator.mediaSession.metadata = new MediaMetadata(md); } catch(err){}
    updateMsBadge();
  };
  if(key === MS.curArtKey && MS.art){ apply(MS.art); return; }
  MS.curArtKey = key;
  buildArtwork(e.song, e.name, url => { MS.art = url; apply(url); });
}
function updateMsBadge(){
  const el = $("msStatus"); if(!el) return;
  if(!MS.ok){ el.textContent = "◌ 系统播放器：不支持"; return; }
  let ok = true;
  try { ok = !!navigator.mediaSession.metadata; } catch(e){ ok = false; }
  el.textContent = ok ? "◉ 系统播放器：已连接（锁屏可控制）" : "◌ 系统播放器：未连接";
  el.style.color = ok ? "#7fe36f" : "";
}
function updatePositionState(){
  if(!MS.ok || !navigator.mediaSession.setPositionState) return;
  const d = P().duration;
  if(!isFinite(d) || d <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: d, playbackRate: P().playbackRate || 1,
      position: Math.max(0, Math.min(P().currentTime, d))
    });
  } catch(e){}
}
function updateMsState(){
  if(!MS.ok) return;
  try { navigator.mediaSession.playbackState = App.playing ? "playing" : (curEntry() ? "paused" : "none"); } catch(e){}
  updatePositionState();
  updateMsBadge();
}
function initMediaSession(){
  if(!MS.ok){ updateMsBadge(); return; }
  const H = (name, fn) => { try { navigator.mediaSession.setActionHandler(name, fn); } catch(e){} };
  H("play",          () => play());
  H("pause",         () => pause());
  H("stop",          () => stop());
  H("previoustrack", () => { if(App.cur > 0) selectSong(App.cur-1, true); else seek(0); });
  H("nexttrack",     () => { if(App.cur < App.songs.length-1) selectSong(App.cur+1, true); });
  H("seekbackward",  d => seek(songTimeNow() - ((d && d.seekOffset) || 5)));
  H("seekforward",   d => seek(songTimeNow() + ((d && d.seekOffset) || 5)));
  H("seekto",        d => { if(d && typeof d.seekTime === "number") seek(d.seekTime); });
  setInterval(updatePositionState, 1000);
}

/* ---------------- 选曲 ---------------- */
let selectToken = 0;                 // 状态清单 A 类：selectSong 的请求令牌：连点防串台
function selectSong(i, autoplay){
  if(i < 0 || i >= App.songs.length) return;
  const token = ++selectToken;
  try { P().pause(); } catch(e){}
  App.cur = i;
  const entry = App.songs[i];
  intentSet(entry, { seekAt: null, play: !!autoplay });   // 本次点击是否要起播
  updateTransport();
  // 显式流程：先用内存 → 再回磁盘 → 都没有才真渲染 → 最后确保起播
  (async () => {
    try {
      if(!entry.master) await ensureMaster(entry);
      if(token !== selectToken) return;
      if(!entry.master){
        // ★ 统一走 kickRender（令牌去重 + failUntil 退避 + withTimeout）。
        //   直接调 startRender 会绕过全部保护（M-3）。
        if(autoplay) intentSet(entry, {play: true});
        kickRender(entry);
        return;
      }
      await kickBitsNow(entry, App.crush);
      if(token !== selectToken) return;
      if(curEntry() === entry && intentTakePlay(entry)) play();
    } catch(e){}
  })();
  setTimeout(() => {
    emit("ui-refresh"); updateTransport();
    setMsMetadata();
    updateMsState();
    schedulePrerender();
  }, 0);
}
function updateTransport(){
  const e = curEntry();
  // ★ 只有"还没有可播音频"时才用 ⋯ 表示渲染中：已有音频在播时，
  //   后台导出（kickBitsNow 也会置 renderPct=0）不该把 ▶/⏸ 图标顶掉。
  $("btnPlay").innerHTML = (App.renderPct >= 0 && !(e && e.audioUrl))
    ? "&#8943;"
    : (App.playing ? "&#10074;&#10074;" : "&#9654;");
  $("tTot").textContent = fmtTime(e ? (e.audioUrl ? (isFinite(P().duration) ? P().duration : e.song.duration) : e.song.duration) : 0);
  if(!e){ App.infoText = "NOTHING LOADED"; if(!App.renderMsg) setInfoText(null); }
}

