/* tools.js — the actions the assistant can perform (all local, all free) */
import { state, save } from "./storage.js";

const remindersTimers = [];

function sanitizeCalc(raw) {
  const s = String(raw).trim().replace(/\^/g, "**");
  if (!/^[\d+\-*/%().\s]+$/.test(s)) throw new Error("unsupported expression");
  const v = Function(`"use strict";return (${s})`)();
  if (typeof v !== "number" || !isFinite(v)) throw new Error("not a finite number");
  return v;
}

/* Parse all [TOOL:name:arg] markers out of assistant text */
export function extractTools(text) {
  const out = [];
  const re = /\[TOOL:([a-z]+):([^\]]*)\]/gi;
  let m;
  while ((m = re.exec(text)) !== null) out.push({ name: m[1].toLowerCase(), arg: m[2].trim() });
  return out;
}

/* Execute one tool; returns a display string */
export async function runTool(name, arg) {
  switch (name) {
    case "calc": {
      try {
        const result = sanitizeCalc(arg);
        return `🧮 ${arg} = ${result}`;
      } catch (e) { return `🧮 couldn't compute “${arg}” (${e.message})`; }
    }
    case "note": {
      const [title, ...rest] = arg.split("|");
      state.notes.push({ text: rest.join("|") || title, at: Date.now() });
      save();
      return `📝 note saved${title && rest.length ? `: “${title.trim()}”` : ""}`;
    }
    case "remember": {
      const sep = arg.indexOf("|");
      const k = (sep === -1 ? arg : arg.slice(0, sep)).trim();
      const v = sep === -1 ? "" : arg.slice(sep + 1).trim();
      if (k && v) { state.memory[k] = v; save(); return `🧠 remembered “${k}”`; }
      return "🧠 usage: remember key | value";
    }
    case "recall": {
      const v = state.memory[String(arg).trim()];
      return v !== undefined ? `🧠 ${arg}: ${v}` : `🧠 I don't have “${arg}” stored.`;
    }
    case "remind": {
      const sep = arg.indexOf("|");
      const secs = Math.max(5, parseInt(sep === -1 ? arg : arg.slice(0, sep), 10) || 0);
      const text = sep === -1 ? "reminder" : arg.slice(sep + 1).trim();
      const at = Date.now() + secs * 1000;
      const id = Date.now();
      state.reminders.push({ id, at, text, fired: false });
      scheduleReminder(id, at, text);
      save();
      return `⏰ reminder set (${secs}s from now): ${text}`;
    }
    case "dice": {
      const sides = Math.min(120, Math.max(2, parseInt(arg, 10) || 6));
      return `🎲 d${sides} → ${1 + Math.floor(Math.random() * sides)}`;
    }
    case "search": {
      return await webSearch(arg);
    }
    case "page": {
      return await readPage(arg);
    }
    case "doc": {
      const sep = arg.indexOf("|");
      const title = (sep === -1 ? "Untitled doc" : arg.slice(0, sep)).trim() || "Untitled doc";
      const content = sep === -1 ? arg : arg.slice(sep + 1).trim();
      if (!content) return "📄 doc needs content: [TOOL:doc:Title|the text]";
      state.docs.push({ title, content: content.slice(0, 30000), at: Date.now() });
      if (state.docs.length > 30) state.docs.shift();
      save();
      return `📄 doc saved “${title}” — open the 📄 Docs tab to read or download it`;
    }
    case "research": {
      /* mini deep-research: fetch up to 3 wikipedia summaries on subtopics */
      const topics = arg.split(/[;,+]| and /i).map(t => t.trim()).filter(Boolean).slice(0, 3);
      const parts = [];
      for (const t of (topics.length ? topics : [arg])) {
        const r = await webSearch(t, true);
        parts.push(`### ${t}\n${r}`);
      }
      return `🔬 research gathered:\n\n` + parts.join("\n\n");
    }
    default:
      return `unknown tool “${name}”`;
  }
}

/* ---------- web search (free, keyless, CORS-friendly) ---------- */
async function webSearch(query, quiet) {
  const q = String(query).trim();
  if (!q) return "🔍 no search query given";
  try {
    /* 1) Wikipedia search + summary (CORS: origin=*) */
    const wiki = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=1&format=json&origin=*`
    );
    if (wiki.ok) {
      const j = await wiki.json();
      const title = j?.query?.search?.[0]?.title;
      if (title) {
        const sum = await fetch(
          `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`
        );
        if (sum.ok) {
          const sj = await sum.json();
          const text = `${sj.extract || ""} (source: Wikipedia — ${sj.content_urls?.desktop?.page || title})`;
          return quiet ? text :
            `🔍 web result for “${q}”:\n\n${text}`;
        }
      }
    }
    /* 2) fallback: DuckDuckGo lite HTML via jina reader (keyless) */
    const ddg = await fetch(`https://r.jina.ai/https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`);
    if (ddg.ok) {
      const txt = (await ddg.text()).slice(0, 2500);
      return `🔍 web result for “${q}”:\n\n${txt}`;
    }
    return `🔍 search failed for “${q}” — both lookup paths unreachable.`;
  } catch (e) {
    return `🔍 search error: ${e.message}`;
  }
}

/* ---------- read a specific page (keyless jina reader) ---------- */
async function readPage(url) {
  let u = String(url).trim();
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try {
    const res = await fetch(`https://r.jina.ai/${u}`);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const txt = (await res.text()).slice(0, 6000);
    return `🌐 contents of ${u}:\n\n${txt}`;
  } catch (e) {
    return `🌐 couldn't read ${u} (${e.message})`;
  }
}

/* ---------- reminders: page timer + service-worker timer ---------- */
function scheduleReminder(id, at, text) {
  const delay = at - Date.now();
  /* in-page timer (works while app is open) */
  if (delay > 0 && delay < 2147483000) {
    const t = setTimeout(() => fireReminder(id, text), delay);
    remindersTimers.push(t);
  }
  /* service-worker timer (works while app is backgrounded) */
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: "remind", id, at, text });
  } catch { /* no SW yet */ }
}

async function fireReminder(id, text) {
  const r = state.reminders.find(x => x.id === id);
  if (r) { r.fired = true; save(); }
  await showReminder(text, id);
}

/* Ask the SW to re-arm reminders after reload/restart of the app */
export function rearmReminders() {
  state.reminders.forEach(r => {
    if (r.fired) return;
    scheduleReminder(r.id, r.at, r.text);
  });
}

export async function showReminder(text, id) {
  try {
    if (Notification.permission === "granted") {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) reg.showNotification("⏰ hark reminder", { body: text, icon: "icon.svg", tag: "r" + (id ?? "") });
      else new Notification("⏰ hark reminder", { body: text, icon: "icon.svg" });
      return;
    }
  } catch { /* fall through to alert */ }
  alert(`⏰ ${text}`);
}

/* ---------- slash commands ---------- */
export const SLASH = {
  note: arg => runTool("note", arg),
  calc: arg => runTool("calc", arg),
  remember: arg => runTool("remember", arg),
  recall: arg => runTool("recall", arg),
  remind: arg => runTool("remind", arg),
  dice: arg => runTool("dice", arg),
  search: arg => runTool("search", arg),
  page: arg => runTool("page", arg),
  doc: arg => runTool("doc", arg),
  research: arg => runTool("research", arg)
};

export function isSlash(line) {
  return /^\/(\w+)\b/.test(line);
}

export function getSlash(line) {
  const m = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(line);
  if (!m || !SLASH[m[1]]) return null;
  return { name: m[1], arg: (m[2] ?? "").trim(), run: SLASH[m[1]] };
}
