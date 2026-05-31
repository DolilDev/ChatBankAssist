/* =========================================================================
   Bank Przykładowy — Asystent klienta
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
  };

  /* ----- Konfiguracja trybu API ----- */
  const STORAGE = {
    provider: "bank_api_provider",
    key: "bank_api_key",
    chat: "bank_chat_history",
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

  async function loadKnowledgeBase() {
    try {
      const res = await fetch("knowledge_base.json", { cache: "no-store" });
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

  // Punktacja dopasowania wpisu do pytania użytkownika.
  function scoreEntry(entry, qNorm, qTokens) {
    let score = 0;
    const fields = [];
    (entry.keywords || []).forEach(function (k) {
      fields.push({ t: k, w: 1 });
    });
    if (entry.q) {
      if (entry.q.pl) fields.push({ t: entry.q.pl, w: 0.6 });
      if (entry.q.en) fields.push({ t: entry.q.en, w: 0.6 });
    }
    fields.forEach(function (f) {
      const kwNorm = normalize(f.t);
      if (!kwNorm) return;
      if (qNorm.indexOf(kwNorm) !== -1) {
        // dopasowanie całej frazy — mocno punktowane
        score += (3 + kwNorm.split(" ").length) * f.w;
      } else {
        const kwTokens = kwNorm.split(" ");
        let overlap = 0;
        kwTokens.forEach(function (t) {
          if (t.length > 2 && qTokens.indexOf(t) !== -1) overlap++;
        });
        score += overlap * f.w;
      }
    });
    return score;
  }

  // Zwraca { entry, score } najlepszego dopasowania albo null (brak pewnej odpowiedzi).
  function findAnswer(question) {
    if (!kb.data || !Array.isArray(kb.data.entries)) return null;
    const qNorm = normalize(question);
    if (!qNorm) return null;
    const qTokens = qNorm.split(" ");
    let best = null;
    kb.data.entries.forEach(function (entry) {
      const score = scoreEntry(entry, qNorm, qTokens);
      if (!best || score > best.score) best = { entry: entry, score: score };
    });
    const THRESHOLD = 3;
    return best && best.score >= THRESHOLD ? best : null;
  }

  function escalationText(lang) {
    if (kb.data && kb.data.escalation) {
      return kb.data.escalation[lang] || kb.data.escalation.pl;
    }
    return "Przekazuję sprawę do konsultanta. Zadzwoń na infolinię 800 123 456.";
  }

  /* ----- Tryb API: instrukcja systemowa ugruntowana w bazie wiedzy ----- */
  function buildSystemPrompt(lang) {
    const bank = (kb.data && kb.data.meta && kb.data.meta.bank) || "Bank Przykładowy";
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
        "that you are escalating to a human consultant (helpline +48 800 123 456). Reply in English.\n\n" +
        "KNOWLEDGE BASE:\n" + ctx
      );
    }
    return (
      "Jesteś asystentem obsługi klienta banku " + bank + " (polski bank detaliczny). " +
      "Odpowiadaj WYŁĄCZNIE na podstawie poniższej bazy wiedzy FAQ. Bądź zwięzły, profesjonalny i uprzejmy. " +
      "Jeśli pytanie nie jest objęte bazą wiedzy, napisz, że nie masz pewnej odpowiedzi i przekazujesz sprawę " +
      "do konsultanta (infolinia 800 123 456). Odpowiadaj po polsku.\n\n" +
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

  // Czytelny komunikat błędu trybu API (rozwijany o ostrzeżenia CORS w kolejnym kroku).
  function apiErrorText(provider, err, lang) {
    const raw = (err && err.message) || String(err);
    const corsLikely = /Failed to fetch|NetworkError|Load failed|CORS/i.test(raw);
    const name = (PROVIDERS[provider] && PROVIDERS[provider].label) || provider;
    if (lang === "en") {
      return (
        "Could not reach the " + name + " API. " +
        (corsLikely
          ? "The browser most likely blocked the request (CORS). Gemini is the recommended provider for in-browser use. "
          : "") +
        "Details: " + raw
      );
    }
    return (
      "Nie udało się połączyć z API " + name + ". " +
      (corsLikely
        ? "Najprawdopodobniej przeglądarka zablokowała request (CORS). Do pracy w przeglądarce zalecany jest Gemini. "
        : "") +
      "Szczegóły: " + raw
    );
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
      if (m.role === "bot") addRating(bubble, m);
    });
    state.tokens = estimateConversationTokens();
    state.tokensExact = false;
    renderTokens();
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
    dom.tokenCounter.textContent = prefix + state.tokens.toLocaleString("pl-PL") + " tok";
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
    const lang = "pl"; // wykrywanie języka dodawane w kolejnym kroku
    const cfg = getApiConfig();
    if (cfg) {
      await apiReply(userText, lang, cfg);
    } else {
      await localReply(userText, lang);
    }
  }

  // Tryb lokalny — odpowiedź z bazy wiedzy, symulowany streaming słowo po słowie.
  async function localReply(userText, lang) {
    let text;
    const match = findAnswer(userText);
    if (match) {
      text = match.entry.a[lang] || match.entry.a.pl;
    } else if (!kb.loaded) {
      text =
        "Trwa wczytywanie bazy wiedzy — spróbuj ponownie za chwilę. " +
        "(Podczas testów lokalnych uruchom stronę przez serwer HTTP, a nie z pliku.)";
    } else {
      text = escalationText(lang);
    }
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

  /* ----- Wysyłanie wiadomości ----- */
  async function handleSubmit(e) {
    e.preventDefault();
    if (state.busy) return;
    const text = dom.input.value.trim();
    if (!text) return;

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
      "Dzień dobry! Jestem asystentem Banku Przykładowego. W czym mogę pomóc? " +
        "Możesz zapytać np. o otwieranie konta, przelewy, karty czy bezpieczeństwo."
    );
  }

  /* ----- Modale ----- */
  function openModal(id) {
    const m = document.getElementById(id);
    if (m) m.hidden = false;
  }
  function closeModal(id) {
    const m = document.getElementById(id);
    if (m) m.hidden = true;
  }

  // Treść ostrzeżeń CORS uzupełniana jest w kroku „fix: ostrzeżenia CORS”.
  function updateProviderWarning(/* provider */) {
    const el = $("#provider-warning");
    if (!el) return;
    el.hidden = true;
    el.innerHTML = "";
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

  /* ----- Ekran powitalny (pierwsze uruchomienie) ----- */
  const WELCOME_SEEN = "bank_welcome_seen";

  function initWelcome() {
    const modal = $("#welcome-modal");
    if (!modal) return;

    let seen = false;
    try {
      seen = localStorage.getItem(WELCOME_SEEN) === "1";
    } catch (e) {
      /* ignore */
    }
    // Pokaż tylko przy pierwszym uruchomieniu i gdy tryb API nie jest jeszcze ustawiony.
    if (!seen && !getApiConfig()) openModal("welcome-modal");

    function dismiss() {
      try {
        localStorage.setItem(WELCOME_SEEN, "1");
      } catch (e) {
        /* ignore */
      }
      closeModal("welcome-modal");
    }

    modal.addEventListener("click", function (e) {
      if (e.target.closest("[data-close]")) dismiss();
    });
    const startBtn = $("#welcome-start");
    const settingsBtn = $("#welcome-settings");
    if (startBtn) startBtn.addEventListener("click", dismiss);
    if (settingsBtn)
      settingsBtn.addEventListener("click", function () {
        dismiss();
        openModal("settings-modal");
      });
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
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !modal.hidden) closeModal("settings-modal");
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

    initTheme();
    initSettings();
    initWelcome();

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
    restoreHistory(); // po odświeżeniu czat nie znika
    dom.input.focus();
    await loadKnowledgeBase();
  }

  /* ----- Publiczne API (używane też przez stronę demo) ----- */
  window.BankBot = {
    normalize: normalize,
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
