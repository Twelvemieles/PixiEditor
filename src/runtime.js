// Runtime injected into the game page (classic script, runs before the game).
// Records which line of code set each property of each Pixi object.
(function () {
  if (globalThis.__PIXI_EDITOR__) return;
  var meta = new WeakMap();
  var seq = 0;
  var apps = [];
  var siteUse = new Map(); // id -> number of objects using that line
  var appDecls = new Map(); // app -> { declId, name }

  function isDisplay(o) {
    return !!o && typeof o === "object" && Array.isArray(o.children) && typeof o.addChild === "function" && !!o.position;
  }
  // HTML elements the game creates (menus, forms…): shown by the editor next to the Pixi scene.
  function isDom(o) {
    return !!o && typeof o === "object" && o.nodeType === 1 && typeof o.getBoundingClientRect === "function";
  }
  function isApp(o) {
    return !!o && typeof o === "object" && !!o.stage && typeof o.init === "function" && !isDisplay(o);
  }
  function m(o) {
    var x = meta.get(o);
    if (!x) { x = { name: null, declId: null, sites: {} }; meta.set(o, x); }
    return x;
  }
  function use(id) { siteUse.set(id, (siteUse.get(id) || 0) + 1); }

  // ---- Game audio mute (the editor's own sounds are not affected).
  // WebAudio: everything the game connects to a context's speakers goes through one gain node per
  // context. Media elements (<audio>, new Audio()) are muted directly.
  var muted = false;
  // The editor page (same origin) remembers the choice: start muted before the game makes a sound.
  try { muted = window.parent !== window && window.parent.localStorage.getItem("pixi-editor:muted") === "1"; } catch (e) { /* no storage */ }
  var masters = [];
  var mediaEls = typeof Set !== "undefined" ? new Set() : null;
  function masterFor(ctx) {
    for (var i = 0; i < masters.length; i++) if (masters[i].ctx === ctx) return masters[i].gain;
    var gain = origCreateGain.call(ctx);
    gain.gain.value = muted ? 0 : 1;
    origConnect.call(gain, ctx.destination);
    masters.push({ ctx: ctx, gain: gain });
    return gain;
  }
  var AN = typeof AudioNode !== "undefined" ? AudioNode.prototype : null;
  var BAC = typeof BaseAudioContext !== "undefined" ? BaseAudioContext.prototype : typeof AudioContext !== "undefined" ? AudioContext.prototype : null;
  var origConnect = AN && AN.connect;
  var origDisconnect = AN && AN.disconnect;
  var origCreateGain = BAC && BAC.createGain;
  if (AN && origConnect && origCreateGain) {
    AN.connect = function (target) {
      if (target && typeof AudioDestinationNode !== "undefined" && target instanceof AudioDestinationNode && !(typeof OfflineAudioContext !== "undefined" && target.context instanceof OfflineAudioContext)) {
        var args = Array.prototype.slice.call(arguments);
        args[0] = masterFor(target.context);
        return origConnect.apply(this, args);
      }
      return origConnect.apply(this, arguments);
    };
    AN.disconnect = function (target) {
      if (target && typeof AudioDestinationNode !== "undefined" && target instanceof AudioDestinationNode) {
        var args = Array.prototype.slice.call(arguments);
        args[0] = masterFor(target.context);
        try { return origDisconnect.apply(this, args); } catch (e) { return undefined; }
      }
      return origDisconnect.apply(this, arguments);
    };
  }
  if (typeof HTMLMediaElement !== "undefined") {
    var origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (mediaEls) mediaEls.add(this);
      if (muted) this.muted = true;
      return origPlay.apply(this, arguments);
    };
  }
  function setMuted(on) {
    muted = !!on;
    for (var i = 0; i < masters.length; i++) masters[i].gain.gain.value = muted ? 0 : 1;
    if (mediaEls) mediaEls.forEach(function (el) { el.muted = muted; });
    if (typeof document !== "undefined") {
      var els = document.querySelectorAll("audio, video");
      for (var j = 0; j < els.length; j++) els[j].muted = muted;
    }
  }

  // ---- Elements written in index.html: the editor's server marked each tag with
  // data-pe="<declId> <kind>=<siteId> …". Read them into the elements' meta and remove the marks.
  // Tags written in innerHTML templates carry the same marks plus "tpl"; they appear whenever the
  // game sets innerHTML, so new elements are adopted as they are added to the page.
  function adoptHtml(root) {
    var els = (root || document).querySelectorAll("[data-pe]");
    var list = root && root.hasAttribute && root.hasAttribute("data-pe") ? [root].concat(Array.prototype.slice.call(els)) : els;
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      var parts = (el.getAttribute("data-pe") || "").split(" ");
      el.removeAttribute("data-pe");
      var hm = m(el);
      if (hm.declId) continue; // already linked (created by code)
      var tpl = parts[1] === "tpl";
      hm.declId = parts[0];
      hm.html = !tpl;
      hm.tpl = tpl;
      use(parts[0]);
      for (var k = 1; k < parts.length; k++) {
        var eq = parts[k].lastIndexOf("=");
        if (eq < 1) continue;
        var kind = parts[k].slice(0, eq), sid = parts[k].slice(eq + 1);
        if (hm.sites[kind]) continue; // a line of code sets it later: that one wins
        hm.sites[kind] = tpl ? { id: sid, seq: ++seq, tpl: true } : { id: sid, seq: ++seq, html: true };
        use(sid);
      }
    }
  }
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { adoptHtml(); });
    else adoptHtml();
    if (typeof MutationObserver !== "undefined") {
      new MutationObserver(function (records) {
        for (var r = 0; r < records.length; r++) {
          var added = records[r].addedNodes;
          for (var a = 0; a < added.length; a++) if (added[a].nodeType === 1) adoptHtml(added[a]);
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  globalThis.__PIXI_EDITOR__ = {
    // Code site that sets a property: returns the same object.
    s: function (o, kind, id, transient) {
      if (isDisplay(o) && kind === "parent:children") {
        // createContainer({ children: [o] }): the helper adds it later with its own addChild(),
        // so the list entry is applied again when the container is created (see d).
        var cm = m(o);
        if (cm.childSite !== id) use(id);
        cm.childSite = id;
        if (!cm.sites.parent) cm.sites.parent = { id: id, seq: ++seq };
      } else if (isDom(o)) {
        // HTML element: inline style (css:font-size) and properties (attr:placeholder).
        // `el.style.fontSize = …` arrives with the Pixi text-style kind (style.fontSize).
        var dk = /^(css|attr):/.test(kind) ? kind : /^style\.\w+$/.test(kind) ? "css:" + kind.slice(6).replace(/[A-Z]/g, function (c) { return "-" + c.toLowerCase(); }) : null;
        if (!dk) return o;
        var hm = m(o);
        var hp = hm.sites[dk];
        if (transient && hp && !hp.transient) return o;
        if (!hp || hp.id !== id) use(id);
        hm.sites[dk] = transient ? { id: id, seq: ++seq, transient: true } : { id: id, seq: ++seq };
      } else if (isDisplay(o) && /^(css|attr):/.test(kind)) {
        // a Pixi object with a `style` or `value` of its own: not an HTML property
      } else if (isDisplay(o)) {
        var mm = m(o);
        var prev = mm.sites[kind];
        // `transient`: a line inside a pointer handler (hover/press state). It never replaces the
        // object's own setup line for that property.
        if (transient && prev && !prev.transient) return o;
        if (!prev || prev.id !== id) use(id);
        mm.sites[kind] = transient ? { id: id, seq: ++seq, transient: true } : { id: id, seq: ++seq };
      }
      return o;
    },
    // Creation of an object with a variable name: returns the same object.
    // `opts` maps properties set in the constructor/creation chain to their code sites.
    // `factory` = created by a helper call (createSprite({...})): the call site wins over the
    // `new Sprite()` inside the helper, which runs first.
    d: function (o, id, name, opts, factory) {
      if (isApp(o)) {
        if (apps.indexOf(o) < 0) apps.push(o);
        if (!appDecls.has(o)) appDecls.set(o, { declId: id, name: name });
      } else if (isDisplay(o)) {
        var mm = m(o);
        if (!mm.declId || (factory && mm.declId !== id)) { mm.declId = id; mm.name = name; mm.factory = !!factory; use(id); }
        if (opts) {
          for (var kind in opts) {
            if (!mm.sites[kind] || mm.sites[kind].id !== opts[kind]) use(opts[kind]);
            mm.sites[kind] = { id: opts[kind], seq: ++seq };
          }
        }
        for (var i = 0; i < o.children.length; i++) {
          var km = meta.get(o.children[i]);
          if (km && km.childSite) { km.sites.parent = { id: km.childSite, seq: ++seq }; km.childSite = null; }
        }
      } else if (isDom(o)) {
        var dm = m(o);
        if (!dm.declId) { dm.declId = id; dm.name = name; dm.dom = true; use(id); }
      }
      return o;
    },
    meta: function (o) { return meta.get(o) || null; },
    // The editor replaced `from` with `to` in the scene (e.g. another spine): same code lines.
    adopt: function (from, to) { var x = meta.get(from); if (x) meta.set(to, x); },
    ensureMeta: m,
    siteUse: siteUse,
    apps: apps,
    appDecls: appDecls,
    // Set by the editor while in Edit mode; components pause their animations.
    paused: false,
    nextSeq: function () { return ++seq; },
    setMuted: setMuted,
    isMuted: function () { return muted; },
  };
})();
