"use strict";

/* Pilnuje, że knowledge_base.md jest aktualny względem knowledge_base.json.
   Jeśli ten test pada — uruchom `npm run kb:md` i zacommituj wynik. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { renderMarkdown, loadKb, MD_PATH } = require("../scripts/generate-kb-md.js");

test("knowledge_base.md zgadza się z knowledge_base.json", function () {
  const expected = renderMarkdown(loadKb());
  const actual = fs.readFileSync(MD_PATH, "utf8");
  assert.equal(
    actual,
    expected,
    "knowledge_base.md jest nieaktualny — uruchom `npm run kb:md`."
  );
});
