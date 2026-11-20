import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../site/app.js", import.meta.url), "utf8");
const themes = src.match(/const THEMES = (\{[\s\S]*?\n\});/);
assert.ok(themes, "bloc THEMES absent de app.js");
const T = Function(`return ${themes[1]}`)();
assert.deepEqual(Object.keys(T.light).sort(), Object.keys(T.dark).sort(), "clés différentes entre clair et sombre");
for (const k of ["main", "grid", "bad", "good", "ink", "muted", "card"]) assert.ok(T.light[k] && T.dark[k], `clé ${k} manquante`);
const rest = src.replace(themes[0], "").split("\n").filter((l) => !/^const PALETTE/.test(l));
const hex = rest.filter((l) => /["'`]#[0-9a-fA-F]{3,6}\b|rgba\(\s*\d/.test(l));
assert.deepEqual(hex, [], "couleurs écrites en dur restantes");
assert.match(src, /function applyTheme\(/);
assert.match(src, /function toggleTheme\(/);
console.log("theme.test : OK");
