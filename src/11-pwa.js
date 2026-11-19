/* PWA：注册 service worker。
   只在 http(s) 下注册（file:// 直接打开单文件时跳过），失败不影响播放器。 */
(function () {
  if (!("serviceWorker" in navigator)) return;
  if (!/^https?:$/.test(location.protocol)) return;
  addEventListener("load", function () {
    navigator.serviceWorker.register("service-worker.js", { scope: "./" }).then(function (reg) {
      window.__swReg = reg;
      window.__swState = (reg.active || navigator.serviceWorker.controller) ? "active" : "installing";
      if (navigator.serviceWorker.ready) {
        navigator.serviceWorker.ready.then(function () { window.__swState = "active"; });
      }
    }).catch(function (err) {
      window.__swState = "error";
      console.warn("[MIDI8BIT] SW 注册失败:", err && err.message);
    });
  });
})();
