import http from "node:http"; import { readFile } from "node:fs/promises"; import { join, extname } from "node:path";
import { chromium } from "playwright";
const nm = join(process.cwd(), "node_modules");
const map = { "/vendor/preact.mjs": "preact/dist/preact.mjs", "/vendor/hooks.mjs": "preact/hooks/dist/hooks.mjs", "/vendor/htm.mjs": "htm/dist/htm.mjs", "/vendor/marked.mjs": "marked/lib/marked.esm.js", "/vendor/purify.mjs": "dompurify/dist/purify.es.mjs" };
const page = `<!doctype html><script type="importmap">{"imports":{"preact":"/vendor/preact.mjs","preact/hooks":"/vendor/hooks.mjs","htm":"/vendor/htm.mjs","marked":"/vendor/marked.mjs","dompurify":"/vendor/purify.mjs","chord-delta":"/vendor/chord/delta/index.js"}}</script>
<div id=app></div><script type=module>
import { h, render } from "preact"; import { useState } from "preact/hooks"; import htm from "htm"; import { marked } from "marked"; import DOMPurify from "dompurify"; import { applyImmutable } from "chord-delta";
const html = htm.bind(h); const v = applyImmutable({a:{b:1}}, [["r",{a:{b:2}}]]);
render(html\`<p id=out>\${JSON.stringify(v)} \${DOMPurify.sanitize(marked.parse("**x**"))}</p>\`, document.getElementById("app"));
</script>`;
const srv = http.createServer(async (req, res) => {
  try {
    if (req.url === "/") { res.setHeader("content-type","text/html"); return res.end(page); }
    let f = map[req.url]; if (!f && req.url.startsWith("/vendor/chord/")) f = "@earendil-works/chord/dist/" + req.url.slice(14);
    res.setHeader("content-type", "text/javascript"); res.end(await readFile(join(nm, f)));
  } catch { res.statusCode = 404; res.end(); }
}).listen(0, async () => {
  const b = await chromium.launch(); const p = await b.newPage(); const errs = []; p.on("pageerror", e => errs.push(e.message)); p.on("console", m => m.type()==="error" && errs.push(m.text()));
  await p.goto(`http://127.0.0.1:${srv.address().port}/`); await p.waitForSelector("#out", { timeout: 5000 }).catch(()=>{});
  console.log("rendered:", await p.locator("#out").innerHTML().catch(()=>"(none)"), "errors:", errs);
  await b.close(); srv.close();
});
