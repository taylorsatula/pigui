// Focused server-side verification of the greenfield HTML/CSS/VanillaJS/API UI layer:
// safe Markdown XSS blocking, SSR routes, dialog fragments, granular SSE stream, broken-star non-looping, and SW/assets.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { renderInline, renderMarkdown } from "../src/server/ui/markdown.ts";
import { SessionIndexToken } from "../src/server/documents.ts";
import { context, TestServer } from "./helpers.ts";

describe("safe server-side markdown", () => {
	test("escapes raw HTML tags and blocks unsafe URL schemes while keeping GFM and safe links", () => {
		const xss = [
			`<script>alert(1)</script>`,
			`<img src=x onerror=alert(2)>`,
			`<svg onload=alert(3)>`,
			`<style>body{display:none}</style>`,
			`<form action="/evil"><input name="x"></form>`,
			`[click](javascript:alert(4))`,
			`[encoded](java&#x73;cript:alert(5))`,
			`[data](data:text/html,<script>alert(6)</script>)`,
			`![alt](https://example.com/pic.png)`,
			`[ok](https://example.com/docs "Docs")`,
		].join("\n\n");

		const out = renderMarkdown(xss).value;
		assert.doesNotMatch(out, /<script[\s>]/i);
		assert.doesNotMatch(out, /alert\(1\)/);
		assert.doesNotMatch(out, /<img[\s>]/i);
		assert.doesNotMatch(out, /<svg[\s>]/i);
		assert.doesNotMatch(out, /<style[\s>]/i);
		assert.doesNotMatch(out, /<form[\s>]/i);
		assert.doesNotMatch(out, /<input[\s>]/i);
		assert.doesNotMatch(out, /href="javascript:/i);
		assert.doesNotMatch(out, /href="java&#x73;cript:/i);
		assert.doesNotMatch(out, /href="data:/i);
		assert.match(out, /<a href="https:\/\/example\.com\/docs" title="Docs" target="_blank" rel="noopener noreferrer">ok<\/a>/);

		const inline = renderInline("Use `greet()` and **bold** <script>x</script>").value;
		assert.match(inline, /<code>greet\(\)<\/code>/);
		assert.match(inline, /<strong>bold<\/strong>/);
		assert.doesNotMatch(inline, /<script>/);
	});
});

describe("SSR pages, fragments, SSE, and static assets", () => {
	test("serves SSR HTML pages, redirects invalid /start, and returns 404 HTML for missing sessions", async () => {
		const server = await TestServer.start();
		try {
			const splash = await fetch(`${server.app.url}/`);
			assert.equal(splash.status, 200);
			assert.match(splash.headers.get("content-type") ?? "", /text\/html/);
			const splashHtml = await splash.text();
			assert.match(splashHtml, /data-page="splash"/);
			assert.match(splashHtml, /href="\/css\/app\.css"/);
			assert.match(splashHtml, /src="\/js\/app\.js"/);

			const badStart = await fetch(`${server.app.url}/start`, { redirect: "manual" });
			assert.equal(badStart.status, 302);
			assert.equal(badStart.headers.get("location"), "/");

			const validStart = await fetch(`${server.app.url}/start?place=repo&repo=demo/greeter&mode=new&base=main`);
			assert.equal(validStart.status, 200);
			assert.match(await validStart.text(), /demo\/greeter · new branch from main/);

			const missing = await fetch(`${server.app.url}/s/99999`);
			assert.equal(missing.status, 404);
			assert.match(await missing.text(), /This session does not exist/);

			const sw = await fetch(`${server.app.url}/sw.js`);
			assert.equal(sw.status, 200);
			const swText = await sw.text();
			assert.match(swText, /^const BUILD_ID = "[0-9a-f]{12}";/);
			assert.match(swText, /const SHELL = \[.*\/css\/app\.css.*\/js\/app\.js.*\/icons\/icon-192\.png/s);

			for (const path of ["/css/app.css", "/js/app.js", "/vendor/idiomorph.esm.js", "/shared/references.js", "/shared/wav.js", "/manifest.webmanifest", "/icons/icon-192.png", "/fonts/ibm-plex-mono-latin-400-normal.woff2"]) {
				const res = await fetch(`${server.app.url}${path}`);
				assert.equal(res.status, 200, path);
			}
		} finally {
			await server.close();
		}
	});

	test("renders session SSR, dialog fragments, and granular SSE events without Chord ops", async () => {
		const server = await TestServer.start();
		try {
			const id = await server.createSession("What does greet() return?");
			await server.until(id, (doc) => doc.outcome?.kind === "replied", "replied");

			const sessionRes = await fetch(`${server.app.url}/s/${id}`);
			assert.equal(sessionRes.status, 200);
			const sessionHtml = await sessionRes.text();
			assert.match(sessionHtml, /data-page="session"/);
			assert.match(sessionHtml, /What does greet\(\) return\?/);
			assert.match(sessionHtml, /data-block-key="/);

			const pickerRes = await fetch(`${server.app.url}/ui/picker?current=${id}&sort=modified&dir=desc`);
			assert.equal(pickerRes.status, 200);
			const pickerHtml = await pickerRes.text();
			assert.match(pickerHtml, /aria-current="page"/);
			assert.match(pickerHtml, /data-sort-name="/);

			const reposRes = await fetch(`${server.app.url}/ui/repos`);
			assert.equal(reposRes.status, 200);
			assert.match(await reposRes.text(), /demo\/greeter/);

			// Granular SSE emits ready, attention, header, and blocks — never raw Chord ops.
			const controller = new AbortController();
			const sse = await fetch(`${server.app.url}/api/events?page=session&session=${id}`, { signal: controller.signal });
			assert.equal(sse.status, 200);
			assert.match(sse.headers.get("content-type") ?? "", /text\/event-stream/);
			const reader = sse.body!.getReader();
			const decoder = new TextDecoder();
			let text = "";
			while (!text.includes("event: blocks")) {
				const { value, done } = await reader.read();
				if (done) break;
				text += decoder.decode(value, { stream: true });
			}
			controller.abort();
			await reader.cancel().catch(() => undefined);
			assert.match(text, /event: ready/);
			assert.match(text, /event: header/);
			assert.match(text, /event: blocks/);
			assert.doesNotMatch(text, /"t":"view-ops"/);
		} finally {
			await server.close();
		}
	});

	test("negative-caches broken starred repositories on / so repeated loads never storm the repo host", async () => {
		const server = await TestServer.start();
		try {
			await server.app.harness.commit(async (tx) => {
				const index = await tx.doc(SessionIndexToken);
				index.starredRepos = ["ghost/does-not-exist"];
			}, context);

			let branchCalls = 0;
			const origBranches = server.app.host.branches.bind(server.app.host);
			server.app.host.branches = async (repo: string) => {
				branchCalls += 1;
				return origBranches(repo);
			};

			for (let i = 0; i < 5; i++) {
				const res = await fetch(`${server.app.url}/`);
				assert.equal(res.status, 200);
				const body = await res.text();
				assert.match(body, /ghost\/does-not-exist/);
			}
			assert.equal(branchCalls, 1, "broken starred repo is queried once and cached, never retried per load");
		} finally {
			await server.close();
		}
	});
});
