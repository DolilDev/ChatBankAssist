"use strict";

/* =========================================================================
   Generator knowledge_base.md z knowledge_base.json.
   Jedno źródło prawdy (JSON) → czytelna dokumentacja (Markdown).
   Uruchom: `npm run kb:md` (albo `node scripts/generate-kb-md.js`).
   Test tests/kb-md-sync.test.js pilnuje, by plik .md nie rozjechał się z .json.
   ========================================================================= */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const JSON_PATH = path.join(ROOT, "knowledge_base.json");
const MD_PATH = path.join(ROOT, "knowledge_base.md");

// Buduje treść Markdown z obiektu bazy wiedzy. Czysta funkcja (łatwa do testów).
function renderMarkdown(kb) {
  const meta = kb.meta || {};
  const cats = kb.categories || {};
  const entries = Array.isArray(kb.entries) ? kb.entries : [];
  const out = [];

  out.push("# Baza wiedzy — " + (meta.bank || "Bank"));
  out.push("");
  out.push("- **Bank:** " + (meta.bank || ""));
  out.push("- **Wersja:** " + (meta.version || ""));
  out.push("- **Języki:** " + ((meta.languages || []).join(", ")));
  out.push("- **Aktualizacja:** " + (meta.updated || ""));
  out.push("");

  if (kb.escalation) {
    out.push("## Wiadomość eskalacyjna");
    out.push("");
    out.push("**PL:** " + kb.escalation.pl);
    out.push("");
    out.push("**EN:** " + kb.escalation.en);
    out.push("");
  }

  Object.keys(cats).forEach(function (catKey) {
    const inCat = entries.filter(function (e) { return e.category === catKey; });
    if (!inCat.length) return;
    const cat = cats[catKey];
    const labelPl = (cat.label && cat.label.pl) || catKey;
    const labelEn = (cat.label && cat.label.en) || catKey;

    out.push("---");
    out.push("");
    out.push("# " + labelPl + " / " + labelEn);

    inCat.forEach(function (e) {
      out.push("");
      out.push("## " + e.q.pl + " / " + e.q.en);
      out.push("");
      out.push("**Słowa kluczowe:** " + (e.keywords || []).join(", "));
      out.push("");
      out.push("**PL:** " + e.a.pl);
      out.push("");
      out.push("**EN:** " + e.a.en);
    });
    out.push("");
  });

  return out.join("\n").replace(/\n+$/, "\n");
}

function loadKb() {
  return JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
}

if (require.main === module) {
  fs.writeFileSync(MD_PATH, renderMarkdown(loadKb()), "utf8");
  console.log("Zapisano " + path.relative(ROOT, MD_PATH) + " z " + path.relative(ROOT, JSON_PATH));
}

module.exports = { renderMarkdown: renderMarkdown, loadKb: loadKb, MD_PATH: MD_PATH };
