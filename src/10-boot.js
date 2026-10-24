P().volume = 0.7;
loadIdbIndex().then(tidyCacheAtStartup);   // 读索引 → 点亮绿灯 → 整理一次缓存
renderPlaylist();
renderChannels();
buildRoll();
updateTransport();
initMediaSession();
requestAnimationFrame(tick);

// 同目录 playlist.json 里列出的 MIDI 会被自动加入播放列表（可选）
fetch("playlist.json", {cache:"no-store"})
  .then(r => r.ok ? r.json() : null)
  .then(list => {
    if(!Array.isArray(list) || !list.length) return;
    /** @type {Promise<any>} */ let chain = Promise.resolve();
    list.forEach(item => {
      const url = typeof item === "string" ? item : item.file;
      const name = typeof item === "string" ? undefined : item.name;
      if(!url) return;
      chain = chain.then(() => loadFromUrl(url, name)).catch(e => console.warn("跳过 " + url + ": " + e.message));
    });
    return chain.then(() => { sortSongsByName(); refreshAll(App.cur < 0); });
  })
  .catch(() => {});

/* ★ 点击非输入控件时主动收掉焦点框。iOS Safari 点"不可聚焦元素"（列表项、普通按钮） */
addEventListener("pointerdown", ev => {
  const t = /** @type {any} */ (ev.target);
  if(t && t.closest && t.closest("input, select, textarea")) return;
  const a = /** @type {any} */ (document.activeElement);
  if(a && a !== document.body && typeof a.blur === "function") a.blur();
}, true);

window.MIDI8 = {parseMidi, App, autoWave, GM_NAMES, selectSong, play, pause, stop, seek, addFiles,
                get PLAYER(){ return P(); }, AUDIO, renderMaster, startRender, kickRender, kickBits, markDirty, ChipEngine,
                curEntry, songLength, ensureMaster, evictCache, tidyCacheAtStartup, clearAllCache, makeVariant, generateVariant, schedulePrerender,
                publishIndex, checkCacheInvariant, sortSongsByName, verifyCacheAgainstDisk, idbDelOk, adoptOrReapOrphans, idbGetOk,
                redraw: function(){ drawScope(); drawRoll(); }, rebuildRoll: buildRoll, songTimeNow,
                ms: { setMetadata: setMsMetadata, update: updateMsState, state: () => MS,
                      metadata: () => { try { return navigator.mediaSession.metadata; } catch(e){ return null; } } }};
