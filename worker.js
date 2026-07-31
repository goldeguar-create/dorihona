// ============================================================
// PharmaCare — Telegram Notify Worker
// ============================================================
// Bu kod SERVERDA (Cloudflare Workers) ishlaydi, brauzerda EMAS.
// Shuning uchun TELEGRAM_BOT_TOKEN hech qachon foydalanuvchiga
// ko'rinmaydi — Developer Tools, "View Source", Network tab —
// hech biridan ko'rinmaydi.
//
// O'RNATISH (5 daqiqa, bepul):
// 1) https://dash.cloudflare.com ga kiring (akkaunt yo'q bo'lsa - ro'yxatdan o'ting, bepul)
// 2) Chap menyudan "Workers & Pages" -> "Create" -> "Create Worker"
// 3) Workerga nom bering, masalan: pharmacare-notify
// 4) "Deploy" tugmasini bosing (bo'sh shablon bilan)
// 5) "Edit code" tugmasini bosing, ochilgan editordagi hamma
//    kodni o'chirib, shu faylning TO'LIQ mazmunini joylashtiring
// 6) Yuqori o'ng burchakdagi "Settings" -> "Variables and Secrets" bo'limiga o'ting
// 7) Quyidagi ikkita maxfiy o'zgaruvchini qo'shing (Type: "Secret" tanlang!):
//      TELEGRAM_BOT_TOKEN   = sizning bot tokeningiz (masalan 7880982758:AAH...)
//      TELEGRAM_CHAT_IDS    = 8480297110,BOSHQA_CHAT_ID  (vergul bilan, bo'sh joysiz)
// 8) "Deploy" tugmasini yana bosing
// 9) Sizga shunday manzil beriladi:
//      https://pharmacare-notify.<sizning-subdomen>.workers.dev
//    Shu manzilni frontend.js faylidagi BACKEND_URL ga qo'ying.
//
// MUHIM: token endi bu faylda YOZILMAYDI — u Cloudflare'ning
// "Secret" saqlagichida turadi va hech kimga (sizga ham) qayta
// ko'rsatilmaydi, faqat serverga kod ishlash vaqtida ulanadi.
// ============================================================

export default {
  async fetch(request, env) {
    // CORS — saytingiz shu Workerga so'rov yubora olishi uchun
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*", // xohlasangiz o'z domeningiz bilan cheklang
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const token = env.TELEGRAM_BOT_TOKEN;
    const chatIdsRaw = env.TELEGRAM_CHAT_IDS || "";
    const chatIds = chatIdsRaw.split(",").map((s) => s.trim()).filter(Boolean);

    if (!token || chatIds.length === 0) {
      return new Response(
        JSON.stringify({ ok: false, error: "Server sozlanmagan (token/chat_id yo'q)" }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "Noto'g'ri so'rov" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const text = buildOrderText(body);
    if (!text) {
      return new Response(JSON.stringify({ ok: false, error: "Buyurtma ma'lumotlari yetarli emas" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const results = await Promise.all(
      chatIds.map((chatId) =>
        fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text }),
        }).then((r) => r.json())
      )
    );

    const anyOk = results.some((r) => r.ok);

    return new Response(JSON.stringify({ ok: anyOk, results }), {
      status: anyOk ? 200 : 502,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  },
};

// Buyurtma obyektidan Telegram xabar matnini yasaydi.
// Frontend faqat buyurtma ma'lumotlarini yuboradi — token bilan
// hech qanday ishi yo'q.
function buildOrderText(order) {
  const { id, customer, phone, address, payment, total, items } = order || {};
  if (!id || !customer || !phone) return null;

  const itemsText = Array.isArray(items)
    ? items.map((i) => `• ${i.name} x${i.qty} — ${i.price}`).join("\n")
    : "";

  return (
    `🆕 Yangi buyurtma — PharmaCare\n` +
    `🧾 Raqam: ${id}\n` +
    `👤 Mijoz: ${customer}\n` +
    `📞 Tel: ${phone}\n` +
    `📍 Manzil: ${address || "-"}\n` +
    `💳 To'lov: ${payment || "-"}\n` +
    `${itemsText}\n` +
    `💰 Jami: ${total || "-"}`
  );
}