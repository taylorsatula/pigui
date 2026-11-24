// How the local speech and memory models are held: loaded at start and kept, or loaded on use and released when idle
// (PIGUI_MODELS_UNLOAD). A stand-in model counts its loads and releases, so this needs neither model installed.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { readConfig } from "../src/server/config.ts";
import { heldModel } from "../src/server/held-model.ts";
import { silentLogger } from "../src/server/log.ts";

function standIn(unloadAfterMs: number | undefined, failFirst = false) {
	const counts = { loads: 0, releases: 0 };
	const model = heldModel({
		name: "test",
		load: async () => {
			counts.loads++;
			if (failFirst && counts.loads === 1) throw new Error("no weights");
			return { id: counts.loads };
		},
		release: async () => {
			counts.releases++;
		},
		unloadAfterMs,
		log: silentLogger,
	});
	return { counts, model };
}

test("never unloaded: the model loads as pigui starts and stays", async () => {
	const { counts, model } = standIn(undefined);
	assert.equal(counts.loads, 1, "loaded before any use");
	assert.equal(await model.use(async (it) => it.id), 1);
	await sleep(30);
	assert.equal(await model.use(async (it) => it.id), 1);
	assert.deepEqual(counts, { loads: 1, releases: 0 });
});

test("unloaded when idle: loaded on first use, released after the idle time, loaded again by the next use", async () => {
	const { counts, model } = standIn(20);
	assert.equal(counts.loads, 0, "nothing loads before it is used");
	assert.equal(await model.use(async (it) => it.id), 1);
	await sleep(60);
	assert.deepEqual(counts, { loads: 1, releases: 1 });
	assert.equal(await model.use(async (it) => it.id), 2);
});

test("a model in use is not released, however long the use takes, and the idle time starts after it", async () => {
	const { counts, model } = standIn(20);
	await model.use(async () => {
		await sleep(60);
	});
	assert.equal(counts.releases, 0);
	// A use that starts before the idle time is up keeps it loaded.
	await sleep(5);
	await model.use(async () => undefined);
	assert.deepEqual(counts, { loads: 1, releases: 0 });
	await sleep(60);
	assert.equal(counts.releases, 1);
});

test("a load that fails is tried again by the next use", async () => {
	const { counts, model } = standIn(20, true);
	await assert.rejects(model.use(async (it) => it.id), /no weights/);
	assert.equal(await model.use(async (it) => it.id), 2);
	assert.equal(counts.loads, 2);
});

test("PIGUI_MODELS_UNLOAD: never by default, idle minutes when given, and anything else refused", () => {
	const config = (value: string | undefined) => readConfig({ PIGUI_DATA_DIR: "/tmp/pigui-test", PIGUI_FAKE: "1", PIGUI_MODELS_UNLOAD: value });
	assert.equal(config(undefined).modelsUnloadAfterMs, undefined);
	assert.equal(config("never").modelsUnloadAfterMs, undefined);
	assert.equal(config("5").modelsUnloadAfterMs, 5 * 60_000);
	assert.equal(config("01").modelsUnloadAfterMs, 60_000);
	for (const bad of ["0", "1.5", "always", "1441", "0x10", "1e2", "-5"]) assert.throws(() => config(bad), /PIGUI_MODELS_UNLOAD must be never, or a whole number of idle minutes/);
});
