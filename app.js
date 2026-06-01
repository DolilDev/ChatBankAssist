/* =========================================================================
   Bank — Asystent klienta
   Logika aplikacji (vanilla JS, bez frameworków, bez backendu).
   ========================================================================= */
"use strict";

(function () {
  /* ----- Referencje DOM ----- */
  const dom = {};

  /* ----- Stan ----- */
  const state = {
    busy: false, // true gdy bot generuje odpowiedź
    messages: [], // historia rozmowy [{ role, text, ts }]
    tokens: 0, // licznik tokenów w bieżącej rozmowie
    tokensExact: false, // true gdy oparte na rzeczywistym zużyciu z API
    categories: [], // unikalne kategorie poruszone w rozmowie (do podsumowania)
    lang: "pl", // język ostatniej wiadomości użytkownika
  };

  /* ----- Konfiguracja trybu API ----- */
  const STORAGE = {
    provider: "bank_api_provider",
    key: "bank_api_key",
    chat: "bank_chat_history",
    mode: "bank_chat_mode", // "ai" (Groq przez backend) | "local" (baza wiedzy)
  };

  const PROVIDERS = {
    gemini: { label: "Google Gemini", model: "gemini-2.0-flash" },
    claude: { label: "Anthropic Claude", model: "claude-3-5-haiku-latest" },
    openai: { label: "OpenAI", model: "gpt-4o-mini" },
  };

  // Zwraca { provider, key } gdy tryb API jest skonfigurowany, inaczej null.
  function getApiConfig() {
    try {
      const provider = sessionStorage.getItem(STORAGE.provider) || "";
      const key = sessionStorage.getItem(STORAGE.key) || "";
      if (provider && key && PROVIDERS[provider]) {
        return { provider: provider, key: key };
      }
    } catch (e) {
      /* sessionStorage może być niedostępny */
    }
    return null;
  }

  // Tryb czatu na index.html: "ai" (Groq przez backend) lub "local" (baza wiedzy).
  function getChatMode() {
    try {
      return sessionStorage.getItem(STORAGE.mode) || null;
    } catch (e) {
      return null;
    }
  }

  function setChatMode(mode) {
    try {
      sessionStorage.setItem(STORAGE.mode, mode);
    } catch (e) {
      /* ignore */
    }
  }

  /* ----- Pomocnicze ----- */
  function $(sel) {
    return document.querySelector(sel);
  }

  function delay(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  /* ----- Baza wiedzy ----- */
  const kb = {
    data: null,
    loaded: false,
  };

  // Normalizacja tekstu: małe litery, bez polskich znaków i interpunkcji.
  function normalize(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[łŁ]/g, "l")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "") // usuń znaki diakrytyczne
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /* ----- Wykrywanie języka (pl / en) ----- */
  const PL_DIACRITICS = /[ąćęłńóśźż]/i;
  const PL_WORDS = new Set([
    "jak", "czy", "gdzie", "kiedy", "dlaczego", "ile", "co", "jest", "sa", "mam",
    "chce", "chcialbym", "prosze", "dziekuje", "oraz", "lub", "nie", "tak", "jakie",
    "gdy", "albo", "sie", "moge", "czym", "dla", "ktore", "ktora", "moj", "moje",
    "potrzebuje", "zalozyc", "otworzyc", "zablokowac",
  ]);
  const EN_WORDS = new Set([
    "how", "what", "where", "when", "why", "can", "could", "does", "did", "you",
    "the", "is", "are", "am", "my", "want", "please", "thanks", "thank", "of",
    "for", "and", "or", "would", "should", "will", "need", "about", "with", "have",
    "your", "me", "account", "card", "transfer", "payment", "fee", "password",
    "open", "block", "lost", "money", "send", "hello", "help",
  ]);

  // Zwraca "en", gdy użytkownik pisze po angielsku; w innym wypadku "pl".
  function detectLanguage(text) {
    const raw = String(text || "");
    if (PL_DIACRITICS.test(raw)) return "pl";
    let pl = 0;
    let en = 0;
    normalize(raw)
      .split(" ")
      .forEach(function (t) {
        if (PL_WORDS.has(t)) pl++;
        if (EN_WORDS.has(t)) en++;
      });
    if (en > pl) return "en";
    return "pl"; // remis i brak sygnału → domyślnie polski (polski bank)
  }

  async function loadKnowledgeBase() {
    try {
      const res = await fetch("knowledge-base.json", { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      kb.data = await res.json();
      kb.loaded = true;
    } catch (err) {
      console.warn("Nie udało się wczytać bazy wiedzy:", err);
      kb.data = null;
      kb.loaded = false;
    }
    return kb.data;
  }

  /* ----- Lekki stemming PL + dopasowanie rozmyte ----- */
  // Słowa nieróżnicujące — pomijane przy pokryciu pojedynczych słów,
  // by nie zawyżały punktacji (domenowe słowa jak „konto”/„karta” zostają).
  const STOPWORDS = new Set([
    "jak", "czy", "gdzie", "kiedy", "ile", "co", "jest", "sa", "mam", "chce",
    "prosze", "oraz", "lub", "nie", "tak", "gdy", "albo", "sie", "dla", "moj",
    "moje", "moge", "czym", "the", "is", "are", "am", "want", "please", "for",
    "and", "or", "with", "have", "how", "what", "where", "when", "why", "can",
    "could", "does", "did", "you", "about", "do", "to", "na", "za", "of", "me",
    "your", "lub",
  ]);

  // Konserwatywny stemmer PL: obcina najczęstsze końcówki fleksyjne, by formy
  // „przelew/przelewy/przelewu” czy „konto/konta” trafiały w ten sam rdzeń.
  const PL_SUFFIXES = [
    "iami", "ami", "ach", "ego", "emu", "ych", "ich", "imi", "ymi", "owi",
    "esz", "asz", "cie", "em", "om", "ie", "ej", "ym", "im", "y", "i", "a",
    "e", "u", "o",
  ];
  function stem(token) {
    if (token.length < 5) return token;
    for (let i = 0; i < PL_SUFFIXES.length; i++) {
      const suf = PL_SUFFIXES[i];
      if (token.length - suf.length >= 3 && token.slice(-suf.length) === suf) {
        return token.slice(0, token.length - suf.length);
      }
    }
    return token;
  }

  // Czy słowa różnią się o co najwyżej jedną literówkę (Levenshtein ≤ 1)?
  function fuzzyEqual(a, b) {
    if (a === b) return true;
    const la = a.length;
    const lb = b.length;
    if (Math.abs(la - lb) > 1) return false;
    let i = 0;
    let j = 0;
    let edits = 0;
    while (i < la && j < lb) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++edits > 1) return false;
      if (la > lb) i++; // usunięcie znaku z a
      else if (lb > la) j++; // wstawienie znaku
      else { i++; j++; } // podmiana
    }
    if (i < la || j < lb) edits++; // ogon
    return edits <= 1;
  }

  // Grupy synonimów / mostki PL↔EN. Każdy rdzeń mapujemy na wspólny rdzeń
  // kanoniczny grupy, dzięki czemu np. „aplikacja”, „app” i „apka” liczą się
  // jako JEDNO pojęcie — nie zawyżają punktacji, gdy wpis wymienia je wszystkie.
  const STEM_CANON = (function () {
    const groups = [
      ["haslo", "password"],
      ["karta", "card"],
      ["konto", "account", "rachunek"],
      ["przelew", "transfer", "payment", "platnosc"],
      ["telefon", "phone", "komorka", "mobile", "smartfon"],
      ["aplikacja", "app", "apka"],
      ["zablokowac", "zastrzec", "block", "freeze"],
      ["oplata", "fee", "koszt", "prowizja", "charge"],
      ["kredyt", "loan", "pozyczka"],
      ["lokata", "deposit"],
      ["oszczednosci", "savings", "oszczedzanie"],
      ["bankomat", "atm"],
      ["reklamacja", "complaint", "skarga"],
      ["zagraniczny", "international", "miedzynarodowy", "foreign"],
    ];
    const map = Object.create(null);
    groups.forEach(function (g) {
      const stems = g.map(function (w) { return stem(normalize(w)); });
      const canonical = stems[0];
      stems.forEach(function (s) { map[s] = canonical; });
    });
    return map;
  })();
  function canon(s) { return STEM_CANON[s] || s; }

  // Treściowe rdzenie zapytania (z pominięciem stopwords).
  function queryStems(qTokens) {
    const out = [];
    qTokens.forEach(function (t) {
      if (t.length > 2 && !STOPWORDS.has(t)) out.push(stem(t));
    });
    return out;
  }

  // Czy rdzeń wpisu jest pokryty przez zapytanie — kanonicznie (po synonimach)
  // albo z tolerancją jednej literówki dla dłuższych słów?
  function stemMatched(entryStem, qCanonSet, qStemList) {
    if (qCanonSet.has(canon(entryStem))) return true;
    if (entryStem.length >= 5) {
      for (let i = 0; i < qStemList.length; i++) {
        const qs = qStemList[i];
        if (qs.length >= 5 && fuzzyEqual(entryStem, qs)) return true;
      }
    }
    return false;
  }

  // Punktacja dopasowania wpisu do pytania użytkownika:
  // 1) pokrycie całej wieloczłonowej frazy kluczowej (mocny sygnał) — tolerancyjne
  //    na odmianę, literówki i synonimy,
  // 2) pokrycie pojedynczych słów, gdzie każde POJĘCIE liczone jest najwyżej raz,
  //    więc powtórzenia i synonimy nie zawyżają wyniku.
  function scoreEntry(entry, qCanonSet, qStemList) {
    let score = 0;
    const fields = [];
    (entry.keywords || []).forEach(function (k) { fields.push({ t: k, w: 1 }); });
    if (entry.q) {
      if (entry.q.pl) fields.push({ t: entry.q.pl, w: 0.6 });
      if (entry.q.en) fields.push({ t: entry.q.en, w: 0.6 });
    }

    const counted = new Set(); // kanoniczne pojęcia już policzone dla tego wpisu
    fields.forEach(function (f) {
      const stems = [];
      normalize(f.t).split(" ").forEach(function (tok) {
        if (tok.length > 2 && !STOPWORDS.has(tok)) stems.push(stem(tok));
      });
      if (!stems.length) return;

      // (1) cała wieloczłonowa fraza pokryta przez zapytanie
      if (stems.length >= 2) {
        const all = stems.every(function (s) { return stemMatched(s, qCanonSet, qStemList); });
        if (all) score += (3 + stems.length) * f.w;
      }

      // (2) pokrycie pojedynczych słów — każde pojęcie najwyżej raz
      stems.forEach(function (s) {
        if (!stemMatched(s, qCanonSet, qStemList)) return;
        const c = canon(s);
        if (counted.has(c)) return;
        counted.add(c);
        score += f.w;
      });
    });
    return score;
  }

  // Zwraca { entry, score } najlepszego dopasowania albo null (brak pewnej odpowiedzi).
  function findAnswer(question) {
    if (!kb.data || !Array.isArray(kb.data.entries)) return null;
    const qNorm = normalize(question);
    if (!qNorm) return null;
    const qStemList = queryStems(qNorm.split(" "));
    const qCanonSet = new Set(qStemList.map(canon));
    let best = null;
    kb.data.entries.forEach(function (entry) {
      const score = scoreEntry(entry, qCanonSet, qStemList);
      if (!best || score > best.score) best = { entry: entry, score: score };
    });
    const THRESHOLD = 3;
    return best && best.score >= THRESHOLD ? best : null;
  }

  function escalationText(lang) {
    if (kb.data && kb.data.escalation) {
      return kb.data.escalation[lang] || kb.data.escalation.pl;
    }
    return "Dziękuję za kontakt. Ta sprawa wymaga interwencji konsultanta. Proszę skorzystać z jednej z poniższych form kontaktu.";
  }

  /* ----- Tryb API: instrukcja systemowa ugruntowana w bazie wiedzy ----- */
  const TONE_PL =
    'TON I STYL KOMUNIKACJI (obowiązkowe, bez wyjątków):\n' +
    '- Zawsze zwracaj się do klienta per "Pan/Pani" lub używaj form bezosobowych ("można", "należy", "jest możliwe").\n' +
    '- Nigdy nie używaj: "cześć", "hej", "siema", "super", "świetnie", "spoko", "ok", "okej", "jasne".\n' +
    '- Zamiast tego używaj: "Dzień dobry", "Oczywiście", "Rozumiem", "Chętnie pomogę", "Dziękuję za kontakt".\n' +
    '- Zdania kończ uprzejmie, np. "Czy mogę pomóc w czymś jeszcze?"\n' +
    '- Unikaj wykrzykników i emoji w odpowiedziach.\n' +
    '- Ton: profesjonalny, rzeczowy, ciepły — jak pracownik banku przy okienku.\n\n';

  function buildSystemPrompt(lang) {
    const bank = (kb.data && kb.data.meta && kb.data.meta.bank) || "Bank";
    let ctx = "";
    if (kb.data && Array.isArray(kb.data.entries)) {
      ctx = kb.data.entries
        .map(function (e) {
          const q = e.q ? e.q[lang] || e.q.pl : "";
          const a = e.a ? e.a[lang] || e.a.pl : "";
          return "- " + q + "\n  " + a;
        })
        .join("\n");
    }
    if (lang === "en") {
      return (
        "You are the customer-service assistant of " + bank + ", a Polish retail bank. " +
        "Answer ONLY based on the FAQ knowledge base below. Be concise, professional and friendly. " +
        "If the question is not covered by the knowledge base, say you don't have a reliable answer and " +
        "that you are escalating to a human consultant (helpline +48 000 000 000). Reply in English.\n\n" +
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

  /* ----- Strumieniowe czytanie odpowiedzi SSE ----- */
  async function* sseLines(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        if (line) yield line;
      }
    }
    if (buf.trim()) yield buf.trim();
  }

  async function readError(res, provider) {
    let detail = "";
    try {
      detail = await res.text();
    } catch (e) {
      /* ignore */
    }
    return new Error(provider + " API " + res.status + (detail ? ": " + detail.slice(0, 240) : ""));
  }

  /* ----- Google Gemini (obsługuje requesty z przeglądarki / CORS) ----- */
  async function streamGemini(key, system, messages, onToken) {
    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      PROVIDERS.gemini.model +
      ":streamGenerateContent?alt=sse&key=" +
      encodeURIComponent(key);
    const contents = messages.map(function (m) {
      return { role: m.role === "bot" ? "model" : "user", parts: [{ text: m.text }] };
    });
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: contents,
        generationConfig: { temperature: 0.3 },
      }),
    });
    if (!res.ok) throw await readError(res, "Gemini");
    let usage = null;
    for await (const line of sseLines(res)) {
      if (line.indexOf("data:") !== 0) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let json;
      try {
        json = JSON.parse(data);
      } catch (e) {
        continue;
      }
      const cand = json.candidates && json.candidates[0];
      const parts = cand && cand.content && cand.content.parts;
      if (parts) parts.forEach(function (p) { if (p.text) onToken(p.text); });
      if (json.usageMetadata) {
        usage = {
          promptTokens: json.usageMetadata.promptTokenCount,
          completionTokens: json.usageMetadata.candidatesTokenCount,
          totalTokens: json.usageMetadata.totalTokenCount,
        };
      }
    }
    return usage;
  }

  /* ----- OpenAI (UWAGA: przeglądarkowe CORS — patrz ostrzeżenia w ustawieniach) ----- */
  async function streamOpenAI(key, system, messages, onToken) {
    const msgs = [{ role: "system", content: system }].concat(
      messages.map(function (m) {
        return { role: m.role === "bot" ? "assistant" : "user", content: m.text };
      })
    );
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({
        model: PROVIDERS.openai.model,
        messages: msgs,
        stream: true,
        temperature: 0.3,
        stream_options: { include_usage: true },
      }),
    });
    if (!res.ok) throw await readError(res, "OpenAI");
    let usage = null;
    for await (const line of sseLines(res)) {
      if (line.indexOf("data:") !== 0) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let json;
      try {
        json = JSON.parse(data);
      } catch (e) {
        continue;
      }
      const delta = json.choices && json.choices[0] && json.choices[0].delta;
      if (delta && delta.content) onToken(delta.content);
      if (json.usage) {
        usage = {
          promptTokens: json.usage.prompt_tokens,
          completionTokens: json.usage.completion_tokens,
          totalTokens: json.usage.total_tokens,
        };
      }
    }
    return usage;
  }

  /* ----- Anthropic Claude (UWAGA: przeglądarkowe CORS — patrz ostrzeżenia w ustawieniach) ----- */
  async function streamClaude(key, system, messages, onToken) {
    const msgs = messages.map(function (m) {
      return { role: m.role === "bot" ? "assistant" : "user", content: m.text };
    });
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: PROVIDERS.claude.model,
        max_tokens: 1024,
        system: system,
        messages: msgs,
        stream: true,
      }),
    });
    if (!res.ok) throw await readError(res, "Claude");
    const usage = {};
    for await (const line of sseLines(res)) {
      if (line.indexOf("data:") !== 0) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      let json;
      try {
        json = JSON.parse(data);
      } catch (e) {
        continue;
      }
      if (json.type === "content_block_delta" && json.delta && json.delta.text) {
        onToken(json.delta.text);
      } else if (json.type === "message_start" && json.message && json.message.usage) {
        usage.promptTokens = json.message.usage.input_tokens;
      } else if (json.type === "message_delta" && json.usage) {
        usage.completionTokens = json.usage.output_tokens;
      }
    }
    if (usage.promptTokens != null || usage.completionTokens != null) {
      usage.totalTokens = (usage.promptTokens || 0) + (usage.completionTokens || 0);
      return usage;
    }
    return null;
  }

  // Wspólny punkt wejścia dla trybu API. Zwraca info o zużyciu tokenów (lub null).
  async function streamFromAPI(provider, key, messages, opts) {
    opts = opts || {};
    const onToken = opts.onToken || function () {};
    const system = opts.system || "";
    if (provider === "gemini") return streamGemini(key, system, messages, onToken);
    if (provider === "openai") return streamOpenAI(key, system, messages, onToken);
    if (provider === "claude") return streamClaude(key, system, messages, onToken);
    throw new Error("Nieznany provider: " + provider);
  }

  // Czytelny komunikat błędu trybu API: rozpoznaje limit zapytań (429),
  // odrzucony klucz (401/403) oraz blokadę CORS i dodaje konkretną wskazówkę.
  function apiErrorText(provider, err, lang) {
    const raw = (err && err.message) || String(err);
    const name = (PROVIDERS[provider] && PROVIDERS[provider].label) || provider;
    const rateLimited = /\b429\b|RESOURCE_EXHAUSTED|rate limit|quota/i.test(raw);
    const authFailed = /\b401\b|\b403\b|API key not valid|API_KEY_INVALID|PERMISSION_DENIED|unauthorized/i.test(raw);
    const corsLikely = /Failed to fetch|NetworkError|Load failed|CORS/i.test(raw);

    let hint = "";
    if (lang === "en") {
      if (rateLimited) hint = "API request limit reached (429). Wait a minute and try again, or use local mode (no key). ";
      else if (authFailed) hint = "The API key was rejected (invalid or lacking permissions). Check it in Settings. ";
      else if (corsLikely) hint = "The browser most likely blocked the request (CORS). Gemini is the recommended provider for in-browser use. ";
      return "Could not reach the " + name + " API. " + hint + "Details: " + raw;
    }
    if (rateLimited) hint = "Przekroczono limit zapytań do API (429). Odczekaj kilkadziesiąt sekund i spróbuj ponownie albo skorzystaj z trybu lokalnego (bez klucza). ";
    else if (authFailed) hint = "Klucz API został odrzucony (nieprawidłowy lub bez uprawnień). Sprawdź go w Ustawieniach. ";
    else if (corsLikely) hint = "Najprawdopodobniej przeglądarka zablokowała request (CORS). Do pracy w przeglądarce zalecany jest Gemini. ";
    return "Nie udało się połączyć z API " + name + ". " + hint + "Szczegóły: " + raw;
  }

  function scrollToBottom() {
    if (dom.log) dom.log.scrollTop = dom.log.scrollHeight;
  }

  function formatTime(ts) {
    const d = ts ? new Date(ts) : new Date();
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  /* ----- Renderowanie wiadomości ----- */
  // role: "user" | "bot". Zwraca element bańki, aby dało się go uzupełniać.
  function addMessage(role, text, opts) {
    opts = opts || {};
    const wrap = document.createElement("div");
    wrap.className = "message message--" + role;

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = text || "";
    wrap.appendChild(bubble);

    const meta = document.createElement("div");
    meta.className = "message__meta";
    meta.textContent =
      (role === "user" ? "Ty" : "Asystent") + " · " + formatTime(opts.ts);
    wrap.appendChild(meta);

    dom.log.appendChild(wrap);
    scrollToBottom();
    return bubble;
  }

  /* ----- Wskaźnik pisania ----- */
  function showTyping() {
    const wrap = document.createElement("div");
    wrap.className = "message message--bot";
    const bubble = document.createElement("div");
    bubble.className = "bubble bubble--typing";
    bubble.setAttribute("aria-label", "Asystent pisze…");
    bubble.innerHTML =
      '<span class="typing"><span></span><span></span><span></span></span>';
    wrap.appendChild(bubble);
    dom.log.appendChild(wrap);
    scrollToBottom();
    return wrap;
  }

  /* ----- Streaming tekstu słowo po słowie (jak w ChatGPT) ----- */
  function streamWords(bubble, text) {
    return new Promise(function (resolve) {
      const tokens = String(text).split(/(\s+)/); // zachowujemy odstępy
      let i = 0;
      bubble.classList.add("bubble--streaming");
      (function tick() {
        if (i >= tokens.length) {
          bubble.classList.remove("bubble--streaming");
          resolve();
          return;
        }
        bubble.textContent += tokens[i++];
        scrollToBottom();
        setTimeout(tick, 26 + Math.random() * 42);
      })();
    });
  }

  function recordMessage(role, text) {
    const msg = { role: role, text: text, ts: Date.now() };
    state.messages.push(msg);
    saveHistory();
    return msg;
  }

  /* ----- Historia czatu w sessionStorage ----- */
  function saveHistory() {
    try {
      sessionStorage.setItem(STORAGE.chat, JSON.stringify(state.messages));
    } catch (e) {
      /* ignore (np. limit / prywatny tryb) */
    }
  }

  // Odtwarza zapisaną rozmowę po odświeżeniu strony. Zwraca true, jeśli coś wczytano.
  function restoreHistory() {
    let saved = [];
    try {
      saved = JSON.parse(sessionStorage.getItem(STORAGE.chat) || "[]");
    } catch (e) {
      saved = [];
    }
    if (!Array.isArray(saved) || !saved.length) return false;
    state.messages = saved;
    saved.forEach(function (m) {
      const bubble = addMessage(m.role, m.text, { ts: m.ts });
      if (m.role !== "bot") return;
      if (m.escalated) {
        bubble.classList.add("bubble--escalation");
        appendEscalationActions(bubble, detectLanguage(m.text));
      } else {
        addRating(bubble, m);
      }
    });
    state.tokens = estimateConversationTokens();
    state.tokensExact = false;
    renderTokens();

    // Odtwórz kategorie i język na potrzeby podsumowania.
    saved.forEach(function (m) {
      if (m.role === "user") {
        const mt = findAnswer(m.text);
        if (mt) trackCategory(mt.entry.category);
      }
    });
    for (let i = saved.length - 1; i >= 0; i--) {
      if (saved[i].role === "user") {
        state.lang = detectLanguage(saved[i].text);
        break;
      }
    }
    return true;
  }

  function clearHistory() {
    state.messages = [];
    try {
      sessionStorage.removeItem(STORAGE.chat);
    } catch (e) {
      /* ignore */
    }
    resetTokens();
  }

  /* ----- Ocena odpowiedzi (thumbs up / down) ----- */
  const THUMB_UP =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2h0a3.13 3.13 0 0 1 3 3.88Z"/></svg>';
  const THUMB_DOWN =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="transform:rotate(180deg)"><path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2h0a3.13 3.13 0 0 1 3 3.88Z"/></svg>';

  function makeRateBtn(kind, label, icon) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "rate-btn rate-btn--" + kind;
    b.setAttribute("aria-label", label);
    b.title = label;
    b.innerHTML = icon;
    return b;
  }

  // Dodaje przyciski oceny pod bańką bota, powiązane z rekordem wiadomości.
  function addRating(bubble, msg) {
    const wrap = bubble.closest ? bubble.closest(".message") : bubble.parentNode;
    if (!wrap) return;
    const bar = document.createElement("div");
    bar.className = "msg-actions";
    const up = makeRateBtn("up", "Dobra odpowiedź", THUMB_UP);
    const down = makeRateBtn("down", "Słaba odpowiedź", THUMB_DOWN);
    bar.appendChild(up);
    bar.appendChild(down);

    const meta = wrap.querySelector(".message__meta");
    if (meta) wrap.insertBefore(bar, meta);
    else wrap.appendChild(bar);

    function reflect() {
      up.classList.toggle("is-active", msg.rating === "up");
      down.classList.toggle("is-active", msg.rating === "down");
      up.setAttribute("aria-pressed", String(msg.rating === "up"));
      down.setAttribute("aria-pressed", String(msg.rating === "down"));
    }
    function rate(value) {
      msg.rating = msg.rating === value ? null : value;
      saveHistory();
      reflect();
    }
    up.addEventListener("click", function () { rate("up"); });
    down.addEventListener("click", function () { rate("down"); });
    reflect();
  }

  /* ----- Licznik tokenów ----- */
  // Przybliżenie: ~4 znaki na token (heurystyka jak w popularnych tokenizerach).
  function estimateTokens(text) {
    if (!text) return 0;
    return Math.max(1, Math.round(String(text).trim().length / 4));
  }

  function estimateConversationTokens() {
    return state.messages.reduce(function (sum, m) {
      return sum + estimateTokens(m.text);
    }, 0);
  }

  function renderTokens() {
    if (!dom.tokenCounter) return;
    if (state.tokens <= 0) {
      dom.tokenCounter.hidden = true;
      return;
    }
    dom.tokenCounter.hidden = false;
    const prefix = state.tokensExact ? "" : "~";
    dom.tokenCounter.textContent = prefix + state.tokens.toLocaleString("pl-PL") + " tokens";
  }

  function bumpTokens(n, exact) {
    if (!n) return;
    state.tokens += n;
    if (exact) state.tokensExact = true;
    renderTokens();
  }

  function resetTokens() {
    state.tokens = 0;
    state.tokensExact = false;
    renderTokens();
  }

  /* ----- Odpowiedź bota: tryb lokalny (baza wiedzy) albo tryb API ----- */
  async function botReply(userText) {
    const lang = detectLanguage(userText); // EN gdy użytkownik pisze po angielsku
    state.lang = lang;
    const classified = findAnswer(userText);
    if (classified) trackCategory(classified.entry.category);
    if (getChatMode() === "ai") {
      await groqReply(userText, lang);
    } else {
      await localReply(userText, lang);
    }
  }

  /* ----- Eskalacja do konsultanta ----- */
  const CONTACT = {
    phone: "000 000 000",
    phoneHref: "+48000000000",
    email: "kontakt@bank.pl",
  };
  const ICON_PHONE =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';
  const ICON_MAIL =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 5L2 7"/></svg>';

  // Dodaje pod bańką eskalacji przyciski kontaktu (telefon, e-mail).
  function appendEscalationActions(bubble, lang) {
    const wrap = bubble.closest ? bubble.closest(".message") : bubble.parentNode;
    if (!wrap) return;
    const actions = document.createElement("div");
    actions.className = "escalation-actions";

    const call = document.createElement("a");
    call.className = "esc-btn";
    call.href = "tel:" + CONTACT.phoneHref;
    call.innerHTML = ICON_PHONE + "<span>" + (lang === "en" ? "Call " : "Zadzwoń: ") + CONTACT.phone + "</span>";

    const mail = document.createElement("a");
    mail.className = "esc-btn esc-btn--ghost";
    mail.href = "mailto:" + CONTACT.email;
    mail.innerHTML = ICON_MAIL + "<span>" + (lang === "en" ? "Email us" : "Napisz e-mail") + "</span>";

    actions.appendChild(call);
    actions.appendChild(mail);

    const meta = wrap.querySelector(".message__meta");
    if (meta) wrap.insertBefore(actions, meta);
    else wrap.appendChild(actions);
  }

  async function escalate(userText, lang) {
    const text = escalationText(lang);
    const typing = showTyping();
    await delay(450 + Math.random() * 350);
    typing.remove();
    const bubble = addMessage("bot", "");
    bubble.classList.add("bubble--escalation");
    await streamWords(bubble, text);
    appendEscalationActions(bubble, lang);
    const rec = recordMessage("bot", text);
    rec.escalated = true;
    saveHistory();
    bumpTokens(estimateTokens(userText) + estimateTokens(text), false);
  }

  // Tryb lokalny — odpowiedź z bazy wiedzy, symulowany streaming słowo po słowie.
  async function localReply(userText, lang) {
    const match = findAnswer(userText);

    if (!match && kb.loaded) {
      // Brak pewnej odpowiedzi → eskalacja do konsultanta.
      await escalate(userText, lang);
      return;
    }

    const text = match
      ? match.entry.a[lang] || match.entry.a.pl
      : "Trwa wczytywanie bazy wiedzy — spróbuj ponownie za chwilę. " +
        "(Podczas testów lokalnych uruchom stronę przez serwer HTTP, a nie z pliku.)";

    const typing = showTyping();
    await delay(450 + Math.random() * 350);
    typing.remove();
    const bubble = addMessage("bot", "");
    await streamWords(bubble, text);
    const rec = recordMessage("bot", text);
    addRating(bubble, rec);
    bumpTokens(estimateTokens(userText) + estimateTokens(text), false);
  }

  // Tryb API — prawdziwy streaming tokenów od wybranego dostawcy.
  async function apiReply(userText, lang, cfg) {
    const typing = showTyping();
    let bubble = null;
    try {
      const usage = await streamFromAPI(cfg.provider, cfg.key, state.messages.slice(), {
        system: buildSystemPrompt(lang),
        onToken: function (t) {
          if (!bubble) {
            if (typing.parentNode) typing.remove();
            bubble = addMessage("bot", "");
            bubble.classList.add("bubble--streaming");
          }
          bubble.textContent += t;
          scrollToBottom();
        },
      });
      if (typing.parentNode) typing.remove();
      if (!bubble) {
        bubble = addMessage("bot", "");
        bubble.textContent = "(Otrzymano pustą odpowiedź z API.)";
      }
      bubble.classList.remove("bubble--streaming");
      const rec = recordMessage("bot", bubble.textContent);
      addRating(bubble, rec);
      if (usage && usage.totalTokens) {
        bumpTokens(usage.totalTokens, true); // rzeczywiste zużycie z API
      } else {
        bumpTokens(estimateTokens(userText) + estimateTokens(bubble.textContent), false);
      }
    } catch (err) {
      if (typing.parentNode) typing.remove();
      if (bubble) bubble.classList.remove("bubble--streaming");
      const eb = bubble || addMessage("bot", "");
      const msg = apiErrorText(cfg.provider, err, lang);
      eb.textContent = "";
      await streamWords(eb, msg);
      recordMessage("bot", msg);
    }
  }

  /* ----- Tryb AI (Groq przez backend Vercel /api/chat) ----- */
  // Streaming z naszego backendu (format SSE zgodny z OpenAI, forwardowany z Groq).
  async function streamGroq(messages, lang, onToken) {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        language: lang,
        messages: messages.map(function (m) {
          return { role: m.role, text: m.text };
        }),
      }),
    });
    if (!res.ok) throw await readError(res, "Groq");
    let usage = null;
    for await (const line of sseLines(res)) {
      if (line.indexOf("data:") !== 0) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let json;
      try {
        json = JSON.parse(data);
      } catch (e) {
        continue;
      }
      const delta = json.choices && json.choices[0] && json.choices[0].delta;
      if (delta && delta.content) onToken(delta.content);
      if (json.usage) {
        usage = {
          promptTokens: json.usage.prompt_tokens,
          completionTokens: json.usage.completion_tokens,
          totalTokens: json.usage.total_tokens,
        };
      }
    }
    return usage;
  }

  function groqErrorText(err, lang) {
    const raw = (err && err.message) || String(err);
    const rateLimited = /\b429\b|rate limit|too many|Zbyt wiele|limit/i.test(raw);
    if (lang === "en") {
      if (rateLimited)
        return "Request limit reached — please wait a moment and try again, or switch to local mode (knowledge base). Details: " + raw;
      return "Could not get an AI response right now. You can switch to local mode (knowledge base). Details: " + raw;
    }
    if (rateLimited)
      return "Przekroczono limit zapytań — odczekaj chwilę i spróbuj ponownie albo przełącz się na tryb lokalny (baza wiedzy). Szczegóły: " + raw;
    return "Nie udało się uzyskać odpowiedzi AI. Możesz przełączyć się na tryb lokalny (baza wiedzy). Szczegóły: " + raw;
  }

  async function groqReply(userText, lang) {
    const typing = showTyping();
    let bubble = null;
    try {
      const usage = await streamGroq(state.messages.slice(), lang, function (t) {
        if (!bubble) {
          if (typing.parentNode) typing.remove();
          bubble = addMessage("bot", "");
          bubble.classList.add("bubble--streaming");
        }
        bubble.textContent += t;
        scrollToBottom();
      });
      if (typing.parentNode) typing.remove();
      if (!bubble) {
        bubble = addMessage("bot", "");
        bubble.textContent = "(Otrzymano pustą odpowiedź z modelu.)";
      }
      bubble.classList.remove("bubble--streaming");
      const rec = recordMessage("bot", bubble.textContent);
      addRating(bubble, rec);
      if (usage && usage.totalTokens) {
        bumpTokens(usage.totalTokens, true); // rzeczywiste zużycie z API
      } else {
        bumpTokens(estimateTokens(userText) + estimateTokens(bubble.textContent), false);
      }
    } catch (err) {
      if (typing.parentNode) typing.remove();
      if (bubble) bubble.classList.remove("bubble--streaming");
      const eb = bubble || addMessage("bot", "");
      const msg = groqErrorText(err, lang);
      eb.textContent = "";
      await streamWords(eb, msg);
      recordMessage("bot", msg);
    }
  }

  /* ----- Wysyłanie wiadomości ----- */
  async function handleSubmit(e) {
    e.preventDefault();
    if (state.busy) return;
    const text = dom.input.value.trim();
    if (!text) return;

    hideSuggestions();
    addMessage("user", text);
    recordMessage("user", text);
    dom.input.value = "";
    autoResize();

    setBusy(true);
    try {
      await botReply(text);
    } finally {
      setBusy(false);
      dom.input.focus();
    }
  }

  /* ----- Blokowanie wejścia w trakcie generowania ----- */
  function setBusy(busy) {
    state.busy = busy;
    if (dom.send) dom.send.disabled = busy;
    if (dom.input) dom.input.disabled = busy;
  }

  /* ----- Auto-rozmiar pola tekstowego ----- */
  function autoResize() {
    dom.input.style.height = "auto";
    dom.input.style.height = Math.min(dom.input.scrollHeight, 140) + "px";
  }

  /* ----- Powitanie ----- */
  function greet() {
    addMessage(
      "bot",
      "Dzień dobry. Jestem wirtualnym asystentem banku. W czym mogę Panu/Pani pomóc?"
    );
  }

  /* ----- Podsumowanie rozmowy i nowa sesja ----- */
  function trackCategory(cat) {
    if (cat && state.categories.indexOf(cat) === -1) state.categories.push(cat);
  }

  function categoryLabel(catKey, lang, kind) {
    const cats = kb.data && kb.data.categories;
    const c = cats && cats[catKey];
    if (!c) return catKey;
    const obj = kind === "summary" ? c.summary : c.label;
    return (obj && (obj[lang] || obj.pl)) || catKey;
  }

  function buildSummaryText(lang) {
    const list = state.categories
      .map(function (c) {
        return categoryLabel(c, lang, "summary");
      })
      .join(", ");
    if (lang === "en") {
      return list
        ? "📋 Conversation summary. Your questions were about: " + list + "."
        : "📋 Conversation summary: we haven't covered any specific topics yet.";
    }
    return list
      ? "📋 Podsumowanie rozmowy. Twoje pytania dotyczyły: " + list + "."
      : "📋 Podsumowanie rozmowy: nie poruszyliśmy jeszcze konkretnych tematów.";
  }

  async function showSummary() {
    if (state.busy) return;
    setBusy(true);
    try {
      const lang = state.lang || "pl";
      const typing = showTyping();
      await delay(300);
      typing.remove();
      const bubble = addMessage("bot", "");
      bubble.classList.add("bubble--summary");
      await streamWords(bubble, buildSummaryText(lang));
    } finally {
      setBusy(false);
    }
  }

  function newChat() {
    if (state.busy) return;
    clearHistory();
    state.categories = [];
    state.lang = "pl";
    if (dom.log) dom.log.innerHTML = "";
    greet();
    showSuggestions();
    if (dom.input) dom.input.focus();
  }

  /* ----- Eksport rozmowy do pliku tekstowego ----- */
  function buildTranscript() {
    const bank = (kb.data && kb.data.meta && kb.data.meta.bank) || "Bank";
    const lines = [];
    lines.push(bank + " — zapis rozmowy z asystentem");
    lines.push("Wyeksportowano: " + new Date().toLocaleString("pl-PL"));
    lines.push("");
    let up = 0;
    let down = 0;
    state.messages.forEach(function (m) {
      const who = m.role === "user" ? "Ty" : "Asystent";
      let line = "[" + formatTime(m.ts) + "] " + who + ": " + m.text;
      if (m.rating === "up") { line += "  [ocena: 👍]"; up++; }
      else if (m.rating === "down") { line += "  [ocena: 👎]"; down++; }
      lines.push(line);
    });
    lines.push("");
    lines.push("Podsumowanie ocen: 👍 " + up + " · 👎 " + down);
    return lines.join("\n");
  }

  function exportChat() {
    if (!state.messages.length) return; // nic do zapisania poza powitaniem
    const blob = new Blob([buildTranscript()], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    a.href = url;
    a.download = "rozmowa-" + stamp + ".txt";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  /* ----- Chipy z przykładowymi pytaniami ----- */
  const SUGGESTIONS = [
    "Jak otworzyć konto?",
    "Ile trwa przelew?",
    "Jak zastrzec kartę?",
    "Jak wziąć kredyt gotówkowy?",
    "Jak złożyć reklamację?",
  ];

  function hideSuggestions() {
    if (dom.suggestions) dom.suggestions.hidden = true;
  }

  function showSuggestions() {
    if (!dom.suggestions) return;
    dom.suggestions.innerHTML = "";
    SUGGESTIONS.forEach(function (q) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.textContent = q;
      chip.addEventListener("click", function () {
        if (state.busy) return;
        dom.input.value = q;
        hideSuggestions();
        dom.form.requestSubmit();
      });
      dom.suggestions.appendChild(chip);
    });
    dom.suggestions.hidden = false;
  }

  function initSessionTools() {
    const sBtn = $("#summary-btn");
    const nBtn = $("#newchat-btn");
    const eBtn = $("#export-btn");
    if (sBtn) sBtn.addEventListener("click", showSummary);
    if (nBtn) nBtn.addEventListener("click", newChat);
    if (eBtn) eBtn.addEventListener("click", exportChat);
  }

  /* ----- Modale (z pułapką fokusu — dostępność) ----- */
  const FOCUSABLE =
    'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  const modalState = { lastFocused: null, keyHandler: null };

  function focusablesIn(container) {
    return Array.prototype.slice
      .call(container.querySelectorAll(FOCUSABLE))
      .filter(function (el) { return !el.hidden && el.offsetParent !== null; });
  }

  function openModal(id) {
    const m = document.getElementById(id);
    if (!m) return;
    modalState.lastFocused = document.activeElement;
    m.hidden = false;
    const dialog = m.querySelector(".modal__dialog") || m;
    const list = focusablesIn(dialog);
    (list[0] || dialog).focus();

    // Esc zamyka, Tab krąży wewnątrz okna (focus trap).
    modalState.keyHandler = function (e) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeModal(id);
        return;
      }
      if (e.key !== "Tab") return;
      const f = focusablesIn(dialog);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", modalState.keyHandler, true);
  }

  function closeModal(id) {
    const m = document.getElementById(id);
    if (m) m.hidden = true;
    if (modalState.keyHandler) {
      document.removeEventListener("keydown", modalState.keyHandler, true);
      modalState.keyHandler = null;
    }
    const lf = modalState.lastFocused;
    modalState.lastFocused = null;
    if (lf && typeof lf.focus === "function") {
      try { lf.focus(); } catch (e) { /* ignore */ }
    }
  }

  // Ostrzeżenia o ograniczeniach CORS poszczególnych dostawców.
  function updateProviderWarning(provider) {
    const el = $("#provider-warning");
    if (!el) return;
    if (provider === "openai") {
      el.className = "notice notice--warn";
      el.innerHTML =
        "<strong>⚠ OpenAI blokuje zapytania bezpośrednio z przeglądarki (CORS).</strong> " +
        "Klucz wklejony tutaj najprawdopodobniej nie zadziała bez własnego serwera proxy. " +
        "Do użycia w przeglądarce zalecamy <strong>Gemini</strong> (darmowy).";
      el.hidden = false;
    } else if (provider === "claude") {
      el.className = "notice notice--warn";
      el.innerHTML =
        "<strong>⚠ Anthropic Claude również ogranicza zapytania z przeglądarki (CORS).</strong> " +
        "Mimo nagłówka zezwalającego na dostęp z przeglądarki, w praktyce zwykle potrzebny jest serwer proxy. " +
        "Bezproblemowo i domyślnie działa <strong>Gemini</strong>.";
      el.hidden = false;
    } else if (provider === "gemini") {
      el.className = "notice notice--info";
      el.innerHTML =
        "Gemini działa bezpośrednio z przeglądarki. Darmowy klucz zdobędziesz w 2 minuty na " +
        '<a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener">aistudio.google.com</a>.';
      el.hidden = false;
    } else {
      el.hidden = true;
      el.innerHTML = "";
    }
  }

  /* ----- Tryb ciemny / jasny ----- */
  const THEME_KEY = "bank_theme";
  const ICON_MOON =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  const ICON_SUN =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    if (dom.themeBtn) {
      const dark = theme === "dark";
      dom.themeBtn.innerHTML = dark ? ICON_SUN : ICON_MOON;
      dom.themeBtn.setAttribute("aria-label", dark ? "Włącz tryb jasny" : "Włącz tryb ciemny");
      dom.themeBtn.title = dark ? "Tryb jasny" : "Tryb ciemny";
    }
  }

  function initTheme() {
    dom.themeBtn = $("#theme-toggle");
    let theme = document.documentElement.getAttribute("data-theme");
    if (!theme) {
      try {
        theme = localStorage.getItem(THEME_KEY);
      } catch (e) {
        /* ignore */
      }
      if (!theme) {
        theme =
          window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light";
      }
    }
    applyTheme(theme);

    if (dom.themeBtn) {
      dom.themeBtn.addEventListener("click", function () {
        const next =
          document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
        applyTheme(next);
        try {
          localStorage.setItem(THEME_KEY, next);
        } catch (e) {
          /* ignore */
        }
      });
    }
  }

  /* ----- Wybór trybu rozmowy (AI vs lokalny) ----- */
  function initModeSelector() {
    const modal = $("#mode-modal");
    const btn = $("#mode-btn");
    // Ikona w nagłówku — pozwala zmienić tryb w dowolnym momencie.
    if (btn) btn.addEventListener("click", function () { openModal("mode-modal"); });
    if (!modal) return;

    modal.addEventListener("click", function (e) {
      const closer = e.target.closest("[data-close]");
      if (closer) closeModal(closer.getAttribute("data-close"));
    });

    function choose(mode) {
      setChatMode(mode);
      closeModal("mode-modal");
      if (dom.input) dom.input.focus();
    }

    const aiBtn = $("#mode-ai");
    const localBtn = $("#mode-local");
    if (aiBtn) aiBtn.addEventListener("click", function () { choose("ai"); });
    if (localBtn) localBtn.addEventListener("click", function () { choose("local"); });

    // Przy pierwszym wejściu (brak zapisanego wyboru) poproś o tryb.
    if (!getChatMode()) openModal("mode-modal");
  }

  /* ----- Panel ustawień (tryb API) ----- */
  function initSettings() {
    const btn = $("#settings-btn");
    const modal = $("#settings-modal");
    if (!btn || !modal) return;

    const providerSel = $("#provider-select");
    const keyField = $("#api-key-field");
    const keyInput = $("#api-key-input");
    const keyToggle = $("#api-key-toggle");
    const saveBtn = $("#api-save");
    const clearBtn = $("#api-clear");
    const statusEl = $("#api-status");

    function setStatus(text, kind) {
      statusEl.textContent = text || "";
      statusEl.className = "setting__status" + (kind ? " setting__status--" + kind : "");
    }

    function reflectProvider() {
      keyField.hidden = !providerSel.value;
      updateProviderWarning(providerSel.value);
    }

    // Wczytaj zapisane wartości z sessionStorage.
    try {
      providerSel.value = sessionStorage.getItem(STORAGE.provider) || "";
      keyInput.value = sessionStorage.getItem(STORAGE.key) || "";
    } catch (e) {
      /* ignore */
    }
    reflectProvider();

    btn.addEventListener("click", function () {
      openModal("settings-modal");
      setStatus("");
    });
    modal.addEventListener("click", function (e) {
      const closer = e.target.closest("[data-close]");
      if (closer) closeModal(closer.getAttribute("data-close"));
    });
    providerSel.addEventListener("change", reflectProvider);
    keyToggle.addEventListener("click", function () {
      keyInput.type = keyInput.type === "password" ? "text" : "password";
    });

    saveBtn.addEventListener("click", function () {
      const provider = providerSel.value;
      const key = keyInput.value.trim();
      try {
        if (!provider) {
          sessionStorage.removeItem(STORAGE.provider);
          sessionStorage.removeItem(STORAGE.key);
          setStatus("Tryb lokalny (baza wiedzy) jest aktywny.", "ok");
        } else if (!key) {
          setStatus("Podaj klucz API albo wybierz tryb lokalny.", "err");
        } else {
          sessionStorage.setItem(STORAGE.provider, provider);
          sessionStorage.setItem(STORAGE.key, key);
          setStatus(
            "Zapisano. Tryb API: " + PROVIDERS[provider].label + " — klucz tylko w tej sesji.",
            "ok"
          );
        }
      } catch (e) {
        setStatus("Nie udało się zapisać (sessionStorage niedostępny).", "err");
      }
    });

    clearBtn.addEventListener("click", function () {
      providerSel.value = "";
      keyInput.value = "";
      try {
        sessionStorage.removeItem(STORAGE.provider);
        sessionStorage.removeItem(STORAGE.key);
      } catch (e) {
        /* ignore */
      }
      reflectProvider();
      setStatus("Wyczyszczono klucz. Tryb lokalny aktywny.", "ok");
    });
  }

  /* ----- Inicjalizacja ----- */
  async function init() {
    dom.log = $("#chat-log");
    dom.form = $("#composer");
    dom.input = $("#chat-input");
    dom.send = $("#send-btn");
    dom.tokenCounter = $("#token-counter");
    dom.suggestions = $("#suggestions");

    initTheme();
    initModeSelector();
    initSessionTools();

    if (!dom.log || !dom.form) return; // np. strona demo

    dom.form.addEventListener("submit", handleSubmit);
    dom.input.addEventListener("input", autoResize);
    // Enter wysyła, Shift+Enter dodaje nową linię.
    dom.input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        dom.form.requestSubmit();
      }
    });

    greet();
    await loadKnowledgeBase(); // najpierw baza, by odtworzenie mogło sklasyfikować pytania
    const restored = restoreHistory(); // po odświeżeniu czat nie znika
    if (!restored) showSuggestions(); // chipy tylko na świeżym ekranie
    dom.input.focus();
  }

  /* ----- Publiczne API (używane też przez stronę demo) ----- */
  window.BankBot = {
    normalize: normalize,
    detectLanguage: detectLanguage,
    loadKnowledgeBase: loadKnowledgeBase,
    findAnswer: findAnswer,
    escalationText: escalationText,
    buildSystemPrompt: buildSystemPrompt,
    streamFromAPI: streamFromAPI,
    getApiConfig: getApiConfig,
    apiErrorText: apiErrorText,
    PROVIDERS: PROVIDERS,
    STORAGE: STORAGE,
    get knowledgeBase() {
      return kb.data;
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
