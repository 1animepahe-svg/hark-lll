/* storage.js — saving, memory, docs, export and import */
const KEY = "harklite-state-v1";

const DEFAULTS = {
  chats: [],
  activeChat: 0,
  memory: {},           // { key: value }
  notes: [],            // { text, at }
  docs: [],             // { title, content, at }
  reminders: [],        // { id, at(sec epoch), text, fired }
  settings: { model: "auto", toolsOn: true, notifAsked: false, voice: false }
};

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const parsed = JSON.parse(raw);
    return { ...structuredClone(DEFAULTS), ...parsed,
             settings: { ...DEFAULTS.settings, ...(parsed.settings || {}) } };
  } catch { return structuredClone(DEFAULTS); }
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); }
  catch (e) { console.warn("storage save failed", e); }
}

function newChat(fresh) {
  if (fresh && state.chats.length) state.chats = [];
  state.chats.unshift({ title: "", messages: [], created: Date.now() });
  state.activeChat = 0;
  save();
}

function wipe() {
  localStorage.removeItem(KEY);
  state = structuredClone(DEFAULTS);
}

function exportData() {
  return JSON.stringify(state, null, 2);
}

function importData(json) {
  const parsed = JSON.parse(json);
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.chats)) {
    throw new Error("Not a hark export file");
  }
  state = { ...structuredClone(DEFAULTS), ...parsed,
            settings: { ...DEFAULTS.settings, ...(parsed.settings || {}) } };
  save();
}

export { state, save, newChat, wipe, exportData, importData };
