"use strict";

/* Testy rdzenia dopasowania (window.BankBot) — uruchamiane przez `node --test`. */
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const { BankBot, kbJson, ready } = require("./harness.js");

before(async function () {
  await ready();
});

/* ----- normalize ----- */
test("normalize: małe litery, bez diakrytyków i interpunkcji", function () {
  assert.equal(BankBot.normalize("Zażółć GĘŚLĄ jaźń!"), "zazolc gesla jazn");
  assert.equal(BankBot.normalize("Przelew — 100 zł?"), "przelew 100 zl");
  assert.equal(BankBot.normalize("   wiele   spacji  "), "wiele spacji");
});

/* ----- detectLanguage ----- */
test("detectLanguage: rozpoznaje polski i angielski", function () {
  assert.equal(BankBot.detectLanguage("Jak otworzyć konto?"), "pl"); // diakrytyk
  assert.equal(BankBot.detectLanguage("How do I open an account?"), "en");
  assert.equal(BankBot.detectLanguage("ile kosztuje konto"), "pl"); // brak sygnału EN
  assert.equal(BankBot.detectLanguage("can you help me block my card"), "en");
});

/* ----- Niezmiennik: żadne pytanie z bazy nie eskaluje ----- */
test("każde pytanie z bazy (pl i en) znajduje dopasowanie", function () {
  kbJson.entries.forEach(function (e) {
    const pl = BankBot.findAnswer(e.q.pl);
    assert.ok(pl, "brak dopasowania dla PL: " + e.id + " — " + e.q.pl);
    const en = BankBot.findAnswer(e.q.en);
    assert.ok(en, "brak dopasowania dla EN: " + e.id + " — " + e.q.en);
  });
});

/* ----- Jednoznaczne dopasowania kanoniczne ----- */
const CANONICAL = [
  ["Jak otworzyć konto osobiste?", "open-account-online"],
  ["Ile kosztuje prowadzenie konta?", "account-fees"],
  ["Jak wykonać przelew?", "how-to-transfer"],
  ["Zgubiłem kartę, jak ją zablokować?", "block-card"],
  ["Jak ustawić zlecenie stałe?", "standing-order"],
  ["Dostałem podejrzany SMS z banku", "phishing"],
  ["Jak złożyć reklamację?", "file-complaint"],
  ["Jak wziąć kredyt gotówkowy?", "cash-loan"],
  ["Jak założyć lokatę terminową?", "term-deposit"],
  ["Jak włączyć logowanie biometryczne?", "biometric-login"],
];

test("jednoznaczne pytania trafiają w konkretny wpis", function () {
  CANONICAL.forEach(function (pair) {
    const m = BankBot.findAnswer(pair[0]);
    assert.ok(m, "brak dopasowania: " + pair[0]);
    assert.equal(m.entry.id, pair[1], "„" + pair[0] + "” → " + m.entry.id);
  });
});

/* ----- Punkt 4: odmiana, literówki, synonimy ----- */
test("odmiana fleksyjna trafia w ten sam wpis (stemming)", function () {
  // „przelewy”/„przelewu” zamiast „przelew”
  assert.equal(BankBot.findAnswer("chcę zrobić przelewy").entry.category, "przelewy");
  // „karty”/„kartę”
  assert.equal(BankBot.findAnswer("jak zablokowac karty").entry.id, "block-card");
});

test("literówka (Levenshtein ≤ 1) nadal trafia w temat", function () {
  // „przlew” zamiast „przelew” (brak jednej litery)
  assert.equal(BankBot.findAnswer("ile trwa przlew").entry.category, "przelewy");
  // „reklamcję” zamiast „reklamację” (brak jednej litery)
  assert.equal(BankBot.findAnswer("jak zlozyc reklamcje").entry.id, "file-complaint");
});

test("synonim / mostek PL↔EN trafia w temat", function () {
  // „pożyczka” jako synonim „kredyt”
  assert.equal(BankBot.findAnswer("potrzebuję pożyczki gotówkowej").entry.category, "kredyty");
  // angielskie „password” w polskim zapytaniu trafia w reset hasła
  assert.equal(BankBot.findAnswer("zapomniałem password").entry.id, "password-reset");
});

/* ----- Eskalacja dla pytań spoza bazy ----- */
test("pytania spoza bazy wiedzy zwracają null (eskalacja)", function () {
  assert.equal(BankBot.findAnswer("Czy oferujecie ubezpieczenie na życie?"), null);
  assert.equal(BankBot.findAnswer("Jaki jest dzisiaj kurs dolara?"), null);
  assert.equal(BankBot.findAnswer("Polećcie dobrą pizzę w okolicy"), null);
});

test("escalationText zwraca komunikat w obu językach", function () {
  assert.match(BankBot.escalationText("pl"), /konsultanta/i);
  assert.match(BankBot.escalationText("en"), /consultant/i);
});
