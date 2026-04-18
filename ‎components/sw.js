// COJUR Vault Service Worker v14
// Arquivo: public/sw.js (servido em https://seu-site.vercel.app/sw.js)

const CACHE_NAME = "cojur-vault-v14";
const RUNTIME_CACHE = "cojur-vault-runtime-v14";

// Recursos estaticos cacheados na instalacao
const PRECACHE_URLS = [
  "/",
  "/index.html"
];

// INSTALL: cache inicial dos recursos essenciais
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// ACTIVATE: limpa caches antigos de versoes anteriores
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// FETCH: estrategia adaptativa
// - API Anthropic: network only (nunca cacheia dados sensíveis de IA)
// - HTML: network first com fallback para cache (atualizacao automatica)
// - Assets estaticos (JS/CSS/imagens): cache first (velocidade maxima)
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Ignora requests nao-GET (POST para API, etc)
  if (request.method !== "GET") return;

  // API Anthropic: sempre network, nunca cacheia
  if (url.hostname.includes("anthropic.com") || url.hostname.includes("api.")) {
    return;
  }

  // Mesma origem apenas
  if (url.origin !== self.location.origin) return;

  // Navegacao (HTML): network first
  if (request.mode === "navigate" || request.destination === "document") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match("/")))
    );
    return;
  }

  // Assets estaticos: cache first
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        // Atualiza em background (stale-while-revalidate)
        fetch(request).then((response) => {
          if (response && response.status === 200) {
            caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, response));
          }
        }).catch(() => {});
        return cached;
      }
      return fetch(request).then((response) => {
        if (!response || response.status !== 200 || response.type === "opaque") {
          return response;
        }
        const copy = response.clone();
        caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
        return response;
      });
    })
  );
});

// Mensagem do app para forcar update
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
