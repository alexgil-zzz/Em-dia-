# em dia. — app (PWA) com nuvem no Upstash Redis

Os dados ficam **na nuvem** (Upstash Redis, o mesmo banco do outro projeto, separado pelo prefixo `emdia:`) e **também no aparelho**: o app abre e salva sem internet e sincroniza sozinho quando a conexão volta.

## 1. GitHub
1. github.com → **+** → **New repository** → nome `em-dia` (pode ser Private) → **Create repository**.
2. **uploading an existing file** → arraste tudo **menos** a pasta `images` (inclui a pasta `api`) → **Commit changes**.
3. **Add file → Upload files** → arraste a **pasta `images` inteira** → **Commit changes**.

## 2. Vercel
1. vercel.com → **Add New → Project** → **Import** no `em-dia`.
2. Framework Preset: **Other** → **Deploy**.

## 3. Ligar o Upstash (mesmo banco do outro projeto)
**Jeito A — pelo painel da Vercel (mais fácil):**
1. No projeto `em-dia` na Vercel → aba **Storage**.
2. Escolha o banco Upstash Redis que você já usa → **Connect Project** → marque `em-dia` (Production, Preview e Development) → **Connect**.

**Jeito B — copiando as chaves:**
1. No projeto do outro app na Vercel → **Settings → Environment Variables**: copie os valores de `KV_REST_API_URL` e `KV_REST_API_TOKEN` (ou `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN`). Também dá para pegar em console.upstash.com → seu banco → **REST API**.
2. No projeto `em-dia` → **Settings → Environment Variables** → adicione as mesmas duas variáveis com os mesmos nomes.

Depois de ligar, vá em **Deployments → ⋯ no último → Redeploy** (as variáveis só valem num deploy novo).

## 4. Primeiro acesso
1. Abra o link da Vercel. A **primeira conta criada vira a conta mestre** — crie a sua primeiro.
2. Guarde o **código de recuperação** que aparece.
3. Instale: iPhone (Safari) → Compartilhar → **Adicionar à Tela de Início**; Android (Chrome) → ⋮ → **Instalar app**.

## Contas
- A conta mestre cria contas, dá senha nova, bloqueia ou apaga contas e decide se o cadastro fica aberto para quem tiver o link (começa fechado).
- Ela vê só nome, usuário e datas de acesso. Os dados de cada pessoa são privados.
- Cada pessoa entra com o mesmo usuário e senha em qualquer aparelho e vê os mesmos dados.

## Atualizações
Substitua os arquivos no GitHub. A Vercel publica sozinha e o app avisa: é só fechar e abrir de novo.
