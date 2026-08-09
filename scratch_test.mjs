import { esc, h, raw } from "./js/ui.js";

const payloads = [
  `<img src=x onerror=alert(1)>`,
  `"><script>alert(1)</script>`,
  `" onmouseover="alert(1)`,
  `'><svg/onload=alert(1)>`,
  `javascript:alert(1)`,
  `\${alert(1)}`,
  "`+alert(1)+`",
];
console.log("=== esc ===");
for (const p of payloads) console.log(JSON.stringify(esc(p)));

console.log("=== h in element ctx ===");
for (const p of payloads) console.log(JSON.stringify(h`<div>${p}</div>`));

console.log("=== h in attr ctx ===");
for (const p of payloads) console.log(JSON.stringify(h`<a title="${p}" href="x#${p}">y</a>`));

console.log("=== h array ctx ===");
console.log(JSON.stringify(h`<ul>${payloads.map((p)=>h`<li>${p}</li>`)}</ul>`));

// Does raw() bypass? (expected: yes, but only used on trusted/h content)
console.log("=== raw bypass (by design) ===");
console.log(JSON.stringify(h`<div>${raw("<b>x</b>")}</div>`));
