/* =========================================================================
   Vercel Function: /api/chat
   Proxy do Groq API (model Llama 3.3 70B) ze streamingiem SSE.
   Klucz GROQ_API_KEY pozostaje po stronie serwera (zmienna środowiskowa).
   Body: { messages: [{ role: "user" | "bot", text }], language: "pl" | "en" }
   ========================================================================= */
import kbData from "../knowledge-base.json";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";
const MAX_MESSAGES = 30;
const MAX_TEXT_LEN = 4000;

/* ----- Rate limiting: maks. 10 żądań na minutę z jednego IP -----
   Okno przesuwne w pamięci instancji funkcji (best-effort: stan współdzielony
   tylko w obrębie „ciepłej" instancji, resetuje się przy cold-starcie). */
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 1000;
const ipHits = new Map();

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
  return (
    req.headers["x-real-ip"] ||
    (req.socket && req.socket.remoteAddress) ||
    "unknown"
  );
}

// Zwraca true, gdy IP przekroczyło limit; w przeciwnym razie rejestruje trafienie.
function isRateLimited(ip) {
  const now = Date.now();
  const recent = (ipHits.get(ip) || []).filter(function (t) {
    return now - t < RATE_WINDOW_MS;
  });
  if (recent.length >= RATE_LIMIT) {
    ipHits.set(ip, recent);
    return true;
  }
  recent.push(now);
  ipHits.set(ip, recent);
  return false;
}

/* ----- System prompt: ten sam co w app.js, ugruntowany w bazie wiedzy ----- */
const TONE_PL =
  'TON I STYL KOMUNIKACJI (obowiązkowe, bez wyjątków):\n' +
  '- Zawsze zwracaj się do klienta per "Pan/Pani" lub używaj form bezosobowych ("można", "należy", "jest możliwe").\n' +
  '- Nigdy nie używaj: "cześć", "hej", "siema", "super", "świetnie", "spoko", "ok", "okej", "jasne".\n' +
  '- Zamiast tego używaj: "Dzień dobry", "Oczywiście", "Rozumiem", "Chętnie pomogę", "Dziękuję za kontakt".\n' +
  '- Zdania kończ uprzejmie, np. "Czy mogę pomóc w czymś jeszcze?"\n' +
  '- Unikaj wykrzykników i emoji w odpowiedziach.\n' +
  '- Ton: profesjonalny, rzeczowy, ciepły — jak pracownik banku przy okienku.\n\n';

function buildSystemPrompt(lang) {
  const bank = (kbData && kbData.meta && kbData.meta.bank) || "Bank";
  let ctx = "";
  if (kbData && Array.isArray(kbData.entries)) {
    ctx = kbData.entries
      .map(function (e) {
        const q = e.q ? e.q[lang] || e.q.pl : "";
        const a = e.a ? e.a[lang] || e.a.pl : "";
        return "- " + q + "\n  " + a;
      })
      .join("\n");
  }
  if (lang === "en") {
    return (
      "You are the customer-service assistant of " + bank + ", a Polish retail bank.\n\n" +
      "TONE AND STYLE (mandatory, no exceptions):\n" +
      "- Always address the customer formally.\n" +
      "- Never use: 'hey', 'sure', 'no problem', 'awesome', 'great'.\n" +
      "- Use instead: 'Good day', 'Of course', 'I understand', 'I would be happy to help'.\n" +
      "- End responses politely, e.g. 'Is there anything else I can help you with?'\n" +
      "- No exclamation marks or emoji.\n" +
      "- Tone: professional, concise, warm — like a bank employee.\n\n" +
      "RESPONSE STRUCTURE:\n" +
      "- Maximum 3-4 sentences per answer.\n" +
      "- Use numbered steps when needed.\n" +
      "- Do not repeat the customer's question.\n" +
      "- Vary your openings — do not start every reply the same way.\n\n" +
      "SECURITY RULES:\n" +
      "- Never ask for passwords, PIN, full card number, CVV or SMS codes.\n" +
      "- If fraud or theft is suspected, prioritize securing funds and escalate to a consultant.\n\n" +
      "WHAT YOU NEVER DO:\n" +
      "- No legal or tax advice.\n" +
      "- No specific dates or amounts unless certain — escalate instead.\n" +
      "- No answers outside banking topics.\n\n" +
      "ESCALATION:\n" +
      "If the question is not covered by the knowledge base or requires account access, " +
      "say you are escalating to a human consultant (helpline +48 000 000 000). Reply in English.\n\n" +
      "KNOWLEDGE BASE:\n" + ctx
    );
  }
  return (
    TONE_PL +
    "Jesteś asystentem obsługi klienta banku „" + bank + "” (polski bank detaliczny). " +
    "Odpowiadaj WYŁĄCZNIE na podstawie poniższej bazy wiedzy FAQ. Bądź zwięzły, profesjonalny i uprzejmy. " +
    "Jeśli pytanie nie jest objęte bazą wiedzy, napisz, że nie masz pewnej odpowiedzi i przekazujesz sprawę " +
    "do konsultanta (infolinia 000 000 000). Odpowiadaj po polsku.\n\n" +
    "BAZA WIEDZY:\n" + ctx
  );
}

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

/* Walidacja i normalizacja body → tablica wiadomości w formacie OpenAI. */
function parseBody(req) {
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (e) {
      body = null;
    }
  }
  if (!body || typeof body !== "object") {
    return { error: "Nieprawidłowe body żądania." };
  }

  const language = body.language === "en" ? "en" : "pl";
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { error: "Pole 'messages' musi być niepustą tablicą." };
  }
  if (messages.length > MAX_MESSAGES) {
    return { error: "Zbyt wiele wiadomości w jednym żądaniu." };
  }

  const clean = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") {
      return { error: "Nieprawidłowy element w 'messages'." };
    }
    const role = m.role === "bot" || m.role === "assistant" ? "assistant" : "user";
    const text =
      typeof m.text === "string" ? m.text : typeof m.content === "string" ? m.content : "";
    if (text.length > MAX_TEXT_LEN) {
      return { error: "Wiadomość przekracza dozwoloną długość." };
    }
    if (text.trim()) clean.push({ role: role, content: text });
  }
  if (clean.length === 0) {
    return { error: "Brak treści wiadomości." };
  }
  return { language: language, messages: clean };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Dozwolona jest tylko metoda POST." });
  }

  if (isRateLimited(getClientIp(req))) {
    res.setHeader("Retry-After", "60");
    return sendJson(res, 429, {
      error: "Zbyt wiele zapytań. Spróbuj ponownie za chwilę (limit 10/min).",
    });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return sendJson(res, 500, { error: "Brak konfiguracji GROQ_API_KEY na serwerze." });
  }

  const parsed = parseBody(req);
  if (parsed.error) {
    return sendJson(res, 400, { error: parsed.error });
  }

  const payload = {
    model: MODEL,
    messages: [{ role: "system", content: buildSystemPrompt(parsed.language) }].concat(parsed.messages),
    stream: true,
    temperature: 0.3,
    stream_options: { include_usage: true },
  };

  let upstream;
  try {
    upstream = await fetch(GROQ_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return sendJson(res, 502, {
      error: "Nie udało się połączyć z Groq API.",
      detail: String((err && err.message) || err).slice(0, 300),
    });
  }

  if (!upstream.ok || !upstream.body) {
    let detail = "";
    try {
      detail = await upstream.text();
    } catch (e) {
      /* ignore */
    }
    return sendJson(res, upstream.status || 502, {
      error: "Groq API zwróciło błąd.",
      detail: detail.slice(0, 500),
    });
  }

  // Forward strumienia SSE z Groq (format OpenAI) prosto do klienta.
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value) res.write(Buffer.from(chunk.value));
    }
  } catch (err) {
    /* strumień przerwany — kończymy grzecznie poniżej */
  } finally {
    res.end();
  }
}
