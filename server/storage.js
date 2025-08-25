import { v4 as uuid } from 'uuid';

export const db = {
  users: new Map(),      // id -> { id, nick, balance, blocked }
  sessions: new Map(),   // ws -> userId
  chat: [],              // { id, at, nick, text, type }
  history: [],           // { at, roundId, crashAt }
  round: null,           // { id, startAt, rate, crashAt, running, currentMult }
  betsOpen: []           // { id, roundId, userId, nick, amount, auto, cashedAt: null }
};

export function listUsers(){
  return Array.from(db.users.values()).sort((a,b)=> a.nick.localeCompare(b.nick));
}

export function findUserByNick(nick){
  const n = String(nick||'').trim().toLowerCase();
  for (const u of db.users.values()){
    if (u.nick.trim().toLowerCase() === n) return u;
  }
  return null;
}

export function ensureUser(nick, credits){
  let u = findUserByNick(nick);
  if (u) return u;
  const id = uuid();
  u = { id, nick, balance: credits, blocked: false };
  db.users.set(id, u);
  return u;
}

export function pushChat(msg){
  db.chat.push(msg);
  if (db.chat.length > 300) db.chat.shift();
}

export function pushHistory(h){
  db.history.unshift(h);
  db.history = db.history.slice(0, 50);
}
