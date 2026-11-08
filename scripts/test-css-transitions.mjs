import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync("packages/app/src/index.css", "utf8");
const blockquote = css.match(/\.chat-md blockquote\s*\{[\s\S]*?\}/)?.[0];
assert.ok(blockquote, "chat-md blockquote 规则必须存在");
assert.match(
  blockquote,
  /box-shadow\s+var\(--md-t\)\s+var\(--md-ease\)/,
  "box-shadow 的 transition 必须保留时长 token，避免整条 shorthand 失效",
);
console.log("PASS chat-md blockquote transition duration");
