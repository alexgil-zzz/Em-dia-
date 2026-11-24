// em dia. — API na Vercel guardando contas e dados no Upstash Redis.
// Sem dependências: fala com o Upstash pela API REST.
// Variáveis de ambiente aceitas (a integração da Vercel cria uma destas duplas):
//   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN   ou   KV_REST_API_URL + KV_REST_API_TOKEN
const crypto = require("crypto");

const URL_R = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOK_R = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const P = "emdia:"; // prefixo: não mistura com as chaves dos outros projetos no mesmo banco
const SESSAO_DIAS = 60;
const MAX_PAG_BYTES = 3_000_000, MAX_PAG_DOCS = 300;

class Erro extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function redis(cmd) {
  const r = await fetch(URL_R, { method: "POST", headers: { Authorization: "Bearer " + TOK_R, "Content-Type": "application/json" }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error("redis: " + j.error);
  return j.result;
}
async function pipe(cmds) {
  if (!cmds.length) return [];
  const r = await fetch(URL_R + "/pipeline", { method: "POST", headers: { Authorization: "Bearer " + TOK_R, "Content-Type": "application/json" }, body: JSON.stringify(cmds) });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error("redis: " + (j && j.error));
  return j.map(x => { if (x.error) throw new Error("redis: " + x.error); return x.result; });
}

const K = {
  conta: u => P + "conta:" + u,          // JSON da conta, por usuário
  uid: id => P + "uid:" + id,            // id -> usuário
  contas: P + "contas",                  // set de usuários
  mestre: P + "mestre",                  // id da conta mestre
  config: P + "config",                  // JSON de configurações
  sess: t => P + "sess:" + t,            // token -> id
  docs: id => P + "d:" + id,             // hash caminho -> JSON {v} ou {del:1}
  idx: id => P + "dt:" + id,             // zset caminho com número de sequência
  seq: id => P + "seq:" + id,
  tent: u => P + "tent:" + u,
};

const pbkdf2 = (s, sal) => new Promise((ok, no) => crypto.pbkdf2(String(s), String(sal), 150000, 32, "sha256", (e, b) => e ? no(e) : ok(b.toString("hex"))));
const igual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const novoId = () => "u" + crypto.randomBytes(9).toString("hex");
const novoSal = () => crypto.randomBytes(16).toString("hex");
const novoToken = () => crypto.randomBytes(32).toString("hex");
const novoCodigo = () => { const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; const r = crypto.randomBytes(8); return [...r].map(x => a[x % a.length]).join("").replace(/(.{4})/, "$1-"); };
const normUser = u => String(u || "").trim().toLowerCase();
const normCod = c => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/(.{4})/, "$1-");
const validaUser = u => /^[a-z0-9._-]{3,30}$/.test(u);
const publica = c => ({ id: c.id, usuario: c.usuario, nome: c.nome || "", mestre: !!c.mestre, bloqueado: !!c.bloqueado, criadoEm: c.criadoEm || 0, ultimo: c.ultimo || 0 });

async function lerConta(usuario) { const s = await redis(["GET", K.conta(usuario)]); return s ? JSON.parse(s) : null; }
async function contaPorId(id) { const u = await redis(["GET", K.uid(id)]); return u ? lerConta(u) : null; }
const gravarConta = c => redis(["SET", K.conta(c.usuario), JSON.stringify(c)]);
async function lerConfig() { const s = await redis(["GET", K.config]); return { cadastroAberto: false, ...(s ? JSON.parse(s) : {}) }; }

async function autenticar(token) {
  if (!token || typeof token !== "string") throw new Error401();
  const id = await redis(["GET", K.sess(token)]);
  if (!id) throw new Error401();
  const c = await contaPorId(id);
  if (!c) throw new Error401();
  if (c.bloqueado) throw new Erro(403, "bloqueada");
  return c;
}
function Error401() { return new Erro(401, "sessao"); }
async function exigirMestre(token) { const c = await autenticar(token); if (!c.mestre) throw new Erro(403, "so-mestre"); return c; }

async function criarSessao(id) { const t = novoToken(); await redis(["SET", K.sess(t), id, "EX", SESSAO_DIAS * 86400]); return t; }
async function novaConta({ nome, usuario, senha, mestre }) {
  usuario = normUser(usuario);
  if (!validaUser(usuario)) throw new Erro(400, "O usuário precisa ter de 3 a 30 letras, números, ponto, traço ou sublinhado, sem espaço.");
  if (String(senha || "").length < 6) throw new Erro(400, "A senha precisa ter pelo menos 6 caracteres.");
  const id = novoId(), sal = novoSal(), codSal = novoSal(), codigo = novoCodigo();
  const c = { id, usuario, nome: String(nome || "").slice(0, 40), sal, hash: await pbkdf2(senha, sal), codSal, codHash: await pbkdf2(codigo, codSal), mestre: !!mestre, bloqueado: false, criadoEm: Date.now(), ultimo: Date.now() };
  const ok = await redis(["SET", K.conta(usuario), JSON.stringify(c), "NX"]);
  if (!ok) throw new Erro(409, "Esse usuário já existe. Escolha outro.");
  await pipe([["SET", K.uid(id), usuario], ["SADD", K.contas, usuario]]);
  return { c, codigo };
}
async function apagarTudo(c) {
  await pipe([["DEL", K.docs(c.id)], ["DEL", K.idx(c.id)], ["DEL", K.seq(c.id)], ["DEL", K.uid(c.id)], ["DEL", K.conta(c.usuario)], ["SREM", K.contas, c.usuario]]);
}
async function contarTentativa(u) { const n = await redis(["INCR", K.tent(u)]); if (n === 1) await redis(["EXPIRE", K.tent(u), 300]); return n; }


// ---------- IA (Google Gemini, chave grátis do Google AI Studio) ----------
const LIMITE_IA = +process.env.EMDIA_LIMITE_IA || 40; // perguntas por pessoa por dia
const SYS_IA = () => `Você é a assistente de pesquisa do app "em dia.". Hoje é ${new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long", day: "numeric", month: "long", year: "numeric" })}.
Responda sempre em português do Brasil, de forma clara, acolhedora e organizada: comece pela resposta direta, depois detalhe com títulos curtos (##) e listas quando ajudar. Seja objetiva.
Quando usar a busca na internet, baseie-se nas fontes encontradas e não invente dados. Se não tiver certeza, diga.
Em saúde, finanças e questões legais, dê informação geral e sugira procurar um profissional quando fizer sentido.`;
async function chamarGemini(modelo, contents, comBusca) {
  const body = { systemInstruction: { parts: [{ text: SYS_IA() }] }, contents, generationConfig: { temperature: 0.6 } };
  if (comBusca) body.tools = [{ google_search: {} }];
  const r = await fetch(`${process.env.GEMINI_BASE || "https://generativelanguage.googleapis.com"}/v1beta/models/${modelo}:generateContent`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY }, body: JSON.stringify(body),
  });
  let j = {}; try { j = await r.json(); } catch {}
  return { status: r.status, j };
}
async function perguntarGemini(contents) {
  const modelos = [...new Set([process.env.GEMINI_MODEL, "gemini-2.5-flash", "gemini-flash-latest", "gemini-2.0-flash"].filter(Boolean))];
  let ultimo = null;
  for (const m of modelos) {
    for (const busca of [true, false]) {
      const { status, j } = await chamarGemini(m, contents, busca);
      if (status === 200) {
        const cand = (j.candidates || [])[0] || {};
        const texto = ((cand.content || {}).parts || []).map(x => x.text || "").join("").trim();
        const vistos = new Set(), fontes = [];
        for (const g of ((cand.groundingMetadata || {}).groundingChunks || [])) {
          const w = g.web; if (!w || !w.uri || vistos.has(w.uri)) continue; vistos.add(w.uri);
          fontes.push({ url: w.uri, titulo: String(w.title || "").slice(0, 120) }); if (fontes.length >= 6) break;
        }
        if (!texto) { ultimo = { status: 502, msg: cand.finishReason === "SAFETY" ? "A IA preferiu não responder essa pergunta. Tente escrever de outro jeito." : "A IA não devolveu resposta. Tente de novo." }; break; }
        return { texto, fontes, modelo: m };
      }
      const msg = String(((j.error || {}).message) || "");
      if (status === 429) throw new Erro(429, "A cota grátis do Gemini acabou por agora. Tente de novo daqui a pouco.");
      if (status === 400 && /api key|API_KEY/i.test(msg)) throw new Erro(500, "A chave do Gemini (GEMINI_API_KEY) é inválida. Confira na Vercel.");
      if (status === 403) throw new Erro(500, "A chave do Gemini não tem permissão. Gere outra no Google AI Studio.");
      ultimo = { status, msg };
      if (status === 404) break;                 // modelo não existe: tenta o próximo
      if (!(status === 400 && busca)) break;      // erro sem relação com a busca: tenta o próximo modelo
    }
  }
  console.error("gemini", ultimo);
  throw new Erro(502, (ultimo && ultimo.status === 502 && ultimo.msg) || "Não foi possível falar com a IA agora. Tente de novo.");
}

const ACOES = {
  async status() {
    const [m, cfg] = await Promise.all([redis(["GET", K.mestre]), lerConfig()]);
    return { temMestre: !!m, cadastroAberto: !!cfg.cadastroAberto };
  },
  async criarConta(b) {
    // só existe uma conta mestre (a da dona do app); quem se cadastra pelo app é sempre conta comum
    if (!(await lerConfig()).cadastroAberto) throw new Erro(403, "O cadastro está fechado. Peça para a conta mestre criar sua conta.");
    const r = await novaConta({ ...b, mestre: false });
    return { token: await criarSessao(r.c.id), conta: publica(r.c), codigo: r.codigo };
  },
  async entrar(b) {
    const u = normUser(b.usuario);
    if ((await contarTentativa(u)) > 8) throw new Erro(429, "Muitas tentativas. Espere 5 minutos.");
    const c = await lerConta(u);
    if (!c || !igual(await pbkdf2(b.senha || "", c.sal), c.hash)) throw new Erro(401, "Usuário ou senha incorretos.");
    if (c.bloqueado) throw new Erro(403, "Esta conta está bloqueada. Fale com a conta mestre.");
    await redis(["DEL", K.tent(u)]);
    c.ultimo = Date.now(); await gravarConta(c);
    return { token: await criarSessao(c.id), conta: publica(c) };
  },
  async recuperar(b) {
    const u = normUser(b.usuario);
    if ((await contarTentativa(u)) > 8) throw new Erro(429, "Muitas tentativas. Espere 5 minutos.");
    if (String(b.senha || "").length < 6) throw new Erro(400, "A nova senha precisa ter pelo menos 6 caracteres.");
    const c = await lerConta(u);
    if (!c || !c.codHash || !igual(await pbkdf2(normCod(b.codigo), c.codSal), c.codHash)) throw new Erro(401, "Usuário ou código incorretos.");
    const codigo = novoCodigo();
    c.sal = novoSal(); c.hash = await pbkdf2(b.senha, c.sal); c.codSal = novoSal(); c.codHash = await pbkdf2(codigo, c.codSal);
    await gravarConta(c); await redis(["DEL", K.tent(u)]);
    return { codigo };
  },
  async eu(b) {
    const c = await autenticar(b.token);
    if (Date.now() - (c.ultimo || 0) > 30 * 60000) { c.ultimo = Date.now(); await gravarConta(c); }
    return { conta: publica(c) };
  },
  async sair(b) { if (b.token) await redis(["DEL", K.sess(b.token)]); return {}; },
  async salvarNome(b) { const c = await autenticar(b.token); c.nome = String(b.nome || "").slice(0, 40); await gravarConta(c); return { conta: publica(c) }; },
  async trocarAcesso(b) {
    const c = await autenticar(b.token);
    if (!igual(await pbkdf2(b.senhaAtual || "", c.sal), c.hash)) throw new Erro(400, "A senha atual está incorreta.");
    const novoU = normUser(b.usuario || c.usuario);
    if (!validaUser(novoU)) throw new Erro(400, "Usuário inválido: de 3 a 30 letras, números, ponto, traço ou sublinhado.");
    if (b.novaSenha) { if (String(b.novaSenha).length < 6) throw new Erro(400, "A nova senha precisa ter pelo menos 6 caracteres."); c.sal = novoSal(); c.hash = await pbkdf2(b.novaSenha, c.sal); }
    if (novoU !== c.usuario) {
      const antigo = c.usuario; c.usuario = novoU;
      const ok = await redis(["SET", K.conta(novoU), JSON.stringify(c), "NX"]);
      if (!ok) throw new Erro(409, "Esse usuário já existe.");
      await pipe([["DEL", K.conta(antigo)], ["SREM", K.contas, antigo], ["SADD", K.contas, novoU], ["SET", K.uid(c.id), novoU]]);
    } else await gravarConta(c);
    return { conta: publica(c) };
  },
  // ---------- dados ----------
  async enviar(b) {
    const c = await autenticar(b.token);
    const docs = Array.isArray(b.docs) ? b.docs : [];
    if (!docs.length) return { ok: 0 };
    if (docs.length > 500) throw new Erro(400, "lote grande demais");
    for (const d of docs) if (typeof d.p !== "string" || !d.p || d.p.length > 300) throw new Erro(400, "caminho inválido");
    const fim = await redis(["INCRBY", K.seq(c.id), docs.length]);
    let n = fim - docs.length;
    const hset = ["HSET", K.docs(c.id)], zadd = ["ZADD", K.idx(c.id)];
    for (const d of docs) { n++; hset.push(d.p, JSON.stringify(d.del ? { del: 1 } : { v: d.v })); zadd.push(n, d.p); }
    await pipe([hset, zadd]);
    return { ok: docs.length, seq: fim };
  },
  async receber(b) {
    const c = await autenticar(b.token);
    const desde = Math.max(0, +b.desde || 0);
    const lista = await redis(["ZRANGE", K.idx(c.id), "(" + desde, "+inf", "BYSCORE", "LIMIT", 0, MAX_PAG_DOCS, "WITHSCORES"]);
    if (!lista || !lista.length) return { docs: [], ate: desde, mais: false };
    const caminhos = [], seqs = [];
    for (let i = 0; i < lista.length; i += 2) { caminhos.push(lista[i]); seqs.push(+lista[i + 1]); }
    const vals = await redis(["HMGET", K.docs(c.id), ...caminhos]);
    const docs = []; let bytes = 0, ate = desde;
    for (let i = 0; i < caminhos.length; i++) {
      const s = vals[i] || '{"del":1}';
      if (docs.length && bytes + s.length > MAX_PAG_BYTES) break;
      const o = JSON.parse(s); docs.push(o.del ? { p: caminhos[i], del: 1 } : { p: caminhos[i], v: o.v });
      bytes += s.length; ate = seqs[i];
    }
    return { docs, ate, mais: docs.length < caminhos.length || caminhos.length === MAX_PAG_DOCS };
  },
  // ---------- IA ----------
  async perguntar(b) {
    const c = await autenticar(b.token);
    if (!process.env.GEMINI_API_KEY) throw new Erro(500, "A chave do Gemini ainda não foi colocada na Vercel (variável GEMINI_API_KEY).");
    const pergunta = String(b.pergunta || "").trim().slice(0, 2000);
    if (!pergunta) throw new Erro(400, "Escreva sua pergunta.");
    const kDia = P + "ia:" + c.id + ":" + new Date().toISOString().slice(0, 10);
    const n = await redis(["INCR", kDia]); if (n === 1) await redis(["EXPIRE", kDia, 172800]);
    if (n > LIMITE_IA) throw new Erro(429, `Você chegou ao limite de ${LIMITE_IA} perguntas por hoje. Amanhã libera de novo.`);
    const hist = (Array.isArray(b.historico) ? b.historico : []).slice(-3);
    const contents = [];
    for (const h of hist) { if (!h || !h.p || !h.r) continue; contents.push({ role: "user", parts: [{ text: String(h.p).slice(0, 2000) }] }, { role: "model", parts: [{ text: String(h.r).slice(0, 4000) }] }); }
    contents.push({ role: "user", parts: [{ text: pergunta }] });
    const r = await perguntarGemini(contents);
    return { resposta: r.texto, fontes: r.fontes, restantes: Math.max(0, LIMITE_IA - n) };
  },
  // ---------- conta mestre ----------
  async mListar(b) {
    await exigirMestre(b.token);
    const us = await redis(["SMEMBERS", K.contas]) || [];
    const vals = us.length ? await redis(["MGET", ...us.map(K.conta)]) : [];
    return { contas: vals.filter(Boolean).map(s => publica(JSON.parse(s))), config: await lerConfig() };
  },
  async mCriar(b) { await exigirMestre(b.token); const r = await novaConta({ ...b, mestre: false }); return { conta: publica(r.c), codigo: r.codigo }; },
  async mSenha(b) {
    await exigirMestre(b.token);
    const c = await contaPorId(b.id); if (!c) throw new Erro(404, "Conta não encontrada.");
    if (String(b.senha || "").length < 6) throw new Erro(400, "A senha precisa ter pelo menos 6 caracteres.");
    c.sal = novoSal(); c.hash = await pbkdf2(b.senha, c.sal); c.bloqueado = false; await gravarConta(c); return {};
  },
  async mBloquear(b) {
    const m = await exigirMestre(b.token); if (b.id === m.id) throw new Erro(400, "Você não pode bloquear a conta mestre.");
    const c = await contaPorId(b.id); if (!c) throw new Erro(404, "Conta não encontrada.");
    c.bloqueado = !!b.bloquear; await gravarConta(c); return { conta: publica(c) };
  },
  async mApagar(b) {
    const m = await exigirMestre(b.token); if (b.id === m.id) throw new Erro(400, "Você não pode apagar a conta mestre.");
    const c = await contaPorId(b.id); if (!c) throw new Erro(404, "Conta não encontrada.");
    await apagarTudo(c); return {};
  },
  async mConfig(b) { await exigirMestre(b.token); const cfg = { ...(await lerConfig()), cadastroAberto: !!b.cadastroAberto }; await redis(["SET", K.config, JSON.stringify(cfg)]); return { config: cfg }; },
};

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ erro: "Use POST." });
  if (!URL_R || !TOK_R) return res.status(500).json({ erro: "O banco Upstash não está ligado a este projeto na Vercel." });
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = {}; } }
  b = b || {};
  const fn = ACOES[b.acao];
  if (!fn) return res.status(400).json({ erro: "Ação desconhecida." });
  try { res.status(200).json(await fn(b)); }
  catch (e) {
    if (e instanceof Erro) return res.status(e.status).json({ erro: e.message });
    console.error(e); res.status(500).json({ erro: "Falha no servidor. Tente de novo." });
  }
};
