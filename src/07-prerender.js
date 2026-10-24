/* ==================================================================
   5. 后台预渲染 —— 一个常驻循环，谁都不许再单独排期
   ------------------------------------------------------------------
   早先的版本把"排期"散落在七八个地方，任何一处漏掉续期整条链就静默死掉。
   现在只有一个常驻循环 + 一个 busy 标志，心跳只负责"确保循环在跑"；
   再配一个看门狗，万一渲染挂住也能自己恢复。
   ================================================================== */
let prerunAt = 0;                   // 本轮预渲染起始时刻（看门狗按它算超时）
let prerunEntry = null;             // 本轮正在预渲染的那首 —— 必须是 **entry**：
                                    // 看门狗要复位的是 entry.busy/storing/_loading，
                                    // 存 song 等于把这三个标志写到不存在的属性上（事故）
let prerunSeq = 0;                  // 本轮归属令牌：卡住的旧循环回来时不许清掉新循环的标志
/* 唯一的"踢一脚"入口：延迟一点启动常驻循环 */

/* 预估一首曲子写盘后的字节数 —— 算法与 master.bytes 一致（Int16 PCM + 示波器缓冲） */
function estMasterBytes(song){
  const rate = App.renderRate || RENDER_RATE;
  const sec = ((song && song.duration) ? song.duration : 120) + 0.35;
  const nch = sec > 420 ? 1 : 2;
  return Math.ceil(sec * rate) * nch * 2 + Math.ceil(sec * Math.round(rate / 4)) * 2;
}

function pickPrerenderTarget(){
  if(App.cur < 0) return null;
  const used = (IDB_IDX || []).reduce((a, x) => a + (x.b || 0), 0);
  const end = App.songs.length;
  for(let i = App.cur + 1; i < end; i++){
    const e = App.songs[i];
    // ready = 磁盘上有（绿灯）；RENDERED = 本次会话渲过（别再渲）
    // 两者都不看就会在写盘慢/失败时无限重渲
    if(e && !e.ready && !e.busy && !e.storing && !RENDERED.has(masterKey(e))
       && !(e.failUntil > performance.now())                 // 渲染退避：渲不出来
       // 【C2】写盘退避：渲染成功但磁盘没写下去 = 没写进 RENDERED（上面失败分支
       // 已 RENDERED.delete）→ 这里若不挡，会立刻重渲一遍再失败，形成 churn。
       && !(e.storeFailUntil > performance.now())){
      if(used + estMasterBytes(e.song) > CACHE_BYTES) return null;
      return e;
    }
  }
  return null;
}
on("prerender", () => prerenderLoop());
async function prerenderLoop(){
  if(prerun && prerunEntry &&
     performance.now() - prerunAt > (renderBudgetMs(prerunEntry.song) + 30000)){
    // ★ 看门狗：复位 entry 上的三个标志，否则这首曲子会被 pickPrerenderTarget
    //   和 ensureMaster 双重跳过 —— 既不再预渲染，点播也永远返回 null。
    //   同时作废本轮令牌，让那个卡住的循环恢复后认不出自己。
    const dead = prerunEntry;
    dead.busy = false; dead.storing = false; dead._loading = false;
    console.warn("[预渲染] 看门狗超时，撤销", dead.name);
    prerun = false; prerunEntry = null; prerunSeq++;
  }
  if(prerun) return;
  if(document.hidden) return;          // 后台渲染会挂住，不碰
  if(App.renderingEntry) return;       // 前台（点播）正在渲染，让它先来，别抢资源
  // 刚播/刚暂停时先别启动离线渲染：媒体元素切换音频会话时
  // 容易让 startRendering() 卡住，等稳定两秒再上
  if(performance.now() - (App.audioChangedAt || 0) < 2000) return;
  prerun = true; prerunAt = performance.now();
  const myRun = ++prerunSeq;           // 本轮令牌：只有它还等于 prerunSeq 时才允许收尾
  // ★ 只在每首曲子开始渲染时刷新一次；渲染途中不再刷新。
  //   所以看门狗的实际语义是"起点 + 预算 + 30 秒"的硬上限（合理，别按"心跳"去调它）。
  const bump = () => { prerunAt = performance.now(); };
  try {
    let n = 0;
    while(n++ < 3){          // 每轮少做点，busy 标志经常释放，卡住也不拖累
      // ★ 用户点播了：让前台先渲，别在后台跟它抢同一颗核（两个 OfflineAudioContext
      //   并发会把前台那次撞成超时，然后弹"渲染失败"）
      if(App.renderingEntry) break;
      const t = pickPrerenderTarget();
      // 只在"真没活了"时收起，避免每 2 秒空转一轮就把 HUD 闪一次
      if(!t){ setRenderHud(null); break; }
      prerunEntry = t;
      t.busy = true; t.storing = true; t._loading = true;   // _loading = 三条渲染路径的统一互斥标志
      const tStart = performance.now();
      // ★ 键在渲染开始前定死（同 startRender）：storeMaster 只认它，不现算
      const genKey = masterKey(t);
      const epAtStart = App.cacheEpoch || 0;   // 渲染期间清过缓存 → 这份不许落盘
      try {
        // 超时必须正比于曲目时长：固定超时会掐掉长曲子 → 反复超时重渲 → 什么都渲不出来
        bump();
        // ★ 后台预渲染的进度只走右下角 HUD —— 这是"看不见的活"。顶栏 #info 只报前台
        //   （点播）渲染，两处不再重复。心跳每 400ms 一次，给出"哪首 / 第几块 / 已几秒"。
        const res = await withTimeout(renderMaster(t.song, (pct, done, total, sec) =>
          setRenderHud("预渲染 " + shortName(t.name), done, total, pct, sec)
        ), renderBudgetMs(t.song), "预渲染");
        t.master = {pcm: res.pcm, frames: res.frames, nch: res.nch,
                    rate: res.rate, bytes: res.bytes};
        t.masterKey = genKey;                      // 与这份 PCM 的内容严格对应
        t.scopeBuf = res.scopeBuf; t.scopeRate = res.scopeRate;
        t.activity = buildActivityGrid(t.song);
        dropVariants(t); t.dirty = false;
        const ci = App.songs.indexOf(curEntry()), ti = App.songs.indexOf(t);
        if(ci >= 0 && ti > ci && ti <= ci + PRERENDER_AHEAD){
          try {
            await withTimeout(generateVariant(t, App.crush), 15000, "备成品");
          } catch(e2){
            console.warn("[预渲染] 备成品未完成（不影响干声写盘）", t.name,
                         (e2 && e2.message) || e2);
          }
        }
        storeMaster(t, res, genKey, epAtStart);    // 再写盘（写完会释放非当前曲目的 PCM）
        reclaimStaleVariants();                    // B5：顺手回收非当前曲目的成品 WAV
        sweepMasters();                            // 内存安全阀：别让 PCM 无限堆积
        t.renderFail = 0;
      } catch(err){
        // 失败/超时不要立刻重试：越试越糟，先退避
        t.renderFail = (t.renderFail || 0) + 1;
        const wait = Math.min(120000, 5000 * Math.pow(2, t.renderFail - 1));
        t.failUntil = performance.now() + wait;
        console.warn("[预渲染] 失败", t.name, "第", t.renderFail, "次，退避", Math.round(wait/1000), "秒",
                     "（花了", Math.round((performance.now()-tStart)/1000), "秒）", err && err.message || err);
      }
      finally { sweepMasters(); t.busy = false; t._loading = false; setTimeout(() => { t.storing = false; }, 1500); }
      await new Promise(r => setTimeout(r, 500));  // 让出主线程
    }
  } finally { if(myRun === prerunSeq){ prerun = false; prerunEntry = null; } }
}
setInterval(prerenderLoop, 2000);      // 心跳：只负责确保循环在跑

