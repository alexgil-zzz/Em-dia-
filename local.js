/* em dia. — versão app (PWA) com nuvem.
   Os dados ficam no aparelho (IndexedDB) para abrir e salvar sem internet,
   e são sincronizados com a nuvem (API da Vercel + Upstash Redis) quando há conexão.
   Imita a API de dados que o app já usa (doc / collection / onSnapshot). */
(function () {
  "use strict";
  window.EMDIA_LOCAL = true;
  const API = "/api/emdia";
  const DBN = "emdia", ST = "docs", SESS = "emdia_nuvem";
  const mem = new Map();
  const ouvintesDoc = new Map(), ouvintesCol = new Map();
  let idb = null, fila = Promise.resolve();

  const clone = v => v == null ? v : JSON.parse(JSON.stringify(v));
  function abrirIDB() {
    return new Promise((ok, falha) => {
      let r; try { r = indexedDB.open(DBN, 1); } catch (e) { return falha(e); }
      r.onupgradeneeded = () => r.result.createObjectStore(ST);
      r.onsuccess = () => ok(r.result); r.onerror = () => falha(r.error);
    });
  }
  function carregarTudo() {
    return new Promise(ok => {
      const req = idb.transaction(ST, "readonly").objectStore(ST).openCursor();
      req.onsuccess = () => { const c = req.result; if (c) { mem.set(String(c.key), c.value); c.continue(); } else ok(); };
      req.onerror = () => ok();
    });
  }
  function gravarIDB(caminho, valor) {
    fila = fila.then(() => new Promise(ok => {
      if (!idb) return ok();
      try {
        const tx = idb.transaction(ST, "readwrite"), os = tx.objectStore(ST);
        valor === undefined ? os.delete(caminho) : os.put(valor, caminho);
        tx.oncomplete = tx.onerror = tx.onabort = () => ok();
      } catch { ok(); }
    }));
    return fila;
  }
  const pai = c => c.slice(0, c.lastIndexOf("/"));
  const docSnap = c => { const v = mem.get(c); return { exists: v !== undefined, id: c.slice(c.lastIndexOf("/") + 1), data: () => clone(v) }; };
  function colSnap(c) {
    const pre = c + "/", docs = [];
    for (const [k, v] of mem) if (k.startsWith(pre) && k.indexOf("/", pre.length) < 0) docs.push({ id: k.slice(pre.length), exists: true, data: () => clone(v) });
    return { docs, size: docs.length, empty: !docs.length, forEach: f => docs.forEach(f) };
  }
  let avisoT = null; const sujos = new Set();
  function avisar(c) {
    sujos.add(c); clearTimeout(avisoT);
    avisoT = setTimeout(() => {
      const ds = [...sujos]; sujos.clear(); const cs = new Set(ds.map(pai));
      ds.forEach(d => (ouvintesDoc.get(d) || []).forEach(cb => { try { cb(docSnap(d)); } catch (e) { console.error(e); } }));
      cs.forEach(cc => (ouvintesCol.get(cc) || []).forEach(cb => { try { cb(colSnap(cc)); } catch (e) { console.error(e); } }));
    }, 0);
  }
  // grava no aparelho; se for dado de uma conta, entra na fila para a nuvem
  function escrever(c, v, daNuvem) {
    if (v === undefined) mem.delete(c); else mem.set(c, clone(v));
    avisar(c);
    const p = gravarIDB(c, v === undefined ? undefined : clone(v));
    if (!daNuvem) marcarEnvio(c);
    return p;
  }
  function ouvir(mapa, c, cb, snap) {
    if (!mapa.has(c)) mapa.set(c, new Set()); mapa.get(c).add(cb);
    setTimeout(() => { try { cb(snap(c)); } catch (e) { console.error(e); } }, 0);
    return () => mapa.get(c).delete(cb);
  }
  function docRef(c) {
    return {
      id: c.slice(c.lastIndexOf("/") + 1), path: c,
      get: async () => docSnap(c),
      set: async (d, o) => escrever(c, o && o.merge ? { ...(mem.get(c) || {}), ...d } : d),
      update: async d => { if (!mem.has(c)) { const e = new Error("not_found"); e.code = "not_found"; throw e; } return escrever(c, { ...mem.get(c), ...d }); },
      delete: async () => escrever(c, undefined),
      onSnapshot: cb => ouvir(ouvintesDoc, c, cb, docSnap),
      collection: n => colRef(c + "/" + n),
    };
  }
  function colRef(c) {
    return {
      path: c,
      doc: id => docRef(c + "/" + (id || Math.random().toString(36).slice(2, 12))),
      get: async () => colSnap(c),
      onSnapshot: cb => ouvir(ouvintesCol, c, cb, colSnap),
      add: async d => { const r = docRef(c + "/" + Math.random().toString(36).slice(2, 12)); await r.set(d); return r; },
    };
  }
  const db = { doc: docRef, collection: colRef };

  // ---------- sessão (conta da nuvem) ----------
  function sessao() {
    for (const st of [localStorage, sessionStorage]) { try { const v = JSON.parse(st.getItem(SESS) || "null"); if (v && v.token && v.conta) return v; } catch {} }
    return null;
  }
  function gravarSessao(token, conta, manter) {
    const v = JSON.stringify({ token, conta, manter: !!manter });
    try { localStorage.removeItem(SESS); sessionStorage.removeItem(SESS); (manter ? localStorage : sessionStorage).setItem(SESS, v); } catch {}
  }
  function atualizarConta(conta) { const s = sessao(); if (s) gravarSessao(s.token, { ...s.conta, ...conta }, s.manter); }
  function limparSessao() { for (const st of [localStorage, sessionStorage]) { try { st.removeItem(SESS); } catch {} } }

  async function api(acao, dados) {
    let r;
    try { r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ acao, ...(dados || {}) }) }); }
    catch { const e = new Error("Sem internet agora. Tente de novo quando conectar."); e.offline = true; throw e; }
    let j = {}; try { j = await r.json(); } catch {}
    if (!r.ok) { const e = new Error(j.erro || "Não foi possível falar com a nuvem."); e.status = r.status; throw e; }
    return j;
  }
  const apiConta = (acao, dados) => { const s = sessao(); return api(acao, { ...(dados || {}), token: s && s.token }); };

  // ---------- sincronização ----------
  let uidSync = null;
  const pre = () => "data/users/" + uidSync + "/";
  const kOut = () => "_sync/out/" + uidSync, kCur = () => "_sync/cursor/" + uidSync, kUlt = () => "_sync/ultimo/" + uidSync;
  let saida = new Map();      // caminho relativo -> versão local
  let ver = 0, envioT = null, sincronizando = false, deNovo = false;
  const estado = { pendentes: 0, ultimo: 0, erro: "", sincronizando: false };
  const ouvEstado = new Set();
  function emitir() { estado.pendentes = saida.size; ouvEstado.forEach(cb => { try { cb({ ...estado, online: navigator.onLine }); } catch {} }); }
  function salvarSaida() { const arr = [...saida.keys()]; mem.set(kOut(), arr); gravarIDB(kOut(), arr); }
  function marcarEnvio(c) {
    if (!uidSync || !c.startsWith(pre())) return;
    saida.set(c.slice(pre().length), ++ver); salvarSaida(); emitir();
    clearTimeout(envioT); envioT = setTimeout(sincronizar, 700);
  }
  async function enviar() {
    while (saida.size) {
      const lote = [], versoes = []; let bytes = 0;
      for (const [rel, v] of saida) {
        const val = mem.get(pre() + rel);
        const d = val === undefined ? { p: rel, del: 1 } : { p: rel, v: val };
        const tam = JSON.stringify(d).length;
        if (lote.length && (bytes + tam > 2_500_000 || lote.length >= 400)) break;
        lote.push(d); versoes.push([rel, v]); bytes += tam;
      }
      await apiConta("enviar", { docs: lote });
      versoes.forEach(([rel, v]) => { if (saida.get(rel) === v) saida.delete(rel); });
      salvarSaida(); emitir();
    }
  }
  async function receber() {
    let desde = +mem.get(kCur()) || 0, mais = true;
    while (mais) {
      const r = await apiConta("receber", { desde });
      for (const d of r.docs) {
        if (saida.has(d.p)) continue; // a alteração deste aparelho ainda vai subir: ela vence
        escrever(pre() + d.p, d.del ? undefined : d.v, true);
      }
      desde = r.ate; mem.set(kCur(), desde); gravarIDB(kCur(), desde);
      mais = r.mais && r.docs.length > 0;
    }
  }
  async function sincronizar() {
    if (!uidSync || !sessao()) return;
    if (sincronizando) { deNovo = true; return; }
    if (!navigator.onLine) { emitir(); return; }
    sincronizando = true; estado.sincronizando = true; emitir();
    try {
      await enviar(); await receber();
      estado.ultimo = Date.now(); estado.erro = ""; mem.set(kUlt(), estado.ultimo); gravarIDB(kUlt(), estado.ultimo);
    } catch (e) {
      estado.erro = e.offline ? "" : (e.message || "erro");
      if (e.status === 401 || e.status === 403) { limparSessao(); window.dispatchEvent(new CustomEvent("emdia-sessao-invalida", { detail: e.message })); }
    } finally {
      sincronizando = false; estado.sincronizando = false; emitir();
      if (deNovo) { deNovo = false; setTimeout(sincronizar, 300); }
    }
  }
  function iniciarSync(uid) {
    uidSync = uid;
    saida = new Map((mem.get(kOut()) || []).map(rel => [rel, ++ver]));
    estado.ultimo = +mem.get(kUlt()) || 0; emitir();
    sincronizar();
    window.addEventListener("online", sincronizar);
    window.addEventListener("offline", emitir);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") sincronizar(); });
    setInterval(() => { if (document.visibilityState === "visible") sincronizar(); }, 45000);
  }

  // ---------- runtime que o app usa ----------
  const user = {
    id: async () => { const s = sessao(); return s ? s.conta.id : null; },
    isOwner: async () => { const s = sessao(); return !!(s && s.conta.mestre); },
    me: async () => { const s = sessao(); return s ? { id: s.conta.id, name: s.conta.nome || s.conta.usuario } : null; },
    profiles: async () => ({}),
  };
  let prontoOk; const pronto = new Promise(r => prontoOk = r);
  (async () => {
    try { idb = await abrirIDB(); await carregarTudo(); } catch { idb = null; }
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch {}
    prontoOk();
  })();
  window.claude = { use: async n => { await pronto; if (n === "db") return db; if (n === "user") return user; if (n === "assets") return null; throw new Error("indisponível"); } };

  window.EMDIA = {
    pronto, db, api, apiConta, sessao, gravarSessao, atualizarConta,
    lerSessao: () => { const s = sessao(); return s ? s.conta.id : null; },
    contaAtual: () => { const s = sessao(); return s ? s.conta : null; },
    // ao sair: tenta subir o que falta e, se estiver tudo na nuvem, apaga a cópia deste aparelho (privacidade em aparelho dividido)
    async sair() {
      const s = sessao(); if (!s) return;
      try { await sincronizar(); } catch {}
      if (uidSync && !saida.size) {
        const p = "data/users/" + uidSync + "/";
        for (const k of [...mem.keys()]) if (k.startsWith(p)) { mem.delete(k); gravarIDB(k, undefined); }
        [kOut(), kCur(), kUlt()].forEach(k => { mem.delete(k); gravarIDB(k, undefined); });
        await fila;
      }
      limparSessao(); try { await api("sair", { token: s.token }); } catch {}
    },
    iniciarSync, sincronizar, estado: () => ({ ...estado, pendentes: saida.size, online: navigator.onLine }), onEstado: cb => ouvEstado.add(cb),
    exportar(uid) {
      const out = {}, p = "data/users/" + uid + "/";
      for (const [k, v] of mem) if (k.startsWith(p)) out[k] = v;
      return { app: "em dia.", versao: 2, geradoEm: new Date().toISOString(), tipo: "conta", uid, dados: out };
    },
    async importar(pacote, uid) {
      if (!pacote || pacote.app !== "em dia." || !pacote.dados || !pacote.uid) throw new Error("arquivo-invalido");
      const de = "data/users/" + pacote.uid + "/", para = "data/users/" + uid + "/"; let n = 0;
      for (const [k, v] of Object.entries(pacote.dados)) if (k.startsWith(de)) { await escrever(para + k.slice(de.length), v); n++; }
      return n;
    },
  };
})();
