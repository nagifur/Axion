import assert from "node:assert/strict";
import test from "node:test";
import { findUnsafeMarkdown } from "../scripts/submissionSafety.mjs";

test("accepts normal submissions", () => {
  const markdown = [
    "---",
    "title: My Entity",
    "gallery:",
    "  - file: 1.png",
    "    caption: Caption",
    "---",
    "I <3 cats, 1 < 2, a -> b, <- left.",
    "{{hover|tooltip}} and $x^2$.",
    '::image{file="1.png" folder="x" alt="A" caption="B" align="left"}',
    "[site](https://example.com) [mail](mailto:a@b.c) [page](/Entities/a-071) [anchor](#top)",
    "[ref]: https://example.com",
    "Data: 5, metadata: none, note: javascript is fun.",
  ].join("\n");
  assert.equal(findUnsafeMarkdown(markdown), null);
});

test("rejects raw HTML", () => {
  for (const html of ["<script>alert(1)</script>", "<img src=x onerror=alert(1)>", "</p>", "<!-- x -->", "<?php", "<https://x.y>"]) {
    assert.match(findUnsafeMarkdown(`Hello ${html}`), /HTML is not allowed/, html);
  }
});

test("rejects dangerous link schemes, including obfuscated ones", () => {
  const links = [
    "[x](javascript:alert(1))",
    "[x](JavaScript:alert(1))",
    "[x]( javascript:alert(1))",
    "![x](data:image/svg+xml,abc)",
    "[x](vbscript:msgbox)",
    "[x](jav&#x61;script:alert(1))",
    "[x](jav&#97;script:alert(1))",
    "[x](java&#9;script:alert(1))",
    "[x](javascript&colon;alert(1))",
    "[x][r]\n\n[r]: javascript:alert(1)",
    "> [r]: javascript:alert(1)",
    "[x](file:///etc/passwd)",
  ];
  for (const link of links) {
    assert.match(findUnsafeMarkdown(link) ?? "", /not allowed/, link);
  }
});

test("does not trip over prototype names in character references", () => {
  assert.equal(findUnsafeMarkdown("&constructor; &__proto__; &amp;"), null);
});
