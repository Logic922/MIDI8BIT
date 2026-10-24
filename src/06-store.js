/* ==================================================================
   4. 磁盘缓存 —— 唯一的一层存储
   ------------------------------------------------------------------
   渲染的耗时几乎全在音频线程（建节点只要 0.024ms/音符，831ms 全花在
   20 秒音频的实际渲染上），没法绕开；但同一首歌 + 同一套波形/静音设置
   只需要渲染一次，缓存下来之后打开页面就接近秒开。
   位深不影响缓存 —— 量化是在导出成品时才做的。
   ================================================================== */
const CACHE_DB = "midi8bit-master", CACHE_STORE = "m";
let dbPromise = null;                // IndexedDB 连接（成功或 3 秒超时后都置回 null）
let renderOwner = 0;                 // "谁拥有当前 renderingEntry"的令牌（startRender 用）
/* ---- 缓存预算 CACHE_BYTES 见文件顶部 CONFIG 区 ----
   按**字节**记，不按条数：旧写法 CACHE_MAX = 32 条在长曲子上会到 GB 级
   （一条干声 = 时长×采样率×声道×2，4 分钟立体声 ≈ 42MB，32 条最坏 ≈ 1.5GB），
   而 README 承诺的是 160MB 预算。索引条目带 b（字节数），淘汰时最旧的先出累减。 */
function openDB(){
  if(dbPromise) return dbPromise;
  let to = null, timedOut = false;
  const done = (v) => { if(to){ clearTimeout(to); to = null; } dbPromise = null; return v; };
  dbPromise = new Promise(ok => {
    try {
      const req = indexedDB.open(CACHE_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(CACHE_STORE);
      // ★ 成功时也要清掉那个 3 秒定时器 —— 否则它会照常触发、
      //   把 dbPromise 置回 null，于是每次 openDB 都重开一条连接，只增不减
      req.onsuccess = () => {
        // ★ 超时之后才到的连接：Promise 已决，没人会持有它 → 必须主动 close，
        //   否则连接被永久打开却无法回收（原来只修了"成功早于超时"这一半）。
        if(timedOut){ try { req.result.close(); } catch(e){} return; }
        if(to){ clearTimeout(to); to = null; }
        ok(req.result);
      };
      req.onerror = () => ok(done(null));
      to = setTimeout(() => { timedOut = true; ok(done(null)); }, 3000);
    } catch(e){ ok(null); dbPromise = null; }   // 同步抛出也不留缓存
  });
  return dbPromise;
}
/* FNV-1a 内容指纹，只扫前 8KB —— 足够区分"同名不同内容"。 */
function quickHash(buf){
  if(!buf || typeof buf.byteLength !== "number") return "0";
  let h = 0x811c9dc5;
  const n = Math.min(buf.byteLength, 8192);
  const u8 = new Uint8Array(buf, 0, n);
  for(let i = 0; i < n; i++){ h ^= u8[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}
function masterKey(entry){
  const song = entry.song;
  const rate = App.renderRate || RENDER_RATE;
  const w = song.channels.map(c => c.ch + ":" + (song.wave[c.ch] || "auto") +
              (song.mute[c.ch] ? "M" : "")).join(",");
  // 母带链的每个参数都要进缓存键：漏一个就会出现"改了没效果"（因为命中了旧干声）
  return entry.name + "|" + song.noteCount + "|" + Math.round(song.duration*1000) +
         "|" + (song.srcHash || "?") +            // ★ 内容指纹（文件字节数 + 前 8KB 的 FNV-1a）
         "|" + rate +
         "|" + TONE_LP + "|" + HP_HZ + ":" + SHELF_LOW_HZ + ":" + SHELF_LOW_DB +
         ":" + SHELF_HI_HZ + ":" + SHELF_HI_DB + "|v" + MIX_VER + "|" + w;
}
function idbRun(fn){
  return openDB().then(db => new Promise(ok => {
    if(!db) return ok(null);
    try {
      const tx = db.transaction(CACHE_STORE, fn.mode || "readonly");
      const req = fn.run(tx.objectStore(CACHE_STORE));
      let out = undefined, done = false;
      const fin = v => { if(!done){ done = true; ok(v); } };
      req.onsuccess = () => { out = req.result; };
      req.onerror   = () => fin(null);
      tx.oncomplete = () => fin(out === undefined ? null : out);
      tx.onerror    = () => fin(null);
      tx.onabort    = () => fin(null);
      setTimeout(() => { console.warn("[缓存] IndexedDB 请求超时（按未命中处理）"); fin(null); }, 20000);
    } catch(e){ ok(null); }
  }));
}
const idbGet = key => idbRun({run: st => st.get(key)});
const idbDel = key => idbRun({mode:"readwrite", run: st => st.delete(key)});
const idbSet = (key, val) => idbRun({mode:"readwrite", run: st => st.put(val, key)});
/* 把一份干声挂到 entry 上 —— 唯一入口。 */
function attachMaster(entry, res, fromDisk, keyIn){
  entry.master = {pcm: res.pcm, frames: res.frames, nch: res.nch, rate: res.rate,
                  bytes: res.bytes};
  if(res.scopeBuf && res.scopeBuf.length){
    entry.scopeBuf  = res.scopeBuf;
    entry.scopeRate = res.scopeRate || 11025;
  }
  // ★ 键必须由调用方传入（渲染开始前定死的那个），不能在这里现算：
  //   渲染途中改了波形/静音时，现算得到的是**新设置的键**，却配着**旧设置的 PCM**，
  //   storeMaster 会把它写进磁盘并点亮绿灯 → 跨会话命中错误音频，永远不自愈。
  entry.masterKey = keyIn || masterKey(entry);
  if(!fromDisk) delete entry.badKey;
  if(!entry.activity) entry.activity = buildActivityGrid(entry.song);
  if(fromDisk){
    // 能从磁盘读出来 = 磁盘上确实有 → 灯必须亮，且本次会话不必再渲
    const key = entry.masterKey;
    // ★ 不直写 entry.ready：由唯一写者按"索引里有没有"推导
    RENDERED.add(key);
    // ★ 索引自愈：内存索引可能落后/写丢（写盘是异步串行的），
    //   而"能从磁盘读出来"是硬证据 —— 顺手把它补回索引，别让绿点撒谎
    if(!IDB_KEYS.has(key)){
      publishIndex(IDB_IDX.concat([{key, t: Date.now(),
                    b: (res.bytes || (res.frames && res.nch ? res.frames * res.nch * 2 : 0))}]));
      // 索引写走串行队列：storeMaster 的索引写也在队列里，两条直写会互相覆盖
      //（结构化克隆发生在 put() 执行那一刻，而 IDB_IDX 期间可能被整体替换）。
      idbEnqueue(() => idbSet("__idx", IDB_IDX));
    }
    emit("badges");
  }
  return entry.master;
}
/* 取干声：缓存优先，没有才真渲染。两个出口都必须挂到 entry 上。 */
async function getMaster(entry, onProgress){
  const key = masterKey(entry);
  // ★ 直接查磁盘，不要依赖内存里的 IDB_KEYS 索引 ——
  //   索引是异步读的，首次渲染可能跑在它前面，会导致"绿灯亮着却重渲"
  const hit = await idbGet(key);
  if(hit && hit.frames && hit.pcm){
    if(onProgress) onProgress(-1, 0, 1);
    const res = {pcm: hit.pcm, frames: hit.frames, nch: hit.nch, rate: hit.rate,
                 scopeBuf: hit.scope ? new Int16Array(hit.scope) : null,
                 scopeRate: hit.scopeRate || 11025, bytes: hit.bytes};
    attachMaster(entry, res, true);  // ★ 以前就是漏了这一句
    return res;
  }
  const epAtStart = App.cacheEpoch || 0;      // 清缓存代次：渲染期间清过就不许落盘
  const res = await renderMaster(entry.song, onProgress);
  attachMaster(entry, res, false, key);       // ★ 键沿用渲染开始前那个
  storeMaster(entry, res, key, epAtStart);    // 排进串行写盘队列，不 await（不参与调度）
  return res;
}

/* 给可能卡住的异步操作加个上限：后台时 startRendering() 偶发不再返回，
   不能让它把整条预渲染链拖死。 */
function withTimeout(p, ms, tag){
  return Promise.race([
    p,
    new Promise((_, no) => setTimeout(() => no(new Error("超时:" + (tag || ""))), ms))
  ]);
}

/* ---------------- 渲染调度 ---------------- */

/* markDirty 已移到 08-player（它要操作当前 <audio> 元素）。 */
function kickRender(entry, opts){
  if(!entry) return;
  opts = opts || {};
  if(opts.play) intentSet(entry, {play: true});
  if(opts.seek != null) intentSet(entry, {seekAt: opts.seek});
  if(App.renderingEntry === entry) return;        // startRender 已在渲染
  if(entry._loading){
    if((entry.dirty || (entry.intent && entry.intent.play)) && (entry._retryN || 0) < 40){
      entry._retryN = (entry._retryN || 0) + 1;
      clearTimeout(entry._retryT);
      entry._retryT = setTimeout(() => {
        entry._retryT = null;
        if(curEntry() === entry) kickRender(entry);
      }, 1500);
    }
    return;
  }
  if(!entry.dirty && entry.master){
    if(curEntry() === entry && intentTakePlay(entry)){
      if(entry.curBits !== App.crush) kickBits(entry, {play: true});
      else emit("autoplay", entry);
    }
    return;
  }
  if(entry.failUntil && entry.failUntil > performance.now()){
    const left = Math.ceil((entry.failUntil - performance.now()) / 1000);
    setInfoText("渲染接连失败，" + left + " 秒后重试：" + shortName(entry.name));
    return;
  }
  startRender(entry);
}
async function startRender(entry){
  let renderFailed = null;
  const token = ++renderJob;
  const genKey = masterKey(entry);
  App.renderingEntry = entry;
  renderOwner = token;                  // 本次渲染"拥有"这个标志，收尾时凭它判断
  App.renderPct = 0;
  setInfoText("准备中…");
  App.transportDirty = true;
  try {
    const res = await withTimeout(getMaster(entry, (pct, done, total, sec) => {
      if(token !== renderJob) return;
      if(pct === -2){                      // 块内走动
        App.renderPct = 0;
        const mine = (App.renderingEntry === curEntry());
        setInfoText((mine ? "渲染中 " : "后台渲染 ") + shortName(entry.name) +
                    " " + (done||1) + "/" + (total||1) + " 块 · " + Math.round(sec) + "s");
        return;
      }
      if(pct < 0){ App.renderPct = 0; setInfoText("读取缓存…"); return; }
      App.renderPct = pct;
      const mine2 = (App.renderingEntry === curEntry());
      setInfoText((mine2 ? "渲染中 " : "后台渲染 ") + shortName(entry.name) +
                  " " + (done||1) + "/" + (total||1) + " 块 · 完成");
    }), renderBudgetMs(entry.song), "渲染");
    if(token !== renderJob) return;
    entry.master = {pcm: res.pcm, frames: res.frames, nch: res.nch, rate: res.rate, bytes: res.bytes};
    entry.masterKey = genKey;                    // 与这份 PCM 的内容严格对应（见函数头的 genKey）
    entry.scopeBuf  = res.scopeBuf;
    entry.scopeRate = res.scopeRate;
    entry.activity  = buildActivityGrid(entry.song);
    dropVariants(entry);                         // 干声变了，旧变体作废（含 ObjectURL 回收）
    entry.dirty = false;
    applyReadyFromIndex();
    entry.renderFail = 0; entry.failUntil = 0;       // ★ 成功即复位退避，否则一次偶发失败会永久抬高重试间隔
    entry._retryN = 0; clearTimeout(entry._retryT); entry._retryT = null;
    App.renderingEntry = null;
    emit("badges");               // 立刻点亮绿点，别等下一首渲染完
    // 渲染期间又被改过 → 按最新设置再渲染一次（比较目标键，不再用版本号）
    if(masterKey(entry) !== genKey){ entry.dirty = true; startRender(entry); return; }
    await kickBitsNow(entry, App.crush);
    if(token !== renderJob) return;      // ★ 导出期间被切歌/清缓存顶掉了，
                                         //   别把新任务的进度条、HUD、▶ 状态一并清掉
    App.renderPct = -1; setInfoText(null); setRenderHud(null);
    App.infoDirty = true;
    schedulePrerender();          // 无条件排期
    renderFailed = null;
  } catch(err){
    renderFailed = "渲染失败：" + (err && err.message || err);
    entry.renderFail = (entry.renderFail || 0) + 1;
    entry.failUntil = performance.now() + Math.min(120000, 8000 * Math.pow(2, entry.renderFail - 1));
    console.warn("[渲染] 失败", entry.name, "第", entry.renderFail, "次");
    console.warn("[渲染] 失败", entry.name, err);
  } finally {
    const mine = (renderOwner === token);
    if(mine) App.renderingEntry = null;
    if(mine){
      App.renderPct = -1;
      setRenderHud(null);
      ++renderJob;
      if(renderFailed) flashInfo(renderFailed, 8000);
      else setInfoText(null);
    } else if(renderFailed){
      flashInfo(renderFailed, 8000);   // 旧渲染失败了也让用户看见，但不动新渲染的进度
    }
    App.infoDirty = true;
  }
  App.transportDirty = true;
}
/* 位深切换：从干声导出成品，很快 */
function kickBits(entry, opts){
  if(!entry) return;
  opts = opts || {};
  if(opts.play) intentSet(entry, {play: true});
  if(opts.seek != null) intentSet(entry, {seekAt: opts.seek});
  if(!entry.master) return;                       // 干声还没好：意图已记下，交给渲染完成后的收尾
  kickBitsNow(entry, App.crush);
}
/* 生成（或复用）某个位深的成品，带缓存 */
/* 丢掉所有变体并回收 ObjectURL。
   每个变体是一整首 WAV（44.1k 立体声 ≈10MB/分钟），只置空引用会泄漏。 */
function dropVariants(entry){
  if(!entry) return;
  const held = AudioHooks.held ? AudioHooks.held(entry) : null;
  if(entry.variants){
    for(const k of Object.keys(entry.variants)){
      const u = entry.variants[k];
      // held 为 null = 播放层还没注册钩子（启动早期）→ 无法确定是否被持有，
      // 一律延迟回收，绝不误撤正在播放的 URL。
      if(held ? held.has(u) : true){
        retireUrl(entry, u);
        continue;
      }
      try { URL.revokeObjectURL(u); } catch(e){}
    }
  }
  entry.variants = {};
  entry.variantBlobs = {};
  // ★ 这两处也必须清：它们是同一份整首 WAV 的另外两个引用，
  //   只清 variants 等于"看起来回收了、其实每首还留一份"（≈10MB/分钟）
  entry.blob = null;
  entry.audioUrl = null;
  if(AudioHooks.sweep) AudioHooks.sweep(entry);
}
/* 延迟回收：已被逻辑作废、但仍有 <audio> 元素的 dataset.for 指向的 blob URL。
   不能提前 revoke（会使 seek 到未解码区失败），也不能留在 variants 里（旧成品会被复用）。 */
function retireUrl(entry, url){
  if(!entry || !url) return;
  if(!entry.zombie) entry.zombie = [];
  if(entry.zombie.indexOf(url) < 0) entry.zombie.push(url);
}
/* URL 持有/僵尸回收的实现已移到 08-player（它们要读 <audio> 的 dataset.for）。
   这里通过 Audio 钩子访问：AudioHooks.held(entry) / AudioHooks.sweep(entry) / AudioHooks.release(entry)。 */

/* 回收"非当前、且没有元素持有"的变体。 */
function sweepMasters(){
  const cur = curEntry();
  for(const e of App.songs){
    // ★ e.storing = 写盘还没确认。这时候丢 PCM 就可能变成
    //   "内存没有 + 磁盘没有 + 绿灯亮着"，写盘失败后只能整曲重渲。
    //   settleMasterWrite 成功/失败都会调 releaseNonCurrentPcm()，轮不到这里。
    if(e !== cur && e.master && !e.storing){ e.master = null; e.scopeBuf = null; }
  }
  applyReadyFromIndex();
}
function reclaimStaleVariants(){
  const cur = curEntry();
  const ci = App.songs.indexOf(cur);
  for(let i = 0; i < App.songs.length; i++){
    const e = App.songs[i];
    if(e === cur) continue;
    if(ci >= 0 && i > ci && i <= ci + PRERENDER_AHEAD) continue;
    if(!e.variants || !Object.keys(e.variants).length) continue;
    if(AudioHooks.held && AudioHooks.held(e).size) continue;   // 还被某个元素用着，别碰
    dropVariants(e);
  }
}
async function generateVariant(entry, bits){
  const key = String(bits);
  if(entry.variants && entry.variants[key]) return entry.variants[key];
  if(!entry._variantJobs) entry._variantJobs = {};
  if(entry._variantJobs[key]) return entry._variantJobs[key];
  const job = (async () => {
    try {
      const blob = await makeVariant(entry, bits);
      const url = URL.createObjectURL(blob);
      if(!entry.variants) entry.variants = {};
      if(!entry.variantBlobs) entry.variantBlobs = {};
      const prev = entry.variants[key];
      if(prev && prev !== url) retireUrl(entry, prev);   // 防御：极少数路径下已被别处填写
      entry.variants[key] = url;
      entry.variantBlobs[key] = blob;
      return url;
    } finally {
      delete entry._variantJobs[key];
    }
  })();
  entry._variantJobs[key] = job;
  return job;
}
async function kickBitsNow(entry, bits){
  const key = String(bits);
  const token = ++bitsJob;
  if(entry.variants && entry.variants[key]){         // 命中缓存：瞬时
    entry.curBits = bits;
    entry.blob = (entry.variantBlobs && entry.variantBlobs[key]) || null;
    emit("variant", entry, entry.variants[key]);
    if(!App.renderingEntry){ App.renderPct = -1; setInfoText(null); App.transportDirty = true; }
    return;
  }
  App.renderPct = 0;
  setInfoText("生成 " + (bits ? bits + "bit" : "原声") + " 音频…");
  try {
    const url = await generateVariant(entry, bits);
    if(token !== bitsJob) return;
    delete entry.badKey;        // ★ 导出成功 = 这份数据确实能读，撤下黑名单
    App.renderPct = -1; setInfoText(null);
    entry.curBits = bits;
    entry.blob = entry.variantBlobs[key] || null;
    if(curEntry() === entry) emit("variant", entry, url);
    else App.infoDirty = true;
  } catch(err){
    App.renderPct = -1;
    const msg = String((err && err.message) || err);
    if(/not be found|NotFound|DataCloneError/i.test(msg)){
      entry.master = null;
      entry.scopeBuf = null;
      // ★ 不直写 ready：master 已置 null 且 key 已从索引摘掉 → 推导为 false
      entry.failUntil = performance.now() + 8000;   // 短暂退避，避免立刻重试又撞上
      const badKey = entry.masterKey || masterKey(entry);
      entry.badKey = badKey;      // 持续性标记：绿灯判据要一直扣着它
      //  ① 撤销 RENDERED：pickPrerenderTarget 要求 !RENDERED.has(key)，留着它就永不自动重渲。
      RENDERED.delete(badKey);
      publishIndex(IDB_IDX.filter(x => x.key !== badKey));
      idbEnqueue(async () => {
        const rd2 = await idbDelOk(badKey);
        if(!rd2 || !rd2.ok) flashInfo("缓存清理失败：" + ((rd2 && rd2.why) || "未知原因"), 10000);
        await idbSet("__idx", IDB_IDX);
      });
      emit("badges");
      flashInfo("音频数据已失效（存储被回收），稍后重新渲染：" + shortName(entry.name), 9000);
    } else {
      flashInfo("导出失败：" + msg, 6000);
    }
  }
  App.transportDirty = true;
}
/* applyEntryAudio / useVariant / setPlayerTime 已移到 08-player（它们直接操作 <audio>）。 */

/* ---------------- 磁盘缓存：唯一的一层存储 ---------------- */
let idbQueue = Promise.resolve();   // 状态清单 A 类：IndexedDB 写队列（串行化）
function idbEnqueue(fn){
  // ★ 不能静默 catch：写盘/索引/淘汰任何一处抛错都只剩"绿灯不亮"，
  //   没有提示也没有日志 —— settleMasterWrite 是本文件最容易出错的交集带。
  idbQueue = idbQueue.then(fn).catch(err => console.warn("[缓存] 队列任务失败", err));
  return idbQueue;
}

async function loadIdbIndex(){
  for(let attempt = 0; attempt < 2; attempt++){
    const r = await idbGetOk("__idx");
    if(r && r.ok){
      const raw = r.value;
      publishIndex(Array.isArray(raw) ? raw.filter(x => x && x.key) : []);
      IDB_KEYS.forEach(k => RENDERED.add(k));
      App.idxRetry = 0;
      return;
    }
    if(r && r.why && window.console && console.warn) console.warn("[缓存] 索引读取失败：", r.why);
    if(attempt === 0) await new Promise(r2 => setTimeout(r2, 800));   // 再试一次
  }
  // 两次都读不出来：**保持现状，不清空**，稍后自己重试（有次数上限）
  App.idxRetry = (App.idxRetry || 0) + 1;
  flashInfo("缓存索引读取失败：暂时无法判断哪些已缓存（数据没丢）", 12000);
  if(App.idxRetry <= 3) setTimeout(() => idbEnqueue(loadIdbIndex), 6000);
}
/* 把干声存进磁盘（异步串行，不阻塞渲染） */
/* 缓存淘汰 —— **唯一**的出口。
   以前 storeMaster / trimIDB / attachMaster 三份逻辑各自演化，口径跑偏：
   attachMaster 连预算都不看，trimIDB 又和 storeMaster 复制粘贴。
   这里统一，并补上三个以前漏掉的东西：
     ① 当前曲目豁免 —— README 承诺的"永远保住当前曲目"以前**根本没有实现**，
        正在播的那首（记录往往 t 最旧）会被第一个删掉（2-A）；
     ② 先清"字节数未知"的历史条目 —— b 是后加的字段，老索引里没有。
        它们不计入总量，若混进按字节的循环会让 total 减不下去，
        循环就一路删到只剩一条（2-B）。它们本来就是升版遗留的死重；
     ③ 至少留一条 —— 单条就可能超预算，否则会"渲完就删"无限重渲。
   @returns {Array} 被淘汰的索引条目（调用方负责 idbDel + 写回索引） */
function evictCache(){
  const cur = curEntry();
  const keepKey = cur ? masterKey(cur) : null;

  const unknown = [], sized = [], kept = [];
  for(const x of IDB_IDX){
    if(x.key === keepKey){ kept.push(x); continue; }   // ① 当前曲目不参与淘汰
    (x.b ? sized : unknown).push(x);
  }

  const drop = unknown.slice();                        // ② 未知大小的一次性清掉

  const idxOf = new Map();
  for(let i = 0; i < App.songs.length; i++) idxOf.set(masterKey(App.songs[i]), i);
  const ci = (keepKey != null && idxOf.has(keepKey)) ? idxOf.get(keepKey) : -1;
  const rank = x => !idxOf.has(x.key) ? 0 : ((ci >= 0 && idxOf.get(x.key) < ci) ? 1 : 2);
  sized.sort((a,b) => rank(a) - rank(b) || (a.t || 0) - (b.t || 0));
  let total = 0;
  for(const x of kept) total += (x.b || 0);
  for(const x of sized) total += x.b;
  const keepSized = [];
  for(let i = 0; i < sized.length; i++){
    // (sized.length - i) 是"含本条在内、本轮之后还会剩下的条数"
    if(total > CACHE_LOW && keepSized.length + (sized.length - i) > 1){
      total -= sized[i].b;
      drop.push(sized[i]);
    } else {
      keepSized.push(sized[i]);
    }
  }

  return drop;
}
/* 能分辨成功/失败的写盘。 */
function idbSetOk(key, val){
  return new Promise(res => {
    let done = false;
    const fin = (ok, why) => { if(!done){ done = true; res({ok: !!ok, why: why || ""}); } };
    openDB().then(db => {
      if(!db) return fin(false, "无法打开数据库");
      try {
        const tx = db.transaction(CACHE_STORE, "readwrite");
        tx.objectStore(CACHE_STORE).put(val, key);
        tx.oncomplete = () => fin(true);
        tx.onerror  = () => fin(false, "写入失败（" + ((tx.error && tx.error.name) || "未知") + "）");
        tx.onabort  = () => fin(false, "事务中止（" + ((tx.error && tx.error.name) || "配额或系统回收") + "）");
        // 超时按失败处理（让上层回滚而不是假装成功），但把原因区分出来
        setTimeout(() => fin(false, "写入 20 秒未完成"), 20000);
      } catch(e){ fin(false, "写入抛错（" + ((e && e.name) || e) + "）"); }
    }).catch(e => fin(false, "打开库失败（" + ((e && e.name) || e) + "）"));
  });
}
/* ★ 能分辨成功/失败的删除。idbDel 在**成功和失败时都返回 null** —— */
function idbDelOk(key){
  return new Promise(res => {
    let done = false;
    const fin = (ok, why) => { if(!done){ done = true; res({ok: !!ok, why: why || ""}); } };
    openDB().then(db => {
      if(!db) return fin(false, "无法打开数据库");
      try {
        const tx = db.transaction(CACHE_STORE, "readwrite");
        tx.objectStore(CACHE_STORE).delete(key);
        tx.oncomplete = () => fin(true);
        tx.onerror  = () => fin(false, "删除失败（" + ((tx.error && tx.error.name) || "未知") + "）");
        tx.onabort  = () => fin(false, "事务中止（" + ((tx.error && tx.error.name) || "配额或系统回收") + "）");
        setTimeout(() => fin(false, "删除 20 秒未完成"), 20000);
      } catch(e){ fin(false, "删除抛错（" + ((e && e.name) || e) + "）"); }
    }).catch(e => fin(false, "打开库失败（" + ((e && e.name) || e) + "）"));
  });
}
/* ★ 能分辨成功/失败的读取。idbGet 在**读失败/超时**与**"这条不存在"**两种情形下 */
function idbGetOk(key){
  return new Promise(res => {
    let done = false;
    const fin = (ok, value, why) => { if(!done){ done = true; res({ok: !!ok, value: value, why: why || ""}); } };
    openDB().then(db => {
      if(!db) return fin(false, null, "无法打开数据库");
      try {
        const tx = db.transaction(CACHE_STORE, "readonly");
        const rq = tx.objectStore(CACHE_STORE).get(key);
        tx.oncomplete = () => fin(true, rq.result);
        tx.onerror  = () => fin(false, null, "读取失败（" + ((tx.error && tx.error.name) || "未知") + "）");
        tx.onabort  = () => fin(false, null, "事务中止（" + ((tx.error && tx.error.name) || "配额或系统回收") + "）");
        setTimeout(() => fin(false, null, "读取 20 秒未完成"), 20000);
      } catch(e){ fin(false, null, "读取抛错（" + ((e && e.name) || e) + "）"); }
    }).catch(e => fin(false, null, "打开库失败（" + ((e && e.name) || e) + "）"));
  });
}
/* ★★ 真正能看见"磁盘"的检查器 —— checkCacheInvariant() 只活在内存里 */
async function verifyCacheAgainstDisk(){
  const bad = [];
  try {
    const all = await idbRun({ run: st => st.getAllKeys() });
    const onDisk = new Set((Array.isArray(all) ? all : []).filter(k => k !== "__idx"));
    const inIdx  = new Set((IDB_IDX || []).map(x => x && x.key).filter(Boolean));
    for(const k of inIdx)  if(!onDisk.has(k)) bad.push("清单里有、磁盘上没有：" + String(k).split("|")[0]);
    for(const k of onDisk) if(!inIdx.has(k))  bad.push("磁盘上有、清单里没有：" + String(k).split("|")[0]);
  } catch(e){ bad.push("核对失败：" + ((e && e.name) || e)); }
  if(bad.length){
    flashInfo("缓存与磁盘不一致：" + bad.slice(0,2).join("；") + (bad.length>2 ? " 等 "+bad.length+" 项" : ""), 14000);
    if(window.console && console.warn) console.warn("[磁盘核对]", bad);
  }
  return bad;
}
/* ★★ 处理"磁盘上有、清单里没有"的记录 —— 启动整理的一部分。 */
async function adoptOrReapOrphans(){
  await idbQueue;                                  // 别和正在写盘的条目抢
  let all;
  try { all = await idbRun({ run: st => st.getAllKeys() }); }
  catch(e){ return { adopted: 0, reaped: 0 }; }
  const onDisk = (Array.isArray(all) ? all : []).filter(k => k !== "__idx");
  if(!onDisk.length) return { adopted: 0, reaped: 0 };
  const inIdx = new Set((IDB_IDX || []).map(x => x && x.key).filter(Boolean));
  const want  = new Map();
  for(const e of App.songs) want.set(masterKey(e), e);
  const adopt = [], reap = [];
  for(const k of onDisk){ if(inIdx.has(k)) continue; (want.has(k) ? adopt : reap).push(k); }

  if(adopt.length){
    const add = [];
    for(const k of adopt){
      const rec = await idbGet(k);                 // 读真值填 b，否则会被当"未知大小"清掉
      add.push({ key: k, t: 0,
                 b: (rec && rec.bytes) || (rec && rec.frames && rec.nch ? rec.frames * rec.nch * 2 : 0) });
    }
    publishIndex(IDB_IDX.concat(add));             // 磁盘上确实有 → 补进清单
    idbEnqueue(() => idbSet("__idx", IDB_IDX));
  }
  let reaped = 0;
  for(const k of reap){
    const r = await idbDelOk(k);
    if(r && r.ok) reaped++;
  }
  if(adopt.length || reaped){
    flashInfo("缓存整理：收养 " + adopt.length + " 条可用条目，回收 " + reaped + " 条无主记录", 9000);
    if(window.console && console.info) console.info("[缓存] 收养", adopt.length, "回收", reaped);
  }
  return { adopted: adopt.length, reaped };
}
/* ★ 非当前曲目的 PCM 必须一起释放：master 与 scopeBuf 是**同等级**的大对象 */
function releaseNonCurrentPcm(entry){
  if(curEntry() !== entry){
    entry.master = null;
    entry.scopeBuf = null;
  }
}
/* ★ 淘汰的收尾：先删磁盘，且**只把确实删掉了的**从清单里划掉。 */
async function applyEviction(drop){
  if(!drop.length) return;
  const gone = [];
  for(const d of drop){
    const r = await idbDelOk(d.key);
    if(r && r.ok) gone.push(d.key);
    else flashInfo("缓存删除失败：" + ((r && r.why) || "未知原因"), 10000);
  }
  if(gone.length) publishIndex(IDB_IDX.filter(x => !gone.includes(x.key)));
}
function storeMaster(entry, res, keyIn, epIn){
  // ★ 用渲染开始时就定死的键：现算会把"渲染期间改过设置"的新键贴到旧内容上
  //   （灯亮着、内容错，且跨会话命中，永远不自愈）。
  const key = keyIn || entry.masterKey || masterKey(entry);
  RENDERED.add(key);                        // ★ 立刻登记，杜绝"写盘没回来→又渲一次"
  // 【N1】记下**渲染开始**时的缓存代次（不是调用 storeMaster 的此刻）：
  //   清缓存发生在渲染途中时，这份成果属于上一代，落盘就是幽灵占用。
  const ep = (epIn != null) ? epIn : (App.cacheEpoch || 0);
  const data = {pcm: res.pcm, frames: res.frames, nch: res.nch, rate: res.rate,
                // ★ 直接存 TypedArray 视图：结构化克隆只会复制视图范围内的字节，
                //   与 slice().buffer 等价，但省掉一次 40MB（长曲）的主线程同步拷贝。
                scope: res.scopeBuf, scopeRate: res.scopeRate,
                bytes: res.bytes};
  // ★ 非当前曲目的 PCM 不能在这里就松开：写盘还没成功，一旦失败就是
  //   "内存没有 + 磁盘没有 + 绿灯亮着"（B9）。改到写盘确认成功之后再松。
  idbEnqueue(() => settleMasterWrite(entry, key, data, ep));
}
/* ★ storeMaster 的队列体：写盘 → 代次检查 → 记账/驱逐 → 索引写。 */
async function settleMasterWrite(entry, key, data, ep){
    const w = await idbSetOk(key, data);
    // 【N1】本轮期间清过缓存 → 这份是"清完之后才落盘"的数据，留着就是
    //   索引里没有、谁也淘汰不掉的幽灵占用。删掉并撤销登记，当它没发生。
    if(ep !== (App.cacheEpoch || 0)){
      const rd = await idbDelOk(key);
      if(!rd || !rd.ok) flashInfo("缓存清理失败：" + ((rd && rd.why) || "未知原因"), 10000);
      RENDERED.delete(key);
      return;
    }
    const okw = !!(w && w.ok);
    if(!okw){
      RENDERED.delete(key);                    // 撤销"已渲过"，允许以后重试
      entry.storeFailUntil = performance.now() + 60000;   // 写盘退避（≠ 渲染退避）
      emit("badges");
      console.warn("[缓存] 写盘失败，已撤销就绪状态，稍后重试：", entry.name, w && w.why);
      releaseNonCurrentPcm(entry);
      applyReadyFromIndex();   // ★ 必须在释放 master 之后推导，否则 ready 会停在旧值
      flashInfo("缓存写入失败：" + ((w && w.why) || "未知原因") + "（本次播放不受影响）", 10000);
      return;                                  // 不入索引
    }
    releaseNonCurrentPcm(entry);
    const next = IDB_IDX.filter(x => x.key !== key).concat([{key, t: Date.now(), b: data.bytes || 0}]);
    next.sort((a,b) => (a.t||0) - (b.t||0));
    publishIndex(next);
    // 淘汰只有 evictCache() 一个出口（含当前曲目豁免 + 历史条目清理）
    const drop = evictCache();
    if(drop.length) cachePressure = true;   // 发生过淘汰 ⇒ 缓存真的满了（比拿 used 比阈值可靠）
    await applyEviction(drop);
    delete entry.badKey;
    const wi = await idbSetOk("__idx", IDB_IDX);
    if(!wi || !wi.ok){
      flashInfo("缓存索引写入失败：" + ((wi && wi.why) || "未知原因") + "（已渲内容稍后仍可读出）", 10000);
    }
}
/* ==================================================================
   ★★ 缓存不变量（唯一真相）—— 改任何缓存代码前先读这段
   ------------------------------------------------------------------
   对任意 key K（K = masterKey(song)，含 song.wave / song.mute）：

     【可强制形式 —— 由 checkCacheInvariant() 逐条核对】
       A. IDB_KEYS 恰好等于 IDB_IDX 里全部 key 的集合（无多、无少、无重复）
       B. e.ready === ( IDB_KEYS.has(K) && e.badKey !== K )   ← 只认磁盘，内存不算

     【最终一致形式 —— 写盘是异步的，只能保证"写成功后成立"】
       C. 磁盘上有 K 的 PCM  ⟺  IDB_IDX 含 K
          （失败分支必须把 K 从索引里摘掉；成功分支才允许加入。见 storeMaster）

   而 **绿灯** 的判据是"此刻能不能立刻拿到干声"：
     e.ready === ( IDB_KEYS.has(K) && e.badKey !== K )      ← 只认磁盘，内存不算

   为什么是"或"：用户要在**渲染完成那一刻**就看到绿灯（那时数据还在内存里、
   写盘还没回来）；同时磁盘上有的也必须亮。历史上灯乱窜的**根源**是两个写者
   实现了同一个标志的两种含义 —— startRender 收尾按"内存有"直接写 true，
   applyReadyFromIndex 按"磁盘有"判 false，互相覆盖。

   写者纪律（三条，改缓存前逐条确认）：
     ① IDB_IDX / IDB_KEYS 只能经 publishIndex() 修改，禁止整段直接赋值；
     ② e.ready 只能由 applyReadyFromIndex() 写，禁止在别处直接赋值；
     ③ RENDERED 语义是"本会话渲过（防重渲）"，恒为磁盘集合的超集，
        绝不可用来判定绿灯。

   本环境（WKWebView，无控制台）无法完全实测 IndexedDB 事务行为，所以配
   checkCacheInvariant() 让页面**自证**：违反不变量时报给用户，而不是静默撒谎。
   ================================================================== */
function publishIndex(next){
  IDB_IDX = next;
  IDB_KEYS = new Set(next.map(x => x && x.key).filter(Boolean));
  applyReadyFromIndex();                 // ★ e.ready 的唯一写者
}
const __invSig = { last: "" };
function checkCacheInvariant(){
  const bad = [], seen = new Set();
  for(const x of (IDB_IDX || [])){
    if(!x || !x.key){ bad.push("索引里有空 key"); continue; }
    if(seen.has(x.key)) bad.push("索引重复：" + x.key);
    seen.add(x.key);
  }
  for(const k of seen)   if(!IDB_KEYS.has(k)) bad.push("索引有、IDB_KEYS 没有：" + k);
  for(const k of IDB_KEYS) if(!seen.has(k))   bad.push("IDB_KEYS 有、索引没有：" + k);
  for(const e of App.songs){
    const K = masterKey(e);
    const want = IDB_KEYS.has(K) && e.badKey !== K;
    if(e.ready !== want) bad.push("ready 与推导不符：" + shortName(e.name));
  }
  const sig = bad.join("|");
  if(bad.length && sig !== __invSig.last){          // 同一条只报一次，别刷屏
    __invSig.last = sig;
    flashInfo("缓存不变量异常：" + bad.slice(0,2).join("；") + (bad.length>2 ? " 等 "+bad.length+" 项" : ""), 12000);
    if(window.console && console.warn) console.warn("[不变量]", bad);
  }
  if(!bad.length) __invSig.last = "";
  return bad;
}
/* 绿灯 = "磁盘上确实有这份干声"（索引里有且未被判坏）。
   ★ 内存里有 master 不算（见下面那段说明）。 */
function applyReadyFromIndex(){
  let changed = false;
  for(const e of App.songs){
    const key = masterKey(e);
    const want = IDB_KEYS.has(key) && e.badKey !== key;
    if(e.ready !== want){ e.ready = want; changed = true; }
  }
  if(changed) emit("badges");
  checkCacheInvariant();   // ★ 自证：违反不变量就报给用户（本环境没有控制台）
}

/* ---------------- 磁盘缓存的容量管理 ---------------- */
/* 启动时整理一次缓存。 */
async function tidyCacheAtStartup(){
  try { await adoptOrReapOrphans(); } catch(e){}
  const drop = evictCache();
  if(!drop.length){ verifyCacheAgainstDisk(); return; }
  const gone = [];
  for(const d of drop){
    const r = await idbDelOk(d.key);
    if(r && r.ok) gone.push(d.key);
    else console.warn("[缓存] 删除失败，保留索引条目：", d.key, r && r.why);
  }
  if(gone.length) publishIndex(IDB_IDX.filter(x => !gone.includes(x.key)));
  const wi = await idbSetOk("__idx", IDB_IDX);
  if(!wi || !wi.ok){
    flashInfo("缓存索引写入失败：" + ((wi && wi.why) || "未知原因"), 10000);
  }
  console.info("[缓存] 启动整理：清掉", drop.length, "条（字节数未知或超预算）");
  verifyCacheAgainstDisk();   // 整理完拿磁盘实测一次（异步，不阻塞）
}
/* 取干声：内存里没有就回磁盘拿 */
async function ensureMaster(entry){
  if(entry.master) return entry.master;
  if(entry._loading) return null;                    // 这条路径自己正在渲它
  if(App.renderingEntry === entry) return null;      // startRender 正在渲它
  if(entry.busy || entry.storing) return null;       // 预渲染循环正在渲它
  if(entry.failUntil && entry.failUntil > performance.now()) return null; // 退避期内
  entry._loading = true;
  try {
    await withTimeout(getMaster(entry, null), renderBudgetMs(entry.song), "渲染");
  } catch(e){
    entry.renderFail = (entry.renderFail || 0) + 1;
    entry.failUntil = performance.now() + Math.min(120000, 8000 * Math.pow(2, entry.renderFail - 1));
  } finally {
    entry._loading = false;
  }
  if(entry.master){ entry.renderFail = 0; entry.failUntil = 0; }   // 成功复位退避
  return entry.master;
}

