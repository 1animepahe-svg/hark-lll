/* REA app.js — screens, navigation, chat loop, voice, vault UI */
(function () {
  var R = (window.REA = window.REA || {});
  var S = R.storage;
  var $ = function (s) { return document.getElementById(s); };
  var $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  /* ---------- tiny UI helpers ---------- */
  var ui = {
    toast: function (msg, ms) {
      var t = $('toast');
      t.textContent = msg;
      t.classList.add('show');
      clearTimeout(ui._tt);
      ui._tt = setTimeout(function () { t.classList.remove('show'); }, ms || 2600);
    },
    beep: function () {
      try {
        var c = new (window.AudioContext || window.webkitAudioContext)();
        [0, 0.25, 0.5].forEach(function (d) {
          var o = c.createOscillator(), g = c.createGain();
          o.type = 'sine'; o.frequency.value = 880; o.connect(g); g.connect(c.destination);
          g.gain.setValueAtTime(0.0001, c.currentTime + d);
          g.gain.exponentialRampToValueAtTime(0.2, c.currentTime + d + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + d + 0.18);
          o.start(c.currentTime + d); o.stop(c.currentTime + d + 0.2);
        });
      } catch (e) { }
    },
    notify: function (title, body) {
      try { if (window.Notification && Notification.permission === 'granted') new Notification(title, { body: body || '' }); } catch (e) { }
    }
  };
  R.ui = ui;

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function inline(s) {
    s = esc(s);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    s = s.replace(/^\s*[-*]\s+(.*)$/gm, '• $1');
    s = s.replace(/\n/g, '<br>');
    return s;
  }
  function md(text) {
    var parts = String(text).split(/```(?:[a-zA-Z0-9_+-]*)\n?/);
    var out = '';
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 1) out += '<pre><code>' + esc(parts[i].replace(/\n$/, '')) + '</code></pre>';
      else out += inline(parts[i]);
    }
    return out;
  }
  R.md = md;

  /* ---------- state ---------- */
  var sessions = [];
  var current = null;
  var ctrl = null;
  var busy = false;

  function load() {
    sessions = S.sessions();
    if (!sessions.length) {
      sessions = [{ id: S.uid(), title: 'New chat', messages: [], ts: Date.now() }];
      S.saveSessions(sessions);
    }
    current = sessions[0];
  }

  /* ---------- screens / nav ---------- */
  var SCREENS = ['chat', 'notes', 'memory', 'tasks', 'panels', 'tools', 'settings'];
  function show(name) {
    SCREENS.forEach(function (s) { $('screen-' + s).hidden = (s !== name); });
    $$('.nav-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.screen === name); });
    $('top-title').textContent = ({ chat: 'REA', notes: 'Notes', memory: 'Memory', tasks: 'Action buttons', panels: 'Panels', tools: 'Quick tools', settings: 'Settings' })[name];
    $('input-row').hidden = (name !== 'chat');
    if (window.matchMedia('(max-width: 860px)').matches) $('sidebar').classList.remove('open');
    if (name === 'notes') renderNotes();
    if (name === 'memory') renderMemory();
    if (name === 'tasks') renderTasks();
    if (name === 'panels') renderPanels();
    if (name === 'settings') renderSettings();
  }

  /* ---------- chat ---------- */
  function renderThreads() {
    var html = '';
    sessions.forEach(function (s) {
      html += '<div class="thread' + (current && s.id === current.id ? ' active' : '') + '" data-id="' + s.id + '"><span class="t-title">' + esc(s.title) + '</span><button class="t-del" data-del="' + s.id + '" aria-label="Delete">✕</button></div>';
    });
    $('thread-list').innerHTML = html;
  }

  function findSession(id) { for (var i = 0; i < sessions.length; i++) if (sessions[i].id === id) return sessions[i]; return null; }

  function appendBubble(role, textHtml) {
    var d = document.createElement('div');
    d.className = 'message ' + role;
    var b = document.createElement('div');
    b.className = 'body';
    b.innerHTML = textHtml;
    d.appendChild(b);
    $('messages').appendChild(d);
    $('messages').scrollTop = $('messages').scrollHeight;
    return b;
  }

  function renderChat() {
    var wrap = $('messages');
    wrap.innerHTML = '';
    (current.messages || []).forEach(function (m) {
      appendBubble(m.role === 'assistant' ? 'assistant' : 'user', md(m.content));
    });
    if (!current.messages.length) {
      var st = S.settings();
      wrap.innerHTML = '<div class="hero"><img src="./icon.svg" alt=""><h1>REA</h1><p>Your free personal assistant — one thread, persistent memory, tools, private vault. Everything stays on this device.</p>' + (st.keyPlain || !S.hasPin() ? '<p class="dim">Add a free API key in Settings (Groq, Gemini or OpenRouter) to start.</p>' : '') + '</div>';
    }
  }

  function openChat(id) { current = findSession(id); renderThreads(); renderChat(); fillModelChip(); }

  function newChat() {
    var s = { id: S.uid(), title: 'New chat', messages: [], ts: Date.now() };
    sessions.unshift(s);
    S.saveSessions(sessions);
    openChat(s.id);
    show('chat');
  }

  function cleanOut(t) { return R.stripToolLines ? R.stripToolLines(t) : t; }

  async function assistantTurn() {
    var st = S.settings();
    var key = await S.getApiKey();
    if (!key) return ui.toast('Add a free API key in Settings first');
    var model = st.modelCustom || st.model || R.PROVIDERS[st.provider].models[0];
    var rounds = 0;
    busy = true; $('stop-btn').hidden = false; $('send-btn').disabled = true;
    while (rounds < 3) {
      var hist = current.messages.slice(-14).map(function (m) { return { role: m.role, content: m.content }; });
      var bubble = appendBubble('assistant', '<span class="typing"></span>');
      var acc = '';
      ctrl = new AbortController();
      var full = '';
      try {
        full = await R.generate({
          provider: st.provider, model: model, key: key,
          system: buildSystem, messages: hist,
          signal: ctrl.signal,
          onDelta: function (d) { acc += d; bubble.innerHTML = md(acc) + '<span class="caret"></span>'; }
        });
      } catch (e) {
        var m = String(e && e.message || e);
        if (ctrl.signal.aborted) { full = acc + ' (stopped)'; }
        else { bubble.innerHTML = '<span class="err">' + esc(m) + '</span>'; busy = false; $('stop-btn').hidden = true; $('send-btn').disabled = false; return; }
      }
      bubble.innerHTML = md(cleanOut(full) || '(empty)');
      current.messages.push({ role: 'assistant', content: full });
      S.saveSessions(sessions);
      var calls = R.findToolCalls(full);
      if (!calls.length || rounds === 2) break;
      var results = [];
      calls.forEach(function (c) {
        var r = R.runTool(c.name, c.args);
        var chip = document.createElement('div');
        chip.className = 'toolchip';
        chip.textContent = '⚡ ' + c.name + ' → ' + (r.ok ? String(r.result).slice(0, 90) : 'error: ' + r.error);
        bubble.appendChild(chip);
        results.push('[' + c.name + '] ' + (r.ok ? r.result : 'error: ' + r.error));
      });
      current.messages.push({ role: 'user', content: 'TOOL RESULTS:\n' + results.join('\n') + '\nContinue your answer using these results. Do not repeat the [[TOOL]] line.' });
      rounds++;
    }
    busy = false; $('stop-btn').hidden = true; $('send-btn').disabled = false;
    if (S.settings().voiceOut) speak(cleanOut(current.messages[current.messages.length - 1].content));
  }

  var buildSystem = '';

  function rebuildSystem() {
    buildSystem = R.buildSystemPrompt() + '\n' + toolSectionOf();
  }
  function toolSectionOf() {
    return '\nTOOLS — to run one, end your reply with a single line exactly:\n[[TOOL name {json}]]\nOne tool per reply, then stop; the app appends TOOL RESULTS and you continue.\n' + R.toolPrompt();
  }

  async function send() {
    var input = $('chat-input');
    var text = input.value.trim();
    if (!text || busy) return;
    if (S.isLocked()) { return showLock('Unlock REA to chat.'); }
    var key = '';
    try { key = await S.getApiKey(); } catch (e) { return showLock('REA is locked — unlock to use your key.'); }
    input.value = '';
    current.messages.push({ role: 'user', content: text });
    if (current.messages.length === 1) {
      current.title = text.slice(0, 40) || 'New chat';
      renderThreads();
    }
    S.saveSessions(sessions);
    appendBubble('user', md(text));
    rebuildSystem();
    try { await assistantTurn(); } catch (e) { ui.toast(String(e).slice(0, 120)); }
    S.saveSessions(sessions);
  }

  function speak(text) {
    try {
      if (!('speechSynthesis' in window)) return;
      var t = String(text).replace(/```[\s\S]*?```/g, '').replace(/[#*`>\-]{1,}/g, ' ').slice(0, 700);
      var u = new SpeechSynthesisUtterance(t);
      u.lang = navigator.language || 'en-US';
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch (e) { }
  }

  /* ---------- voice input ---------- */
  var rec = null, recOn = false;
  function micToggle() {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return ui.toast('Speech recognition is not supported in this browser.');
    if (recOn) { rec.stop(); return; }
    rec = new SR();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = function (e) {
      var t = '';
      for (var i = e.resultIndex; i < e.results.length; i++) t += e.results[i][0].transcript;
      $('chat-input').value = t;
    };
    rec.onend = function () { recOn = false; $('mic-btn').classList.remove('rec'); };
    rec.onerror = function (e) { ui.toast('mic: ' + (e.error || 'error')); recOn = false; $('mic-btn').classList.remove('rec'); };
    recOn = true; $('mic-btn').classList.add('rec');
    rec.start();
  }

  /* ---------- notes ---------- */
  function renderNotes() {
    var list = S.notes();
    var html = list.slice().reverse().map(function (n) {
      return '<div class="card"><div class="card-text">' + esc(n.text) + '</div><div class="card-foot"><span>' + new Date(n.ts).toLocaleString() + '</span><button class="chip" data-delnote="' + n.id + '">Delete</button></div></div>';
    }).join('') || '<p class="dim">No notes yet.</p>';
    $('notes-list').innerHTML = html;
    var privArea = $('private-wrap');
    if (S.isLocked()) {
      privArea.innerHTML = '<p class="dim">Private notes are locked. Unlock REA to view.</p><button class="btn" id="priv-unlock">Unlock</button>';
      var b = $('priv-unlock');
      if (b) b.onclick = function () { showLock('Unlock to see private notes.'); };
    } else {
      S.loadPriv().then(function (pl) {
        privArea.innerHTML = '<div class="row"><textarea id="private-note-input" rows="2" placeholder="Private note (encrypted in your vault)…"></textarea><button class="btn primary" id="private-add">Add</button></div><div id="private-notes-list">' +
          (pl.slice().reverse().map(function (n) { return '<div class="card"><div class="card-text">🔒 ' + esc(n.text) + '</div><div class="card-foot"><button class="chip" data-delpriv="' + n.id + '">Delete</button></div></div>'; }).join('') || '<p class="dim">No private notes.</p>') + '</div>';
        $('private-add').onclick = async function () {
          var t = $('private-note-input').value.trim();
          if (!t) return;
          var pl = await S.loadPriv();
          pl.push({ id: S.uid(), text: t, ts: Date.now() });
          await S.savePriv(pl);
          renderNotes();
        };
        privArea.querySelectorAll('[data-delpriv]').forEach(function (btn) {
          btn.onclick = async function () {
            var pl = await S.loadPriv();
            pl = pl.filter(function (x) { return x.id !== btn.dataset.delpriv; });
            await S.savePriv(pl);
            renderNotes();
          };
        });
      }).catch(function (e) { privArea.innerHTML = '<p class="err">' + esc(String(e)) + '</p>'; });
    }
  }

  /* ---------- memory ---------- */
  function renderMemory() {
    var mem = S.memory();
    $('memory-list').innerHTML = mem.map(function (m, i) {
      return '<div class="card"><div class="card-text">' + esc(m) + '</div><div class="card-foot"><button class="chip" data-delmem="' + i + '">Forget</button></div></div>';
    }).join('') || '<p class="dim">Memory is empty. The assistant saves facts here with its memory_add tool, and you can add manually.</p>';
    $('memory-list').querySelectorAll('[data-delmem]').forEach(function (b) {
      b.onclick = function () {
        var mem = S.memory();
        mem.splice(Number(b.dataset.delmem), 1);
        S.saveMemory(mem);
        renderMemory();
      };
    });
  }

  /* ---------- tasks ---------- */
  function renderTasks() {
    var t = S.tasks();
    var open = t.filter(function (x) { return !x.done; });
    var done = t.filter(function (x) { return x.done; });
    var html = open.map(function (x, i) {
      return '<div class="card task"><div class="card-text">' + esc(x.text) + '</div><div class="card-foot"><span>' + (i + 1) + ' </span><button class="chip" data-donetask="' + x.id + '">Done</button><button class="chip" data-runx="' + esc(x.text) + '">Ask REA</button><button class="chip" data-deltask="' + x.id + '">✕</button></div></div>';
    }).join('') || '<p class="dim">No open action items.</p>';
    html += done.length ? '<h4 class="dim">Done</h4>' + done.map(function (x) { return '<div class="card done"><div class="card-text">' + esc(x.text) + '</div></div>'; }).join('') : '';
    $('task-list').innerHTML = html;
    $('task-list').querySelectorAll('[data-donetask]').forEach(function (b) {
      b.onclick = function () {
        var all = S.tasks();
        all.forEach(function (x) { if (x.id === b.dataset.donetask) x.done = true; });
        S.saveTasks(all);
        renderTasks();
      };
    });
    $('task-list').querySelectorAll('[data-deltask]').forEach(function (b) {
      b.onclick = function () {
        S.saveTasks(S.tasks().filter(function (x) { return x.id !== b.dataset.deltask; }));
        renderTasks();
      };
    });
    $('task-list').querySelectorAll('[data-runx]').forEach(function (b) {
      b.onclick = function () { $('chat-input').value = b.dataset.runx; show('chat'); $('send-btn').focus(); };
    });
  }

  async function suggestTasks() {
    busyGuard();
    var st = S.settings();
    var key;
    try { key = await S.getApiKey(); } catch (e) { return showLock(); }
    if (!key) return ui.toast('Add a free API key first');
    var mem = S.memory().join('; ');
    var open = S.tasks().filter(function (t) { return !t.done; }).map(function (t) { return t.text; }).join('; ');
    var notes = S.notes().slice(-6).map(function (n) { return n.text; }).join(' ; ');
    var p = 'Suggest 2-4 short, concrete action items for this person based on the data below. Reply ONLY a JSON array like [{"action":"a short chat message REA can execute"}]. No markdown.\nMEMORY: ' + (mem || 'none') + '\nOPEN TASKS: ' + (open || 'none') + '\nRECENT NOTES: ' + (notes || 'none');
    ui.toast('Thinking…');
    var txt = await R.generate({ provider: st.provider, model: st.modelCustom || st.model, key: key, system: 'You output only compact JSON.', messages: [{ role: 'user', content: p }], onDelta: function () { } });
    var m = /\[[\s\S]*\]/.exec(txt);
    if (!m) return ui.toast('No suggestion came back — try again');
    var arr = JSON.parse(m[0]);
    var all = S.tasks();
    arr.forEach(function (x) { if (x && x.action) all.push({ id: S.uid(), text: String(x.action).slice(0, 160), done: false, ts: Date.now() }); });
    S.saveTasks(all);
    renderTasks();
  }
  function busyGuard() { if (busy) { ui.toast('REA is still answering…'); throw 'busy'; } }

  /* ---------- panels ---------- */
  function renderPanels() {
    var ar = S.panels();
    $('panels-grid').innerHTML = (ar.map(function (p) {
      return '<div class="card panel"><div class="panel-head"><strong>' + esc(p.title) + '</strong><span class="row-buttons"><button class="chip" data-refreshpanel="' + p.id + '">Refresh</button><button class="chip" data-delpanel="' + p.id + '">✕</button></span></div><div class="card-text">' + esc(p.content || 'Tap Refresh.') + '</div></div>';
    }).join('') || '<p class="dim">No panels. Add one — describe what it should show and REA fills it in.</p>');
    $('panels-grid').querySelectorAll('[data-delpanel]').forEach(function (b) {
      b.onclick = function () { S.savePanels(S.panels().filter(function (x) { return x.id !== b.dataset.delpanel; })); renderPanels(); };
    });
    $('panels-grid').querySelectorAll('[data-refreshpanel]').forEach(function (b) {
      b.onclick = async function () {
        var ar = S.panels(), p = findSession(b.dataset.refreshpanel) || null;
        var panel = ar.filter(function (x) { return x.id === b.dataset.refreshpanel; })[0];
        if (!panel) return;
        var st = S.settings();
        var key;
        try { key = await S.getApiKey(); } catch (e) { return showLock(); }
        if (!key) return ui.toast('Add a free API key first');
        b.textContent = '…';
        try {
          var txt = await R.generate({
            provider: st.provider, model: st.modelCustom || st.model, key: key,
            system: 'You are REA. Update the requested panel content. Be concise and current to the best of your knowledge; no markdown headings.',
            messages: [{ role: 'user', content: panel.prompt }], onDelta: function () { }
          });
          panel.content = txt;
          S.savePanels(ar);
        } catch (e) { ui.toast(String(e).slice(0, 120)); }
        renderPanels();
      };
    });
  }

  /* ---------- settings ---------- */
  function renderSettings() {
    var st = S.settings();
    var P = R.PROVIDERS;
    if ($('provider').value !== st.provider) $('provider').value = st.provider;
    fillModels(st.provider);
    if (st.model) $('model').value = st.model;
    $('model-custom').value = st.modelCustom || '';
    $('key-input').value = '';
    $('key-note').textContent = P[st.provider] ? 'Get a free key: ' + P[st.provider].keyUrl : '';
    $('voice-out').checked = !!st.voiceOut;
    var pinBox = $('pin-status');
    if (S.hasPin()) {
      pinBox.innerHTML = '<span>🔒 PIN is set. Private notes + API key are encrypted.</span><input id="pin-remove" placeholder="PIN to remove" inputmode="numeric"><button class="btn danger" id="pin-remove-btn">Remove PIN (erases private notes + stored key)</button>';
      $('pin-remove-btn').onclick = async function () {
        try {
          await S.removePin($('pin-remove').value.trim());
          ui.toast('PIN removed — private notes erased.');
          renderSettings();
        } catch (e) { $('err-pin').textContent = String(e); }
      };
    } else {
      pinBox.innerHTML = '<span>No PIN — set one to encrypt private notes and your API key.</span><input id="pin-new" placeholder="New PIN (4–8 digits)" inputmode="numeric" maxlength="8"><button class="btn" id="pin-set-btn">Set PIN</button>';
      $('pin-set-btn').onclick = async function () {
        try {
          await S.setPin($('pin-new').value.trim());
          var stl = S.settings();
          if (stl.keyPlain) {
            /* key re-encrypt handled in setPin via plain copy — re-store to encrypt */
            var k = stl.keyPlain;
            stl.keyPlain = ''; S.saveSettings(stl);
            try { await S.setApiKey(k); } catch (e) { S.saveSettings(Object.assign(stl, { keyPlain: k })); }
          }
          $('err-pin').textContent = '';
          ui.toast('PIN set — vault active');
          renderSettings();
        } catch (e) { $('err-pin').textContent = String(e); }
      };
    }
  }

  function fillModels(provider) {
    var sel = $('model');
    sel.innerHTML = '';
    (R.PROVIDERS[provider] || { models: [] }).models.forEach(function (m) {
      var o = document.createElement('option');
      o.value = m; o.textContent = m;
      sel.appendChild(o);
    });
  }
  async function saveSettingsFromForm() {
    var st = S.settings();
    st.provider = $('provider').value;
    if (!$('model').value) fillModels(st.provider);
    st.model = $('model').value || st.model;
    st.modelCustom = $('model-custom').value.trim();
    st.voiceOut = $('voice-out').checked;
    S.saveSettings(st);
    var k = $('key-input').value.trim();
    if (k) {
      try { await S.setApiKey(k); ui.toast('Key saved' + (S.hasPin() ? ' (encrypted in vault)' : '')); }
      catch (e) { if (String(e) === 'LOCKED') return showLock('Unlock to update your key.'); ui.toast(String(e)); }
      $('key-input').value = '';
    }
    renderChat();
  }

  async function testKey() {
    if (S.isLocked()) return showLock();
    var st = S.settings();
    var key;
    try { key = await S.getApiKey(); } catch (e) { return showLock(); }
    if (!key) return ui.toast('Save a key first');
    ui.toast('Testing…');
    try {
      var t = await R.generate({ provider: st.provider, model: st.modelCustom || st.model, key: key, system: 'Reply with the single word: ok', messages: [{ role: 'user', content: 'test' }], onDelta: function () { } });
      ui.toast('✅ Working: ' + String(t).trim().slice(0, 40));
    } catch (e) { ui.toast(String(e).slice(0, 140)); }
  }

  /* ---------- lock ---------- */
  function showLock(msg) {
    $('lock-error').textContent = msg || '';
    $('lock-pin').value = '';
    $('screen-lock').hidden = false;
  }
  async function tryUnlock() {
    try {
      await S.unlock($('lock-pin').value.trim());
      $('screen-lock').hidden = true;
      $('lock-error').textContent = '';
      renderChat(); fillModelChip();
      if (isActive('notes')) renderNotes();
      if (isActive('settings')) renderSettings();
    } catch (e) { $('lock-error').textContent = String(e); }
  }
  function isActive(name) { var s = $('screen-' + name); return s && !s.hidden; }

  /* ---------- tools screen wiring (direct use, no AI) ---------- */
  function wireToolShorcuts() {
    $('conv-go').onclick = function () {
      try { $('conv-result').textContent = String(R.runTool('convert', { value: $('conv-val').value, from: $('conv-from').value, to: $('conv-to').value }).result == null ? '' : R.runTool('convert', { value: $('conv-val').value, from: $('conv-from').value, to: $('conv-to').value }).result); } catch (e) { }
    };
    $('calc-go').onclick = function () {
      var r = R.runTool('calc', { expr: $('calc-mini').value });
      $('calc-mini-result').textContent = r.ok ? r.result : r.error;
    };
    $('dice-go').onclick = function () { var r = R.runTool('dice', { spec: $('dice-in').value }); $('calc-mini-result').textContent = r.ok ? r.result : r.error; };
    $('timer-go').onclick = function () {
      var r = R.runTool('timer', { minutes: Number($('timer-min').value) || 5, label: $('timer-label').value || 'Timer' });
      ui.toast(r.ok ? r.result : r.error);
      if (window.Notification && Notification.permission === 'default') Notification.requestPermission();
    };
    $('read-go').onclick = async function () {
      var r = R.runTool('web_read', { url: $('read-url').value.trim() });
      $('read-out').textContent = r.ok ? r.result : r.error;
    };
  }

  /* ---------- export / import / wipe ---------- */
  function doExport() {
    var blob = new Blob([JSON.stringify(S.exportAll(), null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'rea-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }
  function doImport(file) {
    var fr = new FileReader();
    fr.onload = function () {
      try {
        S.importAll(JSON.parse(fr.result));
        ui.toast('Imported — reloading');
        setTimeout(function () { location.reload(); }, 700);
      } catch (e) { ui.toast(String(e)); }
    };
    fr.readAsText(file);
  }

  /* ---------- boot ---------- */
  function fillModelChip() {
    var st = S.settings();
    $('model-chip').textContent = (st.modelCustom || st.model) ? (st.modelCustom || st.model) : '';
  }

  function boot() {
    load();
    rebuildSystem();
    /* nav */
    $$('.nav-btn').forEach(function (b) { b.onclick = function () { show(b.dataset.screen); }; });
    $('menu-btn').onclick = function () { $('sidebar').classList.toggle('open'); };
    $('scrim').onclick = function () { $('sidebar').classList.remove('open'); };
    $('settings-open').onclick = function () { show('settings'); };
    $('lock-hdr-btn').onclick = function () { S.lock(); showLock('REA locked. Enter your PIN.'); };
    /* sidebar */
    $('new-chat').onclick = newChat;
    $('thread-list').addEventListener('click', function (e) {
      var del = e.target.closest('[data-del]');
      var th = e.target.closest('.thread');
      if (del) {
        sessions = sessions.filter(function (s) { return s.id !== del.dataset.del; });
        if (!sessions.length) sessions = [{ id: S.uid(), title: 'New chat', messages: [], ts: Date.now() }];
        S.saveSessions(sessions);
        current = sessions[0];
        renderThreads(); renderChat();
      } else if (th) {
        openChat(th.dataset.id);
      }
    });
    /* chat */
    $('send-btn').onclick = send;
    $('chat-input').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    $('stop-btn').onclick = function () { if (ctrl) ctrl.abort(); };
    $('mic-btn').onclick = micToggle;
    /* notes */
    $('note-add').onclick = function () {
      var t = $('note-input').value.trim();
      if (!t) return;
      var l = S.notes();
      l.push({ id: S.uid(), text: t, ts: Date.now() });
      S.saveNotes(l);
      $('note-input').value = '';
      renderNotes();
    };
    $('notes-list').addEventListener('click', function (e) {
      var b = e.target.closest('[data-delnote]');
      if (b) { S.saveNotes(S.notes().filter(function (n) { return n.id !== b.dataset.delnote; })); renderNotes(); }
    });
    /* memory */
    $('memory-add').onclick = function () {
      var t = $('memory-input').value.trim();
      if (!t) return;
      var mem = S.memory();
      mem.push(t);
      S.saveMemory(mem);
      $('memory-input').value = '';
      renderMemory();
    };
    $('memory-clear').onclick = function () { S.saveMemory([]); renderMemory(); };
    /* tasks */
    $('task-add').onclick = function () {
      var t = $('task-input').value.trim();
      if (!t) return;
      var all = S.tasks();
      all.push({ id: S.uid(), text: t, done: false, ts: Date.now() });
      S.saveTasks(all);
      $('task-input').value = '';
      renderTasks();
    };
    $('task-suggest').onclick = async function () {
      try { await suggestTasks(); } catch (e) { if (String(e) !== 'busy') ui.toast(String(e).slice(0, 90)); }
    };
    /* panels */
    $('panel-add').onclick = function () {
      var t = $('panel-title').value.trim(), p = $('panel-prompt').value.trim();
      if (!t || !p) return ui.toast('Give the panel a title and a prompt');
      var ar = S.panels();
      ar.push({ id: S.uid(), title: t, prompt: p, content: 'Not refreshed yet — tap Refresh.' });
      S.savePanels(ar);
      $('panel-title').value = ''; $('panel-prompt').value = '';
      renderPanels();
    };
    /* tools */
    wireToolShorcuts();
    /* settings */
    $('provider').onchange = function () { fillModels($('provider').value); S.saveSettings(Object.assign(S.settings(), { provider: $('provider').value, model: '' })); $('model').selectedIndex = 0; renderSettings(); };
    $('save-settings').onclick = saveSettingsFromForm;
    $('test-key').onclick = testKey;
    $('export-btn').onclick = doExport;
    $('import-input').onchange = function (e) { if (e.target.files[0]) doImport(e.target.files[0]); };
    $('wipe-btn').onclick = function () {
      if (confirm('Erase ALL REA data on this device (chats, notes, memory, key, PIN)?')) {
        S.wipe();
        location.reload();
      }
    };
    /* lock */
    $('lock-unlock').onclick = tryUnlock;
    $('lock-pin').addEventListener('keydown', function (e) { if (e.key === 'Enter') tryUnlock(); });
    /* model chip */
    if (!S.settings().model) {
      var st = S.settings();
      st.model = (R.PROVIDERS[st.provider] || R.PROVIDERS.groq).models[0];
      S.saveSettings(st);
    }
    fillModelChip();

    /* lock gate */
    if (S.isLocked()) showLock();

    /* PWA */
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      window.__install = e;
      var btn = $('install-btn');
      if (btn) {
        btn.hidden = false;
        btn.onclick = function () { e.prompt(); };
      }
    });
    if ('serviceWorker' in navigator) {
      try { navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(function () { }); } catch (e) { }
    }

    renderThreads();
    renderChat();
    show('chat');
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
