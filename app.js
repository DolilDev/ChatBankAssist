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
  };

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

  /* ----- Odpowiedź bota na podstawie bazy wiedzy ----- */
  async function botReply(userText) {
    const lang = "pl"; // wykrywanie języka dodawane w kolejnym kroku
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
  }

  /* ----- Wysyłanie wiadomości ----- */
  async function handleSubmit(e) {
    e.preventDefault();
    if (state.busy) return;
    const text = dom.input.value.trim();
    if (!text) return;

    addMessage("user", text);
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

  /* ----- Inicjalizacja ----- */
  async function init() {
    dom.log = $("#chat-log");
    dom.form = $("#composer");
    dom.input = $("#chat-input");
    dom.send = $("#send-btn");

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
    dom.input.focus();
    await loadKnowledgeBase();
  }

  /* ----- Publiczne API (używane też przez stronę demo) ----- */
  window.BankBot = {
    normalize: normalize,
    loadKnowledgeBase: loadKnowledgeBase,
    findAnswer: findAnswer,
    escalationText: escalationText,
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
