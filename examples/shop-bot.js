/*
 * Example auto-reply bot for WA Dummy, acting as the shop account.
 *
 *   node examples/shop-bot.js http://localhost:3000 <API_KEY>
 *
 * It listens to the live event stream, reads each new customer message and replies.
 * Replace answerFor() with calls to your real AI model and stock/inventory system.
 */
const BASE = process.argv[2] || 'http://localhost:3000';
const KEY = process.argv[3] || process.env.API_KEY;
if (!KEY) {
  console.error('Usage: node examples/shop-bot.js <server-url> <api-key>');
  process.exit(1);
}
const headers = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

// Demo inventory. In your project this comes from the shop's real stock data.
const STOCK = {
  flour: { price: 60, qty: 12, unit: 'kg' },
  rice: { price: 55, qty: 0, unit: 'kg' },
  sugar: { price: 45, qty: 8, unit: 'kg' },
};

function answerFor(text) {
  const t = text.toLowerCase();
  for (const [item, s] of Object.entries(STOCK)) {
    if (!t.includes(item)) continue;
    return s.qty > 0
      ? `Yes, we have ${item}. ${s.qty} ${s.unit} available at ₹${s.price}/${s.unit}.`
      : `Sorry, ${item} is out of stock right now.`;
  }
  return 'Thanks for your message! We will get back to you shortly.';
}

async function api(method, path, body) {
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${method} ${path} failed with ${r.status}`);
  return r.status === 204 ? null : r.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function handle(m, me) {
  if (m.senderId === me.id) return;                      // never answer our own messages
  console.log(`[${m.senderName}] ${m.text}`);
  await api('POST', '/api/delivered');
  await api('POST', `/api/chats/${m.chatId}/read`);
  await api('POST', `/api/chats/${m.chatId}/typing`);
  await sleep(1500);                                      // look a little human
  const sent = await api('POST', `/api/chats/${m.chatId}/messages`, { text: answerFor(m.text) });
  console.log(`  -> ${sent.text}`);
}

async function listen(me) {
  const res = await fetch(`${BASE}/api/events`, { headers });
  if (!res.ok) throw new Error(`Event stream refused (${res.status}). Check the API key.`);
  console.log('Connected. Waiting for customer messages...');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error('Event stream closed');
    buf += decoder.decode(value, { stream: true });
    let end;
    while ((end = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, end);
      buf = buf.slice(end + 2);
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (event === 'message:new' && data) {
        handle(JSON.parse(data), me).catch((e) => console.error('Reply failed:', e.message));
      }
    }
  }
}

(async function main() {
  for (;;) {
    try {
      const me = await api('GET', '/api/me');
      console.log(`Logged in as "${me.name}"`);
      await listen(me);
    } catch (err) {
      console.error(err.message, '- retrying in 3 seconds');
      await sleep(3000);
    }
  }
})();
