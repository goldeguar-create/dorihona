



/*
  BU FAYL CLOUDFLARE WORKER'DA ISHLAYDI.
  Bot tokeni bu yerda YOZILMAYDI — u alohida "Secret" sifatida saqlanadi.
 
  Kerakli secretlar:
    TELEGRAM_BOT_TOKEN
    TELEGRAM_BOT_USERNAME   (@ belgisisiz)
    TELEGRAM_ADMIN_CHAT_ID  (ixtiyoriy — admin xabarnomasi uchun)
 
  Kerakli KV: KV
 
  ================= YANGI OQIM (v3) =================
  Endi buyurtma FAQAT foydalanuvchi botni oldindan ochib "/start" bosgan
  bo'lsa yaratiladi. Oqim:
 
    1. Sayt /create-session chaqiradi -> sessionId qaytadi
    2. Foydalanuvchi botni ochadi (/start session_<sessionId>)
       -> webhook orqali sessiya "connected" bo'ladi, chatId saqlanadi
    3. Sayt /session-status orqali holatni kuzatadi. "connected" bo'lgach,
       foydalanuvchiga buyurtma formasi ko'rsatiladi (ismi, manzili)
    4. Sayt /create-order chaqiradi (sessionId bilan) -> chatId allaqachon
       ma'lum bo'lgani uchun bot DARHOL o'sha odamga buyurtma tafsilotlari
       va Ha/Yo'q tugmalarini yuboradi (yana /start kerak emas)
    5. Foydalanuvchi Ha/Yo'q bosadi -> /order-status orqali sayt ko'radi
 
  Bu orqali: botni ochmagan odam UMUMAN buyurtma bera olmaydi — chunki
  /create-order chaqirilishidan oldin ulanish shart.
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
 
/* --- 1. Yangi sessiya yaratish (botga ulanishdan oldin) --- */
async function createSession(env, cors) {
  const sessionId = randomId();
  await env.KV.put(
    "session:" + sessionId,
    JSON.stringify({ status: "waiting", createdAt: Date.now() }),
    { expirationTtl: 900 } // 15 daqiqa amal qiladi
  );
 
  const botLink = `https://t.me/${env.TELEGRAM_BOT_USERNAME}?start=session_${sessionId}`;
  return json({ ok: true, sessionId, botLink }, 200, cors);
}
 
/* --- 2. Sayt sessiya holatini kuzatadi --- */
async function sessionStatus(url, env, cors) {
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) return json({ ok: false, error: "sessionId kerak" }, 400, cors);
 
  const raw = await env.KV.get("session:" + sessionId);
  if (!raw) return json({ ok: false, error: "Sessiya topilmadi yoki muddati tugagan" }, 404, cors);
 
  const data = JSON.parse(raw);
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
 
  const rawSession = await env.KV.get("session:" + sessionId);
  if (!rawSession) return json({ ok: false, error: "Sessiya topilmadi yoki muddati tugagan" }, 404, cors);
 
  const session = JSON.parse(rawSession);
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
 
  await env.KV.put("order:" + orderId, JSON.stringify(orderData), { expirationTtl: 3600 });
 
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
 
  const raw = await env.KV.get("order:" + orderId);
  if (!raw) return json({ ok: false, error: "Buyurtma topilmadi yoki muddati tugagan" }, 404, cors);
 
  const data = JSON.parse(raw);
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
    const raw = await env.KV.get("session:" + sessionId);
    if (!raw) {
      await tgApi(env, "sendMessage", {
        chat_id: chatId,
        text: "Kechirasiz, bu havola muddati tugagan. Saytga qaytib qayta urinib ko'ring.",
      });
      return new Response("ok");
    }
 
    const session = JSON.parse(raw);
    session.status = "connected";
    session.chatId = chatId;
    session.username = username;
    await env.KV.put("session:" + sessionId, JSON.stringify(session), { expirationTtl: 900 });
 
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
 
    const raw = await env.KV.get("order:" + orderId);
    if (raw) {
      const orderData = JSON.parse(raw);
      orderData.status = action === "confirm" ? "confirmed" : "declined";
      await env.KV.put("order:" + orderId, JSON.stringify(orderData), { expirationTtl: 3600 });
 
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
 













