# 架构与模块边界

> 生成方式见文末。行数为当前值，改代码后以实际为准。

## 分层（按拼接顺序）

| # | 模块 | 行 | 职责 | 允许依赖 |
|---|---|---|---|---|
| 01 | `01-config.js` | 83 | 全部可调常量（含缓存键成员） | 无 |
| — | `01b-util.js` | 38 | `$` / `fmtTime` / `esc` / `CH_COLORS` | 无 |
| 02 | `02-midi.js` | 299 | SMF 解析器（`[PARSE]` 区段，可独立测试） | 无 |
| 03 | `03-synth.js` | 580 | `ChipEngine`：波形 / 包络 / 鼓机 / 响度 / 限幅 | config |
| 04 | `04-state.js` | 79 | **仅**跨模块共享的运行时状态（7 个） | 无 |
| 05 | `05-core.js` | 301 | `App`、`entry` 辅助、`renderMaster` / `makeVariant` | config / synth / state |
| 06 | `06-store.js` | 745 | IndexedDB、缓存索引、淘汰、写盘、渲染调度 | 上面全部 |
| 07 | `07-prerender.js` | 121 | 后台预渲染循环 + 看门狗 | 上面全部 |
| 08 | `08-player.js` | 554 | 双缓冲 `<audio>`、播放控制、Media Session | 上面全部 |
| 09 | `09-ui.js` | 560 | 播放列表 / 声道面板 / 卷帘 / 示波器 / 事件 | 上面全部 |
| 10 | `10-boot.js` | 40 | 启动序列 | 全部 |

**原则**：数字大的可以依赖数字小的，反过来不行。唯一的例外是下面列出的环。

## 状态归属

`04-state.js` 只剩 7 个真正跨模块的变量：

| 变量 | 谁写 | 谁读 |
|---|---|---|
| `renderJob` / `bitsJob` | store | store、ui |
| `IDB_KEYS` / `IDB_IDX` | store（`publishIndex` 唯一写者） | store、prerender、player、ui |
| `RENDERED` | store、prerender | 同上 |
| `prerun` | prerender | prerender、ui |
| `pidx` | player | core、store、player |

模块私有状态已归位（不要再从别处碰）：
`06-store`：`dbPromise` / `renderOwner` / `idbQueue`
`07-prerender`：`prerunAt` / `prerunEntry` / `prerunSeq`
`08-player`：`selectToken`
`09-ui`：`rollBuf` / `rollW` / `rollH` / `lastSweep` / `lastTitle` / `rzT` / `lastPct` / `lastTimeStr` / `lastDraw` / `lastRollCheck`
`03-synth`：`NOISE_DATA`

每首歌的状态**一律挂 `entry`**，绝不挂 `App`（切歌时会忘清理）。待执行动作只经 `entry.intent` 的 6 个函数读写。

## 收敛结果（S4 完成后）

三个环全部拆成单向，**真实反向依赖 = 0**（剩余 4 条检测项都是词法误报：局部变量 `tick`、方法 `.stop()`、属性 `.play`/`.seek`）。

做法不是 DI 容器，而是三件具体的事：

| 原来 | 现在 |
|---|---|
| store 直接调 `updateTransport()` / `setInfoText()` / `flashInfo()` | 只写 `App.renderPct` / `App.infoText` / `App.renderMsg`；UI 在 `UIPaint` 里注册绘制，写入时同步画一次 |
| store 的 `applyEntryAudio` 调 `play()` / `preloadNextEntry()` | `applyEntryAudio` / `useVariant` / `markDirty` 移到 player；store 用 `emit("variant")` / `emit("autoplay")` 广播 |
| store 读 `<audio>` 的 `dataset.for` 判断 URL 是否被持有 | player 注册 `AudioHooks.held/sweep/release`，store 只调钩子 |
| player 调 `renderPlaylist()` / `buildRoll()` | `emit("ui-refresh")` / `emit("redraw")`，ui 订阅 |
| prerender 的 `setRenderHud()` | 改为写 `App.hud`（core），ui 绘制 |
| store 调 `schedulePrerender()` | `schedulePrerender` 移到 util，内部 `emit("prerender")` |

事件总线只有 15 行（`on` / `emit`，**同步**遍历，不用微任务/定时器，避免"渲染完等一帧"）。
订阅者共 6 个事件：`variant`、`autoplay`、`badges`、`ui-refresh`、`redraw`、`prerender`。

### 回调钩子（避免循环依赖的两个小接口）

```js
// 05-core
const UIPaint     = { info: null, hud: null };                    // ui 注册绘制
const AudioHooks  = { held: null, sweep: null, release: null };    // player 注册 URL 持有查询
```

低层模块只认这两个对象，**不认识任何具体函数名**；注册发生在各自模块顶层，早于 boot 的任何调用。

## 改代码时放哪

1. 新常量 → `01-config.js`（进缓存键的标 `★CACHE`）
2. 新纯函数 → 尽量 `01b-util.js`，且不引用任何状态
3. 新的"某首歌"状态 → `entry.xxx`
4. 新的"播放器"状态 → `App.xxx`（跨曲目）或对应模块的私有 `let`（单模块用）
5. 新的待执行动作 → 加到 `entry.intent` 的语义里，**不要**再起一个 `pendingXxx`
6. 新的缓存/磁盘逻辑 → `06-store.js`，索引写一律走 `publishIndex()`

## 依赖矩阵（词法近似，反向边已为 0）

```
模块            反向依赖
01-config       0
01b-util        0
02-midi         0   （tick 是局部变量，误报）
03-synth        0   （osc.stop() 是方法名，误报）
04-state        0
05-core         0   （intent.play 是属性名，误报）
06-store        0   （opts.play / opts.seek 是选项名，误报）
07-prerender    0
08-player       0
09-ui           0
10-boot         0

真实反向依赖：0
```

生成方法：去注释/字符串后，按 `^(function|const|let|var) NAME` 收集顶层符号，再统计跨文件引用。
词法近似会把局部同名变量和方法名算进来，所以会看到少量误报 —— 已逐条人工核对过。

## 验证

```sh
node build.mjs --check        # 产物 + 本文档行数
node test/parse_test.js
node test/unit_test.js
```

> 早先这里还列过一个 `midi8bit-dev/check.sh`（tsc + id 校验 + 两个测试），
> 那个工作区目录已不在，不属于交付物；交付物只依赖上面三条。
