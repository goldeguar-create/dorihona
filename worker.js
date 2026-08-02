/*
  BU FAYL CLOUDFLARE WORKER'DA ISHLAYDI.
  Bot tokeni bu yerda YOZILMAYDI — u alohida "Secret" sifatida saqlanadi.

  Kerakli secretlar:
    TELEGRAM_BOT_TOKEN
    TELEGRAM_BOT_USERNAME   (@ belgisisiz)
    TELEGRAM_ADMIN_CHAT_ID  (ixtiyoriy — admin xabarnomasi uchun)

  Kerakli binding: STORE (Durable Object, class_name = "Store")
  KV endi KERAK EMAS — quyida tushuntirilgan sababga ko'ra Durable
  Object bilan almashtirildi.

  ================= NEGA KV EMAS, DURABLE OBJECT =================
  Avvalgi versiyada sessiya/buyurtma holati Cloudflare KV'da saqlangan
  edi. KV yozuvlari esa "eventually consistent" — ya'ni bitta joyda
  yozilgan qiymat boshqa Cloudflare tugunlarida darhol ko'rinmaydi,
  bu holat hattoki ~60 soniyagacha davom etishi mumkin. Amalda bu
  "botga ulandim, lekin sayt hali ham 'kutilmoqda' deb turibdi"
  muammosiga olib kelgan — chunki bot yozgan yangilanishni sayt
  o'qiyotgan so'rov hali ko'rmagan bo'lishi mumkin edi.

  Durable Object esa har bir sessiya/buyurtma uchun bitta yagona,
  izchil (strongly consistent) joyda ishlaydi: yozilgan narsa keyingi
  o'qishda DARHOL ko'rinadi, hech qanday tarqalish kechikishisiz.

  ================= OQIM (o'zgarishsiz, v3) =================
    1. Sayt /create-session chaqiradi -> sessionId qaytadi
    2. Foydalanuvchi botni ochadi (/start session_<sessionId>)
       -> webhook orqali sessiya "connected" bo'ladi, chatId saqlanadi
    3. Sayt /session-status orqali holatni kuzatadi. "connected" bo'lgach,
       foydalanuvchiga buyurtma formasi ko'rsatiladi (ismi, manzili)
    4. Sayt /create-order chaqiradi (sessionId bilan) -> chatId allaqachon
       ma'lum bo'lgani uchun bot DARHOL o'sha odamga buyurtma tafsilotlari
       va Ha/Yo'q tugmalarini yuboradi (yana /start kerak emas)
    5. Foydalanuvchi Ha/Yo'q bosadi -> /order-status orqali sayt ko'radi
*/

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname.endsWith("/create-session")) {
      return createSession(env, cors);
    }
    if (request.method === "GET" && url.pathname.endsWith("/session-status")) {
      return sessionStatus(url, env, cors);
    }
    if (request.method === "POST" && url.pathname.endsWith("/create-order")) {
      return createOrder(request, env, cors);
    }
    if (request.method === "GET" && url.pathname.endsWith("/order-status")) {
      return orderStatus(url, env, cors);
    }
    if (request.method === "POST" && url.pathname.endsWith("/tg-webhook")) {
      return tgWebhook(request, env);
    }

    return json({ ok: false, error: "Not found" }, 404, cors);
  },
};

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function randomId() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

async function tgApi(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

/* ================= Durable Object storage helpers =================
   Har bir "key" (masalan "session:abc123" yoki "order:xyz789") o'ziga
   xos Durable Object nusxasiga mos keladi — shu tufayli yozish va
   o'qish har doim bitta joyda, kechikishsiz sodir bo'ladi. */

function storeStub(env, key) {
  const id = env.STORE.idFromName(key);
  return env.STORE.get(id);
}

async function storePut(env, key, data, ttlSeconds) {
  const stub = storeStub(env, key);
  await stub.fetch("https://do/", {
    method: "PUT",
    body: JSON.stringify({ data, ttl: ttlSeconds }),
  });
}

async function storeGet(env, key) {
  const stub = storeStub(env, key);
  const res = await stub.fetch("https://do/", { method: "GET" });
  return res.json(); // null agar topilmasa yoki muddati tugagan bo'lsa
}

async function storePatch(env, key, patch, ttlSeconds) {
  const stub = storeStub(env, key);
  const res = await stub.fetch("https://do/", {
    method: "PATCH",
    body: JSON.stringify({ patch, ttl: ttlSeconds }),
  });
  return res.json();
}

/* --- 1. Yangi sessiya yaratish (botga ulanishdan oldin) --- */
async function createSession(env, cors) {
  const sessionId = randomId();
  await storePut(
    env,
    "session:" + sessionId,
    { status: "waiting", createdAt: Date.now() },
    900 // 15 daqiqa amal qiladi
  );

  const botLink = `https://t.me/${env.TELEGRAM_BOT_USERNAME}?start=session_${sessionId}`;
  return json({ ok: true, sessionId, botLink }, 200, cors);
}

/* --- 2. Sayt sessiya holatini kuzatadi --- */
async function sessionStatus(url, env, cors) {
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) return json({ ok: false, error: "sessionId kerak" }, 400, cors);

  const data = await storeGet(env, "session:" + sessionId);
  if (!data) return json({ ok: false, error: "Sessiya topilmadi yoki muddati tugagan" }, 404, cors);

  return json(
    { ok: true, status: data.status, username: data.username || null },
    200,
    cors
  );
}

/* --- 3. Buyurtma yaratish — FAQAT ulangan sessiya bilan --- */
async function createOrder(request, env, cors) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "JSON xato" }, 400, cors);
  }

  const sessionId = body.sessionId;
  if (!sessionId) return json({ ok: false, error: "Avval botga ulaning" }, 400, cors);

  const session = await storeGet(env, "session:" + sessionId);
  if (!session) return json({ ok: false, error: "Sessiya topilmadi yoki muddati tugagan" }, 404, cors);

  if (session.status !== "connected" || !session.chatId) {
    return json({ ok: false, error: "Avval Telegram botga ulanishingiz kerak" }, 400, cors);
  }

  const orderId = randomId();
  const orderData = {
    status: "pending",
    name: body.name || "",
    address: body.address || "",
    items: body.items || [],
    total: body.total || 0,
    chatId: session.chatId,          // botga ulangan haqiqiy chat
    username: session.username || null,
    createdAt: Date.now(),
  };

  await storePut(env, "order:" + orderId, orderData, 3600);

  // chatId allaqachon ma'lum — bot darhol xabar yubora oladi, yana /start shart emas
  const itemsText = (orderData.items || []).map((i) => `• ${i.name} x${i.qty}`).join("\n");

  await tgApi(env, "sendMessage", {
    chat_id: session.chatId,
    text: `🧾 Buyurtma #${orderId}\n👤 ${orderData.name}\n📍 ${orderData.address}\n\n${itemsText}\n\n💰 Jami: ${orderData.total} so'm\n\nUshbu buyurtmani tasdiqlaysizmi?`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Ha, tasdiqlayman", callback_data: `confirm:${orderId}` },
          { text: "❌ Yo'q", callback_data: `decline:${orderId}` },
        ],
      ],
    },
  });

  return json({ ok: true, orderId }, 200, cors);
}

/* --- 4. Sayt buyurtma holatini kuzatadi --- */
async function orderStatus(url, env, cors) {
  const orderId = url.searchParams.get("orderId");
  if (!orderId) return json({ ok: false, error: "orderId kerak" }, 400, cors);

  const data = await storeGet(env, "order:" + orderId);
  if (!data) return json({ ok: false, error: "Buyurtma topilmadi yoki muddati tugagan" }, 404, cors);

  return json({ ok: true, status: data.status }, 200, cors);
}

/* --- 5. Telegram webhook --- */
async function tgWebhook(request, env) {
  const update = await request.json();

  if (update.message && update.message.text === "/myid") {
    await tgApi(env, "sendMessage", {
      chat_id: update.message.chat.id,
      text: `Sizning chat ID: ${update.message.chat.id}`,
    });
    return new Response("ok");
  }

  // foydalanuvchi botni ochib /start session_<id> bosdi
  if (update.message && update.message.text && update.message.text.startsWith("/start")) {
    const parts = update.message.text.split(" ");
    const payload = parts[1]; // "session_<id>"
    const chatId = update.message.chat.id;
    const username = update.message.from && update.message.from.username
      ? update.message.from.username
      : null;

    if (!payload || !payload.startsWith("session_")) {
      await tgApi(env, "sendMessage", {
        chat_id: chatId,
        text: "Salom! Buyurtma berish uchun saytdagi \"Telegram botni ulash\" tugmasini bosing.",
      });
      return new Response("ok");
    }

    const sessionId = payload.replace("session_", "");
    const existing = await storeGet(env, "session:" + sessionId);
    if (!existing) {
      await tgApi(env, "sendMessage", {
        chat_id: chatId,
        text: "Kechirasiz, bu havola muddati tugagan. Saytga qaytib qayta urinib ko'ring.",
      });
      return new Response("ok");
    }

    // Durable Object PATCH — yozilishi bilanoq keyingi o'qishda darhol ko'rinadi
    await storePatch(
      env,
      "session:" + sessionId,
      { status: "connected", chatId, username },
      900
    );

    await tgApi(env, "sendMessage", {
      chat_id: chatId,
      text: "✅ Ulanish muvaffaqiyatli! Endi saytga qaytib buyurtmangizni davom ettiring.",
    });

    return new Response("ok");
  }

  // Ha/Yo'q tugmasi bosildi
  if (update.callback_query) {
    const cq = update.callback_query;
    const [action, orderId] = (cq.data || "").split(":");

    const orderData = await storeGet(env, "order:" + orderId);
    if (orderData) {
      const newStatus = action === "confirm" ? "confirmed" : "declined";
      await storePatch(env, "order:" + orderId, { status: newStatus }, 3600);

      await tgApi(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: action === "confirm" ? "Rahmat, tasdiqlandi!" : "Buyurtma bekor qilindi.",
      });

      await tgApi(env, "editMessageText", {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        text:
          cq.message.text +
          (action === "confirm" ? "\n\n✅ TASDIQLANDI" : "\n\n❌ BEKOR QILINDI"),
      });

      if (action === "confirm" && env.TELEGRAM_ADMIN_CHAT_ID) {
        const itemsText = (orderData.items || []).map((i) => `• ${i.name} x${i.qty}`).join("\n");
        const summaryText =
          `✅ Yangi tasdiqlangan buyurtma!\n\n` +
          `🆔 Buyurtma ID: ${orderId}\n` +
          `👤 Ism: ${orderData.name}\n` +
          `🔗 Telegram: ${orderData.username ? "@" + orderData.username : "(username yo'q)"}\n` +
          `🔢 Chat ID: ${orderData.chatId}\n` +
          `📍 Manzil: ${orderData.address}\n\n` +
          `🛒 Mahsulotlar:\n${itemsText}\n\n` +
          `💰 Jami: ${orderData.total} so'm`;

        await tgApi(env, "sendMessage", {
          chat_id: env.TELEGRAM_ADMIN_CHAT_ID,
          text: summaryText,
        });
      }
    }

    return new Response("ok");
  }

  return new Response("ok");
}

/* ================= Durable Object klassi =================
   Bitta soddagina, umumiy maqsadli DO: JSON ma'lumotni saqlaydi,
   ixtiyoriy TTL (soniyalarda) bilan, muddati tugaganda alarm orqali
   o'zini tozalaydi. Sessiyalar ham, buyurtmalar ham shu bitta klass
   orqali ishlaydi (har biri o'z nomi bilan alohida nusxada). */
export class Store {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    if (request.method === "PUT") {
      const { data, ttl } = await request.json();
      await this.state.storage.put("data", data);
      if (ttl) await this.state.storage.setAlarm(Date.now() + ttl * 1000);
      return new Response("ok");
    }

    if (request.method === "PATCH") {
      const { patch, ttl } = await request.json();
      const current = (await this.state.storage.get("data")) || {};
      const merged = { ...current, ...patch };
      await this.state.storage.put("data", merged);
      if (ttl) await this.state.storage.setAlarm(Date.now() + ttl * 1000);
      return new Response(JSON.stringify(merged), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (request.method === "GET") {
      const data = await this.state.storage.get("data");
      return new Response(JSON.stringify(data ?? null), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("not found", { status: 404 });
  }

  // TTL tugaganda o'zini tozalaydi (KV'dagi expirationTtl o'rnini bosadi)
  async alarm() {
    await this.state.storage.deleteAll();
  }
}