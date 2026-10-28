/* REA tools.js — local, key-free actions the assistant can run */
(function () {
  var R = (window.REA = window.REA || {});
  var S = R.storage;
  function j(x) { try { return JSON.stringify(x); } catch (e) { return 'null'; } }

  /* ---------- safe calculator (recursive descent, no eval) ---------- */
  function calc(exprIn) {
    var src = String(exprIn).replace(/,/g, '');
    var i = 0;
    function skip() { while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++; }
    function digit() { var m = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(src.slice(i)); if (!m) return null; i += m[0].length; return parseFloat(m[0]); }
    function ident() { var m = /^[a-zA-Z]+/.exec(src.slice(i)); return m ? m[0].toLowerCase() : null; }
    function expr() { var v = term(); for (;;) { skip(); var c = src[i]; if (c === '+') { i++; v += term(); } else if (c === '-') { i++; v -= term(); } else return v; } }
    function term() { var v = unary(); for (;;) { skip(); var c = src[i]; if (c === '*') { i++; v *= unary(); } else if (c === '/') { i++; v /= unary(); } else if (c === '%') { i++; v %= unary(); } else return v; } }
    function unary() { skip(); if (src[i] === '-') { i++; return -unary(); } if (src[i] === '+') { i++; return unary(); } return power(); }
    function power() { var b = atom(); skip(); if (src[i] === '^') { i++; var e = unary(); return Math.pow(b, e); } return b; }
    function atom() {
      skip();
      var id = ident();
      if (id === 'pi') { i += 2; return Math.PI; }
      if (id === 'e') { i += 1; return Math.E; }
      if (id === 'sqrt' || id === 'abs' || id === 'cbrt' || id === 'round' || id === 'floor' || id === 'ceil' || id === 'ln' || id === 'log') {
        i += id.length;
        skip();
        if (src[i] !== '(') throw 'expected ( after ' + id;
        i++;
        var v = expr(); skip();
        if (src[i] !== ')') throw 'missing )';
        i++;
        if (id === 'sqrt') return Math.sqrt(v);
        if (id === 'abs') return Math.abs(v);
        if (id === 'cbrt') return Math.cbrt(v);
        if (id === 'round') return Math.round(v);
        if (id === 'floor') return Math.floor(v);
        if (id === 'ceil') return Math.ceil(v);
        if (id === 'ln') return Math.log(v);
        return Math.log10(v);
      }
      if (src[i] === '(') { i++; var v2 = expr(); skip(); if (src[i] !== ')') throw 'missing )'; i++; return v2; }
      var n = digit();
      if (n === null || isNaN(n)) throw 'unexpected "' + (src[i] || 'end') + '"';
      return n;
    }
    var out = expr(); skip();
    if (i < src.length) throw 'unexpected "' + src[i] + '"';
    if (!isFinite(out)) throw 'not a finite number';
    return Math.round(out * 1e10) / 1e10;
  }

  function fmt(n) {
    if (typeof n !== 'number') return String(n);
    return n.toLocaleString('en-US', { maximumFractionDigits: 10 });
  }

  var DIST = { km: 1000, m: 1, cm: 0.01, mm: 0.001, mi: 1609.344, yd: 0.9144, ft: 0.3048, in: 0.0254 };
  var MASS = { kg: 1, g: 0.001, lb: 0.45359237, oz: 0.02834952, st: 6.35029318, t: 1000 };
  var TEMP = { c: 'c', f: 'f', k: 'k' };
  function convert(v, from, to) {
    from = String(from).toLowerCase(); to = String(to).toLowerCase();
    var val = Number(v);
    if (isNaN(val)) throw 'value not a number';
    var res;
    if (DIST[from] && DIST[to]) res = val * DIST[from] / DIST[to];
    else if (MASS[from] && MASS[to]) res = val * MASS[from] / MASS[to];
    else if (TEMP[from] && TEMP[to]) {
      var c = from === 'c' ? val : from === 'f' ? (val - 32) * 5 / 9 : val - 273.15;
      res = to === 'c' ? c : to === 'f' ? c * 9 / 5 + 32 : c + 273.15;
    } else throw 'unknown unit pair (' + from + ' to ' + to + '). Distances: km m cm mm mi yd ft in. Mass: kg g lb oz st t. Temp: c f k.';
    return Math.round(res * 1e6) / 1e6;
  }

  function dice(spec) {
    var m = /^(\d{0,3})d(\d{1,3})$/i.exec(String(spec || '1d6').trim());
    var n = m ? parseInt(m[1] || '1', 10) : 1;
    var sides = m ? parseInt(m[2], 10) : 6;
    if (n < 1) n = 1; if (n > 100) n = 100;
    var total = 0, rolls = [];
    for (var x = 0; x < n; x++) { var r = 1 + Math.floor(Math.random() * sides); rolls.push(r); total += r; }
    return n + 'd' + sides + ' → [' + rolls.join(', ') + '] = ' + total;
  }

  async function webRead(url) {
    if (!/^https?:\/\//i.test(url)) throw 'needs an http(s) URL';
    try {
      var r = await fetch('https://r.jina.ai/' + url.replace(/^https?:\/\//, 'https://'));
      if (!r.ok) throw 'reader ' + r.status;
      var t = await r.text();
      return t.slice(0, 16000);
    } catch (e) {
      var r2 = await fetch(url);
      var h = await r2.text();
      var d = new DOMParser().parseFromString(h, 'text/html');
      var txt = (d.body && d.body.innerText || '').replace(/\s{3,}/g, '\n');
      return txt.slice(0, 16000);
    }
  }

  var TOOLS = {
    calc: {
      any: false, desc: 'Precise math. Supports + - * / % ^ ( ) and sqrt abs cbrt ln log round floor ceil pi e.',
      syntax: '{"expr":"(12+8)*3^2"}',
      run: function (a) { return fmt(calc(a.expr == null ? '' : String(a.expr))); }
    },
    convert: {
      desc: 'Unit conversion for distance, mass and temperature.',
      syntax: '{"value":90,"from":"kg","to":"lb"}',
      run: function (a) { return fmt(convert(a.value, a.from, a.to)) + ' ' + String(a.to); }
    },
    time: {
      desc: 'Current local date, time and timezone.',
      syntax: '{}',
      run: function () { var d = new Date(); return d.toString() + ' | ' + (Intl.DateTimeFormat().resolvedOptions().timeZone || ''); }
    },
    timer: {
      desc: 'One-shot countdown that beeps and notifies when done (works while the app is open).',
      syntax: '{"minutes":10,"label":"laundry"}',
      run: function (a) {
        var mins = Number(a.minutes); if (!isFinite(mins) || mins <= 0 || mins > 24 * 60) throw 'minutes 0.1–1440';
        var label = String(a.label || 'Timer');
        var ms = Math.round(mins * 60000);
        setTimeout(function () {
          if (R.ui) { R.ui.beep(); try { if (window.Notification && Notification.permission === 'granted') new Notification('⏰ ' + label + ' done', { body: 'Timer set for ' + mins + ' min.' }); } catch (e) { } R.ui.toast('⏰ ' + label + ' done'); }
        }, ms);
        return 'timer set for ' + mins + ' min (' + j(label) + ')';
      }
    },
    dice: { desc: 'Dice roller.', syntax: '{"spec":"2d6"}', run: function (a) { return dice(a.spec); } },
    random: { desc: 'Random integer between min and max inclusive.', syntax: '{"min":1,"max":10}', run: function (a) { var mn = a.min == null ? 1 : Number(a.min), mx = a.max == null ? 10 : Number(a.max); if (mx < mn) { var t = mn; mn = mx; mx = t; } return String(mn + Math.floor(Math.random() * (mx - mn + 1))); } },
    note_add: {
      desc: 'Save a note to the Notes screen.',
      syntax: '{"text":"buy oat milk"}',
      run: function (a) {
        var list = S.notes();
        list.push({ id: S.uid(), text: String(a.text || '').slice(0, 2000), ts: Date.now() });
        S.saveNotes(list);
        return 'note saved (' + list.length + ' total)';
      }
    },
    note_search: {
      desc: 'Search saved notes.',
      syntax: '{"query":"milk"}',
      run: function (a) {
        var q = String(a.query || '').toLowerCase();
        var list = S.notes().filter(function (n) { return (n.text || '').toLowerCase().indexOf(q) > -1; });
        if (!list.length) return 'no notes match';
        return list.slice(-8).map(function (n) { return (n.text || '').slice(0, 140); }).join(' | ');
      }
    },
    memory_add: {
      desc: 'Persist a fact about the user into permanent memory (use for stable preferences and important facts only).',
      syntax: '{"fact":"The user prefers oat milk"}',
      run: function (a) {
        var mem = S.memory();
        var f = String(a.fact || '').trim().slice(0, 200);
        for (var x = 0; x < mem.length; x++) if (mem[x].toLowerCase() === f.toLowerCase()) return 'already in memory';
        mem.push(f);
        S.saveMemory(mem.slice(-60));
        return 'memory updated (' + Math.min(mem.length, 60) + ')';
      }
    },
    task_add: {
      desc: 'Add an action item to the Tasks screen.',
      syntax: '{"text":"Order tomatoes — ask at market"}',
      run: function (a) {
        var t = S.tasks();
        t.push({ id: S.uid(), text: String(a.text || '').slice(0, 200), done: false, ts: Date.now() });
        S.saveTasks(t);
        return 'task added';
      }
    },
    task_done: {
      desc: 'Mark a task done by its number as shown on the Tasks screen (1-based).',
      syntax: '{"index":2}',
      run: function (a) {
        var t = S.tasks().filter(function (x) { return !x.done; });
        var idx = (Number(a.index) || 1) - 1;
        if (idx < 0 || idx >= t.length) return 'no such open task (' + t.length + ' open)';
        var target = t[idx];
        var all = S.tasks();
        for (var x = 0; x < all.length; x++) if (all[x].id === target.id) all[x].done = true;
        S.saveTasks(all);
        return 'task done: ' + target.text.slice(0, 80);
      }
    },
    web_read: {
      desc: 'Read a public web page as plain text for summarizing or research.',
      syntax: '{"url":"https://example.com/article"}',
      run: function (a) { return webRead(a.url); }
    },
    panel_create: {
      desc: 'Create a custom panel on the Panels screen (a mini-widget the assistant fills in).',
      syntax: '{"title":"Bitcoin","prompt":"Give a one-line plain-English summary of what you know about bitcoin price trends, update when asked."}',
      run: function (a) {
        var p = S.panels();
        p.push({ id: S.uid(), title: String(a.title || 'Panel').slice(0, 40), prompt: String(a.prompt || '').slice(0, 600), content: 'Not refreshed yet — tap refresh.' });
        S.savePanels(p);
        return 'panel created';
      }
    }
  };

  function toolPrompt() {
    return Object.keys(TOOLS).map(function (k) {
      return '• ' + k + ' — ' + TOOLS[k].desc + '  args: ' + TOOLS[k].syntax;
    }).join('\n');
  }
  function runTool(name, args) {
    try {
      var t = TOOLS[name];
      if (!t) return { ok: false, error: 'unknown tool' };
      return { ok: true, result: String(t.run(args == null ? {} : args)).slice(0, 4000) };
    } catch (e) {
      return { ok: false, error: String(e).slice(0, 200) };
    }
  }
  function findToolCalls(text) {
    var calls = [];
    var rx = /\[\[TOOL (\w+) \{([\s\S]*?)\}\]/g, m;
    while ((m = rx.exec(text))) {
      var args = {};
      try { args = JSON.parse(m[2]); } catch (e) { args = { raw: m[2] }; }
      calls.push({ name: m[1], args: args });
      if (calls.length >= 4) break;
    }
    return calls;
  }
  function stripToolLines(text) {
    return String(text).replace(/\[\[TOOL \w+ \{[\s\S]*?\}\]\]\n?/g, '');
  }

  R.tools = TOOLS;
  R.toolPrompt = toolPrompt;
  R.runTool = runTool;
  R.findToolCalls = findToolCalls;
  R.stripToolLines = stripToolLines;
  R._calc = calc;
})();
