import http from "node:http"; import { readFile } from "node:fs/promises"; import { join } from "node:path";
import { chromium } from "playwright";
const nm = join(process.cwd(), "node_modules");
const vendor = { "/vendor/preact.mjs": "preact/dist/preact.mjs", "/vendor/hooks.mjs": "preact/hooks/dist/hooks.mjs", "/vendor/jsx-runtime.mjs": "preact/jsx-runtime/dist/jsxRuntime.mjs", "/vendor/marked.mjs": "marked/lib/marked.esm.js", "/vendor/purify.mjs": "dompurify/dist/purify.es.mjs" };
const page = `<!doctype html><script type="importmap">{"imports":{"preact":"/vendor/preact.mjs","preact/hooks":"/vendor/hooks.mjs","preact/jsx-runtime":"/vendor/jsx-runtime.mjs","marked":"/vendor/marked.mjs","dompurify":"/vendor/purify.mjs","@earendil-works/chord/delta":"/vendor/chord/delta/index.js"}}</script><div id=app></div><script type=module src="/build/client/main.js"></script>`;
const srv = http.createServer(async (req, res) => { try {
  if (req.url === "/") { res.setHeader("content-type", "text/html"); return res.end(page); }
  let f = vendor[req.url]; let base = nm;
  if (!f && req.url.startsWith("/vendor/chord/")) f = "@earendil-works/chord/dist/" + req.url.slice(14);
  if (!f && req.url.startsWith("/build/")) { base = process.cwd(); f = req.url.slice(1); }
  res.setHeader("content-type", "text/javascript"); res.end(await readFile(join(base, f)));
} catch { res.statusCode = 404; res.end(); } }).listen(0, async () => {
  const b = await chromium.launch(); const p = await b.newPage(); const errs = [];
  p.on("pageerror", (e) => errs.push(e.message)); p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  await p.goto(`http://127.0.0.1:${srv.address().port}/`); await p.waitForSelector("#out", { timeout: 5000 }).catch(() => {});
  console.log("rendered:", await p.locator("main").innerHTML().catch(() => "(none)"), "| errors:", errs);
  await b.close(); srv.close(); });
