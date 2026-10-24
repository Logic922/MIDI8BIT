/* ==================================================================
   0. 工具 —— 全文件通用的小函数（取元素 / 格式化 / 转义 / 声道配色）
   谁都能用，但它不依赖任何其他模块，也不持有状态。
   ================================================================== */
const CH_COLORS = ["#6fe36f","#ffb000","#63c8ff","#ff7bd0","#ffe873","#8affd8","#b78dff","#ff9d6b",
                   "#7cf5c0","#f57cff","#9dff6b","#6bb0ff","#ff6b8a","#ffe0a3","#a3ffe0","#d4d4d4"];

/* 取元素。刻意返回 any：本文件里同一个元素会被当 textContent/style/value/canvas 用， */
const $ = /** @type {(id:string)=>any} */ (id => document.getElementById(id));
const fmtTime = t => {
  t = Math.max(0, t||0);
  const m = Math.floor(t/60), s = Math.floor(t%60);
  return String(m).padStart(2,"0") + ":" + String(s).padStart(2,"0");
};
const esc = s => String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

/* 截短文件名，用于 info 栏 / 日志 */
function shortName(n){ n = String(n || "?"); return n.length > 10 ? n.slice(0, 10) + "…" : n; }

/* ---- 最小事件层：低层只广播事实，谁关心谁订阅（同步，绝不延迟一帧） ---- */
const Bus = Object.create(null);
function on(evt, fn){ (Bus[evt] || (Bus[evt] = [])).push(fn); }
function emit(evt, a, b){
  const list = Bus[evt];
  if(!list) return;
  for(let i = 0; i < list.length; i++){
    try { list[i](a, b); } catch(e){ console.warn("[事件] " + evt, e); }
  }
}

/* 一次渲染的超时预算：正比于曲目时长（真机慢 5~10 倍 → 1.5 倍时长 + 20 秒兜底） */
function renderBudgetMs(song){
  const dur = (song && song.duration) ? song.duration : 120;
  return Math.max(20000, Math.round(dur * 1000 * 1.5) + 20000);
}

/* 踢一脚预渲染循环（只是 setTimeout，所以归工具层） */
function schedulePrerender(){ setTimeout(() => emit("prerender"), 200); }
