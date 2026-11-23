// Fake mode, ready to use: a temporary data directory, an empty Pi configuration directory and a free port unless
// PIGUI_PORT says otherwise. Safe on a machine where a real pigui runs: it touches none of that one's state.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "../src/server/app.ts";
import { readConfig } from "../src/server/config.ts";

const dataDir = process.env.PIGUI_DATA_DIR ?? (await mkdtemp(join(tmpdir(), "pigui-fake-")));
const agentDir = process.env.PI_CODING_AGENT_DIR ?? (await mkdtemp(join(tmpdir(), "pigui-pi-")));
const config = readConfig({ ...process.env, PIGUI_FAKE: "1", PIGUI_DATA_DIR: dataDir, PIGUI_PORT: process.env.PIGUI_PORT ?? "0" });
const tokensPerSecond = Number(process.env.PIGUI_FAKE_TOKENS_PER_SECOND ?? 60);
// PIGUI_FAKE_MEMORY=off shows the app as a server without an embedder shows it.
const memoryOff = process.env.PIGUI_FAKE_MEMORY === "off";
const app = await startApp({
	config,
	agentDir,
	fakeModel: { tokensPerSecond },
	...(memoryOff ? { embedder: { off: "This fake server was started with PIGUI_FAKE_MEMORY=off." } } : {}),
});
process.stdout.write(`pigui fake mode on ${app.url}\ndata: ${dataDir}\n`);

const stop = () => {
	void app.close().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
