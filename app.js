/* app.js — startup, screens, navigation, voice, attachments */
import { state, save, newChat, wipe, exportData, importData } from "./storage.js";
import { askAI } from "./ai.js";
import { extractTools, runTool, rearmReminders, isSlash, getSlash, showReminder } from "./tools.js";

const $ = id => document.getElementById(id);
const chat = $("chat"), input = $("input"), statusEl = $("status");

/* ---------- boot ---------- */
if ("serviceWorker" in navigator) {
  addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

function boot() {
  if (!state.chats.length) newChat(false);
  rearmReminders();
  renderChat();
  renderViews();
  $("modelSel").value = state.settings.model;
  $("ToolsOn").checked = state.settings.toolsOn;
  syncVoiceBtn();
  if (!state.settings.notifAsked && "Notification" in window) {
    // ask lazily only when they click the reminder bell (no nagging)
  }
}
addEventListener("DOMContentLoaded", boot);

/* ---------- reminders fired by the SW while the page is open ---------- */
navigator.serviceWorker?.addEventListener("message", e => {
  const d = e.data || {};
  if (d.type === "remind-fired") {
    const r = state.reminders.find(x => x.id === d.id);
    if (r) { r.fired = true; save(); }
    showReminder(d.text, d.id);
  }
});

/* ---------- navigation ---------- */
$("menuBtn")?.addEventListener("click", toggleDrawer);
$("drawerClose").addEventListener("click", toggleDrawer);
$("backdrop").addEventListener("click", toggleDrawer);
function toggleDrawer() {
  $("drawer").classList.toggle("open");
  $("backdrop").classList.toggle("show");
}
document.querySelectorAll(".d-btn").forEach(b =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".d-btn").forEach(x => x.classList.toggle("on", x === b));
    document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
    $("view-" + b.dataset.view).classList.add("active");
    toggleDrawer();
  }));

/* ---------- chat ---------- */
function bubble(role, text) {
  const div = document.createElement("div");
  div.className = "msg " + (role === "user" ? "you" : "bot");
  const who = role === "user" ? "🫵" : "✦";
  div.innerHTML = `<span class="who"></span><div class="body"></div>`;
  div.querySelector(".who").textContent = who;
  const body = div.querySelector(".body");
  body.textContent = text || "";
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return body;
}

function renderChat() {
  chat.innerHTML = "";
  const c = state.chats[state.activeChat];
  if (!c.messages.length) {
    bubble("assistant", "Hi — I'm hark. Whatever you need, let me handle it.\n\nTry: /research James Webb telescope · /search Premier League table · /remind 1800 stretch · /doc write a 3-day Lagos trip plan");
  }
  c.messages.forEach(m => bubble(m.role, m.content));
}

let controller = null;
let attachments = [];      // pending images for the next message

/* ---------- speak the final answer (voice output) ---------- */
function stripToolLines(t) {
  return t.replace(/\[TOOL:[^\]]*\]/gi, "").trim();
}
function speak(text) {
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(stripToolLines(text).slice(0, 2000));
    u.rate = 1.02; u.pitch = 1;
    speechSynthesis.speak(u);
  } catch { /* no TTS */ }
}
function syncVoiceBtn() {
  const on = state.settings.voice;
  $("voiceBtn").textContent = on ? "🔊" : "🔇";
  $("voiceBtn").title = on ? "Voice on — tap to mute" : "Muted — tap to hear answers";
}

/* ---------- send ---------- */
$("composer").addEventListener("submit", async e => {
  e.preventDefault();
  if (controller) return;                       // busy
  const raw = input.value.trim();
  if (!raw && !attachments.length) return;
  input.value = "";
  input.style.height = "auto";

  const active = state.chats[state.activeChat];
  const sent = attachments;
  attachments = [];
  renderAttachmentPreview();

  /* slash commands short-circuit the model */
  if (isSlash(raw)) {
    const cmd = getSlash(raw);
    if (cmd) {
      bubble("user", raw);
      active.messages.push({ role: "user", content: raw });
      const result = await cmd.run(cmd.arg);
      bubble("assistant", result);
      active.messages.push({ role: "assistant", content: result });
      save(); renderViews(); return;
    }
  }

  bubble("user", raw + (sent.length ? " 📷×" + sent.length : ""));

  /* stream the answer */
  const body = bubble("assistant", "");
  body.insertAdjacentHTML("beforeend", '<span class="cursor"></span>');
  let acc = "";
  const cursor = body.querySelector(".cursor");
  const onDelta = d => { acc += d; body.textContent = acc; body.appendChild(cursor); chat.scrollTop = chat.scrollHeight; };
  $("stopGen").hidden = false;
  statusEl.textContent = "thinking…";
  controller = new AbortController();

  try {
    const full = await askAI(active.messages, state.memory,
                             { onDelta, model: state.settings.model, signal: controller.signal,
                               attachments: sent });
    acc = full || acc;
  } catch (err) {
    acc = acc || `⚠️ ${err.message}`;
  }

  controller = null;
  $("stopGen").hidden = true;
  statusEl.textContent = "";
  cursor.remove();
  body.textContent = acc;

  /* run tool markers — then feed results back for a synthesis round */
  const tools = state.settings.toolsOn ? extractTools(acc) : [];
  if (tools.length) {
    statusEl.textContent = "running tools…";
    const results = [];
    for (const t of tools) {
      const result = await runTool(t.name, t.arg);
      results.push(result);
      const card = document.createElement("div");
      card.className = "tcard";
      card.textContent = result;
      $("toolcards").appendChild(card);
    }
    $("toolcards").lastChild?.scrollIntoView({ block: "nearest" });

    /* synthesis: model answers again, knowing the tool results */
    const body2 = bubble("assistant", "");
    const cursor2 = document.createElement("span");
    cursor2.className = "cursor";
    body2.appendChild(cursor2);
    let acc2 = "";
    statusEl.textContent = "thinking…";
    controller = new AbortController();
    try {
      const follow = [
        ...active.messages,
        { role: "user", content: "(tool results)\n" + results.join("\n---\n") }
      ];
      const full2 = await askAI(follow, state.memory,
        { onDelta: d => { acc2 += d; body2.textContent = acc2; body2.appendChild(cursor2); chat.scrollTop = chat.scrollHeight; },
          model: state.settings.model, signal: controller.signal });
      acc2 = full2 || acc2;
    } catch (err) { if (!acc2) body2.remove(); }
    cursor2.remove();
    if (acc2) {
      body2.textContent = acc2;
      acc = acc2;
    }
    statusEl.textContent = "";
    controller = null;
  }

  if (state.settings.voice) speak(acc);

  if (!active.title) { active.title = raw.slice(0, 40) || "photo"; }
  active.messages.push({ role: "assistant", content: acc });
  save();
  renderViews();
});

$("stopGen").addEventListener("click", () => { try { controller?.abort(); } catch {} });

/* ---------- voice output toggle ---------- */
$("voiceBtn").addEventListener("click", () => {
  state.settings.voice = !state.settings.voice;
  save();
  if (!state.settings.voice) { try { speechSynthesis.cancel(); } catch {} }
  syncVoiceBtn();
});

/* ---------- mic input (free browser speech recognition) ---------- */
$("micBtn").addEventListener("click", () => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return alert("Voice input not supported in this browser");
  const r = new SR();
  r.lang = "en-US";
  r.interimResults = false;
  r.onresult = e => { input.value += (input.value ? " " : "") + e.results[0][0].transcript; input.focus(); };
  r.onerror = () => {};
  $("micBtn").style.color = "#f0883e";
  r.onend = () => { $("micBtn").style.color = ""; };
  try { r.start(); } catch {}
});

/* ---------- image attach (vision) ---------- */
$("attachBtn").addEventListener("click", () => $("photoInput").click());
$("photoInput").addEventListener("change", async e => {
  const f = e.target.files[0];
  if (!f) return;
  if (!f.type.startsWith("image/")) return alert("Photos only (JPG/PNG) — PDFs not supported");
  const dataUrl = await new Promise(res => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.readAsDataURL(f);
  });
  /* downscale big photos so we stay light */
  const small = await new Promise(res => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1024 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      res(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => res(dataUrl);
    img.src = dataUrl;
  });
  attachments.push({ dataUrl: small, name: f.name });
  e.target.value = "";
  renderAttachmentPreview();
});

function renderAttachmentPreview() {
  const box = $("attachmentPreview");
  box.innerHTML = "";
  attachments.slice(0, 4).forEach(a => {
    const thumb = document.createElement("img");
    thumb.src = a.dataUrl;
    thumb.className = "att";
    thumb.onclick = () => { attachments = attachments.filter(x => x !== a); renderAttachmentPreview(); };
    box.appendChild(thumb);
  });
}
        capture => {} /* delta */

/* model chip cycles auto → openai → openai-fast → mistral → deepseek */
$("modelBtn").addEventListener("click", () => {
  const order = ["auto", "openai", "openai-fast", "mistral", "deepseek"];
  const i = (order.indexOf(state.settings.model) + 1) % order.length;
  state.settings.model = order[i];
  save();
  $("modelSel").value = order[i];
  $("modelBtn").textContent = order[i] + (order[i] === "auto" ? " ▾" : "");
});

/* ---------- storage UI ---------- */
$("btnNew").addEventListener("click", () => { newChat(true); renderChat(); toggleDrawer(); });
$("btnClear").addEventListener("click", () => {
  if (confirm("Delete ALL chats, memory, notes, docs and reminders?")) { wipe(); location.reload(); }
});
$("btnExport").addEventListener("click", () => {
  const blob = new Blob([exportData()], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "hark-export-" + new Date().toISOString().slice(0, 10) + ".json";
  a.click();
  URL.revokeObjectURL(a.href);
});
$("btnImport").addEventListener("click", () => $("importFile").click());
$("importFile").addEventListener("change", e => {
  const f = e.target.files[0];
  if (!f) return;
  f.text().then(t => { importData(t); renderChat(); renderViews(); });
});

$("modelSel").addEventListener("change", () => {
  state.settings.model = $("modelSel").value;
  save();
});
$("ToolsOn").addEventListener("change", () => {
  state.settings.toolsOn = $("ToolsOn").checked;
  save();
});

$("memAdd").addEventListener("submit", e => {
  e.preventDefault();
  const k = $("memKey").value.trim(), v = $("memVal").value.trim();
  if (!k || !v) return;
  state.memory[k] = v;
  save();
  $("memKey").value = ""; $("memVal").value = "";
  renderViews();
});

/* notifications opt-in */
$("askNotif").addEventListener("click", async () => {
  if (!("Notification" in window)) return alert("Notifications unsupported here");
  const perm = await Notification.requestPermission();
  state.settings.notifAsked = true; save();
  $("askNotif").textContent = perm === "granted"
      ? "🔔 Notifications on" : "🔔 Notifications blocked by browser";
});

/* ---------- panel renderers ---------- */
function renderViews() {
  /* memory */
  const mem = $("memList"); mem.innerHTML = "";
  const entries = Object.entries(state.memory);
  if (!entries.length) mem.innerHTML = '<div class="empty">nothing remembered yet</div>';
  entries.forEach(([k, v]) => {
    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `<div><b>${esc(k)}</b><br><small>${esc(v)}</small></div>`;
    const del = document.createElement("button");
    del.className = "del"; del.textContent = "✕";
    del.onclick = () => { delete state.memory[k]; save(); renderViews(); };
    el.appendChild(del);
    mem.appendChild(el);
  });

  /* notes */
  const nl = $("noteList"); nl.innerHTML = "";
  if (!state.notes.length) nl.innerHTML = '<div class="empty">no notes yet — say: /note buy rice | check market close</div>';
  [...state.notes].reverse().forEach((n) => {
    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `<div>${esc(n.text)}<br><small>${new Date(n.at).toLocaleString()}</small></div>`;
    const del = document.createElement("button");
    del.className = "del"; del.textContent = "✕";
    del.onclick = () => { state.notes = state.notes.filter(x => x !== n); save(); renderViews(); };
    el.appendChild(del);
    nl.appendChild(el);
  });

  /* docs (artifacts) */
  const dl = $("docList"); dl.innerHTML = "";
  if (!state.docs.length) dl.innerHTML = '<div class="empty">no docs yet — say: /doc write a CV for a data analyst role</div>';
  [...state.docs].reverse().forEach((d) => {
    const el = document.createElement("div");
    el.className = "item";
    const short = d.content.length > 300 ? d.content.slice(0, 300) + "…" : d.content;
    el.innerHTML = `<div><b>${esc(d.title)}</b><br><span class="docbody">${esc(short)}</span><br><small>${new Date(d.at).toLocaleString()}</small></div>`;
    const dwn = document.createElement("button");
    dwn.className = "open"; dwn.textContent = "⬇ download";
    dwn.onclick = () => {
      const blob = new Blob([d.content], { type: "text/markdown" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = d.title.replace(/[^\w\d -]/g, "").trim() || "doc";
      a.click();
      URL.revokeObjectURL(a.href);
    };
    el.appendChild(dwn);
    const del = document.createElement("button");
    del.className = "del"; del.textContent = "✕";
    del.onclick = () => { state.docs = state.docs.filter(x => x !== d); save(); renderViews(); };
    el.appendChild(del);
    dl.appendChild(el);
  });

  /* reminders */
  const rl = $("remList"); rl.innerHTML = "";
  if (!state.reminders.length) rl.innerHTML = '<div class="empty">no reminders — say: /remind 600 tea break</div>';
  [...state.reminders].reverse().forEach(r => {
    const el = document.createElement("div");
    el.className = "item";
    const when = r.fired ? "fired" : formatIn(r.at - Date.now());
    el.innerHTML = `<div>${esc(r.text)}<br><small>${when}</small></div>`;
    const del = document.createElement("button");
    del.className = "del"; del.textContent = "✕";
    del.onclick = () => { state.reminders = state.reminders.filter(x => x !== r); save(); renderViews(); };
    el.appendChild(del);
    rl.appendChild(el);
  });
}

function formatIn(ms) {
  if (ms <= 0) return "any moment…";
  const m = Math.floor(ms / 60000), s = Math.ceil((ms % 60000) / 1000);
  return m ? `in ${m}m ${s}s` : `in ${s}s`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
