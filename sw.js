/* em dia. — service worker: guarda o app inteiro no aparelho para abrir sem internet */
const VERSAO = "emdia-635b78995e";
const ARQUIVOS = ["./", "index.html", "local.js", "exercicios.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "maskable-512.png", "apple-touch-icon.png"];
const FONTES = "emdia-fontes";
self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSAO).then(c => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSAO && k !== FONTES).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET") return;
  const url = new URL(req.url);
  // fontes do Google: usa a cópia guardada e atualiza quando tiver internet
  if (url.hostname.endsWith("fonts.googleapis.com") || url.hostname.endsWith("fonts.gstatic.com")) {
    e.respondWith(caches.open(FONTES).then(async c => {
      const hit = await c.match(req);
      const rede = fetch(req).then(r => { if (r && (r.ok || r.type === "opaque")) c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || rede;
    }));
    return;
  }
  if (url.origin !== location.origin) return;
  // páginas: tenta a rede (para pegar versões novas) e cai para a cópia guardada sem internet
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then(r => { const cp = r.clone(); caches.open(VERSAO).then(c => c.put("index.html", cp)); return r; }).catch(() => caches.match("index.html").then(r => r || caches.match("./"))));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(r => { if (r.ok) { const cp = r.clone(); caches.open(VERSAO).then(c => c.put(req, cp)); } return r; })));
});
