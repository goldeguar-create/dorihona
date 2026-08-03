/*
  BU FAYL CLOUDFLARE WORKER'DA ISHLAYDI.
  Bot tokeni bu yerda YOZILMAYDI — u alohida "Secret" sifatida saqlanadi.

  Kerakli secretlar:
    TELEGRAM_BOT_TOKEN
    TELEGRAM_BOT_USERNAME   (@ belgisisiz)
    TELEGRAM_ADMIN_CHAT_ID  (ixtiyoriy — admin xabarnomasi uchun)

  Kerakli Durable Object binding: SESSION_STORE (class SessionStore,
  shu faylning pastki qismida e'lon qilingan)

  ================= NEGA KV EMAS, DURABLE OBJECT? =================
  Cloudflare KV "eventual consistency" tizimi — yozilgan ma'lumot
  barcha data-markazlarga darhol emas, balki bir necha soniyadan
  60 soniyagacha tarqaladi. Shu sabab bot "connected" deb yozgandan
  keyin ham sayt buni darrov ko'rmasligi mumkin edi.

  Durable Object — bitta global "joy"da ishlaydigan yagona obyekt.
  Yozish ham, o'qish ham shu bitta joydan o'tadi, shuning uchun
  hech qanday tarqalish kechikishi bo'lmaydi — o'zgarish DARHOL
  ko'rinadi.

  ================= OQIM (v4, Durable Object) =================
    1. Sayt /create-session chaqiradi -> sessionId qaytadi
    2. Foydalanuvchi botni ochadi (/start session_<sessionId>)
       -> webhook orqali sessiya "connected" bo'ladi (DARHOL)
    3. Sayt /session-status orqali holatni kuzatadi — kechikishsiz
    4. Sayt /create-order chaqiradi (sessionId bilan) -> chatId
       allaqachon ma'lum bo'lgani uchun bot DARHOL o'sha odamga
       buyurtma tafsilotlari va Ha/Yo'q tugmalarini yuboradi
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
    const store = getStore(env);

    if (request.method === "POST" && url.pathname.endsWith("/create-session")) {
      return createSession(env, store, cors);
    }
    if (request.method === "GET" && url.pathname.endsWith("/session-status")) {
      return sessionStatus(url, store, cors);
    }
    if (request.method === "POST" && url.pathname.endsWith("/create-order")) {
      return createOrder(request, env, store, cors);
    }
    if (request.method === "GET" && url.pathname.endsWith("/order-status")) {
      return orderStatus(url, store, cors);
    }
    if (request.method === "POST" && url.pathname.endsWith("/tg-webhook")) {
      return tgWebhook(request, env, store);
    }

    return json({ ok: false, error: "Not found" }, 404, cors);
  },
};

/* ================= YORDAMCHI FUNKSIYALAR ================= */

function getStore(env) {
  // Har doim BITTA global Durable Object'ga murojaat qilamiz —
  // shu orqali barcha sessiya/buyurtmalar bitta joyda, darhol
  // izchil (consistent) holatda saqlanadi.
  const id = env.SESSION_STORE.idFromName("global");
  return env.SESSION_STORE.get(id);
}

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

/* Durable Object bilan gaplashish uchun kichik yordamchilar */

async function doGet(store, path) {
  const res = await store.fetch("https://do/" + path);
  if (res.status === 404) return null;
  return res.json();
}

async function doPost(store, path, body) {
  const res = await store.fetch("https://do/" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return res.json();
}

/* --- 1. Yangi sessiya yaratish (botga ulanishdan oldin) --- */
async function createSession(env, store, cors) {
  const sessionId = randomId();
  await doPost(store, "session/" + sessionId, {});

  const botLink = `https://t.me/${env.TELEGRAM_BOT_USERNAME}?start=session_${sessionId}`;
  return json({ ok: true, sessionId, botLink }, 200, cors);
}

/* --- 2. Sayt sessiya holatini kuzatadi --- */
async function sessionStatus(url, store, cors) {
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) return json({ ok: false, error: "sessionId kerak" }, 400, cors);

  const data = await doGet(store, "session/" + sessionId);
  if (!data || !data.ok) {
    return json({ ok: false, error: "Sessiya topilmadi yoki muddati tugagan" }, 404, cors);
  }

  const s = data.session;
  return json({ ok: true, status: s.status, username: s.username || null }, 200, cors);
}

/* --- 3. Buyurtma yaratish — FAQAT ulangan sessiya bilan --- */
async function createOrder(request, env, store, cors) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "JSON xato" }, 400, cors);
  }

  const sessionId = body.sessionId;
  if (!sessionId) return json({ ok: false, error: "Avval botga ulaning" }, 400, cors);

  const data = await doGet(store, "session/" + sessionId);
  if (!data || !data.ok) {
    return json({ ok: false, error: "Sessiya topilmadi yoki muddati tugagan" }, 404, cors);
  }

  const session = data.session;
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
  };

  await doPost(store, "order/" + orderId, orderData);

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

  // ADMINGA DARHOL XABAR — mijoz "Ha" bosishini kutmasdan, buyurtma
  // berilgan zahoti to'liq ma'lumot bilan yuboriladi.
  if (env.TELEGRAM_ADMIN_CHAT_ID) {
    const adminText =
      `🆕 YANGI BUYURTMA (tasdiqlash kutilmoqda)\n\n` +
      `🆔 Buyurtma ID: ${orderId}\n` +
      `👤 Ism: ${orderData.name}\n` +
      `📍 Manzil: ${orderData.address}\n\n` +
      `🛒 Mahsulotlar:\n${itemsText}\n\n` +
      `💰 Jami: ${orderData.total} so'm\n\n` +
      `🔢 Telegram chat ID: ${orderData.chatId}\n` +
      `🔗 Telegram username: ${orderData.username ? "@" + orderData.username : "(username yo'q)"}`;

    await tgApi(env, "sendMessage", {
      chat_id: env.TELEGRAM_ADMIN_CHAT_ID,
      text: adminText,
    });
  }

  return json({ ok: true, orderId }, 200, cors);
}

/* --- 4. Sayt buyurtma holatini kuzatadi --- */
async function orderStatus(url, store, cors) {
  const orderId = url.searchParams.get("orderId");
  if (!orderId) return json({ ok: false, error: "orderId kerak" }, 400, cors);

  const data = await doGet(store, "order/" + orderId);
  if (!data || !data.ok) {
    return json({ ok: false, error: "Buyurtma topilmadi yoki muddati tugagan" }, 404, cors);
  }

  return json({ ok: true, status: data.order.status }, 200, cors);
}

/* --- 5. Telegram webhook --- */
async function tgWebhook(request, env, store) {
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
        text: "Salom! Buyurtma berish uchun saytdagi https://goldeguar-create.github.io/dorihona/ tugmasini bosing.",
      });
      return new Response("ok");
    }

    const sessionId = payload.replace("session_", "");
    const data = await doGet(store, "session/" + sessionId);
    if (!data || !data.ok) {
      await tgApi(env, "sendMessage", {
        chat_id: chatId,
        text: "Kechirasiz, bu havola muddati tugagan. Saytga qaytib qayta urinib ko'ring.",
      });
      return new Response("ok");
    }

    await doPost(store, "session/" + sessionId + "/connect", { chatId, username });

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

    const data = await doGet(store, "order/" + orderId);
    if (data && data.ok) {
      const newStatus = action === "confirm" ? "confirmed" : "declined";
      const result = await doPost(store, "order/" + orderId + "/status", { status: newStatus });
      const orderData = result.order;

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

/* ================= DURABLE OBJECT ================= */
/*
  Bitta global obyekt sifatida ishlaydi: barcha sessiya va buyurtma
  ma'lumotlari shu obyekt ichida, xotirada (tez) va disk-storage'da
  (doimiy) saqlanadi. Yozish/o'qish ketma-ket, bitta joyda bajarilgani
  uchun KV'dagi kabi "tarqalish kechikishi" umuman yo'q.
*/
export class SessionStore {
  constructor(state) {
    this.state = state;
  }

  isExpired(createdAt, ttlMs) {
    return Date.now() - createdAt > ttlMs;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // ["session", id] yoki ["session", id, "connect"]

    const respond = (body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    if (parts[0] === "session") {
      const id = parts[1];
      const key = "session:" + id;

      if (request.method === "POST" && parts.length === 2) {
        // Har bir sessiya O'ZINING alohida kalitiga yoziladi — boshqa
        // qurilma/sessiya bir vaqtda yozsa ham hech narsani "bosib
        // ketmaydi" (avvalgi to'liq-ro'yxat dizaynida shu muammo bor edi).
        await this.state.storage.put(key, { status: "waiting", createdAt: Date.now() });
        return respond({ ok: true });
      }

      if (request.method === "GET" && parts.length === 2) {
        const s = await this.state.storage.get(key);
        if (!s || this.isExpired(s.createdAt, 15 * 60 * 1000)) {
          if (s) await this.state.storage.delete(key);
          return respond({ ok: false, error: "not found" }, 404);
        }
        return respond({ ok: true, session: s });
      }

      if (request.method === "POST" && parts[2] === "connect") {
        const body = await request.json();
        const s = await this.state.storage.get(key);
        if (!s || this.isExpired(s.createdAt, 15 * 60 * 1000)) {
          return respond({ ok: false, error: "not found" }, 404);
        }
        s.status = "connected";
        s.chatId = body.chatId;
        s.username = body.username || null;
        await this.state.storage.put(key, s);
        return respond({ ok: true });
      }
    }

    if (parts[0] === "order") {
      const id = parts[1];
      const key = "order:" + id;

      if (request.method === "POST" && parts.length === 2) {
        const body = await request.json();
        await this.state.storage.put(key, { ...body, createdAt: Date.now() });
        return respond({ ok: true });
      }

      if (request.method === "GET" && parts.length === 2) {
        const o = await this.state.storage.get(key);
        if (!o || this.isExpired(o.createdAt, 60 * 60 * 1000)) {
          return respond({ ok: false, error: "not found" }, 404);
        }
        return respond({ ok: true, order: o });
      }

      if (request.method === "POST" && parts[2] === "status") {
        const body = await request.json();
        const o = await this.state.storage.get(key);
        if (!o) return respond({ ok: false, error: "not found" }, 404);
        o.status = body.status;
        await this.state.storage.put(key, o);
        return respond({ ok: true, order: o });
      }
    }

    return respond({ ok: false, error: "unknown route" }, 404);
  }
}