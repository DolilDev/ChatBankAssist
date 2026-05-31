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

  /* ----- Odpowiedź bota (treść z bazy wiedzy dodawana w kolejnym kroku) ----- */
  async function botReply() {
    const text =
      "Dziękuję za wiadomość. Za chwilę nauczę się odpowiadać na podstawie bazy wiedzy banku.";
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
  function init() {
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
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
