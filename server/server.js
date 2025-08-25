import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { v4 as uuid } from 'uuid';
import { db, ensureUser, listUsers, findUserByNick, pushChat, pushHistory } from './storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, '../web');

const app = express();
app.use(express.json());
app.use(express.static(WEB_DIR));

const PORT = Number(process.env.PORT||3000);
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD||'');

const CONFIG = {
  heartbeat: Number(process.env.WS_HEARTBEAT_MS||15000),
  defaultCredits: Number(process.env.DEFAULT_CREDITS||1000),
  houseEdge: Number(process.env.HOUSE_EDGE||0.99),
  maxMult: Number(process.env.MAX_MULTIPLIER||50),
  cooldown: Number(process.env.ROUND_COOLDOWN_MS||2500),
};

// ===== Admin API (senha via header X-Admin-Password) =====
function adminAuth(req, res, next){
  const pw = req.get('X-Admin-Password') || req.body?.password;
  if (ADMIN_PASSWORD && pw === ADMIN_PASSWORD) return next();
  return res.status(401).json({ error:'unauthorized' });
}
app.get('/api/admin/ping', adminAuth, (req,res)=> res.json({ok:true}));
app.get('/api/admin/users', adminAuth, (req,res)=> res.json({ users: listUsers() }));
app.post('/api/admin/create', adminAuth, (req,res)=>{
  const { nick, credits=CONFIG.defaultCredits } = req.body||{};
  if (!nick) return res.status(400).json({error:'nick required'});
  const u = ensureUser(String(nick).slice(0,24), Number(credits||0));
  return res.json({ ok:true, user:u });
});
app.post('/api/admin/credit', adminAuth, (req,res)=>{
  const { nick, delta } = req.body||{};
  const u = findUserByNick(nick);
  if (!u) return res.status(404).json({error:'user not found'});
  u.balance = Math.max(0, Math.floor(u.balance + Number(delta||0)));
  return res.json({ ok:true, user:u });
});
app.post('/api/admin/block', adminAuth, (req,res)=>{
  const { nick, blocked } = req.body||{};
  const u = findUserByNick(nick);
  if (!u) return res.status(404).json({error:'user not found'});
  u.blocked = !!blocked;
  return res.json({ ok:true, user:u });
});

// ===== HTTP server & WebSocket =====
const server = app.listen(PORT, () => {
  console.log('HTTP on', PORT);
});
const wss = new WebSocketServer({ server });

function broadcast(type, payload){
  const msg = JSON.stringify({ type, payload });
  wss.clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
}

function cryptoRandom(){
  const b = new Uint32Array(1);
  crypto.webcrypto.getRandomValues(b);
  return b[0] / 2**32;
}

function sampleCrash(){
  let u = cryptoRandom();
  let m = (CONFIG.houseEdge) / (1 - u);
  if (!Number.isFinite(m) || m < 1) m = 1;
  return Math.min(CONFIG.maxMult, m);
}

function startRound(){
  const rate = 0.62;
  const crashAt = sampleCrash();
  db.round = { id: uuid(), startAt: Date.now(), rate, crashAt, running: true, currentMult: 1 };
  broadcast('roundStart', { roundId: db.round.id, startAt: db.round.startAt });
}

// Tick loop
setInterval(() => {
  if (!db.round || !db.round.running) return;
  const t = (Date.now() - db.round.startAt) / 1000;
  const mult = Math.max(1, Math.exp(db.round.rate * t));
  db.round.currentMult = Number(mult.toFixed(2));
  broadcast('tick', { mult: db.round.currentMult });

  // Auto cashout
  for (const bet of db.betsOpen){
    if (bet.roundId === db.round.id && bet.cashedAt == null && bet.auto <= mult){
      doCashout(bet.userId);
    }
  }

  if (mult >= db.round.crashAt){
    // Crash
    db.round.running = false;
    pushHistory({ at: Date.now(), roundId: db.round.id, crashAt: Number(db.round.crashAt.toFixed(2)) });
    broadcast('roundCrash', { roundId: db.round.id, crashAt: Number(db.round.crashAt.toFixed(2)) });
    // limpar apostas abertas não resgatadas
    db.betsOpen = db.betsOpen.filter(b => b.roundId !== db.round.id || b.cashedAt != null);
    setTimeout(() => startRound(), CONFIG.cooldown);
  }
}, 100);

// start first round
setTimeout(startRound, 800);

// Cashout helper
function doCashout(userId){
  if (!db.round || !db.round.running) return;
  const mult = db.round.currentMult || 1;
  const bet = db.betsOpen.find(b => b.userId === userId && b.roundId === db.round.id && b.cashedAt == null);
  if (!bet) return;
  bet.cashedAt = mult;
  const user = db.users.get(userId);
  if (!user) return;
  const payout = Math.floor(bet.amount * mult);
  user.balance += payout;
  broadcast('cashout', { nick: bet.nick, mult: Number(mult.toFixed(2)), payout });
  // notify balance to that user via their session sockets
  wss.clients.forEach(ws => {
    const uid = db.sessions.get(ws);
    if (uid === userId && ws.readyState === 1){
      ws.send(JSON.stringify({ type:'balance', payload:{ balance: user.balance } }));
    }
  });
}

// WebSocket handling
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => ws.isAlive = true);

  ws.on('message', (buf) => {
    try{
      const { type, payload } = JSON.parse(buf.toString());

      if (type === 'hello'){
        const nick = String(payload?.nick||'').slice(0,24).trim() || 'Convidado';
        const user = ensureUser(nick, CONFIG.defaultCredits);
        db.sessions.set(ws, user.id);
        ws.send(JSON.stringify({ type:'welcome', payload:{ user, chat: db.chat, history: db.history } }));
        const msg = { id: uuid(), at: Date.now(), nick:'sistema', text:`${nick} entrou`, type:'system' };
        pushChat(msg); broadcast('chat', msg);
        return;
      }

      const userId = db.sessions.get(ws);
      const user = db.users.get(userId);
      if (!user) return;

      if (type === 'chat'){
        const text = String(payload?.text||'').slice(0,180);
        const msg = { id: uuid(), at: Date.now(), nick: user.nick, text, type:'user' };
        pushChat(msg); broadcast('chat', msg);
        return;
      }

      if (type === 'placeBet'){
        if (user.blocked){ ws.send(JSON.stringify({ type:'notice', payload:{ message:'Conta bloqueada pelo admin' } })); return; }
        if (!db.round || !db.round.running){ ws.send(JSON.stringify({ type:'notice', payload:{ message:'Aguarde a próxima rodada' } })); return; }
        const amount = Math.floor(Math.max(1, Number(payload?.amount||0)));
        const auto = Math.max(1.1, Math.min(10, Number(payload?.auto||1.5)));
        if (user.balance < amount){ ws.send(JSON.stringify({ type:'notice', payload:{ message:'Saldo insuficiente' } })); return; }
        user.balance -= amount;
        ws.send(JSON.stringify({ type:'balance', payload:{ balance: user.balance } }));
        const bet = { id: uuid(), roundId: db.round.id, userId, nick:user.nick, amount, auto, cashedAt: null };
        db.betsOpen.push(bet);
        const sys = { id: uuid(), at: Date.now(), nick:'sistema', text:`${user.nick} apostou R$ ${amount.toFixed(2)} • auto ${auto.toFixed(2)}x`, type:'system' };
        pushChat(sys); broadcast('chat', sys);
        broadcast('bet', { nick:user.nick, amount, auto });
        return;
      }

      if (type === 'cashout'){
        doCashout(userId);
        return;
      }

    }catch(err){
      console.error('ws message err', err);
    }
  });

  ws.on('close', () => {
    const userId = db.sessions.get(ws);
    const user = db.users.get(userId);
    if (user){
      const msg = { id: uuid(), at: Date.now(), nick:'sistema', text:`${user.nick} saiu`, type:'system' };
      pushChat(msg); broadcast('chat', msg);
    }
    db.sessions.delete(ws);
  });
});

// Heartbeat
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false; ws.ping();
  });
}, CONFIG.heartbeat);