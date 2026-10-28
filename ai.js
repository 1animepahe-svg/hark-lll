/* REA ai.js — model calls, streaming and fallbacks (free-tier keys, stored locally) */
(function () {
  var R = (window.REA = window.REA || {});

  var PROVIDERS = {
    groq: {
      label: 'Groq (console.groq.com — free key)',
      kind: 'openai',
      base: 'https://api.groq.com/openai/v1/chat/completions',
      models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
      keyUrl: 'https://console.groq.com/keys'
    },
    gemini: {
      label: 'Google Gemini (aistudio.google.com — free key)',
      kind: 'gemini',
      base: 'https://generativelanguage.googleapis.com/v1beta/',
      models: ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
      keyUrl: 'https://aistudio.google.com/apikey'
    },
    openrouter: {
      label: 'OpenRouter (openrouter.ai — free models)',
      kind: 'openai',
      base: 'https://openrouter.ai/api/v1/chat/completions',
      models: ['meta-llama/llama-3.3-70b-instruct:free', 'google/gemini-2.0-flash-exp:free', 'deepseek/deepseek-chat-v3-0324:free', 'qwen/qwen3-30b-a3b:free'],
      keyUrl: 'https://openrouter.ai/keys'
    }
  };

  function buildSystemPrompt() {
    var S = R.storage;
    var now = new Date();
    var tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    var mem = S.memory().slice(0, 40).map(function (x) { return '• ' + x; }).join('\n');
    var open = S.tasks().filter(function (t) { return !t.done; }).slice(0, 12).map(function (t) { return '• ' + t.text; }).join('\n');
    return [
      'You are REA, the personal AI assistant on the user’s own device. You are one continuous assistant across the app: chat, notes, memory, tasks and panels.',
      'Tone: helpful, warm, concise. Prefer short paragraphs and bullet lists. Answer in the user’s language.',
      'Current local date/time: ' + now.toString() + (tz ? ' (' + tz + ')' : ''),
      '',
      'PERSISTENT MEMORY (facts you already know about the user):',
      mem || '(empty — nothing yet)',
      '',
      'OPEN TASKS:',
      open || '(none)'
    ].join('\n');
  }

  function toolSection() {
    return [
      '',
      'You can perform real actions with built-in local tools. When you need one, reply with a single line in EXACTLY this format:',
      '[[TOOL name {json}]]',
      'Rules: run only ONE tool per reply; place the line at the end of the reply; after it, stop writing — the app will append “TOOL RESULTS …” and you continue then.',
      'Available tools:',
      R.toolPrompt(),
      'Use tools whenever they beat guessing (math, conversions, timers, note/task/memory updates, reading a public web page).'
    ].join('\n');
  }

  function friendly(status, body) {
    var b = String(body || '').slice(0, 220);
    if (status === 401 || status === 403) return 'API key missing or invalid — paste a fresh free key in Settings.' + (b ? ' (' + b + ')' : '');
    if (status === 429) return 'Free-tier rate limit hit — wait about a minute and send again. Adding a second provider’s free key gives you extra headroom.';
    if (status === 404) return 'Model not found — pick another model in Settings. ' + b;
    if (status >= 500) return 'Provider hiccup (' + status + ') — try again in a moment. ' + b;
    return 'Request failed (' + status + '). ' + b;
  }

  async function readSSE(res, kind, onDelta) {
    if (!res.ok || !res.body) {
      var t = '';
      try { t = await res.text(); } catch (e) { }
      throw new Error(friendly(res.status, t));
    }
    var reader = res.body.getReader();
    var d = new TextDecoder();
    var buf = '', full = '';
    for (;;) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buf += d.decode(chunk.value, { stream: true });
      var nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        var line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        line = line.trim();
        if (line.indexOf('data:') !== 0) continue;
        var payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          var j = JSON.parse(payload);
          var piece = '';
          if (kind === 'gemini') {
            var cand = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
            piece = cand.map(function (p) { return p.text || ''; }).join('');
          } else {
            var ch = j.choices && j.choices[0] && j.choices[0].delta;
            piece = (ch && ch.content) || '';
          }
          if (piece) { full += piece; if (onDelta) onDelta(piece); }
        } catch (e) { }
      }
    }
    return full;
  }

  async function once(provider, model, key, system, messages, onDelta, signal) {
    var p = PROVIDERS[provider];
    if (!p) throw new Error('Unknown provider.');
    if (p.kind === 'gemini') {
      var contents = messages.map(function (m) {
        return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] };
      });
      var res = await fetch(p.base + model + ':streamGenerateContent?alt=sse&key=' + encodeURIComponent(key), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: signal,
        body: JSON.stringify({ contents: contents, systemInstruction: { parts: [{ text: system }] } })
      });
      return readSSE(res, 'gemini', onDelta);
    }
    var msgs = [{ role: 'system', content: system }].concat(messages.map(function (m) {
      return { role: m.role, content: m.content };
    }));
    var res2 = await fetch(p.base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      signal: signal,
      body: JSON.stringify({ model: model, messages: msgs, stream: true })
    });
    return readSSE(res2, 'openai', onDelta);
  }

  async function doTurn(opts) {
    var onDelta = opts.onDelta, signal = opts.signal;
    var list = opts.models && opts.models.length ? opts.models : [opts.model].filter(Boolean);
    var err = null;
    for (var x = 0; x < list.length; x++) {
      try {
        return await once(opts.provider, list[x], opts.key, opts.system, opts.messages, onDelta, signal);
      } catch (e) {
        if (signal && signal.aborted) throw e;
        err = e;
        var m = String(e && e.message || e);
        if (/Model not found/.test(m) || /\(404\)/.test(m) || /not found/i.test(m)) continue;
        throw e;
      }
    }
    throw err || new Error('All models failed.');
  }

  async function generate(opts) {
    opts.models = [opts.model].concat(PROVIDERS[opts.provider] ? PROVIDERS[opts.provider].models.filter(function (m) { return m !== opts.model; }) : []);
    try {
      return await doTurn(opts);
    } catch (e) {
      var m = String(e && e.message || e);
      if (/429/.test(m)) {
        if (onDeltaWatch(opts)) await sleep(15000);
        try { return await doTurn(opts); } catch (e2) { }
      }
      if (/Failed to fetch/i.test(m)) throw new Error('No internet connection (or provider unreachable). REA otherwise works offline for saved data.');
      throw e;
    }
  }
  function onDeltaWatch() { return false; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  R.PROVIDERS = PROVIDERS;
  R.buildSystemPrompt = buildSystemPrompt;
  R.generate = generate;
})();
