/* WA Dummy browser app. Plain JavaScript, no build step. */
const EDIT_WINDOW_MS = 15 * 60 * 1000;                 // keep in sync with server.js
const EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const $ = (id) => document.getElementById(id);

const S = {
  token: sessionStorage.getItem('wa_token'),           // per tab, so two tabs can be two users on one laptop
  me: null,
  users: [],
  chats: [],
  chat: null,                                          // the open chat (summary)
  messages: [],                                        // messages of the open chat
  online: new Set(),
  lastSeen: {},
  typing: {},                                          // userId -> { chatId, name, timer }
  reply: null,                                         // message being replied to
  editing: null,                                       // message being edited
  es: null,
  lastTypingSent: 0,
};

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = (name) => (String(name || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()) || '?';
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const fmtDay = (ts) => (sameDay(ts, Date.now()) ? 'Today' : sameDay(ts, Date.now() - 864e5) ? 'Yesterday' : new Date(ts).toLocaleDateString());
const fmtLastSeen = (ts) => (!ts ? 'offline' : sameDay(ts, Date.now()) ? `last seen today at ${fmtTime(ts)}` : `last seen ${new Date(ts).toLocaleDateString()}`);
const tickHtml = (s) => (s === 'read' ? '<span class="tick read">✓✓</span>' : s === 'delivered' ? '<span class="tick">✓✓</span>' : '<span class="tick">✓</span>');

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2500);
}

async function api(method, url, body) {
  const opts = { method, headers: { Authorization: 'Bearer ' + (S.token || '') } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (res.status === 401 && S.token) { logout(); throw new Error('Session ended, please log in again'); }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

// ---------- login / session ----------
function showLogin(err = '') {
  $('app').classList.add('hidden');
  $('login').classList.remove('hidden');
  $('loginError').textContent = err;
}

function logout() {
  sessionStorage.removeItem('wa_token');
  S.token = null;
  if (S.es) S.es.close();
  location.reload();
}

async function start() {
  S.me = await api('GET', '/api/me');
  S.users = await api('GET', '/api/users');
  S.online = new Set(S.users.filter((u) => u.online).map((u) => u.id));
  for (const u of S.users) S.lastSeen[u.id] = u.lastSeen;
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('meName').textContent = S.me.name;
  $('meAvatar').textContent = initials(S.me.name);
  await loadChats();
  connect();
}

$('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  $('loginError').textContent = '';
  try {
    const r = await api('POST', '/api/login', { name: $('loginName').value, phone: $('loginPhone').value });
    S.token = r.token;
    sessionStorage.setItem('wa_token', r.token);
    await start();
  } catch (err) {
    $('loginError').textContent = err.message;
  }
};

(async function init() {
  if (!S.token) return showLogin();
  try {
    await start();
  } catch (err) {
    S.token = null;
    sessionStorage.removeItem('wa_token');
    showLogin(err.message);
  }
})();

// ---------- live events ----------
function setConn(ok) {
  const b = $('connBar');
  b.textContent = 'Reconnecting…';
  b.classList.toggle('hidden', ok);
}

function connect() {
  if (S.es) S.es.close();
  const es = new EventSource(`/api/events?token=${encodeURIComponent(S.token)}`);
  S.es = es;
  const on = (name, fn) => es.addEventListener(name, (e) => {
    try { fn(JSON.parse(e.data)); } catch (err) { console.error(err); }
  });
  es.onopen = () => setConn(true);
  es.onerror = () => {
    setConn(false);
    if (es.readyState === EventSource.CLOSED) logout();  // session no longer valid
  };
  on('hello', async () => {
    setConn(true);
    await api('POST', '/api/delivered').catch(() => {});
    await loadChats();
    if (S.chat) await loadMessages();
  });
  on('message:new', onMessageNew);
  on('message:update', (m) => { upsert(m); loadChats(); });
  on('receipt', ({ chatId }) => {
    if (S.chat && S.chat.id === chatId) loadMessages();
    loadChats();
  });
  on('chat:new', () => loadChats());
  on('typing', onTyping);
  on('presence', onPresence);
}

function onMessageNew(m) {
  if (m.senderId !== S.me.id) {
    api('POST', '/api/delivered').catch(() => {});
    // they sent it, so they are no longer "typing…"
    if (S.typing[m.senderId]) {
      clearTimeout(S.typing[m.senderId].timer);
      delete S.typing[m.senderId];
      renderHeader();
    }
  }
  if (S.chat && m.chatId === S.chat.id) {
    upsert(m);
    if (m.senderId !== S.me.id && !document.hidden) markRead();
  }
  loadChats();
}

function onTyping({ chatId, userId, name }) {
  if (userId === S.me.id) return;
  clearTimeout(S.typing[userId]?.timer);
  S.typing[userId] = {
    chatId,
    name,
    timer: setTimeout(() => { delete S.typing[userId]; renderHeader(); }, 3000),
  };
  renderHeader();
}

function onPresence({ userId, online, lastSeen }) {
  if (online) S.online.add(userId);
  else S.online.delete(userId);
  if (lastSeen) S.lastSeen[userId] = lastSeen;
  renderChats();
  renderHeader();
}

// ---------- chats ----------
async function loadChats() {
  S.chats = await api('GET', '/api/chats');
  renderChats();
  if (S.chat) {
    const fresh = S.chats.find((c) => c.id === S.chat.id);
    if (fresh) { S.chat = fresh; renderHeader(); }
  }
}

function renderChats() {
  const q = $('search').value.trim().toLowerCase();
  const list = S.chats.filter((c) => !q || c.title.toLowerCase().includes(q));
  $('chatList').innerHTML = list.length
    ? list.map((c) => {
        const other = c.type === 'direct' ? c.members.find((m) => m.id !== S.me.id) : null;
        const dot = other && S.online.has(other.id) ? '<i class="dot"></i>' : '';
        const last = c.lastMessage;
        let preview = 'No messages yet';
        if (last) {
          const who = last.senderId === S.me.id ? 'You: ' : c.type === 'group' ? `${last.senderName}: ` : '';
          preview = who + (last.deletedForEveryone ? '🚫 This message was deleted' : last.text);
        }
        return `<div class="chatitem${S.chat && S.chat.id === c.id ? ' active' : ''}" data-id="${esc(c.id)}">
          <div class="avatar${c.type === 'group' ? ' group' : ''}">${esc(initials(c.title))}${dot}</div>
          <div class="ci-body">
            <div class="ci-top"><b>${esc(c.title)}</b><small>${last ? fmtTime(last.createdAt) : ''}</small></div>
            <div class="ci-bottom"><span class="prev">${esc(preview)}</span>${c.unread ? `<span class="badge">${c.unread}</span>` : ''}</div>
          </div>
        </div>`;
      }).join('')
    : '<div class="nochats">No chats yet. Use ＋ to start one.</div>';
}

async function openChat(id) {
  const chat = S.chats.find((c) => c.id === id);
  if (!chat) return;
  S.chat = chat;
  S.reply = null;
  S.editing = null;
  S.messages = [];
  $('empty').classList.add('hidden');
  $('chatView').classList.remove('hidden');
  document.body.classList.add('chat-open');
  $('input').value = '';
  autosize();
  renderHeader();
  renderComposer();
  renderChats();
  await loadMessages(true);
  markRead();
}

async function loadMessages(scrollToEnd = false) {
  if (!S.chat) return;
  const id = S.chat.id;
  const list = await api('GET', `/api/chats/${id}/messages`);
  if (!S.chat || S.chat.id !== id) return;             // user switched chats in the meantime
  S.messages = list;
  renderMessages(scrollToEnd);
}

async function markRead() {
  if (!S.chat) return;
  await api('POST', `/api/chats/${S.chat.id}/read`).catch(() => {});
  loadChats();
}

function renderHeader() {
  const c = S.chat;
  if (!c) return;
  const other = c.type === 'direct' ? c.members.find((m) => m.id !== S.me.id) : null;
  const typing = Object.values(S.typing).filter((t) => t.chatId === c.id).map((t) => t.name);
  let sub;
  if (typing.length) sub = `${typing.join(', ')} typing…`;
  else if (other) sub = S.online.has(other.id) ? 'online' : fmtLastSeen(S.lastSeen[other.id]);
  else sub = c.members.map((m) => (m.id === S.me.id ? 'You' : m.name)).join(', ');
  $('chatTitle').textContent = c.title;
  $('chatAvatar').textContent = initials(c.title);
  $('chatAvatar').className = 'avatar' + (c.type === 'group' ? ' group' : '');
  $('chatSub').textContent = sub;
}

// ---------- messages ----------
function upsert(m) {
  if (!S.chat || m.chatId !== S.chat.id) return;
  const i = S.messages.findIndex((x) => x.id === m.id);
  const isNew = i < 0;
  if (isNew) S.messages.push(m);
  else S.messages[i] = m;
  renderMessages(isNew && m.senderId === S.me.id);
}

function bubble(m) {
  const mine = m.senderId === S.me.id;
  const isGroup = S.chat && S.chat.type === 'group';
  const reacts = Object.entries(m.reactions || {}).filter(([, ids]) => ids.length);
  const reactHtml = reacts.length
    ? `<div class="rxs">${reacts.map(([e, ids]) => `<span>${e}${ids.length > 1 ? ' ' + ids.length : ''}</span>`).join('')}</div>`
    : '';
  const ticks = mine && !m.deletedForEveryone ? tickHtml(m.status) : '';
  const quote = m.replyTo
    ? `<div class="quote" data-jump="${esc(m.replyTo.id)}"><b>${esc(m.replyTo.senderName)}</b><div>${esc(m.replyTo.text)}</div></div>`
    : '';
  return `<div class="row ${mine ? 'out' : 'in'}" data-id="${esc(m.id)}">
    <div class="bubble${m.deletedForEveryone ? ' deleted' : ''}">
      <button class="menu-btn" title="Message options">⌄</button>
      ${!mine && isGroup ? `<div class="sender">${esc(m.senderName)}</div>` : ''}
      ${m.forwarded ? '<div class="fwd">↪ Forwarded</div>' : ''}
      ${quote}
      <div class="text">${m.deletedForEveryone ? '🚫 <i>This message was deleted</i>' : esc(m.text)}</div>
      <div class="meta">${m.editedAt ? '<span>edited</span>' : ''}<span>${fmtTime(m.createdAt)}</span>${ticks}</div>
      ${reactHtml}
    </div>
  </div>`;
}

function renderMessages(scrollToEnd = false) {
  const box = $('messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 150;
  let html = '';
  let day = '';
  for (const m of S.messages) {
    if ((m.deletedFor || []).includes(S.me.id)) continue;
    const d = fmtDay(m.createdAt);
    if (d !== day) { day = d; html += `<div class="day">${d}</div>`; }
    html += bubble(m);
  }
  box.innerHTML = html;
  if (scrollToEnd || nearBottom) box.scrollTop = box.scrollHeight;
}

function renderComposer() {
  const bar = $('replyBar');
  const t = S.editing
    ? { label: 'Editing message', text: S.editing.text }
    : S.reply
      ? { label: 'Replying to ' + (S.reply.senderId === S.me.id ? 'yourself' : S.reply.senderName), text: S.reply.text }
      : null;
  bar.classList.toggle('hidden', !t);
  if (t) bar.innerHTML = `<div class="bar-body"><b>${esc(t.label)}</b><span>${esc(t.text)}</span></div><button title="Cancel">✕</button>`;
}

function autosize() {
  const el = $('input');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}

async function send() {
  const input = $('input');
  const text = input.value.trim();
  if (!text || !S.chat) return;
  try {
    if (S.editing) {
      upsert(await api('PATCH', `/api/messages/${S.editing.id}`, { text }));
      S.editing = null;
    } else {
      upsert(await api('POST', `/api/chats/${S.chat.id}/messages`, { text, replyTo: S.reply ? S.reply.id : null }));
      S.reply = null;
    }
    input.value = '';
    autosize();
    renderComposer();
    renderMessages(true);
    loadChats();
  } catch (err) {
    toast(err.message);
  }
}

function typingPing() {
  if (!S.chat || S.editing) return;
  const t = Date.now();
  if (t - S.lastTypingSent < 2500) return;
  S.lastTypingSent = t;
  api('POST', `/api/chats/${S.chat.id}/typing`).catch(() => {});
}

async function react(m, emoji) {
  try { upsert(await api('POST', `/api/messages/${m.id}/react`, { emoji })); }
  catch (err) { toast(err.message); }
}

async function removeMsg(m, scope) {
  try {
    await api('DELETE', `/api/messages/${m.id}?scope=${scope}`);
    await loadMessages();
    loadChats();
  } catch (err) { toast(err.message); }
}

function copyText(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
  toast('Copied');
}

// ---------- message menu (right-click or the ⌄ button) ----------
function openMenu(m, x, y) {
  const mine = m.senderId === S.me.id;
  const live = !m.deletedForEveryone;
  const canEdit = mine && live && Date.now() - m.createdAt <= EDIT_WINDOW_MS;
  const actions = [];
  if (live) actions.push(['reply', '↩️ Reply'], ['forward', '↪️ Forward'], ['copy', '📋 Copy']);
  if (canEdit) actions.push(['edit', '✏️ Edit']);
  actions.push(['delme', '🗑️ Delete for me']);
  if (mine && live) actions.push(['delall', '🚫 Delete for everyone']);
  const emojis = live
    ? `<div class="emojis">${EMOJIS.map((e) => `<button data-emoji="${e}">${e}</button>`).join('')}</div>`
    : '';
  const menu = $('ctxmenu');
  menu.innerHTML = emojis + actions.map(([a, label]) => `<button data-act="${a}">${label}</button>`).join('');
  menu.dataset.msg = m.id;
  menu.classList.remove('hidden');
  menu.style.left = Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8)) + 'px';
}

function closeMenu() { $('ctxmenu').classList.add('hidden'); }

$('ctxmenu').onclick = async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const m = S.messages.find((x) => x.id === $('ctxmenu').dataset.msg);
  closeMenu();
  if (!m) return;
  if (btn.dataset.emoji) return react(m, btn.dataset.emoji);
  switch (btn.dataset.act) {
    case 'reply':
      S.reply = m; S.editing = null; renderComposer(); $('input').focus();
      break;
    case 'forward':
      openForward(m);
      break;
    case 'copy':
      copyText(m.text);
      break;
    case 'edit':
      S.editing = m; S.reply = null; $('input').value = m.text;
      renderComposer(); autosize(); $('input').focus();
      break;
    case 'delme':
      await removeMsg(m, 'me');
      break;
    case 'delall':
      if (confirm('Delete this message for everyone?')) await removeMsg(m, 'everyone');
      break;
  }
};

// ---------- modals ----------
function openModal(title, html) {
  $('mTitle').textContent = title;
  $('mBody').innerHTML = html;
  $('mBody').onclick = null;
  $('modal').classList.remove('hidden');
}

function closeModal() {
  $('modal').classList.add('hidden');
  $('mBody').innerHTML = '';
}

function openForward(m) {
  openModal('Forward message', `
    <div class="quote static"><div>${esc(m.text)}</div></div>
    <div class="list">${S.chats.map((c) => `
      <label class="pick">
        <input type="checkbox" value="${esc(c.id)}">
        <span class="avatar small">${esc(initials(c.title))}</span>
        <span>${esc(c.title)}</span>
      </label>`).join('') || '<p class="nochats">No chats yet.</p>'}</div>
    <button class="primary" id="doForward">Forward</button>`);
  $('doForward').onclick = async () => {
    const ids = [...$('mBody').querySelectorAll('input:checked')].map((i) => i.value);
    if (!ids.length) return toast('Pick at least one chat');
    try {
      await api('POST', `/api/messages/${m.id}/forward`, { chatIds: ids });
      closeModal();
      toast(`Forwarded to ${ids.length} chat${ids.length > 1 ? 's' : ''}`);
      await loadChats();
      if (S.chat && ids.includes(S.chat.id)) await loadMessages();
    } catch (err) { toast(err.message); }
  };
}

async function openNewChat() {
  const users = await api('GET', '/api/users');
  openModal('New chat', `<div class="list">${users.map((u) => `
    <div class="pick" data-uid="${esc(u.id)}">
      <span class="avatar small">${esc(initials(u.name))}</span>
      <span>${esc(u.name)}<small>+${esc(u.phone)}</small></span>
    </div>`).join('') || '<p class="nochats">No other accounts yet. Log in on another laptop first.</p>'}</div>`);
  $('mBody').onclick = async (e) => {
    const el = e.target.closest('[data-uid]');
    if (!el) return;
    try {
      const chat = await api('POST', '/api/chats', { userId: el.dataset.uid });
      closeModal();
      await loadChats();
      openChat(chat.id);
    } catch (err) { toast(err.message); }
  };
}

async function openNewGroup() {
  const users = await api('GET', '/api/users');
  openModal('New group', `
    <input id="gName" maxlength="60" placeholder="Group name">
    <div class="list">${users.map((u) => `
      <label class="pick">
        <input type="checkbox" value="${esc(u.id)}">
        <span class="avatar small">${esc(initials(u.name))}</span>
        <span>${esc(u.name)}</span>
      </label>`).join('')}</div>
    <button class="primary" id="gCreate">Create group</button>`);
  $('gCreate').onclick = async () => {
    const memberIds = [...$('mBody').querySelectorAll('input[type=checkbox]:checked')].map((i) => i.value);
    try {
      const chat = await api('POST', '/api/chats', { type: 'group', name: $('gName').value, memberIds });
      closeModal();
      await loadChats();
      openChat(chat.id);
    } catch (err) { toast(err.message); }
  };
}

// ---------- wiring ----------
$('newChatBtn').onclick = () => openNewChat().catch((e) => toast(e.message));
$('newGroupBtn').onclick = () => openNewGroup().catch((e) => toast(e.message));
$('logoutBtn').onclick = logout;
$('search').oninput = renderChats;
$('chatList').onclick = (e) => {
  const el = e.target.closest('.chatitem');
  if (el) openChat(el.dataset.id);
};
$('backBtn').onclick = () => document.body.classList.remove('chat-open');

$('composer').onsubmit = (e) => { e.preventDefault(); send(); };
$('input').onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
};
$('input').oninput = () => { autosize(); typingPing(); };

$('replyBar').onclick = () => {
  if (S.editing) { S.editing = null; $('input').value = ''; autosize(); }
  S.reply = null;
  renderComposer();
};

$('messages').onclick = (e) => {
  const btn = e.target.closest('.menu-btn');
  if (btn) {
    const r = btn.getBoundingClientRect();
    const row = btn.closest('[data-id]');
    const m = S.messages.find((x) => x.id === row.dataset.id);
    if (m) openMenu(m, r.left, r.bottom);
    return;
  }
  const q = e.target.closest('.quote');
  if (q) {
    const el = document.querySelector(`.row[data-id="${CSS.escape(q.dataset.jump)}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1200);
    }
  }
};

$('messages').oncontextmenu = (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  e.preventDefault();
  const m = S.messages.find((x) => x.id === row.dataset.id);
  if (m) openMenu(m, e.clientX, e.clientY);
};

$('mClose').onclick = closeModal;
$('modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };

document.addEventListener('click', (e) => {
  if (!e.target.closest('#ctxmenu, .menu-btn')) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeMenu(); closeModal(); }
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && S.chat) markRead();
});
