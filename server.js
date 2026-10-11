#!/usr/bin/env node
/*
 * WA Dummy: a WhatsApp-style messenger for demos and for testing your AI.
 * No npm packages needed. Requires Node.js 18 or newer.
 *   node server.js
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';            // 0.0.0.0 = reachable from other laptops
const EDIT_WINDOW_MS = 15 * 60 * 1000;                  // WhatsApp lets you edit for 15 minutes
const ALLOWED_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const SHOP_NAME = process.env.SHOP_NAME || 'My Shop';   // the business account your AI replies from
const SHOP_PHONE = process.env.SHOP_PHONE || '9999999999';

const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// ---------- storage: a single JSON file ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = fs.existsSync(DB_FILE)
  ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))
  : { users: [], chats: [], messages: [], sessions: {}, apiKey: null, shopUserId: null };
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db));

// The shop account and the API key your AI uses. The key has full access to the shop account.
let shop = db.users.find((u) => u.phone === SHOP_PHONE);
if (!shop) {
  shop = { id: crypto.randomUUID(), name: SHOP_NAME, phone: SHOP_PHONE, lastSeen: Date.now() };
  db.users.push(shop);
}
db.shopUserId = shop.id;
db.apiKey = process.env.API_KEY || db.apiKey || 'wa_' + crypto.randomBytes(24).toString('hex');
save();

// ---------- live connections (Server-Sent Events) ----------
const streams = new Map();                               // userId -> Set of open responses
const isOnline = (userId) => (streams.get(userId)?.size || 0) > 0;
function emitTo(userIds, event, data) {
  const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const id of new Set(userIds)) for (const res of streams.get(id) || []) res.write(chunk);
}
const emitAll = (event, data) => emitTo([...streams.keys()], event, data);

// ---------- helpers ----------
const now = () => Date.now();
const userById = (id) => db.users.find((u) => u.id === id);
const chatById = (id) => db.chats.find((c) => c.id === id);
const msgById = (id) => db.messages.find((m) => m.id === id);
const isMember = (chat, userId) => !!chat && chat.members.includes(userId);
const publicUser = (u) => ({ id: u.id, name: u.name, phone: u.phone, online: isOnline(u.id), lastSeen: u.lastSeen });

function myMessage(me, id) {
  const m = msgById(id);
  return m && isMember(chatById(m.chatId), me.id) ? m : null;
}

function newMessage(chatId, senderId, text, extra = {}) {
  return {
    id: crypto.randomUUID(), chatId, senderId, text, createdAt: now(), editedAt: null,
    deletedForEveryone: false, deletedFor: [], forwarded: false, replyTo: null,
    reactions: {}, deliveredTo: [], readBy: [], ...extra,
  };
}

// What clients receive: adds the sender's name and the sender-side tick status (sent / delivered / read).
function decorate(m) {
  const chat = chatById(m.chatId);
  const sender = userById(m.senderId);
  const others = chat ? chat.members.filter((id) => id !== m.senderId) : [];
  let status = 'sent';
  if (others.length && others.every((id) => m.deliveredTo.includes(id))) status = 'delivered';
  if (others.length && others.every((id) => m.readBy.includes(id))) status = 'read';
  let replyTo = m.replyTo;
  if (replyTo) {
    const orig = msgById(replyTo.id);
    if (orig) {
      replyTo = {
        id: orig.id,
        senderName: replyTo.senderName,
        text: orig.deletedForEveryone ? 'This message was deleted' : replyTo.text,
      };
    }
  }
  return {
    ...m,
    text: m.deletedForEveryone ? '' : m.text,
    senderName: sender ? sender.name : 'Unknown',
    status,
    replyTo,
  };
}

function chatSummary(chat, meId) {
  const visible = db.messages.filter((m) => m.chatId === chat.id && !m.deletedFor.includes(meId));
  const last = visible[visible.length - 1];
  return {
    id: chat.id,
    type: chat.type,
    title: chat.type === 'group' ? chat.name : (userById(chat.members.find((id) => id !== meId))?.name || 'Unknown'),
    members: chat.members.map((id) => userById(id)).filter(Boolean).map(publicUser),
    unread: visible.filter((m) => m.senderId !== meId && !m.readBy.includes(meId)).length,
    lastMessage: last
      ? {
          id: last.id,
          senderId: last.senderId,
          senderName: userById(last.senderId)?.name || '',
          text: last.deletedForEveryone ? '' : last.text,
          deletedForEveryone: last.deletedForEveryone,
          createdAt: last.createdAt,
        }
      : null,
    lastActivity: last ? last.createdAt : chat.createdAt,
  };
}

function announceChat(chat) {
  for (const id of chat.members) emitTo([id], 'chat:new', chatSummary(chat, id));
}

// ---------- auth ----------
function bearer(req, url) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return url.searchParams.get('token');                  // browsers' EventSource cannot send headers
}

function authenticate(req, url) {
  const token = bearer(req, url);
  if (!token) return null;
  if (token === db.apiKey) return userById(db.shopUserId); // the API key acts as the shop account
  const id = db.sessions[token];
  return id ? userById(id) : null;
}

// ---------- routing ----------
const routes = [];
const route = (method, pattern, handler, { open = false } = {}) => routes.push({ method, pattern, handler, open });

route('POST', /^\/api\/login$/, ({ body }) => {
  const name = String(body.name || '').trim().slice(0, 40);
  const phone = String(body.phone || '').replace(/\D/g, '');
  if (phone.length < 7) return [400, { error: 'Enter a valid phone number' }];
  let user = db.users.find((u) => u.phone === phone);
  if (!user) {
    if (!name) return [400, { error: 'Enter your name to create an account' }];
    user = { id: crypto.randomUUID(), name, phone, lastSeen: now() };
    db.users.push(user);
  }
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = user.id;
  save();
  return [200, { token, user: publicUser(user) }];
}, { open: true });

route('POST', /^\/api\/logout$/, ({ req, url }) => {
  const t = bearer(req, url);
  if (t && db.sessions[t]) { delete db.sessions[t]; save(); }
  return [204];
});

route('GET', /^\/api\/me$/, ({ me }) => [200, publicUser(me)]);

route('GET', /^\/api\/users$/, ({ me }) => [200, db.users.filter((u) => u.id !== me.id).map(publicUser)]);

route('GET', /^\/api\/chats$/, ({ me }) => [
  200,
  db.chats.filter((c) => isMember(c, me.id)).map((c) => chatSummary(c, me.id)).sort((a, b) => b.lastActivity - a.lastActivity),
]);

route('POST', /^\/api\/chats$/, ({ me, body }) => {
  if (body.type === 'group') {
    const name = String(body.name || '').trim().slice(0, 60);
    const ids = Array.isArray(body.memberIds) ? body.memberIds : [];
    const members = [...new Set([me.id, ...ids])].filter((id) => userById(id));
    if (!name) return [400, { error: 'Give the group a name' }];
    if (members.length < 2) return [400, { error: 'Pick at least one other member' }];
    const chat = { id: crypto.randomUUID(), type: 'group', name, members, createdBy: me.id, createdAt: now() };
    db.chats.push(chat);
    save();
    announceChat(chat);
    return [201, chatSummary(chat, me.id)];
  }
  const other = userById(body.userId);
  if (!other || other.id === me.id) return [400, { error: 'Pick a valid contact' }];
  let chat = db.chats.find((c) => c.type === 'direct' && isMember(c, me.id) && isMember(c, other.id));
  if (!chat) {
    chat = { id: crypto.randomUUID(), type: 'direct', members: [me.id, other.id], createdAt: now() };
    db.chats.push(chat);
    save();
    announceChat(chat);
  }
  return [200, chatSummary(chat, me.id)];
});

route('GET', /^\/api\/chats\/([^/]+)\/messages$/, ({ me, params }) => {
  const chat = chatById(params[0]);
  if (!isMember(chat, me.id)) return [404, { error: 'Chat not found' }];
  const list = db.messages.filter((m) => m.chatId === chat.id && !m.deletedFor.includes(me.id)).slice(-300);
  return [200, list.map(decorate)];
});

route('POST', /^\/api\/chats\/([^/]+)\/messages$/, ({ me, params, body }) => {
  const chat = chatById(params[0]);
  if (!isMember(chat, me.id)) return [404, { error: 'Chat not found' }];
  const text = String(body.text || '').trim();
  if (!text) return [400, { error: 'Message is empty' }];
  if (text.length > 4000) return [400, { error: 'Message too long (4000 characters max)' }];
  let replyTo = null;
  const target = body.replyTo ? msgById(body.replyTo) : null;
  if (target && target.chatId === chat.id) {
    replyTo = { id: target.id, senderName: userById(target.senderId)?.name || 'Unknown', text: target.text };
  }
  const m = newMessage(chat.id, me.id, text, { replyTo });
  db.messages.push(m);
  save();
  emitTo(chat.members, 'message:new', decorate(m));
  return [201, decorate(m)];
});

route('POST', /^\/api\/chats\/([^/]+)\/read$/, ({ me, params }) => {
  const chat = chatById(params[0]);
  if (!isMember(chat, me.id)) return [404, { error: 'Chat not found' }];
  let changed = false;
  for (const m of db.messages) {
    if (m.chatId !== chat.id || m.senderId === me.id) continue;
    if (!m.readBy.includes(me.id)) { m.readBy.push(me.id); changed = true; }
    if (!m.deliveredTo.includes(me.id)) m.deliveredTo.push(me.id);
  }
  if (changed) {
    save();
    emitTo(chat.members, 'receipt', { chatId: chat.id });
  }
  return [204];
});

route('POST', /^\/api\/delivered$/, ({ me }) => {
  // "delivered" = the recipient's app received the message (ticks turn into two grey ticks)
  const touched = new Set();
  for (const m of db.messages) {
    if (m.senderId === me.id || m.deliveredTo.includes(me.id)) continue;
    const chat = chatById(m.chatId);
    if (!isMember(chat, me.id)) continue;
    m.deliveredTo.push(me.id);
    touched.add(chat.id);
  }
  if (touched.size) save();
  for (const id of touched) emitTo(chatById(id).members, 'receipt', { chatId: id });
  return [204];
});

route('POST', /^\/api\/chats\/([^/]+)\/typing$/, ({ me, params }) => {
  const chat = chatById(params[0]);
  if (!isMember(chat, me.id)) return [404, { error: 'Chat not found' }];
  emitTo(chat.members.filter((id) => id !== me.id), 'typing', { chatId: chat.id, userId: me.id, name: me.name });
  return [204];
});

route('PATCH', /^\/api\/messages\/([^/]+)$/, ({ me, params, body }) => {
  const m = myMessage(me, params[0]);
  if (!m) return [404, { error: 'Message not found' }];
  if (m.senderId !== me.id) return [403, { error: 'You can only edit your own messages' }];
  if (m.deletedForEveryone) return [400, { error: 'Deleted messages cannot be edited' }];
  if (now() - m.createdAt > EDIT_WINDOW_MS) return [400, { error: 'Messages can only be edited within 15 minutes' }];
  const text = String(body.text || '').trim().slice(0, 4000);
  if (!text) return [400, { error: 'Message is empty' }];
  m.text = text;
  m.editedAt = now();
  save();
  const payload = decorate(m);
  emitTo(chatById(m.chatId).members, 'message:update', payload);
  return [200, payload];
});

route('DELETE', /^\/api\/messages\/([^/]+)$/, ({ me, params, url }) => {
  const m = myMessage(me, params[0]);
  if (!m) return [404, { error: 'Message not found' }];
  if (url.searchParams.get('scope') === 'everyone') {
    if (m.senderId !== me.id) return [403, { error: 'Only the sender can delete for everyone' }];
    m.deletedForEveryone = true;
    m.text = '';
    m.reactions = {};
    save();
    const payload = decorate(m);
    emitTo(chatById(m.chatId).members, 'message:update', payload);
    return [200, payload];
  }
  // "delete for me" only hides it for this user
  if (!m.deletedFor.includes(me.id)) m.deletedFor.push(me.id);
  save();
  return [200, { id: m.id, deletedFor: me.id }];
});

route('POST', /^\/api\/messages\/([^/]+)\/react$/, ({ me, params, body }) => {
  const m = myMessage(me, params[0]);
  if (!m) return [404, { error: 'Message not found' }];
  if (m.deletedForEveryone) return [400, { error: 'Cannot react to a deleted message' }];
  const emoji = String(body.emoji || '');
  if (!ALLOWED_EMOJI.includes(emoji)) return [400, { error: 'Unsupported reaction' }];
  // One reaction per person, like WhatsApp. Tapping the same emoji again removes it.
  const had = (m.reactions[emoji] || []).includes(me.id);
  for (const e of Object.keys(m.reactions)) {
    m.reactions[e] = m.reactions[e].filter((id) => id !== me.id);
    if (!m.reactions[e].length) delete m.reactions[e];
  }
  if (!had) (m.reactions[emoji] = m.reactions[emoji] || []).push(me.id);
  save();
  const payload = decorate(m);
  emitTo(chatById(m.chatId).members, 'message:update', payload);
  return [200, payload];
});

route('POST', /^\/api\/messages\/([^/]+)\/forward$/, ({ me, params, body }) => {
  const src = myMessage(me, params[0]);
  if (!src) return [404, { error: 'Message not found' }];
  if (src.deletedForEveryone) return [400, { error: 'Deleted messages cannot be forwarded' }];
  const ids = [...new Set(Array.isArray(body.chatIds) ? body.chatIds : [])].slice(0, 10);
  const targets = ids.map((id) => chatById(id)).filter((c) => isMember(c, me.id));
  if (!targets.length) return [400, { error: 'Pick at least one chat you are in' }];
  const sent = targets.map((chat) => {
    const m = newMessage(chat.id, me.id, src.text, { forwarded: true });
    db.messages.push(m);
    emitTo(chat.members, 'message:new', decorate(m));
    return decorate(m);
  });
  save();
  return [201, sent];
});

route('GET', /^\/api\/events$/, ({ me, res }) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const wasOnline = isOnline(me.id);
  if (!streams.has(me.id)) streams.set(me.id, new Set());
  streams.get(me.id).add(res);
  res.write(`event: hello\ndata: ${JSON.stringify(publicUser(me))}\n\n`);
  // snapshot: tell this new connection who is already online
  for (const id of streams.keys()) {
    if (id !== me.id) res.write(`event: presence\ndata: ${JSON.stringify({ userId: id, online: true })}\n\n`);
  }
  if (!wasOnline) emitAll('presence', { userId: me.id, online: true });
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  res.on('close', () => {
    clearInterval(ping);
    const set = streams.get(me.id);
    set.delete(res);
    if (set.size === 0) {
      streams.delete(me.id);
      me.lastSeen = now();
      save();
      emitAll('presence', { userId: me.id, online: false, lastSeen: me.lastSeen });
    }
  });
  return null;                                           // response stays open; nothing more to send
}, {});

// ---------- HTTP plumbing ----------
function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) { req.destroy(); reject(new Error('Body too large')); }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function send(res, status, data) {
  if (status === 204 || data === undefined) { res.writeHead(status); return res.end(); }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function handleApi(req, res, url) {
  const r = routes.find((x) => x.method === req.method && x.pattern.test(url.pathname));
  if (!r) return send(res, 404, { error: 'No such endpoint' });
  const ctx = { req, res, url, params: url.pathname.match(r.pattern).slice(1), body: {}, me: null };
  if (!r.open) {
    ctx.me = authenticate(req, url);
    if (!ctx.me) return send(res, 401, { error: 'Log in first, or send a valid API key' });
  }
  if (req.method === 'POST' || req.method === 'PATCH') {
    try { ctx.body = (await readJson(req)) || {}; } catch { return send(res, 400, { error: 'Body must be valid JSON' }); }
  }
  const out = await r.handler(ctx);
  if (out) send(res, out[0], out[1]);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'OPTIONS') return send(res, 204);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(res, url.pathname);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: 'Server error: ' + err.message });
  }
});

server.listen(PORT, HOST, () => {
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && !i.internal && (i.family === 'IPv4' || i.family === 4))
    .map((i) => i.address);
  console.log('\n  WA Dummy is running\n');
  console.log(`  This laptop:        http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  Other laptops:      http://${ip}:${PORT}`);
  console.log(`\n  Shop account:       ${SHOP_NAME}  (log in with phone ${SHOP_PHONE})`);
  console.log(`  API key for your AI: ${db.apiKey}`);
  console.log('                      (keep it secret; send it as "Authorization: Bearer <key>")\n');
});
