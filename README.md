# Aviador – Friends Edition (Créditos Virtuais)
Este pacote é para diversão entre amigos **sem dinheiro real**. O administrador ajusta saldos manualmente.
Inclui:
- Painel do Jogador (neon, chat, feed de apostas)
- Painel Admin (login por senha, listar usuários, bônus/débito, bloquear)
- Servidor Node (Express + WebSocket), servindo os arquivos estáticos de /web

## Como usar
1) **Node 18+** instalado.
2) Na pasta `server/`:
   ```bash
   cp .env.example .env
   # edite ADMIN_PASSWORD
   npm i
   npm run dev
   ```
3) Acesse `http://localhost:3000` para o **painel do jogador** e `http://localhost:3000/admin.html` para o **admin**.
4) Entre com um apelido quando solicitado; o admin pode criar/ajustar saldos.

> ⚠️ Não use com dinheiro real. Jogos com dinheiro real exigem licença e conformidade legal.
