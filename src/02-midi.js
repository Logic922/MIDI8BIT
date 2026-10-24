/* ==== [PARSE-BEGIN] 纯算法：不依赖 DOM / 音频，可独立测试 ====
   ↓ 本区段内严禁出现 document / window / AudioContext / canvas / indexedDB
     之类的宿主引用 —— test/parse_test.js 会把这段源码原样抽出来，
     在 Node（无浏览器）里 new Function 跑断言。区段内自带它需要的全部
     常量（GM_NAMES / MAX_SONG_SEC / MAX_EVENTS / txtDec）。
   ================================================================== */
/* ==================================================================
   1. MIDI 解析器  —  自行实现，零依赖
   支持 SMF format 0/1/2、running status、meta、sysex、
        tempo map、CC7/10/11/64、pitch bend
   ================================================================== */
/* ---- 解析器自身的两个安全上限（放本区段内，保证可独立测试）---- */
/* 允许的最长曲目。duration 直接决定 renderMaster 里的分配量 */
const MAX_SONG_SEC = 1800;
/* 事件数上限（审查报告 #23）。以前只限时长、不限事件数：一个畸形（或 */
const MAX_EVENTS = 2000000;
/* 字符解码器提到解析器外复用一个实例（报告 #9）：一首歌几千条文本事件， */
const txtDec = new TextDecoder("utf-8", {fatal:false});
const GM_NAMES = ("Acoustic Grand Piano|Bright Acoustic Piano|Electric Grand Piano|Honky-tonk Piano|Electric Piano 1|Electric Piano 2|Harpsichord|Clavinet|"+
"Celesta|Glockenspiel|Music Box|Vibraphone|Marimba|Xylophone|Tubular Bells|Dulcimer|"+
"Drawbar Organ|Percussive Organ|Rock Organ|Church Organ|Reed Organ|Accordion|Harmonica|Tango Accordion|"+
"Acoustic Guitar (nylon)|Acoustic Guitar (steel)|Electric Guitar (jazz)|Electric Guitar (clean)|Electric Guitar (muted)|Overdriven Guitar|Distortion Guitar|Guitar Harmonics|"+
"Acoustic Bass|Electric Bass (finger)|Electric Bass (pick)|Fretless Bass|Slap Bass 1|Slap Bass 2|Synth Bass 1|Synth Bass 2|"+
"Violin|Viola|Cello|Contrabass|Tremolo Strings|Pizzicato Strings|Orchestral Harp|Timpani|"+
"String Ensemble 1|String Ensemble 2|Synth Strings 1|Synth Strings 2|Choir Aahs|Voice Oohs|Synth Voice|Orchestra Hit|"+
"Trumpet|Trombone|Tuba|Muted Trumpet|French Horn|Brass Section|Synth Brass 1|Synth Brass 2|"+
"Soprano Sax|Alto Sax|Tenor Sax|Baritone Sax|Oboe|English Horn|Bassoon|Clarinet|"+
"Piccolo|Flute|Recorder|Pan Flute|Blown Bottle|Shakuhachi|Whistle|Ocarina|"+
"Lead 1 (square)|Lead 2 (sawtooth)|Lead 3 (calliope)|Lead 4 (chiff)|Lead 5 (charang)|Lead 6 (voice)|Lead 7 (fifths)|Lead 8 (bass+lead)|"+
"Pad 1 (new age)|Pad 2 (warm)|Pad 3 (polysynth)|Pad 4 (choir)|Pad 5 (bowed)|Pad 6 (metallic)|Pad 7 (halo)|Pad 8 (sweep)|"+
"FX 1 (rain)|FX 2 (soundtrack)|FX 3 (crystal)|FX 4 (atmosphere)|FX 5 (brightness)|FX 6 (goblins)|FX 7 (echoes)|FX 8 (sci-fi)|"+
"Sitar|Banjo|Shamisen|Koto|Kalimba|Bag pipe|Fiddle|Shanai|"+
"Tinkle Bell|Agogo|Steel Drums|Woodblock|Taiko Drum|Melodic Tom|Synth Drum|Reverse Cymbal|"+
"Guitar Fret Noise|Breath Noise|Seashore|Bird Tweet|Telephone Ring|Helicopter|Applause|Gunshot").split("|");

function parseMidi(buffer){
  const d = new DataView(buffer);
  let p = 0;
  const u8  = () => {
    // ★ 越过文件末尾要给明确的话。以前是 DataView 抛裸的
    //   "Offset is outside the bounds of the DataView"，用户只看到一句内部错误。
    if(p >= d.byteLength)
      throw new Error("文件数据不完整（读第 " + p + " 字节时已到文件末尾）"
                      + " —— 不是标准 MIDI，或文件被截断");
    return d.getUint8(p++);
  };
  const u16 = () => { const v = d.getUint16(p); p += 2; return v; };
  const u32 = () => { const v = d.getUint32(p); p += 4; return v; };
  const s4  = () => { let s = ""; for(let i=0;i<4;i++) s += String.fromCharCode(u8()); return s; };
  const vl  = () => { let v=0,c; do { c=u8();
                       v = v * 128 + (c & 0x7f);            // ★ 用乘法：<< 会先做 int32 转换，
                       if(v > 0x0FFFFFFF) v = 0x0FFFFFFF;   //   溢出成负数就夹不住了
                     } while(c&0x80); return v; };
  const txt = (off,len) => { try { return txtDec.decode(new Uint8Array(buffer,off,len)).replace(/\0+$/,"").trim(); } catch(e){ return ""; } };

  // ★ 先验尺寸再读字节。否则空文件/极小文件会在 u8() 里抛
  //   "Out of bounds access" —— 内部错误串直接甩给用户，看不懂也无法据此判断。
  if(d.byteLength < 14){
    throw new Error("文件太小（" + d.byteLength + " 字节），不是有效的 MIDI");
  }
  if(s4() !== "MThd") throw new Error("不是标准 MIDI 文件（缺少 MThd）");
  const hlen = u32();
  const format = u16();
  const ntrks = u16();
  let division = u16();
  if(hlen > 6) p += hlen - 6;

  let ppq = division, smpte = false;
  if(division & 0x8000){                     // SMPTE 时基
    smpte = true;
    const fps = 256 - ((division >> 8) & 0xff);
    const sub = division & 0xff;
    ppq = (fps || 25) * (sub || 40);         // ticks per second
  }
  if(!ppq) ppq = 480;

  const tracks = [];
  let evCount = 0;      // ★ 全文件事件计数：在**解析时**就掐断。
                        //   旧实现只在"合并所有轨道"那一步数，解析阶段无上限 ——
                        //   一个畸形文件会在触发保护前先把几万个对象堆进内存。
  while(p + 8 <= d.byteLength){
    const id = s4();
    const len = u32();
    const end = Math.min(p + len, d.byteLength);
    if(id !== "MTrk"){ p = end; continue; }      // 非轨道块：整块跳过，不做长度校验
    if(len > d.byteLength - p){
      throw new Error("文件已截断（轨道声明 " + len + " 字节，实际只剩 "
                      + (d.byteLength - p) + " 字节）");
    }
    // ★ 这里千万不能再写 p = end —— 下面的事件循环要从当前位置一直读到 end，
    //   把 p 提前推到 end 会让循环一次都不执行 → 0 音符（我犯过一次）

    const evs = [];
    const pushEv = e => {
      if(++evCount > MAX_EVENTS){
        throw new Error("事件数异常（超过上限 " + MAX_EVENTS + " 条）"
                        + " —— 文件可能已损坏或非标准 MIDI");
      }
      evs.push(e);
    };
    let tick = 0, rs = 0, name = "";
    while(p < end){
      tick += vl();
      if(p >= end) break;
      let status = d.getUint8(p);
      // ★ running status 只记**通道**消息的状态字节。meta(0xFF) / sysex(0xF0,0xF7) /
      //   系统消息一律不许覆盖它 —— 以前 rs 会被写成 0xFF，于是 meta 之后那条
      //   "裸数据字节继续发音符"会被当成又一条 meta，按假长度 break，
      //   整条轨道剩下的音符静默消失（不报错，最难查）。
      //   这里选择"保留上一条通道状态"而不是清零：规范说 meta 取消 running status，
      //   但老音序器/导出插件确实会这么写，保留它只会多解析出音符，不会误判。
      if(status & 0x80){ p++; if(status < 0xF0) rs = status; } else { status = rs; }
      if(!status){
        // 既没有可用的 running status，读到的又不是状态字节：字节流已经不同步了。
        // 试过"跳过这个字节继续"——不行：下一轮 vl() 会把紧随的 0x90 当 delta 高位，
        // 一路吃掉数据字节，最后静默解析出 0 音符或幻音，比报错难查得多。
        throw new Error("轨道数据异常（第 " + (tracks.length + 1) + " 轨：事件以数据字节开头，"
                        + "但前一条消息不支持 running status）—— 文件可能已损坏");
      }
      if(status === 0xFF){
        const type = u8();
        const l = vl();
        if(p + l > end) break;
        if(type === 0x51 && l === 3){
          pushEv({tick, t:"tempo", v:(d.getUint8(p)<<16)|(d.getUint8(p+1)<<8)|d.getUint8(p+2)});
        } else if(type === 0x58 && l >= 2){
          pushEv({tick, t:"timesig", n:d.getUint8(p), d2:Math.pow(2,d.getUint8(p+1))});
        } else if((type === 0x03 || type === 0x04) && l){
          const s = txt(p, l); if(type === 0x03 && !name) name = s;
          pushEv({tick, t:"text", s});
        } else if(type === 0x2F){
          pushEv({tick, t:"end"});
          p += l;
          break;                 // ★ 轨道到 EOT 就该结束。以前继续往下读，
                                 //   遇到作者的填充字节会走成一条假 meta 事件
        }
        p += l;
      } else if(status === 0xF0 || status === 0xF7){
        const l = vl();          // 注意：必须先把长度读完再加，p += vl() 会先取 p 的旧值
        if(p + l > end) break;   // 同上：SysEx 越出轨道就停，别读进下一轨
        p += l;
      } else if(status >= 0xF0){
        // ★ 系统公共 / 实时消息：0xF1(1 个数据字节) 0xF2(2) 0xF3(1) 0xF6/0xF8-0xFE(0)。
        //   以前它们落进下面的"通道消息"分支被读 2 个数据字节，把后面真正的状态字节
        //   当数据吃掉 → 整轨错位 → 一个合法文件被判成"轨道数据不完整"。
        const skip = status === 0xF2 ? 2 : (status === 0xF1 || status === 0xF3) ? 1 : 0;
        if(p + skip > end) break;
        p += skip;
      } else {
        const cmd = status >> 4, ch = status & 0x0f;
        const need = (cmd === 0xC || cmd === 0xD) ? 1 : 2;
        // ★ 数据字节必须落在**本轨道内**。以前只在循环开头检查 p < end：
        //   轨道末尾缺一个数据字节时，会静默把下一轨的字节当成音符读进来，
        //   凭空多出一个音（多轨文件里完全不报错）。单轨则抛 DataView 的裸错误。
        if(p + need > end){
          throw new Error("轨道数据不完整（第 " + (tracks.length + 1) + " 轨在事件中途结束）"
                          + " —— 文件可能已损坏或不是标准 MIDI");
        }
        const a = u8();
        const b = (cmd === 0xC || cmd === 0xD) ? 0 : u8();
        pushEv({tick, t:"midi", cmd, ch, a, b});
      }
    }
    p = end;
    tracks.push(evs);
  }
  if(!tracks.length) throw new Error("文件中没有找到 MTrk 轨道");

  // ---- 合并所有轨道并按 tick 排序 ----
/* 事件数上限已经在解析阶段（pushEv）掐过了，这里只做合并。 */
  const all = [];
  for(const evs of tracks) for(const e of evs) all.push(e);
  const evPrio = e => (e.t === "midi" &&
      (e.cmd === 0x8 || (e.cmd === 0x9 && e.b === 0))) ? 0 : 1;
  all.sort((x,y) => (x.tick - y.tick) || (evPrio(x) - evPrio(y)));

  // ---- 时间轴 + 音符抽取 ----
  const notes = [];
  const tempos = [{tick:0, time:0, us:500000}];
  const usedCh = new Set();
  const chanProg = new Array(16).fill(0);
  const chanVol  = new Array(16).fill(100);
  const chanPan  = new Array(16).fill(64);
  const chanExp  = new Array(16).fill(127);
  const chanBend = new Array(16).fill(0);   // 弯音：归一化 -1..+1
  const chanBendTL = new Array(16).fill(null).map(() => []);   // 每通道弯音时间线
  const sustain  = new Array(16).fill(false);
  const held     = new Array(16).fill(null).map(()=>[]);
  const pending  = new Map();
  let timeSig = {n:4, d2:4};

  let curTick = 0, curTime = 0, curTempo = 500000;
  const secPerTick = () => smpte ? 1/ppq : curTempo/(ppq*1e6);

/* pending: key → 数组（同通道同音高可能重叠）。 */
  const closeNote = (key, at) => {
    const list = pending.get(key);
    if(!list || !list.length) return;
    const n = list.shift();                       // FIFO：先按下的先结束
    if(!list.length) pending.delete(key);
    notes.push({start:n.start, dur:Math.max(0.03, at - n.start), note:n.note, vel:n.vel,
                ch:n.ch, prog:n.prog, vol:n.vol, pan:n.pan, bend:n.bend || 0,
                exp:n.exp == null ? 127 : n.exp});
  };

  for(let i=0;i<all.length;i++){
    const e = all[i];
    curTime += (e.tick - curTick) * secPerTick();
    curTick = e.tick;
    if(e.t === "tempo"){ curTempo = e.v; tempos.push({tick:e.tick, time:curTime, us:e.v}); continue; }
    if(e.t === "timesig"){ timeSig = {n:e.n, d2:e.d2}; continue; }
    if(e.t !== "midi") continue;

    const ch = e.ch; usedCh.add(ch);
    if(e.cmd === 0x9 && e.b > 0){
      const pkey = ch*128 + e.a;
      let plist = pending.get(pkey);
      if(!plist){ plist = []; pending.set(pkey, plist); }
      plist.push({start:curTime, vel:e.b, note:e.a, ch,
        prog:chanProg[ch], vol:chanVol[ch], pan:chanPan[ch], bend:chanBend[ch],
        exp:chanExp[ch]});
    } else if(e.cmd === 0x8 || (e.cmd === 0x9 && e.b === 0)){
      const key = ch*128 + e.a;
      if(sustain[ch]) held[ch].push(key); else closeNote(key, curTime);
    } else if(e.cmd === 0xB){
      switch(e.a){
        case 7:  chanVol[ch] = e.b; break;
        case 10: chanPan[ch] = e.b; break;
        case 11: chanExp[ch] = e.b; break;
        case 64:
          if(e.b < 64){
            const list = held[ch]; held[ch] = [];
            for(const k of list) closeNote(k, curTime);
          }
          sustain[ch] = e.b >= 64; break;
        case 120: case 123:
          held[ch] = [];
          for(const k of [...pending.keys()]) if((k>>7) === ch) closeNote(k, curTime);
          break;
      }
    } else if(e.cmd === 0xE){
      chanBend[ch] = (((e.b << 7) | e.a) - 8192) / 8192;
      chanBendTL[ch].push({t: curTime, v: chanBend[ch]});   // 供音符内部滑音用
    } else if(e.cmd === 0xC){
      chanProg[ch] = e.a;
    }
  }
  const endTime = curTime;
  for(const k of [...pending.keys()]) closeNote(k, endTime);

  notes.sort((a,b) => a.start - b.start);

  let duration = 0;
  for(const n of notes) duration = Math.max(duration, n.start + n.dur);
  duration = Math.max(duration, endTime, 0.1);

  // ---- 声道汇总 ----
  const channels = [];
  for(const ch of [...usedCh].sort((a,b)=>a-b)){
    const own = notes.filter(n => n.ch === ch);
    if(!own.length) continue;               // 只有控制器事件、无音符的声道不显示
    const progs = [...new Set(own.map(n => n.prog))];
    // ★ 不能用 Math.max.apply(null, own.map(...))：apply 的实参个数有上限
    //   （V8 约 13 万就抛 RangeError），一首密集合成器曲子单通道二十万音符很合法，
    //   却会在这里把整首曲子的解析毁掉，报的还是引擎内部的调用栈错误。
    let volMax = 100;
    for(const n of own) if(n.vol > volMax) volMax = n.vol;
    channels.push({ch, count:own.length, prog:progs[0]||0, progs,
      name: ch===9 ? "Drums (GM)" : (GM_NAMES[progs[0]||0] || "Program "+(progs[0]||0)),
      vol: volMax});
  }
  channels.sort((a,b) => a.ch - b.ch);

  const noteCount = notes.length;
  let lo = 127, hi = 0;
  for(const n of notes){ if(n.note < lo) lo = n.note; if(n.note > hi) hi = n.note; }
  if(!noteCount){
    // 首事件是数据字节、running status 错乱、或整轨都是元事件 —— 都会走到这里。
    // 以前静默返回一首"0 音符的可播放曲目"，用户只会觉得播放器坏了。
    throw new Error("没有解析到任何音符 —— 文件可能不是标准 MIDI 或已损坏");
  }
  // ★ 挡住畸形时长。否则 renderMaster 会按 秒×采样率 去建数组 —— 抛 RangeError
  //   被 catch 成"渲染失败"（8 秒后自动消失、无解释），而且预渲染每 120 秒重试一次。
  if(duration > MAX_SONG_SEC){
    throw new Error("时长异常（约 " + Math.round(duration / 60) + " 分钟，上限 "
                    + (MAX_SONG_SEC / 60) + " 分钟）—— 文件可能已损坏或非标准 MIDI");
  }

  return {format, ntrks, ppq, smpte, division, notes, tempos, channels, duration, bends: chanBendTL,
          timeSig, noteCount, lo, hi,
          tempoAt(t){
            let us = tempos.length ? tempos[0].us : 500000;
            for(const x of tempos){ if(x.time <= t) us = x.us; else break; }
            return us;
          }};
}

/* ==== [PARSE-END] 纯算法区段结束（上面这段可整段抽出来在 Node 里测）==== */

