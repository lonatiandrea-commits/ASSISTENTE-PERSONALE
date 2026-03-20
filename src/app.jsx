import { useState, useEffect, useRef, useCallback } from "react";

const LS = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const defaultMemoria = {
  nome: "",
  settore: "Edilizia / Costruzioni",
  stile: "cordiale ma professionale",
  clienti: [],
  fornitori: [],
  note_stile: [],
  ultima_modifica: null,
};

function buildSystemPrompt(m) {
  return `Sei l'assistente personale italiano di ${m.nome || "un imprenditore edile"}.

PROFILO UTENTE:
- Settore: ${m.settore}
- Stile comunicativo: ${m.stile}
- Note di stile apprese: ${m.note_stile.join("; ") || "nessuna ancora"}
- Clienti noti: ${m.clienti.join(", ") || "nessuno ancora"}
- Fornitori noti: ${m.fornitori.join(", ") || "nessuno ancora"}

CAPACITÀ:
1. Scrivi email nel suo stile (cordiale, professionale, terminologia edilizia)
2. Gestisci appuntamenti e promemoria (Google Calendar integrato)
3. Genera preventivi, rapporti di cantiere, comunicazioni clienti
4. Cerca e confronta fornitori e prezzi
5. Ricorda tutto ciò che impari per migliorare le risposte future

REGOLE:
- Parla SEMPRE in italiano perfetto
- Sii conciso ma completo — l'utente spesso è in auto o in cantiere
- Se crei un'email, usa questo formato esatto:
  📧 EMAIL PRONTA:
  OGGETTO: [oggetto]
  ---
  [testo email]
- Se rilevi un appuntamento da creare, usa:
  📅 APPUNTAMENTO RILEVATO:
  Titolo: [titolo]
  Data: [data]
  Ora: [ora]
  Luogo: [luogo se presente]
- Se crei un documento/preventivo:
  📄 DOCUMENTO:
  [contenuto formattato]
- Se aggiorni la memoria: termina con
  🧠 APPRESO: [cosa hai imparato]
- Fai domande di approfondimento SOLO se indispensabili
- Anticipa le esigenze: se chiede un preventivo, chiedi subito cliente, lavoro, misure
- Tono: caldo ma efficiente, come un assistente di fiducia`;
}

const C = {
  bg: "#0f1923", bgCard: "#1a2535", bgInput: "#243040",
  accent: "#e8a020", accentDk: "#b87d10",
  text: "#f0f4f8", muted: "#8899aa", border: "#2a3a4a",
  bubbleUser: "#1a4a6a", bubbleAI: "#1e2d3d",
  green: "#1a6b3c", red: "#c0392b",
};

export default function App() {
  const [memoria, setMemoria] = useState(() => LS.get("ass_memoria") || defaultMemoria);
  const [chat, setChat] = useState(() => (LS.get("ass_chat") || []).slice(-40));
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [listening, setListening] = useState(false);
  const [view, setView] = useState("chat");
  const [setupDone, setSetupDone] = useState(() => !!(LS.get("ass_memoria")?.nome));
  const [pendingEvent, setPendingEvent] = useState(null);
  const [toast, setToast] = useState(null);
  const [speakEnabled, setSpeakEnabled] = useState(true);
  const chatEndRef = useRef(null);
  const recRef = useRef(null);
  const taRef = useRef(null);

  useEffect(() => { LS.set("ass_chat", chat); }, [chat]);
  useEffect(() => { LS.set("ass_memoria", memoria); }, [memoria]);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chat, loading]);

  const showToast = useCallback((msg, type = "ok") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const speak = useCallback((text) => {
    if (!speakEnabled || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const clean = text.replace(/[📧📅📄⏰🧠*_#\-]/g, "").slice(0, 280);
    const u = new SpeechSynthesisUtterance(clean);
    u.lang = "it-IT"; u.rate = 1.05;
    const voices = window.speechSynthesis.getVoices();
    const itVoice = voices.find(v => v.lang.startsWith("it"));
    if (itVoice) u.voice = itVoice;
    window.speechSynthesis.speak(u);
  }, [speakEnabled]);

  const send = useCallback(async (text) => {
    if (!text?.trim() || loading) return;
    const userMsg = { role: "user", content: text.trim(), ts: Date.now() };
    const newChat = [...chat, userMsg];
    setChat(newChat);
    setInput("");
    setLoading(true);
    try {
      const messages = newChat.map(m => ({ role: m.role, content: m.content }));
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          system: buildSystemPrompt(memoria),
          messages,
          mcp_servers: [{ type: "url", url: "https://gcal.mcp.claude.com/mcp", name: "gcal" }]
        })
      });
      const data = await res.json();
      let reply = "";
      if (data.content) {
        for (const b of data.content) { if (b.type === "text") reply += b.text; }
      }
      if (!reply) reply = "Non ho ricevuto risposta. Riprova.";
      const aiMsg = { role: "assistant", content: reply, ts: Date.now() };
      setChat(prev => [...prev, aiMsg]);
      if (reply.includes("📅 APPUNTAMENTO RILEVATO:")) setPendingEvent(reply);
      if (reply.includes("🧠 APPRESO:")) {
        const learned = reply.split("🧠 APPRESO:")[1].split("\n")[0].trim();
        if (learned) setMemoria(prev => ({ ...prev, note_stile: [...prev.note_stile.slice(-9), learned], ultima_modifica: Date.now() }));
      }
      speak(reply);
    } catch {
      setChat(prev => [...prev, { role: "assistant", content: "⚠️ Errore di connessione. Controlla la rete e riprova.", ts: Date.now() }]);
    } finally {
      setLoading(false);
    }
  }, [chat, loading, memoria, speak]);

  const startListen = useCallback(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { showToast("Microfono non supportato", "err"); return; }
    const r = new SR();
    r.lang = "it-IT"; r.continuous = false; r.interimResults = false;
    r.onstart = () => setListening(true);
    r.onend = () => setListening(false);
    r.onresult = (e) => { send(e.results[0][0].transcript); };
    r.onerror = () => { setListening(false); showToast("Errore microfono", "err"); };
    recRef.current = r;
    r.start();
  }, [send, showToast]);

  const stopListen = useCallback(() => { recRef.current?.stop(); setListening(false); }, []);

  const addToCalendar = useCallback(async () => {
    if (!pendingEvent) return;
    try {
      await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 500,
          system: "Crea l'evento su Google Calendar con i dettagli forniti.",
          messages: [{ role: "user", content: `Crea questo evento: ${pendingEvent}` }],
          mcp_servers: [{ type: "url", url: "https://gcal.mcp.claude.com/mcp", name: "gcal" }]
        })
      });
      showToast("✅ Aggiunto al calendario!");
    } catch { showToast("Errore calendario", "err"); }
    setPendingEvent(null);
  }, [pendingEvent, showToast]);

  if (!setupDone) {
    return <Setup onComplete={(nome) => {
      const m = { ...defaultMemoria, nome, ultima_modifica: Date.now() };
      setMemoria(m);
      setChat([{ role: "assistant", content: `Ciao ${nome}! 👋 Sono il tuo assistente personale.\n\nSono pronto ad aiutarti con email, appuntamenti, preventivi e rapporti di cantiere. Puoi scrivermi o parlarmi — anche dal telefono in cantiere.\n\nCosa facciamo?`, ts: Date.now() }]);
      setSetupDone(true);
    }} />;
  }

  return (
    <div style={s.app}>
      <div style={s.bgGlow} />
      {toast && <div style={{ ...s.toast, background: toast.type === "err" ? C.red : C.green }}>{toast.msg}</div>}
      <header style={s.header}>
        <div style={s.hLeft}>
          <div style={s.logo}>A</div>
          <div>
            <div style={s.hTitle}>Assistente</div>
            <div style={s.hSub}>{memoria.nome} · Edilizia</div>
          </div>
        </div>
        <div style={s.hRight}>
          <button style={s.iBtn} onClick={() => setSpeakEnabled(v => !v)}>{speakEnabled ? "🔊" : "🔇"}</button>
          <button style={s.iBtn} onClick={() => setView(v => v === "memoria" ? "chat" : "memoria")}>🧠</button>
        </div>
      </header>
      {view === "chat" ? (
        <>
          <div style={s.chat}>
            {chat.map((m, i) => <Bubble key={i} msg={m} />)}
            {loading && <Typing />}
            {pendingEvent && (
              <div style={s.eventCard}>
                <div style={s.eventTitle}>📅 Aggiungo al calendario?</div>
                <div style={s.eventBtns}>
                  <button style={s.btnSi} onClick={addToCalendar}>✅ Sì, aggiungi</button>
                  <button style={s.btnNo} onClick={() => setPendingEvent(null)}>No</button>
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
          <QuickActions onSelect={(p) => { setInput(p); taRef.current?.focus(); }} />
          <div style={s.bar}>
            <textarea ref={taRef} style={s.ta} value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); } }} placeholder="Scrivi o usa il microfono..." rows={1} />
            <button style={{ ...s.mic, background: listening ? C.red : "#2c3e50" }} onPointerDown={startListen} onPointerUp={stopListen} onPointerLeave={stopListen}>{listening ? "⏹" : "🎤"}</button>
            <button style={{ ...s.send, opacity: input.trim() ? 1 : 0.35 }} onClick={() => send(input)} disabled={!input.trim() || loading}>➤</button>
          </div>
        </>
      ) : (
        <Memoria memoria={memoria} setMemoria={setMemoria} onBack={() => setView("chat")} />
      )}
    </div>
  );
}

function Bubble({ msg }) {
  const isUser = msg.role === "user";
  const lines = msg.content.split("\n");
  return (
    <div style={{ ...s.row, justifyContent: isUser ? "flex-end" : "flex-start", animation: "fadeIn 0.2s ease" }}>
      {!isUser && <div style={s.av}>A</div>}
      <div style={isUser ? s.bUser : s.bAI}>
        {lines.map((line, i) => {
          if (line.startsWith("📧") || line.startsWith("📅") || line.startsWith("📄") || line.startsWith("⏰")) return <div key={i} style={s.aLine}>{line}</div>;
          if (line.startsWith("OGGETTO:")) return <div key={i} style={s.subj}>{line}</div>;
          if (line === "---") return <hr key={i} style={{ border: "none", borderTop: `1px solid ${C.border}`, margin: "6px 0" }} />;
          if (line.startsWith("🧠 APPRESO:")) return <div key={i} style={s.learned}>{line}</div>;
          return <div key={i}>{line || <br />}</div>;
        })}
        <div style={s.ts}>{new Date(msg.ts).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}</div>
      </div>
    </div>
  );
}

function Typing() {
  return (
    <div style={{ ...s.row, justifyContent: "flex-start" }}>
      <div style={s.av}>A</div>
      <div style={{ ...s.bAI, display: "flex", gap: 4, padding: "12px 14px", alignItems: "center" }}>
        {[0, 0.2, 0.4].map((d, i) => (
          <span key={i} style={{ width: 7, height: 7, borderRadius: "50%", background: C.accent, display: "inline-block", animation: `bounce 1s ${d}s infinite` }} />
        ))}
      </div>
    </div>
  );
}

const QA = [
  { icon: "📧", label: "Email", p: "Devo scrivere un'email a " },
  { icon: "📅", label: "Appuntamento", p: "Aggiungi appuntamento: " },
  { icon: "📋", label: "Preventivo", p: "Crea un preventivo per " },
  { icon: "🏗️", label: "Cantiere", p: "Scrivi rapporto di cantiere per oggi: " },
  { icon: "📞", label: "Promemoria", p: "Ricordami di " },
  { icon: "🔍", label: "Fornitore", p: "Cerca il miglior fornitore per " },
];

function QuickActions({ onSelect }) {
  return (
    <div style={s.qa}>
      {QA.map((q, i) => (
        <button key={i} style={s.qBtn} onClick={() => onSelect(q.p)}>
          <span style={{ fontSize: 18 }}>{q.icon}</span>
          <span style={s.qLabel}>{q.label}</span>
        </button>
      ))}
    </div>
  );
}

function Memoria({ memoria, setMemoria, onBack }) {
  const [nome, setNome] = useState(memoria.nome);
  const save = () => { setMemoria(p => ({ ...p, nome, ultima_modifica: Date.now() })); onBack(); };
  return (
    <div style={s.mem}>
      <button style={s.back} onClick={onBack}>← Torna alla chat</button>
      <h2 style={s.memT}>🧠 La mia memoria</h2>
      <p style={s.memD}>Tutto ciò che ho imparato su di te.</p>
      {[
        { label: "Il tuo nome", content: <input style={s.mIn} value={nome} onChange={e => setNome(e.target.value)} /> },
        { label: "Settore", content: <div style={s.mVal}>{memoria.settore}</div> },
        { label: "Stile comunicativo", content: <div style={s.mVal}>{memoria.stile}</div> },
        { label: `Note apprese (${memoria.note_stile.length})`, content: memoria.note_stile.length === 0 ? <div style={s.mEmpty}>Crescerà con l'uso</div> : memoria.note_stile.map((n, i) => <div key={i} style={s.mTag}>🧠 {n}</div>) },
        { label: "Clienti noti", content: memoria.clienti.length === 0 ? <div style={s.mEmpty}>Menziona clienti nella chat</div> : memoria.clienti.map((c, i) => <div key={i} style={s.mTag}>👤 {c}</div>) },
        { label: "Fornitori noti", content: memoria.fornitori.length === 0 ? <div style={s.mEmpty}>Menziona fornitori nella chat</div> : memoria.fornitori.map((f, i) => <div key={i} style={s.mTag}>🏭 {f}</div>) },
      ].map((sec, i) => (
        <div key={i} style={s.mSec}>
          <label style={s.mLabel}>{sec.label}</label>
          {sec.content}
        </div>
      ))}
      <button style={s.saveBtn} onClick={save}>💾 Salva</button>
    </div>
  );
}

function Setup({ onComplete }) {
  const [nome, setNome] = useState("");
  return (
    <div style={s.setup}>
      <div style={s.setupCard}>
        <div style={s.logo2}>A</div>
        <h1 style={s.sT}>Assistente Personale</h1>
        <p style={s.sD}>Edilizia · Email · Calendario · Documenti</p>
        <p style={s.sH}>Come ti chiami?</p>
        <input style={s.sIn} placeholder="Il tuo nome" value={nome} onChange={e => setNome(e.target.value)} onKeyDown={e => e.key === "Enter" && nome.trim() && onComplete(nome.trim())} autoFocus />
        <button style={{ ...s.sBtn, opacity: nome.trim() ? 1 : 0.35 }} onClick={() => nome.trim() && onComplete(nome.trim())} disabled={!nome.trim()}>Inizia →</button>
        <p style={s.sNote}>I tuoi dati rimangono sul tuo dispositivo</p>
      </div>
    </div>
  );
}

const s = {
  app: { display: "flex", flexDirection: "column", height: "100dvh", maxWidth: 540, margin: "0 auto", background: C.bg, color: C.text, fontFamily: "'Georgia', serif", position: "relative", overflow: "hidden" },
  bgGlow: { position: "absolute", inset: 0, zIndex: 0, background: `radial-gradient(circle at 15% 15%, rgba(232,160,32,0.05) 0%, transparent 50%), radial-gradient(circle at 85% 85%, rgba(26,74,106,0.07) 0%, transparent 50%)`, pointerEvents: "none" },
  toast: { position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)", color: "#fff", padding: "10px 20px", borderRadius: 8, fontSize: 14, zIndex: 1000, fontFamily: "sans-serif", boxShadow: "0 4px 20px rgba(0,0,0,0.4)", whiteSpace: "nowrap" },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px 12px", borderBottom: `1px solid ${C.border}`, background: C.bgCard, zIndex: 10, position: "relative", boxShadow: "0 2px 12px rgba(0,0,0,0.3)" },
  hLeft: { display: "flex", alignItems: "center", gap: 12 },
  logo: { width: 40, height: 40, borderRadius: 10, background: `linear-gradient(135deg, ${C.accent}, ${C.accentDk})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, fontWeight: "bold", color: "#1a0a00" },
  hTitle: { fontSize: 17, fontWeight: "bold" },
  hSub: { fontSize: 11, color: C.muted, fontFamily: "sans-serif" },
  hRight: { display: "flex", gap: 6 },
  iBtn: { background: "none", border: "none", fontSize: 20, cursor: "pointer", padding: "4px 6px", borderRadius: 6, color: C.text },
  chat: { flex: 1, overflowY: "auto", padding: "16px 12px", display: "flex", flexDirection: "column", gap: 12, position: "relative", zIndex: 1 },
  row: { display: "flex", alignItems: "flex-end", gap: 8 },
  av: { width: 28, height: 28, borderRadius: 8, flexShrink: 0, background: `linear-gradient(135deg, ${C.accent}, ${C.accentDk})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: "bold", color: "#1a0a00" },
  bUser: { maxWidth: "75%", padding: "10px 14px", borderRadius: "16px 16px 4px 16px", background: C.bubbleUser, fontSize: 15, lineHeight: 1.5, fontFamily: "sans-serif" },
  bAI: { maxWidth: "82%", padding: "10px 14px", borderRadius: "16px 16px 16px 4px", background: C.bubbleAI, fontSize: 15, lineHeight: 1.6, border: `1px solid ${C.border}`, fontFamily: "sans-serif" },
  ts: { fontSize: 10, color: C.muted, marginTop: 4, textAlign: "right" },
  aLine: { fontWeight: "bold", color: C.accent, marginBottom: 4 },
  subj: { background: "rgba(232,160,32,0.1)", padding: "4px 8px", borderRadius: 4, fontSize: 13, color: C.accent, marginBottom: 4 },
  learned: { fontSize: 11, color: "#5a8a6a", fontStyle: "italic", marginTop: 6 },
  eventCard: { background: C.bgCard, border: `1px solid ${C.accent}50`, borderRadius: 12, padding: "12px 14px", fontFamily: "sans-serif" },
  eventTitle: { fontWeight: "bold", marginBottom: 10, color: C.accent },
  eventBtns: { display: "flex", gap: 8 },
  btnSi: { flex: 1, padding: "8px", background: C.green, color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 14 },
  btnNo: { padding: "8px 16px", background: C.bgInput, color: C.muted, border: "none", borderRadius: 8, cursor: "pointer", fontSize: 14 },
  qa: { display: "flex", gap: 6, padding: "8px 12px 4px", overflowX: "auto", scrollbarWidth: "none", zIndex: 1, position: "relative" },
  qBtn: { display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "7px 10px", minWidth: 60, background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 10, cursor: "pointer", color: C.text, flexShrink: 0 },
  qLabel: { fontSize: 9, color: C.muted, fontFamily: "sans-serif", whiteSpace: "nowrap" },
  bar: { display: "flex", gap: 8, padding: "10px 12px 20px", background: C.bgCard, borderTop: `1px solid ${C.border}`, zIndex: 10, position: "relative" },
  ta: { flex: 1, background: C.bgInput, color: C.text, border: `1px solid ${C.border}`, borderRadius: 12, padding: "10px 14px", fontSize: 15, resize: "none", fontFamily: "sans-serif", lineHeight: 1.4, outline: "none", maxHeight: 100, overflowY: "auto" },
  mic: { width: 44, height: 44, borderRadius: 12, border: "none", fontSize: 18, cursor: "pointer", flexShrink: 0, color: "#fff", transition: "background 0.15s" },
  send: { width: 44, height: 44, borderRadius: 12, background: `linear-gradient(135deg, ${C.accent}, ${C.accentDk})`, border: "none", fontSize: 18, cursor: "pointer", flexShrink: 0, color: "#1a0a00", fontWeight: "bold" },
  mem: { flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 14, fontFamily: "sans-serif", zIndex: 1, position: "relative" },
  back: { background: "none", border: "none", color: C.accent, fontSize: 14, cursor: "pointer", padding: 0, marginBottom: 4, textAlign: "left" },
  memT: { fontSize: 20, fontWeight: "bold", margin: 0 },
  memD: { fontSize: 13, color: C.muted, margin: 0 },
  mSec: { background: C.bgCard, borderRadius: 12, border: `1px solid ${C.border}`, padding: "12px 14px" },
  mLabel: { display: "block", fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 },
  mVal: { fontSize: 15 },
  mIn: { width: "100%", background: C.bgInput, color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", fontSize: 15, outline: "none", boxSizing: "border-box" },
  mTag: { display: "inline-block", background: C.bgInput, border: `1px solid ${C.border}`, borderRadius: 6, padding: "4px 10px", fontSize: 13, margin: "2px 4px 2px 0" },
  mEmpty: { fontSize: 13, color: C.muted, fontStyle: "italic" },
  saveBtn: { padding: 14, background: `linear-gradient(135deg, ${C.accent}, ${C.accentDk})`, border: "none", borderRadius: 12, color: "#1a0a00", fontWeight: "bold", fontSize: 15, cursor: "pointer" },
  setup: { height: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", background: C.bg, padding: 20 },
  setupCard: { textAlign: "center", maxWidth: 380, width: "100%", fontFamily: "sans-serif" },
  logo2: { width: 64, height: 64, borderRadius: 16, margin: "0 auto 20px", background: `linear-gradient(135deg, ${C.accent}, ${C.accentDk})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 32, fontWeight: "bold", color: "#1a0a00" },
  sT: { fontSize: 26, fontWeight: "bold", margin: "0 0 8px", color: C.text },
  sD: { fontSize: 14, color: C.muted, margin: "0 0 32px" },
  sH: { fontSize: 16, color: C.text, margin: "0 0 12px" },
  sIn: { width: "100%", background: C.bgInput, color: C.text, border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 16px", fontSize: 16, outline: "none", boxSizing: "border-box", marginBottom: 16, textAlign: "center" },
  sBtn: { width: "100%", padding: 14, fontSize: 16, fontWeight: "bold", background: `linear-gradient(135deg, ${C.accent}, ${C.accentDk})`, border: "none", borderRadius: 12, color: "#1a0a00", cursor: "pointer", marginBottom: 16 },
  sNote: { fontSize: 11, color: C.muted },
};
