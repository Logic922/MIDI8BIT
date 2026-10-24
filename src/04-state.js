/* ==================================================================
   运行时状态清单（报告 #21 的落地方式：**文档化**，不搬家）
   ------------------------------------------------------------------
   审查意见是"后来者很难判断新状态该往哪加"。判据如下，按顺序问：

     1. 它属于"某一首歌"吗？            → 挂 entry.xxx
        （entry = App.songs[i]，随曲目一起被丢弃/重建，天然不串台）
     2. 它属于"整个播放器"吗？          → 挂 App.xxx
        （只有一份，跨曲目存活；rAF 主循环每帧读的就是它）
     3. 它是一次性令牌 / 缓存 / 队列 / 画布 / 节流时间戳这类
        纯模块内部实现细节吗？          → 模块级 let（就是下面这一组）
     4. 它是常量吗？                    → 文件顶部 CONFIG 区
        （解析器自用的两个上限例外：放 PARSE 区段内，保证可独立测试）

   ★ 硬规则：**每首歌的状态一律挂 entry，绝不挂 App** —— 挂 App 的每首歌
     状态在切歌时必然忘记清理（"串台"类事故的根源）。
   ------------------------------------------------------------------
   A. 模块级 let（本文件）  名字 → 用途 / 唯一写者

     dbPromise    IndexedDB 连接（成功或 3 秒超时后都置回 null）  openDB
     renderJob    干声渲染令牌：防"上一首的渲染回调改到这一首"   startRender / kickRender
     bitsJob      位深导出令牌，同理                            kickBits / kickBitsNow
     selectToken  selectSong 的请求令牌，连点防串台             selectSong
     IDB_KEYS     磁盘上有哪些干声 key（== 绿灯判据）            loadIdbIndex / idbSetOk / storeMaster / tidyCacheAtStartup / clearAllCache
     IDB_IDX      缓存索引本体 [{key,t,b}]（内存为准，b=字节数）  loadIdbIndex / idbSetOk / tidyCacheAtStartup / evictCache
     prerun       预渲染循环 busy 标志                          prerenderLoop
     prerunAt     本轮预渲染起始时刻（看门狗按它算超时）          prerenderLoop
     prerunEntry  本轮正在预渲染的那首（**entry**；看门狗要复位它的 busy/storing/_loading）  prerenderLoop
     prerunSeq    预渲染轮次令牌：卡住的旧循环回来时不许清掉新循环的标志                    prerenderLoop
     RENDERED     本会话已渲过的 key，防写盘慢/失败时反复重渲     startRender / prerenderLoop
     renderOwner  "谁拥有当前 renderingEntry"的令牌             startRender
     idbQueue     IndexedDB 写队列（串行化，避免并发写）          idbEnqueue
     pidx         双缓冲：当前在用的是哪个 <audio>              selectSong / applyEntryAudio / kickRender…
     rollBuf / rollW / rollH   卷帘离屏画布及其尺寸              buildRoll
     lastSweep    主循环"只留一个元素在响"巡检的节流时间戳        tick
     lastTitle    标题栏 "n/N 已缓存" 的节流时间戳                tick
   ★ entry._loading  挂在 entry 上（**不是** App 上的单值字段）：三条渲染路径
                     （ensureMaster / startRender / 预渲染循环）的统一互斥标志。
                     用单值字段会被"切到别的曲子"覆盖掉，于是同一首能被渲两份。
     lastPct      进度条宽度上一次写入的值（避免每帧写样式）       tick
     lastTimeStr  时间文本上一次写入的值（同上）                  tick
     rzT          resize 防抖定时器                             resize 监听
     NOISE_DATA   白噪声样本缓存 Map（按采样率），只增不删        noiseSamples（const，内容可变）

   B. App（播放器 + 界面状态）—— 逐字段说明见下面 App 对象定义处。
   C. entry（每首歌）—— 逐字段说明见 registerSong / attachMaster 处。

   ★ 刻意**不**把这十几个 let 搬进 App：那要动几百处引用，收益只是"看起来
     整齐"，反而把这份清单本来要解决的"该往哪加"重新搅浑（报告 #21 就是指
     这种改法，已按文档化落实）。只有引用点极少的变量才值得考虑搬迁 ——
     目前没有达到"搬了明显更清楚"的程度。
   ================================================================== */
/* 模块级状态（本文件只留"跨模块共享"的那几个；各自的私有状态已归位到使用它的模块）
     名字 → 用途 / 唯一写者
     renderJob    干声渲染令牌：防"上一首的渲染回调改到这一首"   startRender / kickRender
     bitsJob      位深导出令牌，同理                            kickBits / kickBitsNow
     IDB_KEYS     磁盘上有哪些干声 key（== 绿灯判据）            loadIdbIndex / idbSetOk / storeMaster / tidyCacheAtStartup / clearAllCache
     IDB_IDX      缓存索引本体 [{key,t,b}]（内存为准，b=字节数）  loadIdbIndex / idbSetOk / tidyCacheAtStartup / evictCache
     prerun       预渲染循环 busy 标志（UI 也要读）              prerenderLoop
     RENDERED     本会话已渲过的 key，防写盘慢/失败时反复重渲     startRender / prerenderLoop
     pidx         双缓冲：当前在用的是哪个 <audio>              selectSong / applyEntryAudio |

   已归位到各模块的私有状态（不要在别处读写）：
     06-store  dbPromise / renderOwner / idbQueue
     07-prerender  prerunAt / prerunEntry / prerunSeq
     08-player selectToken
     09-ui     rollBuf / rollW / rollH / lastSweep / lastTitle / rzT /
               lastPct / lastTimeStr / lastDraw / lastRollCheck
     03-synth  NOISE_DATA
   ================================================================== */
/* ---------------- 跨模块共享的运行时状态 ---------------- */
let renderJob  = 0;                 // 当前曲目渲染的令牌（防串台）
let bitsJob    = 0;                 // 位深导出的令牌
let IDB_KEYS   = new Set();         // 磁盘上有哪些干声（绿灯的依据）
let IDB_IDX    = [];                // 索引本体（{key,t,b}，内存为准；b = 该条缓存占用字节数）
let prerun     = false;             // 预渲染循环 busy 标志
let RENDERED   = new Set();         // 本会话里"已经渲过"的 key —— 防止写盘慢/失败时反复重渲
let pidx       = 0;                 // 双缓冲：当前在用的是哪个 <audio>

