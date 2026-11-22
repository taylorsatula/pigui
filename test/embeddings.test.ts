// Long-term memory's embeddings at their boundary: the requests picloud sends, and how real mode finds the key to sign
// them with in Pi's configuration. Both against a local stand-in endpoint and a temporary Pi directory.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { readConfig } from "../src/server/config.ts";
import { silentLogger } from "../src/server/log.ts";
import { httpEmbedder, piEmbedder } from "../src/server/memory/embedder.ts";
import { leafEmbedder, leafInstalled } from "../src/server/memory/leaf.ts";

type Received = { authorization: string | undefined; model: string; input: string[] };

describe("embeddings", () => {
	let server: Server;
	let url: string;
	let failWith: number | undefined;
	const received: Received[] = [];
	before(async () => {
		server = createServer((request, response) => {
			let body = "";
			request.on("data", (chunk: Buffer) => (body += chunk.toString()));
			request.on("end", () => {
				const parsed = JSON.parse(body) as { model: string; input: string[] };
				received.push({ authorization: request.headers.authorization, ...parsed });
				if (failWith !== undefined) {
					response.writeHead(failWith).end("no capacity");
					return;
				}
				// Out of order, as a provider may return them: each vector holds its input's number.
				const data = parsed.input.map((text, index) => ({ index, embedding: [Number(text.split(" ")[1]), 1] })).reverse();
				response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data }));
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/embeddings`;
	});
	after(() => new Promise<void>((resolve) => server.close(() => resolve())));

	test("posts the model and texts in batches of 128, signed, and reads each vector by its index", async () => {
		received.length = 0;
		const texts = Array.from({ length: 130 }, (_, i) => `text ${i}`);
		const vectors = await httpEmbedder({ url, model: "emb-test", apiKey: "secret" }).embed(texts, "document");
		assert.deepEqual(
			received.map((request) => request.input.length),
			[128, 2],
		);
		assert.equal(received[0]!.authorization, "Bearer secret");
		assert.equal(received[0]!.model, "emb-test");
		assert.deepEqual(
			vectors.map((vector) => vector[0]),
			texts.map((_, i) => i),
		);
	});

	test("a failed request says which endpoint answered what", async () => {
		failWith = 503;
		try {
			await assert.rejects(httpEmbedder({ url, model: "emb-test", apiKey: undefined }).embed(["text 1"], "document"), new RegExp(`HTTP 503 from ${url} — no capacity`));
		} finally {
			failWith = undefined;
		}
	});

	test("real mode signs with the key Pi holds for the memory provider, and is off without one", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "picloud-pi-"));
		const resolve = async (env: Record<string, string>) => {
			const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
			return piEmbedder(runtime, agentDir, readConfig({ PICLOUD_DATA_DIR: agentDir, PICLOUD_FAKE: "1", ...env }).memory);
		};
		try {
			const off = await resolve({});
			assert.ok("off" in off);
			assert.match(off.off, /no key for lunaroute/);

			await writeFile(join(agentDir, "auth.json"), JSON.stringify({ lunaroute: { type: "api_key", key: "from-auth-json" } }));
			received.length = 0;
			const on = await resolve({ PICLOUD_MEMORY_EMBED_URL: url });
			assert.ok("embedder" in on);
			assert.equal(on.embedder.model, "emb-qwen3");
			await on.embedder.embed(["text 1"], "document");
			assert.equal(received[0]?.authorization, "Bearer from-auth-json");

			await writeFile(join(agentDir, "auth.json"), JSON.stringify({ lunaroute: { type: "api_key", key: "!pass show lunaroute" } }));
			const command = await resolve({});
			assert.ok("off" in command);
			assert.match(command.off, /is a command/);
		} finally {
			await rm(agentDir, { recursive: true, force: true });
		}
	});
});

/** The real models are tried only where this checkout has them (npm ci, then deploy/models.sh models memory). */
const leaf = await leafInstalled();

describe("LEAF on this server", { skip: leaf ? false : "the memory models are not installed: deploy/models.sh models memory" }, () => {
	// Three memories written to the create rules, and searches for them that share no content word with them.
	const memories = [
		"`git commit -m` truncates a multi-line message at its first double quote and parses the remaining words as pathspecs, failing with \"did not match any file(s) known to git\" and committing nothing. Commit text goes through `git commit -F <file>`. Verify stale by: committing a message that holds a quote from a scratch repo.",
		"dockerd in the Claude Code cloud sandbox stops periodically and is restarted with `dockerd --data-root` pointing under the session scratchpad; image builds there need `--network host` and base images re-tagged with the proxy CA. Verify stale by: a build without --network host succeeding.",
		"Web Push to iOS reaches the phone only once the PWA is added to the home screen and notifications are allowed from inside it; Safari tabs receive nothing. Verify stale by: subscribing from a Safari tab on a current iOS release.",
	];
	const searches = [
		"I am recording finished work in version control from a shell with no terminal attached. The description spans several lines and contains quotation marks. Success is a history entry whose text matches what I wrote.",
		"I am producing a container image inside an ephemeral cloud workspace. The image pulls packages during its build. I want the build to finish instead of failing on certificate or connection errors.",
		"I am investigating why alerts about finished runs never show on an iPhone. The client is a web app opened in the mobile browser. A good outcome is a banner arriving while the phone is locked.",
	];
	const offTopic = [
		"Explain the plot of a nineteenth century novel in which an inheritance is contested by distant relatives. I need the chapter structure summarised.",
		"I am researching the history of municipal tram networks in central Europe. I want to know why so many were closed in the nineteen sixties.",
	];
	const embedder = leafEmbedder(silentLogger);
	const dot = (a: Float32Array, b: Float32Array) => a.reduce((sum, value, i) => sum + value * b[i]!, 0);

	test("finds each memory from a search in other words, above its floor, and no memory from an unrelated one", async () => {
		const stored = await embedder.embed(memories, "document");
		for (const vector of stored) {
			assert.equal(vector.length, 768);
			assert.ok(Math.abs(Math.sqrt(dot(vector, vector)) - 1) < 1e-3, "the vectors are normalised");
		}
		const queries = await embedder.embed(searches, "query");
		queries.forEach((query, target) => {
			const similarities = stored.map((vector) => dot(query, vector));
			const best = similarities.indexOf(Math.max(...similarities));
			assert.equal(best, target, `search ${target} found memory ${best}`);
			assert.ok(similarities[target]! >= embedder.floor, `search ${target} matched at ${similarities[target]}`);
		});
		for (const query of await embedder.embed(offTopic, "query")) {
			assert.ok(Math.max(...stored.map((vector) => dot(query, vector))) < embedder.floor);
		}
	});

	test("embeds a text the same whatever is embedded with it, since stored vectors must reproduce", async () => {
		const [alone] = await embedder.embed([memories[0]!], "document");
		const together = await embedder.embed(["short", ...memories], "document");
		assert.deepEqual(together[1], alone);
	});
});
