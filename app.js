/* =========================================================================
   Bank Przykładowy — Asystent klienta
   Logika aplikacji (vanilla JS, bez frameworków, bez backendu).
   ========================================================================= */
"use strict";

(function () {
  /* ----- Referencje DOM ----- */
  const dom = {};

  /* ----- Pomocnicze ----- */
  function $(sel) {
    return document.querySelector(sel);
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

  /* ----- Odpowiedź bota (placeholder — w kolejnych krokach: streaming + baza wiedzy) ----- */
  function botReply() {
    addMessage(
      "bot",
      "Dziękuję za wiadomość. Za chwilę nauczę się odpowiadać na podstawie bazy wiedzy banku."
    );
  }

  /* ----- Wysyłanie wiadomości ----- */
  function handleSubmit(e) {
    e.preventDefault();
    const text = dom.input.value.trim();
    if (!text) return;

    addMessage("user", text);
    dom.input.value = "";
    autoResize();
    botReply(text);
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
