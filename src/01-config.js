// @ts-check —— 供编辑器与 dev 侧 `tsc --checkJs` 检查（dev 目录在工作区，不属于交付物）。
//   运行时只是一条注释，产品仍是零依赖单文件。`$()` 刻意返回 any：这里绝大多数元素访问
//   是 textContent/style/value 混用，用 HTMLElement 推断会制造上百条噪声；
//   id 拼写由 dev/check-ids.mjs 直接与 HTML 的 id 对比，比类型检查更准。
"use strict";
/* ==================================================================
   CONFIG 区 —— 全部**可调常量**集中在这里
   ------------------------------------------------------------------
   为什么集中：以前这些数字散在 1000 多行里，想调先得找半天。
   现在改任何一项，只看本区即可。
   ★CACHE = 该常量会进入**缓存键**（masterKey()）。改它会让磁盘上已有的
     干声全部失效、下次打开重新渲染 —— 这是正确且必需的：否则改动被旧
     缓存吃掉，听起来毫无变化，最容易误判成"改了没用"。
   缓存键 = entry.name | song.noteCount | song.duration | song.srcHash
           | RATE(=App.renderRate，默认 RENDER_RATE)
           | TONE_LP | HP_HZ : SHELF_LOW_HZ : SHELF_LOW_DB
                    : SHELF_HI_HZ : SHELF_HI_DB
           | v MIX_VER | 各声道波形 song.wave[ch] + 静音 song.mute[ch]
     ★ 动了母带链任何一环，**务必把 MIX_VER +1** —— 它是"我改过声音"的
       兜底宣告（何况 ch9 的波形/静音也是逐首进键的）。
   不在本区的常量（按图索骥，别去别处找）：
     · MAX_SONG_SEC / MAX_EVENTS ……… PARSE 区段内（解析器必须自洽、可独立测试）
     · CHUNK / TAIL …………………… renderMaster() 内局部，只在那一个函数用
     · LIM_MAKEUP ……………………… limitAt() 下方，由 LIM_CEIL 派生的补偿增益
     · RENDER_MASTER_GAIN …………… 渲染入口旁（总线增益，进干声内容）
     · CACHE_DB / CACHE_STORE ……… 磁盘缓存节（存储名，不进缓存键）
     · WAVE_SHORT / WAVE_LABELS / CH_COLORS … 界面文案与配色
     · SHAPES / GM_WAVE / GM_SHAPE / tailLevel() 的系数 … 合成引擎节
     · DRUMS 鼓机配方 / noiseSamples() 的 seed … 合成引擎节
     · measureLoudness() 的 K 加权参数(1681.97 / 3.999 / 38.13) … 响度测量节
   ================================================================== */

/* ---- A. 渲染调度 -------------------------------------------------- */
const RENDER_RATE = 44100;
const PRERENDER_AHEAD = 4;   // 只用于「成品 WAV 最多给往后几首保留」这个内存安全阀
                             // （reclaimStaleVariants）。**预渲染目标本身不再受它限制**，
                             // 只受容量约束 —— 装得下就往下渲。
/* 渲染耗时几乎只跟采样率 × 时长成正比（实测 700 音符 20 秒：
   44.1k 407ms，22.05k 189ms）。默认 44.1k 音质最好。 */

/* ---- B. 母带链：低通 / 搁架 / 高通 / 限幅 / 响度归一 ★CACHE ---- */
/* 低通：削掉方波最扎耳的高次谐波。 */
const TONE_LP   = 10000;
/* 频段平衡：★ 只做很轻的一点点倾斜。 */
const HP_HZ        = 35;                    // 高通：只去隆隆声/直流，这条最安全
const SHELF_LOW_HZ = 200,  SHELF_LOW_DB = -1.5;   // 低频搁架：极轻
const SHELF_HI_HZ  = 4000, SHELF_HI_DB  =  1.5;   // 高频搁架：极轻
/* ---- 响度归一化（复刻 EasyEffects Auto Gain）---- */
const TARGET_LUFS = -16;      // 目标响度：EBU 广播是 -23，流媒体常 -14，音乐取中间
const LUFS_MIN = -40, LUFS_MAX = 0;   // 目标/实测的合理范围，防呆
/* ---- 母带限幅 ---- */
const LIM_KNEE  = 0.62;    // 拐点：低于此值完全不动（透明）
const LIM_CEIL  = 0.92;    // 天花板
const LIM_RATIO = 5;       // 压缩比（越大越硬）
/* 混音版本号。凡是改母带链 / 鼓组电平 / 总线增益这类"会影响干声内容"的东西，
   必须 +1 —— 否则缓存键不变，老干声会被直接复用，改动根本听不见。 */
const MIX_VER = 10;

/* ---- C. 导出 / 位深量化 ------------------------------------------- */
/* TONE_LP 是"干声渲染时的低通"：留亮点，让 8.5k 以上还留些空气感，
   扎耳的高频和量化底噪在"导出"阶段按位深再削。 */
/* 各档位深在导出时额外加的低通（Hz），0 = 不加。
   量化噪声是宽带的，越低位深台阶越大、"丝丝"声越重 —— 用它压掉。 */
const BITS_LP = {0: 0, 8: 0, 6: 7000, 4: 5500};
const HARD_LEVEL = 0.05;     // 量化门限：低于这个电平时逐渐不做量化（消掉安静段的"丝丝"声）

/* ---- D. 合成：各波形音量 / 包络基线 / 弯音范围 --------------------- */
/* 各波形的实际 RMS 差很多（脉冲 12.5% 只有 0.34，方波 0.85），
   这里做一次"等响度"补偿（只补 70%，保留各自的音色性格）。 */
const WAVE_GAIN = {pulse12:1.45, pulse25:1.00, pulse50:0.62, square:0.62,
                   triangle:0.95, saw:1.05, sine:1.00, noise:1.00};
const SUSTAIN = {pulse12:0.52, pulse25:0.62, pulse50:0.72, square:0.72, triangle:0.86, saw:0.68, sine:0.9, noise:0.4};
const BEND_SEMI  = 2;      // 弯音范围：±2 个半音（GM 默认，多数 MIDI 不做 RPN 设定）

/* ---- E. 磁盘缓存预算 ---------------------------------------------- */
/* 缓存预算按**字节**，不按条数。 */
const CACHE_BYTES = 1024 * 1024 * 1024;      // 1GB
let cachePressure = false;   // 真的发生过淘汰 = "用满"的唯一可靠判据（见 dropCacheBehind）
const CACHE_LOW   = CACHE_BYTES - 64 * 1024 * 1024;   // 留 64MB 余量。

/* ---- F. 界面 ------------------------------------------------------ */
const SCOPE_SPAN = 900;

