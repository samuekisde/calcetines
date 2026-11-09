/*
 * HexWeb — the browser side of the game's web build.
 *
 * Everything the page knows that Unity can't see on its own: the safe-area insets around the
 * Dynamic Island, whether the page was hidden (iOS freezes a hidden tab outright, so the game
 * never runs a frame to notice), Home Screen mode, sharing an invite, the wake lock. Unity reads
 * it all through Assets/Plugins/WebGL/WebBridge.jslib → Game.Platform.WebBridge (C#). Unity
 * polls; nothing here calls into Unity, so nothing here depends on a GameObject's name.
 */
(function () {
  "use strict";

  var params = new URLSearchParams(window.location.search);

  // An invite (?join=CODE) is used once: the game reads it from `params`, and the address bar
  // forgets it, so a reload, the failure panel's Reload, or adding the page to the Home Screen
  // never joins an old table again.
  (function forgetInvite() {
    if (!params.has("join") || !window.history || !history.replaceState) return;
    var rest = new URLSearchParams(window.location.search);
    rest.delete("join");
    var query = rest.toString();
    try {
      history.replaceState(history.state, "", window.location.pathname + (query ? "?" + query : "") + window.location.hash);
    } catch (e) {}
  })();
  var ua = navigator.userAgent || "";

  // iPadOS reports itself as a Mac; the touch points give it away.
  var isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  function isStandalone() {
    return navigator.standalone === true ||
      (window.matchMedia && (window.matchMedia("(display-mode: standalone)").matches ||
                             window.matchMedia("(display-mode: fullscreen)").matches));
  }

  // The page's language: what the address asks for, else what the game last chose, else the
  // browser's.
  var lang = (function () {
    var stored = null;
    try { stored = localStorage.getItem("hexweb.lang"); } catch (e) {}
    var raw = params.get("lang") || stored || navigator.language || "en";
    return raw.toLowerCase().indexOf("es") === 0 ? "es" : "en";
  })();

  // ---------------------------------------------------------------- logs (for ?debug and Share logs)

  var logLines = [];
  var LOG_LIMIT = 300;

  function remember(kind, args) {
    var text;
    try {
      text = Array.prototype.map.call(args, function (a) {
        if (a instanceof Error) return a.stack || a.message;
        return typeof a === "string" ? a : JSON.stringify(a);
      }).join(" ");
    } catch (e) {
      text = String(args[0]);
    }
    var t = new Date();
    logLines.push(t.toTimeString().slice(0, 8) + " " + kind + " " + text);
    if (logLines.length > LOG_LIMIT) logLines.splice(0, logLines.length - LOG_LIMIT);
  }

  ["log", "info", "warn", "error"].forEach(function (kind) {
    var original = console[kind];
    console[kind] = function () {
      remember(kind === "log" ? "·" : kind.toUpperCase(), arguments);
      return original.apply(console, arguments);
    };
  });

  window.addEventListener("error", function (e) { remember("ERROR", [e.message + " @ " + e.filename + ":" + e.lineno]); });
  window.addEventListener("unhandledrejection", function (e) { remember("ERROR", ["unhandled rejection: " + (e.reason && (e.reason.stack || e.reason))]); });

  // ---------------------------------------------------------------- visibility

  // A counter rather than a flag: iOS stops the game dead while the page is hidden, so by the time
  // Unity runs again the page is visible again. Only a count can tell it that something happened.
  var hiddenCount = 0;
  var hiddenSince = 0;
  var lastHiddenMs = 0;
  var visible = document.visibilityState !== "hidden";

  function setVisible(now) {
    if (now === visible) return;
    visible = now;
    if (!now) {
      hiddenCount++;
      hiddenSince = performance.now();
    } else {
      lastHiddenMs = hiddenSince ? performance.now() - hiddenSince : 0;
      requestWakeLock();
    }
  }

  document.addEventListener("visibilitychange", function () { setVisible(document.visibilityState !== "hidden"); });
  window.addEventListener("pagehide", function () { setVisible(false); });
  // Safari's back/forward cache restores a frozen page without reloading it.
  window.addEventListener("pageshow", function () { setVisible(true); });

  // ---------------------------------------------------------------- the stage fills the visible page

  // iOS Safari, loading in landscape, reports a viewport that is too short until something
  // resizes the page (rotating fixed it), and the game drew short of the bottom with a white band
  // under it. So the stage is sized here, in pixels, to what is actually visible: on load, on
  // every resize, rotation and toolbar change, a few times just after each, and once a second as
  // a net for the cases that fire nothing.
  var stageSize = [0, 0];

  function visibleSize() {
    var w = window.innerWidth, h = window.innerHeight;
    var vv = window.visualViewport;
    // The visual viewport is the truer size while it is not zoomed (it follows the toolbars).
    if (vv && Math.abs(vv.scale - 1) < 0.01 && vv.width > 0 && vv.height > 0) {
      w = vv.width;
      h = vv.height;
    }
    return [Math.round(w), Math.round(h)];
  }

  function fitStage() {
    var stage = document.getElementById("stage");
    if (!stage) return;
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
    var size = visibleSize();
    if (size[0] === stageSize[0] && size[1] === stageSize[1]) return;
    stageSize = size;
    stage.style.width = size[0] + "px";
    stage.style.height = size[1] + "px";
  }

  function fitStageSoon() {
    fitStage();
    [60, 250, 600, 1200].forEach(function (ms) { setTimeout(fitStage, ms); });
  }

  window.addEventListener("resize", fitStageSoon);
  window.addEventListener("orientationchange", fitStageSoon);
  window.addEventListener("pageshow", fitStageSoon);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", fitStageSoon);
    window.visualViewport.addEventListener("scroll", fitStage);
  }
  document.addEventListener("DOMContentLoaded", fitStageSoon);
  setInterval(fitStage, 1000);

  // ---------------------------------------------------------------- gestures the browser must not take

  document.addEventListener("gesturestart", function (e) { e.preventDefault(); }, { passive: false });
  document.addEventListener("contextmenu", function (e) { e.preventDefault(); });
  document.addEventListener("touchmove", function (e) { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });

  // ---------------------------------------------------------------- wake lock

  var wakeWanted = false;
  var wakeLock = null;

  function requestWakeLock() {
    if (!wakeWanted || wakeLock || !("wakeLock" in navigator) || document.visibilityState !== "visible") return;
    navigator.wakeLock.request("screen").then(function (lock) {
      wakeLock = lock;
      lock.addEventListener("release", function () { wakeLock = null; });
    }).catch(function (e) { remember("warn", ["wake lock refused: " + e.message]); });
  }

  function setWakeLock(on) {
    wakeWanted = !!on;
    if (wakeWanted) requestWakeLock();
    else if (wakeLock) { wakeLock.release().catch(function () {}); wakeLock = null; }
  }

  // ---------------------------------------------------------------- safe area

  var probe = null;

  // ?safe=59,0,59,21 pretends the page has those insets (left, top, right, bottom, CSS px), so a
  // phone's island can be checked in a desktop browser. A real device's own insets win over it.
  var simulatedSafe = (function () {
    var raw = params.get("safe");
    if (!raw) return null;
    var parts = raw.split(",").map(function (v) { return parseFloat(v) || 0; });
    while (parts.length < 4) parts.push(0);
    return parts.slice(0, 4);
  })();

  function safeAreaCss() {
    probe = probe || document.getElementById("safe-probe");
    var real = [0, 0, 0, 0];
    if (probe) {
      var s = getComputedStyle(probe);
      real = [parseFloat(s.paddingLeft) || 0, parseFloat(s.paddingTop) || 0,
              parseFloat(s.paddingRight) || 0, parseFloat(s.paddingBottom) || 0];
    }
    if (!simulatedSafe || real[0] + real[1] + real[2] + real[3] > 0) return real;
    // A simulated island sits on the side the phone is turned to, like a real one: the larger
    // side inset follows the first number.
    return simulatedSafe;
  }

  // ---------------------------------------------------------------- what kind of device this is

  var touchScreen = (navigator.maxTouchPoints || 0) > 0 ||
    (window.matchMedia && window.matchMedia("(pointer: coarse)").matches);

  // ?device=phone|tablet|desktop forces a layout (for checking one in a desktop browser).
  // Numbers match Game.Platform.DeviceClass; -1 means "decide from the screen".
  function deviceHint() {
    var asked = (params.get("device") || "").toLowerCase();
    if (asked === "desktop") return 0;
    if (asked === "tablet" || asked === "ipad") return 1;
    if (asked === "phone" || asked === "iphone") return 2;
    return -1;
  }

  // ---------------------------------------------------------------- the game's own language

  // The game tells the page its language, so the next load greets the player in it.
  var LANG_KEY = "hexweb.lang";

  function setLanguage(code) {
    code = (code || "").toLowerCase().indexOf("es") === 0 ? "es" : "en";
    try { localStorage.setItem(LANG_KEY, code); } catch (e) {}
  }

  // ---------------------------------------------------------------- a match in progress

  var matchRunning = false;

  function setMatchRunning(on) {
    matchRunning = !!on;
    setWakeLock(matchRunning);
  }

  // Leaving the page by accident (a back swipe, a mistyped address) would drop the player from a
  // match. Only asked while one runs; browsers show their own wording.
  window.addEventListener("beforeunload", function (e) {
    if (!matchRunning) return;
    e.preventDefault();
    e.returnValue = "";
  });

  // ---------------------------------------------------------------- sharing and the clipboard

  var pendingShare = null;

  // Called from a Unity button. Safari only allows share() during a user gesture; Unity handles
  // the tap a frame after the browser saw it, which is usually still inside the gesture's grace
  // period. If it isn't, the share is retried on the very next touch.
  function share(title, text, url) {
    var data = { title: title, text: text, url: url };
    if (navigator.share) {
      navigator.share(data).catch(function (e) {
        if (e && e.name === "NotAllowedError") {
          pendingShare = data;
          document.addEventListener("pointerup", retryShare, { once: true, capture: true });
        } else if (e && e.name !== "AbortError") {
          copyText(url);
        }
      });
      return 1;
    }
    return copyText(text ? text + " " + url : url) ? 2 : 0;
  }

  function retryShare() {
    if (!pendingShare) return;
    var data = pendingShare;
    pendingShare = null;
    navigator.share(data).catch(function () { copyText(data.url); });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function (e) { remember("warn", ["copy failed: " + e.message]); });
      return true;
    }
    return false;
  }

  var clipboardText = null;

  function requestClipboard() {
    clipboardText = null;
    if (!navigator.clipboard || !navigator.clipboard.readText) { clipboardText = ""; return; }
    navigator.clipboard.readText()
      .then(function (t) { clipboardText = t || ""; })
      .catch(function () { clipboardText = ""; });
  }

  function takeClipboard() {
    var t = clipboardText;
    clipboardText = null;
    return t;
  }

  // ---------------------------------------------------------------- loader, failure, hint

  function localise(root) {
    var nodes = root.querySelectorAll("[data-en]");
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].textContent = nodes[i].getAttribute(lang === "es" ? "data-es" : "data-en");
    }
  }

  function fail(message) {
    remember("ERROR", [message]);
    var box = document.getElementById("failure");
    if (!box) return;
    document.getElementById("failure-detail").textContent = String(message || "");
    box.hidden = false;
    document.getElementById("failure-reload").onclick = function () { window.location.reload(); };
  }

  function showHomeHint() {
    var key = "hexweb.homeHintDismissed";
    var dismissed = false;
    try { dismissed = localStorage.getItem(key) === "1"; } catch (e) {}
    if (!isIOS || isStandalone() || dismissed) return;
    var hint = document.getElementById("home-hint");
    if (!hint) return;
    hint.hidden = false;
    document.getElementById("home-hint-close").onclick = function () {
      hint.hidden = true;
      try { localStorage.setItem(key, "1"); } catch (e) {}
    };
  }

  function renderPixelRatio() {
    var asked = parseFloat(params.get("dpr"));
    if (asked > 0) return asked;
    return Math.min(window.devicePixelRatio || 1, 2);
  }

  var instance = null;

  // The render scale must follow the page: a phone rotating, Safari's toolbars growing or
  // shrinking, a window dragged to another display or zoomed. Fixed at load, Unity kept drawing at
  // the old scale into a canvas of the new size, and the game showed up cropped and zoomed.
  function followPixelRatio() {
    var applied = 0;
    function apply() {
      var ratio = renderPixelRatio();
      if (!instance || !instance.Module || ratio === applied) return;
      applied = ratio;
      instance.Module.devicePixelRatio = ratio;
    }
    apply();
    window.addEventListener("resize", apply);
    if (window.visualViewport) window.visualViewport.addEventListener("resize", apply);
    // Fires when the pixel ratio itself changes, which a resize doesn't always announce.
    (function watch() {
      if (!window.matchMedia) return;
      var mq = window.matchMedia("(resolution: " + (window.devicePixelRatio || 1) + "dppx)");
      var onChange = function () { mq.removeEventListener("change", onChange); apply(); watch(); };
      mq.addEventListener("change", onChange);
    })();
  }

  function boot(canvas, loaderUrl, config) {
    // The iPhone's ring/silent switch mutes Web Audio unless the page says it is a player.
    try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch (e) {}

    showHomeHint();

    var fill = document.getElementById("loader-fill");
    var script = document.createElement("script");
    script.src = loaderUrl;
    script.onerror = function () { fail("Could not download " + loaderUrl); };
    script.onload = function () {
      createUnityInstance(canvas, config, function (progress) {
        fill.style.width = Math.round(progress * 100) + "%";
      }).then(function (unity) {
        instance = unity;
        var loader = document.getElementById("loader");
        loader.classList.add("done");
        // Gone for good after the fade: a CSS fade can stall (a hidden page doesn't animate), and
        // a half-faded loader left over the game would be worse than no fade at all.
        setTimeout(function () { loader.style.display = "none"; }, 700);
        followPixelRatio();
        if (params.get("debug")) startDebugOverlay(params.get("debug"));
      }).catch(fail);
    };
    document.body.appendChild(script);
  }

  // ---------------------------------------------------------------- family password

  // SHA-256 as lowercase hex. The browser's own where it has one (any https page, localhost);
  // a small fallback for a plain-http page on the home network, where crypto.subtle is missing.
  function sha256Hex(text) {
    var bytes = new TextEncoder().encode(text);
    if (window.crypto && crypto.subtle && crypto.subtle.digest) {
      return crypto.subtle.digest("SHA-256", bytes).then(function (buf) { return toHex(new Uint8Array(buf)); });
    }
    return Promise.resolve(toHex(sha256Fallback(bytes)));
  }

  function toHex(arr) {
    var out = "";
    for (var i = 0; i < arr.length; i++) out += (arr[i] < 16 ? "0" : "") + arr[i].toString(16);
    return out;
  }

  function sha256Fallback(msg) {
    function ror(x, n) { return (x >>> n) | (x << (32 - n)); }
    var K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    var len = msg.length, total = ((len + 9 + 63) >> 6) << 6, data = new Uint8Array(total);
    data.set(msg);
    data[len] = 0x80;
    var view = new DataView(data.buffer), bits = len * 8;
    view.setUint32(total - 4, bits >>> 0);
    view.setUint32(total - 8, Math.floor(bits / 4294967296));
    var W = new Array(64);
    for (var off = 0; off < total; off += 64) {
      var t;
      for (t = 0; t < 16; t++) W[t] = view.getUint32(off + t * 4);
      for (t = 16; t < 64; t++) {
        var s0 = ror(W[t - 15], 7) ^ ror(W[t - 15], 18) ^ (W[t - 15] >>> 3);
        var s1 = ror(W[t - 2], 17) ^ ror(W[t - 2], 19) ^ (W[t - 2] >>> 10);
        W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (t = 0; t < 64; t++) {
        var t1 = (h + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + W[t]) | 0;
        var t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    var out = new Uint8Array(32), ov = new DataView(out.buffer);
    for (var i = 0; i < 8; i++) ov.setUint32(i * 4, H[i] >>> 0);
    return out;
  }

  // Runs `then` once the family password has been given on this device (remembered after the
  // first time), or straight away when this page has no gate. Nothing is downloaded before.
  function gate(then) {
    var cfg = window.HexWebGate;
    if (!cfg || !cfg.hash) { then(); return; }

    var KEY = "hexweb.gate";
    try { if (localStorage.getItem(KEY) === cfg.hash) { then(); return; } } catch (e) {}

    var box = document.getElementById("gate");
    var form = document.getElementById("gate-form");
    var input = document.getElementById("gate-input");
    var error = document.getElementById("gate-error");
    var loader = document.getElementById("loader");
    if (!box || !form || !input) { then(); return; }

    if (loader) loader.style.visibility = "hidden";
    box.hidden = false;
    setTimeout(function () { try { input.focus(); } catch (e) {} }, 50);

    var busy = false;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (busy) return;
      busy = true;
      var given = (input.value || "").trim();
      sha256Hex(cfg.salt + ":" + given).then(function (hash) {
        busy = false;
        if (hash !== cfg.hash) {
          error.hidden = false;
          form.classList.remove("wrong");
          void form.offsetWidth;
          form.classList.add("wrong");
          input.select();
          return;
        }
        try { localStorage.setItem(KEY, cfg.hash); } catch (e2) {}
        input.blur();
        box.hidden = true;
        if (loader) loader.style.visibility = "";
        then();
      }, function () { busy = false; });
    });
  }

  // ---------------------------------------------------------------- ?debug=1 overlay

  function startDebugOverlay(mode) {
    if (mode === "eruda") {
      var s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/eruda@3.0.1/eruda.min.js";
      s.onload = function () { window.eruda && window.eruda.init(); };
      document.body.appendChild(s);
    }

    var box = document.createElement("div");
    box.id = "hex-debug";
    var text = document.createElement("div");
    box.appendChild(text);

    function button(label, action) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.addEventListener("click", action);
      box.appendChild(b);
    }
    button("Copy logs", function () { copyText(report()); });
    button("Share logs", function () {
      if (navigator.share) navigator.share({ title: "Hexatone logs", text: report() }).catch(function () {});
      else copyText(report());
    });
    button("Hide", function () { box.remove(); });
    document.body.appendChild(box);

    var frames = 0, last = performance.now(), fps = 0, worst = 0, prev = last;
    function tick(now) {
      frames++;
      worst = Math.max(worst, now - prev);
      prev = now;
      if (now - last >= 1000) {
        fps = frames * 1000 / (now - last);
        text.textContent = summary(fps, worst);
        frames = 0; worst = 0; last = now;
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function summary(fps, worst) {
    var heap = instance && instance.Module && instance.Module.HEAPU8 ? (instance.Module.HEAPU8.length / 1048576).toFixed(0) + " MB" : "?";
    var js = performance.memory ? (performance.memory.usedJSHeapSize / 1048576).toFixed(0) + " MB" : "n/a";
    var c = document.getElementById("unity-canvas");
    var sa = safeAreaCss();
    return [
      "fps " + fps.toFixed(1) + "   worst " + worst.toFixed(0) + " ms",
      "wasm heap " + heap + "   js heap " + js,
      "css " + window.innerWidth + "x" + window.innerHeight + "   dpr " + (window.devicePixelRatio || 1) + "   render x" + renderPixelRatio(),
      "visual " + (window.visualViewport ? Math.round(window.visualViewport.width) + "x" + Math.round(window.visualViewport.height) : "n/a") +
        "   stage " + stageSize[0] + "x" + stageSize[1] + "   screen " + screen.width + "x" + screen.height,
      "canvas " + (c ? c.width + "x" + c.height : "?"),
      "safe css L" + sa[0] + " T" + sa[1] + " R" + sa[2] + " B" + sa[3],
      "ios " + isIOS + "   standalone " + isStandalone() + "   hidden x" + hiddenCount,
      "version " + (window.HexWebVersion || "dev"),
    ].join("\n");
  }

  function report() {
    return summary(0, 0) + "\n\n" + navigator.userAgent + "\n\n" + logLines.join("\n");
  }

  // ---------------------------------------------------------------- public surface

  window.HexWeb = {
    params: params,
    lang: lang,
    isIOS: function () { return isIOS; },
    isStandalone: isStandalone,
    isVisible: function () { return visible; },
    isPortrait: function () { return window.innerHeight > window.innerWidth; },
    isTouch: function () { return touchScreen; },
    deviceHint: deviceHint,
    setLanguage: setLanguage,
    setMatchRunning: setMatchRunning,
    hiddenCount: function () { return hiddenCount; },
    lastHiddenMs: function () { return lastHiddenMs; },
    safeAreaCss: safeAreaCss,
    renderPixelRatio: renderPixelRatio,
    setWakeLock: setWakeLock,
    share: share,
    copyText: copyText,
    requestClipboard: requestClipboard,
    takeClipboard: takeClipboard,
    localise: localise,
    fail: fail,
    boot: boot,
    gate: gate,
    sha256Hex: sha256Hex,
    report: report,
  };
})();
