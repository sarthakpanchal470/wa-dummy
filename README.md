# WA Dummy

A WhatsApp-style messenger you can run on your own network. It has real-time delivery between laptops, a REST API, and a bot example. Use it to build and demo an AI that answers customers, without touching the real WhatsApp.

No npm install is needed. Requires **Node.js 18 or newer** (check with `node -v`).

```
wa-dummy/
├── server.js            the server: API, live events, storage
├── public/              the WhatsApp-style web app (index.html, style.css, app.js)
├── examples/shop-bot.js example AI bot that reads customer messages and replies
├── data/db.json         created on first run (all chats and users are stored here)
└── package.json
```

## 1. Run it on two laptops

One laptop runs the server. Both laptops use the browser.

1. On **Laptop A** (the server, the shop), open a terminal in the `wa-dummy` folder and run:
   ```
   node server.js
   ```
   It prints something like:
   ```
   This laptop:        http://localhost:3000
   Other laptops:      http://192.168.1.25:3000
   Shop account:       My Shop  (log in with phone 9999999999)
   API key for your AI: wa_xxxxxxxxxxxxxxxxxxxxxxxx
   ```
2. Laptop A opens `http://localhost:3000` and logs in with phone `9999999999`. This is the shop account.
3. **Laptop B** (the customer) must be on the same Wi-Fi. Open the "Other laptops" address, for example `http://192.168.1.25:3000`, and log in with any name and a different phone number, such as `9876543210`.
4. On Laptop B, click **＋**, choose **My Shop**, and send a message. It appears on Laptop A immediately.

**Windows:** the first time, Windows may ask whether to allow Node.js through the firewall. Tick **Private networks** and allow it. If Laptop B cannot connect, that firewall prompt is the usual cause.

**Testing on one laptop:** open two browser windows (for example, a normal window and an incognito window). Each tab keeps its own login, so you can be the shop in one and the customer in the other.

To change the shop name or phone number, set environment variables before starting:
```
SHOP_NAME="Sharma Kirana" SHOP_PHONE=9123456780 node server.js
```
To reset everything, stop the server and delete the `data` folder.

## 2. Features

| Feature | How it works |
|---|---|
| Live messages | Delivered to the other laptop in under a second, no refresh |
| Ticks | ✓ sent, ✓✓ grey delivered, ✓✓ blue read |
| Typing… and online / last seen | Shown in the chat header |
| Reply | Quotes the original message |
| Edit | Sender only, within 15 minutes, shows "edited" |
| Delete for me | Hides the message for you only |
| Delete for everyone | Sender only, the message becomes "This message was deleted" for all |
| React | 👍 ❤️ 😂 😮 😢 🙏, one reaction per person, tap again to remove |
| Forward | To one or more chats, marked "Forwarded" |
| Groups | Create a group from the 👥 button. Messages show the sender's name |
| Unread counts and search | Chat list badges and a search box |

Message menu: hover over a message and click ⌄, or right-click it.

## 3. API reference (for your AI project)

Base URL: `http://<server-laptop-ip>:3000/api`

**Authentication:** send `Authorization: Bearer <KEY>` on every request.
- Use the **API key** printed at startup to act as the **shop account**. Your AI should use this.
- Logged-in browser users get a session token from `POST /api/login`.

The API key is saved in `data/db.json`. You can also set your own with `API_KEY=... node server.js`. Keep it private, because it gives full access to the shop account.

| Method | Path | Body | What it does |
|---|---|---|---|
| POST | `/login` | `{name, phone}` | Log in as a person. Returns `{token, user}` |
| GET | `/me` | | The account this key or token belongs to |
| GET | `/users` | | All accounts (`id`, `name`, `phone`, `online`) |
| GET | `/chats` | | Chat list with `unread`, `lastMessage`, `title`, `members` |
| POST | `/chats` | `{userId}` for a direct chat, or `{type:"group", name, memberIds}` | Opens or creates a chat |
| GET | `/chats/:id/messages` | | The last 300 messages in a chat |
| POST | `/chats/:id/messages` | `{text, replyTo?}` | Send a message. Returns the message |
| POST | `/chats/:id/read` | | Mark the chat as read (blue ticks) |
| POST | `/chats/:id/typing` | | Show "typing…" to the other people in the chat |
| POST | `/delivered` | | Mark all incoming messages as delivered |
| PATCH | `/messages/:id` | `{text}` | Edit your message (within 15 minutes) |
| DELETE | `/messages/:id?scope=me` | | Delete for you only |
| DELETE | `/messages/:id?scope=everyone` | | Delete for everyone (sender only) |
| POST | `/messages/:id/react` | `{emoji}` | Add or remove a reaction |
| POST | `/messages/:id/forward` | `{chatIds: [...]}` | Forward to other chats |
| GET | `/events` | | Live event stream (Server-Sent Events) |

**Live events** from `/api/events` are sent as `event:` and `data:` lines:
- `message:new` a new message, including messages sent by others to this account
- `message:update` an edit, delete, or reaction
- `receipt` read or delivered status changed
- `chat:new` added to a new chat or group
- `typing`, `presence`, `hello`

A chat ID is returned by `GET /chats` or `POST /chats`. To message a phone number, first find the person with `GET /users` (match on `phone`), then call `POST /chats` with their `userId`.

### Quick examples

Terminal:
```bash
KEY=wa_xxxxxxxx
BASE=http://192.168.1.25:3000/api

curl -s $BASE/chats -H "Authorization: Bearer $KEY"

curl -s -X POST $BASE/chats/CHAT_ID/messages \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"text":"Yes, we have flour. 12 kg at ₹60/kg."}'
```

Python (for example, in your AI project):
```python
import requests

BASE = "http://192.168.1.25:3000/api"
KEY = "wa_xxxxxxxx"                       # the API key printed by server.js
H = {"Authorization": f"Bearer {KEY}"}

# Send a message to a customer by phone number
users = requests.get(f"{BASE}/users", headers=H).json()
customer = next(u for u in users if u["phone"] == "9876543210")
chat = requests.post(f"{BASE}/chats", headers=H, json={"userId": customer["id"]}).json()
requests.post(f"{BASE}/chats/{chat['id']}/messages", headers=H,
              json={"text": "Yes, we have rice. 25 kg in stock."})
```

Node.js: `examples/shop-bot.js` is a full auto-reply loop that listens to `/api/events`. Run it while the server is running:
```
node examples/shop-bot.js http://localhost:3000 wa_xxxxxxxx
```
Then from the customer laptop, send "do you have flour?". The bot replies within a few seconds. Replace `answerFor()` in that file with calls to your AI model and your stock system.

## 4. Notes

- **This is a demo.** Phone-number login has no password, and the API key gives full access. Use it only on a trusted network, and don't expose port 3000 to the internet.
- **Storage** is one JSON file, which is fine for demos. For a real product, move it to a database such as SQLite or Postgres.
- **Real WhatsApp** is different. The official way to connect an AI to WhatsApp is the WhatsApp Business Platform (Cloud API). It needs a Meta business account, a verified business number, and a public HTTPS webhook. Automating the WhatsApp Web app, for example with unofficial libraries, breaks WhatsApp's terms of service and can get numbers banned. The API in this project has the same shape as what your AI needs, so the AI logic will carry over when you switch to the official API.
