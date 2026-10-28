/* REA storage.js — local data + encrypted vault (no server, free forever) */
(function () {
  var R = (window.REA = window.REA || {});
  var K = { SET: 'rea.settings', SES: 'rea.sessions', NOTES: 'rea.notes', MEM: 'rea.memory', TASKS: 'rea.tasks', PANELS: 'rea.panels', PIN: 'rea.pin', ENC: 'rea.keyenc', PRIV: 'rea.priv' };
  var TE = new TextEncoder();
  var TD = new TextDecoder();
  function b64(buf) { var b = new Uint8Array(buf), s = '', i; for (i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }
  function unb64(s) { var b = atob(s), a = new Uint8Array(b.length), i; for (i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; }
  function jget(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } }
  function jset(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  var vaultKey = null;
  function sha256(str) { return crypto.subtle.digest('SHA-256', TE.encode(str)).then(b64); }
  async function deriveKey(pin, salt) {
    var base = await crypto.subtle.importKey('raw', TE.encode(pin), { name: 'PBKDF2' }, false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: unb64(salt), iterations: 150000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function enc_(ivB64, key, text) { return b64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: unb64(ivB64) }, key, TE.encode(text))); }
  async function dec_(ivB64, key, ctB64) { return TD.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivB64) }, key, unb64(ctB64))); }

  var storage = {
    uid: uid,
    settings: function () { return jget(K.SET, { provider: 'groq', model: '', modelCustom: '', keyPlain: '', voiceOut: false }); },
    saveSettings: function (s) { jset(K.SET, s); },

    sessions: function () { return jget(K.SES, []); },
    saveSessions: function (l) { jset(K.SES, l); },

    notes: function () { return jget(K.NOTES, []); },
    saveNotes: function (l) { jset(K.NOTES, l); },

    memory: function () { return jget(K.MEM, []); },
    saveMemory: function (l) { jset(K.MEM, l); },

    tasks: function () { return jget(K.TASKS, []); },
    saveTasks: function (l) { jset(K.TASKS, l); },

    panels: function () { return jget(K.PANELS, []); },
    savePanels: function (l) { jset(K.PANELS, l); },

    /* ---- vault ---- */
    hasPin: function () { return !!jget(K.PIN, null); },
    isLocked: function () { return this.hasPin() && !vaultKey; },
    async setPin(pin) {
      if (!/^\d{4,8}$/.test(String(pin))) throw 'PIN must be 4 to 8 digits.';
      if (this.hasPin()) throw 'A PIN is already set. Remove it first.';
      var salt = b64(crypto.getRandomValues(new Uint8Array(16)));
      jset(K.PIN, { s: salt, h: await sha256(salt + ':' + pin) });
      vaultKey = await deriveKey(pin, salt);
      var st = this.settings();
      if (st.keyPlain) { await this._encKey(st.keyPlain); st.keyPlain = ''; this.saveSettings(st); }
    },
    async unlock(pin) {
      var pb = jget(K.PIN, null);
      if (!pb) return true;
      var h = await sha256(pb.s + ':' + pin);
      if (h !== pb.h) throw 'Wrong PIN.';
      vaultKey = await deriveKey(pin, pb.s);
      return true;
    },
    async removePin(pin) {
      var pb = jget(K.PIN, null);
      if (!pb) return;
      var h = await sha256(pb.s + ':' + pin);
      if (h !== pb.h) throw 'Wrong PIN.';
      vaultKey = null;
      localStorage.removeItem(K.PIN);
      localStorage.removeItem(K.ENC);
      localStorage.removeItem(K.PRIV);
    },
    lock: function () { vaultKey = null; },
    async _encKey(key) {
      var iv = b64(crypto.getRandomValues(new Uint8Array(12)));
      jset(K.ENC, { i: iv, c: await enc_(iv, vaultKey, key) });
    },
    async setApiKey(key) {
      var st = this.settings();
      if (this.hasPin()) {
        if (!vaultKey) throw 'LOCKED';
        await this._encKey(key);
        st.keyPlain = '';
      } else {
        st.keyPlain = key;
      }
      this.saveSettings(st);
    },
    async getApiKey() {
      var st = this.settings();
      if (st.keyPlain) return st.keyPlain;
      var rec = jget(K.ENC, null);
      if (!rec) return '';
      if (!vaultKey) throw 'LOCKED';
      return await dec_(rec.i, vaultKey, rec.c);
    },
    async savePriv(list) {
      if (this.hasPin()) {
        if (!vaultKey) throw 'LOCKED';
        var iv = b64(crypto.getRandomValues(new Uint8Array(12)));
        jset(K.PRIV, { i: iv, c: await enc_(iv, vaultKey, JSON.stringify(list)) });
      } else {
        jset(K.PRIV, { plain: list });
      }
    },
    async loadPriv() {
      var rec = jget(K.PRIV, null);
      if (!rec) return [];
      if (rec.plain) return rec.plain;
      if (!vaultKey) throw 'LOCKED';
      return JSON.parse(await dec_(rec.i, vaultKey, rec.c));
    },

    /* ---- backup ---- */
    exportAll: function () {
      var st = this.settings();
      var safe = {}; for (var k in st) if (k !== 'keyPlain') safe[k] = st[k];
      return { v: 1, app: 'REA', settings: safe, sessions: this.sessions(), notes: this.notes(), memory: this.memory(), tasks: this.tasks(), panels: this.panels() };
    },
    importAll: function (data) {
      if (!data || data.app !== 'REA') throw 'Not an REA backup file.';
      var st = this.settings();
      if (data.settings) for (var k in data.settings) if (k !== 'keyPlain') st[k] = data.settings[k];
      this.saveSettings(st);
      jset(K.SES, data.sessions || []);
      jset(K.NOTES, data.notes || []);
      jset(K.MEM, data.memory || []);
      jset(K.TASKS, data.tasks || []);
      jset(K.PANELS, data.panels || []);
    },
    wipe: function () {
      Object.keys(K).forEach(function (k) { localStorage.removeItem(K[k]); });
    }
  };
  R.storage = storage;
})();
