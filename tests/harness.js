"use strict";

/* =========================================================================
   Harness testowy — ładuje rdzeń window.BankBot z app.js w Node, bez
   przeglądarki. app.js jest zwykłym skryptem (IIFE) pisanym pod DOM, więc
   podstawiamy minimalne atrapy globali (window, document, fetch, storage),
   tak aby init() bezpiecznie wykonał no-op, a window.BankBot został wyeksponowany.
   ========================================================================= */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const kbJson = JSON.parse(
  fs.readFileSync(path.join(ROOT, "knowledge-base.json"), "utf8")
);

function memStore() {
  const m = new Map();
  return {
    getItem: function (k) { return m.has(k) ? m.get(k) : null; },
    setItem: function (k, v) { m.set(k, String(v)); },
    removeItem: function (k) { m.delete(k); },
  };
}

const stubEl = {
  setAttribute: function () {},
  getAttribute: function () { return null; },
  appendChild: function () {},
  addEventListener: function () {},
  remove: function () {},
  style: {},
  classList: { add: function () {}, remove: function () {}, toggle: function () {} },
};

global.window = {};
global.localStorage = memStore();
global.sessionStorage = memStore();
global.document = {
  readyState: "complete",
  documentElement: { getAttribute: function () { return null; }, setAttribute: function () {} },
  querySelector: function () { return null; },
  getElementById: function () { return null; },
  createElement: function () { return Object.create(stubEl); },
  addEventListener: function () {},
};
// fetch zwraca lokalną bazę wiedzy z dysku.
global.fetch = async function () {
  return { ok: true, status: 200, json: async function () { return kbJson; } };
};

require(path.join(ROOT, "app.js")); // efekt uboczny: ustawia window.BankBot
const BankBot = global.window.BankBot;

let loaded = false;
async function ready() {
  if (!loaded) {
    await BankBot.loadKnowledgeBase();
    loaded = true;
  }
  return BankBot;
}

module.exports = { BankBot: BankBot, kbJson: kbJson, ready: ready, ROOT: ROOT };
