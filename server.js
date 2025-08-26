
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const ORIGIN = process.env.ORIGIN || `http://localhost:${PORT}`;

const app = express();
app.use(express.json());
app.use(cors({ origin: ORIGIN, credentials: true }));

// ===== DB (SQLite) =====
sqlite3.verbose();
const db = new sqlite3.Database(path.join(__dirname, 'data.db'));

function run(sql, params=[]) { return new Promise((res, rej)=> db.run(sql, params, function(err){ if(err) rej(err); else res(this); })); }
function all(sql, params=[]) { return new Promise((res, rej)=> db.all(sql, params, (err, rows)=> err?rej(err):res(rows))); }
function get(sql, params=[]) { return new Promise((res, rej)=> db.get(sql, params, (err, row)=> err?rej(err):res(row))); }

await run(`PRAGMA journal_mode = WAL`);
await run(`CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT, email TEXT UNIQUE, password_hash TEXT,
  balance REAL DEFAULT 1000,
  role TEXT DEFAULT 'user',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);

await run(`CREATE TABLE IF NOT EXISTS bets(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER, user_id INTEGER, amount REAL,
  auto_cashout REAL, cashed_out_at REAL, payout REAL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);

await run(`CREATE TABLE IF NOT EXISTS rounds(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  crash_at REAL, started_at INTEGER, ended_at INTEGER
)`);

// seed admin
const adminEmail = 'admin@example.com';
const admin = await get(`SELECT * FROM users WHERE email = ?`, [adminEmail]);
if(!admin){
  const hash = bcrypt.hashSync('admin123', 10);
  await run(`INSERT INTO users(name,email,password_hash,role,balance) VALUES(?,?,?,?,?)`, ['Administrador', adminEmail, hash, 'admin', 0]);
  console.log('Admin criado: admin@example.com / admin123');
}

// ===== Auth helpers =====
function sign(user){
  return jwt.sign({ id:user.id, role:user.role, name:user.name, email:user.email }, JWT_SECRET, { expiresIn: '7d' });
}
function auth(req,res,next){
  const h = req.headers.authorization||'';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if(!token) return res.status(401).json({error:'no_token'});
  try{
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  }catch(e){
    return res.status(401).json({error:'invalid_token'});
  }
}
function adminOnly(req,res,next){
  if(req.user?.role !== 'admin') return res.status(403).json({error:'forbidden'});
  next();
}

// ===== REST =====
app.post('/api/register', async (req,res)=>{
  try{
    const {name, email, password} = req.body;
    if(!name || !email || !password) return res.status(400).json({error:'missing_fields'});
    const hash = bcrypt.hashSync(password, 10);
    await run(`INSERT INTO users(name,email,password_hash) VALUES(?,?,?)`, [name, email, hash]);
    const user = await get(`SELECT * FROM users WHERE email=?`, [email]);
    return res.json({ token: sign(user), user:{id:user.id, name:user.name, email:user.email, balance:user.balance, role:user.role} });
  }catch(e){
    console.error(e);
    return res.status(400).json({error:'register_failed'});
  }
});

app.post('/api/login', async (req,res)=>{
  const {email, password} = req.body;
  const user = await get(`SELECT * FROM users WHERE email=?`, [email]);
  if(!user) return res.status(401).json({error:'invalid_credentials'});
  const ok = bcrypt.compareSync(password, user.password_hash||'');
  if(!ok) return res.status(401).json({error:'invalid_credentials'});
  return res.json({ token: sign(user), user:{id:user.id, name:user.name, email:user.email, balance:user.balance, role:user.role} });
});

app.get('/api/me', auth, async (req,res)=>{
  const user = await get(`SELECT id,name,email,balance,role FROM users WHERE id=?`, [req.user.id]);
  return res.json(user);
});

app.get('/api/users', auth, adminOnly, async (req,res)=>{
  const rows = await all(`SELECT id,name,email,balance,role,created_at FROM users ORDER BY id DESC`);
  res.json(rows);
});

app.post('/api/credit', auth, adminOnly, async (req,res)=>{
  const { userId, amount } = req.body;
  if(!userId || !Number.isFinite(Number(amount))) return res.status(400).json({error:'invalid'});
  await run(`UPDATE users SET balance = round(balance + ?, 2) WHERE id = ?`, [Number(amount), userId]);
  const updated = await get(`SELECT id,name,email,balance FROM users WHERE id=?`, [userId]);
  io.to(`user_${userId}`).emit('wallet:update', updated.balance);
  res.json(updated);
});

// Static
app.use(express.static(path.join(__dirname, 'public')));

// ===== Game Engine =====
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ORIGIN, credentials: true }
});

let PHASE = 'WAITING'; // WAITING | FLYING | CRASHED
let roundId = 0;
let multiplier = 1.0;
let crashAt = 2.0;
let startedAt = 0;
let waitEndsAt = Date.now() + 8000; // 8s para apostar
let history = []; // últimos multiplicadores
const TICK = 100; // ms
const rate = 0.62; // same growth rate as client example

// bets in memory for current round
const liveBets = new Map(); // userId -> {amount, autoCash, cashed:false}

const chatLog = []; // keep last 50

function sampleCrash(){
  // heavy-tailed distribution; cap 50x; house edge 1%
  const u = Math.random();
  let m = 0.99 / (1 - u);
  if(!Number.isFinite(m) || m<1) m = 1;
  return Math.min(50, m);
}

async function newRound(){
  PHASE = 'WAITING';
  multiplier = 1.0;
  crashAt = sampleCrash();
  waitEndsAt = Date.now() + 8000; // 8s janela de apostas
  startedAt = 0;
  liveBets.clear();
  io.emit('state', getState());
}

async function startFlying(){
  PHASE = 'FLYING';
  const ins = await run(`INSERT INTO rounds(crash_at, started_at) VALUES(?, strftime('%s','now'))`, [crashAt]);
  roundId = ins.lastID;
  startedAt = Date.now();
  io.emit('state', getState());
}

async function crash(){
  PHASE = 'CRASHED';
  await run(`UPDATE rounds SET ended_at = strftime('%s','now') WHERE id = ?`, [roundId]);
  history.unshift(Number(crashAt.toFixed(2)));
  history.splice(20);
  // settle losers
  for (const [userId, b] of liveBets.entries()){
    if(!b.cashed){
      // lost bet
      await run(`INSERT INTO bets(round_id,user_id,amount,auto_cashout,cashed_out_at,payout) VALUES(?,?,?,?,?,?)`,
        [roundId, userId, b.amount, b.autoCash, null, 0]);
    }
  }
  io.emit('state', getState());
  setTimeout(newRound, 5000); // 5s até próxima rodada
}

function getState(){
  return {
    phase: PHASE,
    roundId,
    multiplier: Number(multiplier.toFixed(2)),
    timeToBet: Math.max(0, waitEndsAt - Date.now()),
    crashAt: PHASE==='CRASHED' ? Number(crashAt.toFixed(2)) : null,
    history,
    live: Array.from(liveBets.entries()).map(([uid,b])=>({ userId:Number(uid), amount:b.amount, cashed:!!b.cashed })),
  };
}

setInterval(async ()=>{
  if(PHASE==='WAITING'){
    if(Date.now() >= waitEndsAt){
      await startFlying();
    }
  }else if(PHASE==='FLYING'){
    const t = (Date.now()-startedAt)/1000;
    multiplier = Math.max(1, Math.exp(rate*t));
    // auto cashouts
    for (const [userId, b] of liveBets.entries()){
      if(!b.cashed && b.autoCash && multiplier >= b.autoCash){
        await doCashout(Number(userId));
      }
    }
    if(multiplier >= crashAt){
      await crash();
    }else{
      io.volatile.emit('state', getState());
    }
  }
}, TICK);

// ===== Sockets =====
io.use((socket, next)=>{
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if(!token) return next();
  try{
    const payload = jwt.verify(token, JWT_SECRET);
    socket.user = payload;
    next();
  }catch(e){
    console.log('Socket auth failed');
    next();
  }
});

io.on('connection', async (socket)=>{
  const userId = socket.user?.id;
  if(userId){
    socket.join(`user_${userId}`);
    const me = await get(`SELECT id,name,balance,role FROM users WHERE id=?`, [userId]);
    socket.emit('wallet:update', me?.balance ?? 0);
  }

  socket.emit('state', getState());
  socket.emit('chat:history', chatLog);

  socket.on('chat:send', async (text)=>{
    text = String(text||'').slice(0, 200);
    if(!text.trim()) return;
    const who = socket.user?.name || 'Visitante';
    const item = { who, text, t: Date.now() };
    chatLog.push(item);
    if(chatLog.length>50) chatLog.shift();
    io.emit('chat:new', item);
  });

  socket.on('place_bet', async ({ amount, autoCash })=>{
    if(!socket.user) return socket.emit('error_msg', 'Faça login para apostar.');
    if(PHASE!=='WAITING') return socket.emit('error_msg', 'Apostas somente na fase de espera.');
    amount = Math.floor(Number(amount)||0);
    if(amount<=0) return socket.emit('error_msg', 'Valor inválido.');

    const row = await get(`SELECT balance FROM users WHERE id=?`, [socket.user.id]);
    if(!row || row.balance < amount) return socket.emit('error_msg', 'Saldo insuficiente.');

    await run(`UPDATE users SET balance = balance - ? WHERE id = ?`, [amount, socket.user.id]);
    io.to(`user_${socket.user.id}`).emit('wallet:update', row.balance - amount);

    liveBets.set(String(socket.user.id), { amount, autoCash: Number(autoCash)||null, cashed:false });
    io.emit('state', getState());
  });

  socket.on('cashout', async ()=>{
    if(!socket.user) return;
    await doCashout(socket.user.id);
  });

  socket.on('disconnect', ()=>{});
});

async function doCashout(userId){
  const b = liveBets.get(String(userId));
  if(!b || b.cashed || PHASE!=='FLYING') return;
  const payout = Math.floor(b.amount * multiplier * 100)/100;
  b.cashed = true;
  await run(`UPDATE users SET balance = round(balance + ?,2) WHERE id = ?`, [payout, userId]);
  await run(`INSERT INTO bets(round_id,user_id,amount,auto_cashout,cashed_out_at,payout) VALUES(?,?,?,?,?,?)`,
    [roundId, userId, b.amount, b.autoCash, multiplier, payout]);
  io.to(`user_${userId}`).emit('wallet:update', (await get(`SELECT balance FROM users WHERE id=?`, [userId])).balance);
  io.emit('state', getState());
}

// Start
server.listen(PORT, ()=>{
  console.log('Servidor rodando em http://localhost:'+PORT);
  console.log('Origem permitida:', ORIGIN);
});
