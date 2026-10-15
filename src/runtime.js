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
  function isApp(o) {
    return !!o && typeof o === "object" && !!o.stage && typeof o.init === "function" && !isDisplay(o);
  }
  function m(o) {
    var x = meta.get(o);
    if (!x) { x = { name: null, declId: null, sites: {} }; meta.set(o, x); }
    return x;
  }
  function use(id) { siteUse.set(id, (siteUse.get(id) || 0) + 1); }

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
  };
})();
