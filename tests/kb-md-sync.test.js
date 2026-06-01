"use strict";

/* Pilnuje, że knowledge-base.md jest aktualny względem knowledge-base.json.
   Jeśli ten test pada — uruchom `npm run kb:md` i zacommituj wynik. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { renderMarkdown, loadKb, MD_PATH } = require("../scripts/generate-knowledge-base-md.js");

test("knowledge-base.md zgadza się z knowledge-base.json", function () {
  const expected = renderMarkdown(loadKb());
  const actual = fs.readFileSync(MD_PATH, "utf8");
  assert.equal(
    actual,
    expected,
    "knowledge-base.md jest nieaktualny — uruchom `npm run kb:md`."
  );
});
