/* midi8bit 构建：把 src/*.js 按文件名顺序拼进 index.html 的 <script>。
   只用 node 内置模块，iSH 里可直接跑：node build.mjs
   --check 只校验产物与磁盘一致，不写盘（CI/自检用）。
   交付物仍是单文件零依赖：iOS 上直接打开 index.html 即可，不需要构建。 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const SRC = path.join(ROOT, "src");
const OUT = path.join(ROOT, "index.html");

/* 剥离 JS 注释（产物不保留注释；源码 src/ 完整保留）。
   字符串/模板/正则感知：宁可少删，也不能把代码当成注释删掉。
   调用方必须用 new Function() 再编译一遍作为兜底。 */
function scanComments(s) {
  const out = []; let i = 0; const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const q = c; i++;
      while (i < n) { if (s[i] === "\\") { i += 2; continue; } if (s[i] === q) { i++; break; } i++; }
      continue;
    }
    if (c === "`") {
      i++;
      while (i < n) { if (s[i] === "\\") { i += 2; continue; } if (s[i] === "`") { i++; break; } i++; }
      continue;
    }
    if (c === "/" && s[i + 1] === "/") {
      let j = s.indexOf("\n", i); if (j < 0) j = n;
      out.push([i, j]); i = j; continue;
    }
    if (c === "/" && s[i + 1] === "*") {
      let j = s.indexOf("*/", i + 2); j = j < 0 ? n : j + 2;
      out.push([i, j]); i = j; continue;
    }
    if (c === "/") {
      // 正则字面量：前一个有意义字符决定它是不是除号
      let k = i - 1;
      while (k >= 0 && /\s/.test(s[k])) k--;
      const prev = k >= 0 ? s[k] : "";
      if (prev === "" || "=(,:[!&|?{};".includes(prev) ||
          /(return|typeof|case|in|of)$/.test(s.slice(Math.max(0, k - 6), k + 1).trim())) {
        i++;
        let inSet = false;
        while (i < n) {
          if (s[i] === "\\") { i += 2; continue; }
          if (s[i] === "[") inSet = true;
          else if (s[i] === "]") inSet = false;
          else if (s[i] === "/" && !inSet) { i++; break; }
          else if (s[i] === "\n") break;
          i++;
        }
        continue;
      }
    }
    i++;
  }
  return out;
}
function stripComments(s) {
  const cs = scanComments(s);
  let out = "", last = 0;
  for (const [a, b] of cs) { out += s.slice(last, a); last = b; }
  out += s.slice(last);
  return out.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n");
}

const head = fs.readFileSync(path.join(SRC, "index.head.html"), "utf8");
const tail = fs.readFileSync(path.join(SRC, "index.tail.html"), "utf8");
const files = fs.readdirSync(SRC).filter(f => /^\d\d[a-z]?-.+\.js$/.test(f)).sort();
if (!files.length) { console.error("src/ 里没有模块"); process.exit(1); }

const parts = files.map(f => {
  const text = fs.readFileSync(path.join(SRC, f), "utf8");
  if (!text.endsWith("\n")) { console.error(`${f} 末尾缺少换行（拼接会粘连）`); process.exit(1); }
  return text;
});
// 产物不保留注释（源码 src/ 里照旧，方便阅读与 tsc）
const js = stripComments(parts.join(""));
try { new Function(js); } catch (e) {
  console.error("✗ 去注释后语法不通过，拒绝写盘：" + e.message);
  process.exit(1);
}
const out = head + js + tail;

/* ---- 顺带同步 ARCHITECTURE.md 的「行」列 ----
   那张表的行数以前靠手填，改几次代码就全过期（06-store 写 845、实际 735 这种）。
   现在构建时顺手按真实行数改写；--check 时把差异报出来并要求重新 build。 */
const ARCH = path.join(ROOT, "ARCHITECTURE.md");
function syncArchLines() {
  if (!fs.existsSync(ARCH)) return { text: null, stale: [] };
  const before = fs.readFileSync(ARCH, "utf8");
  const stale = [];
  let after = before;
  for (const f of files) {
    const t = fs.readFileSync(path.join(SRC, f), "utf8");
    const n = t.split("\n").length - (t.endsWith("\n") ? 1 : 0);
    const name = f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("(\\|\\s*(?:\\d\\d[a-z]?|—)\\s*\\|\\s*`" + name + "`\\s*\\|\\s*)(\\d+)");
    after = after.replace(re, (m, head, old) => {
      if (+old !== n) stale.push(f + ": " + old + " → " + n);
      return head + n;
    });
  }
  return { text: after, before, stale };
}
const arch = syncArchLines();

const check = process.argv.includes("--check");
if (check) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  let bad = false;
  if (cur === out) { console.log("✓ index.html 与 src/ 一致 (" + files.length + " 个模块, " + out.length + " chars)"); }
  else { console.error("✗ index.html 与 src/ 不一致 —— 需要重新 build"); bad = true; }
  if (arch.stale.length) {
    console.error("✗ ARCHITECTURE.md 行数过期：" + arch.stale.join("，") + " —— 跑 node build.mjs 同步");
    bad = true;
  } else if (arch.text != null) {
    console.log("✓ ARCHITECTURE.md 行数与 src/ 一致");
  }
  if (bad) process.exit(1);
} else {
  fs.writeFileSync(OUT, out);
  console.log("✓ 已生成 index.html: " + files.length + " 个模块, " + out.length + " chars");
  console.log("  " + files.join("  "));
  if (arch.text != null && arch.text !== arch.before) {
    fs.writeFileSync(ARCH, arch.text);
    console.log("✓ 已同步 ARCHITECTURE.md 行数：" + (arch.stale.length || "无变化"));
  }
}
