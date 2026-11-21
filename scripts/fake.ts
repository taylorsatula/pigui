// Fake mode, ready to use: a temporary data directory, an empty Pi configuration directory and a free port unless
// PICLOUD_PORT says otherwise. Safe on a machine where a real picloud runs: it touches none of that one's state.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "../src/server/app.ts";
import { readConfig } from "../src/server/config.ts";

const dataDir = process.env.PICLOUD_DATA_DIR ?? (await mkdtemp(join(tmpdir(), "picloud-fake-")));
const agentDir = process.env.PI_CODING_AGENT_DIR ?? (await mkdtemp(join(tmpdir(), "picloud-pi-")));
const config = readConfig({ ...process.env, PICLOUD_FAKE: "1", PICLOUD_DATA_DIR: dataDir, PICLOUD_PORT: process.env.PICLOUD_PORT ?? "0" });
const tokensPerSecond = Number(process.env.PICLOUD_FAKE_TOKENS_PER_SECOND ?? 60);
const app = await startApp({ config, agentDir, fakeModel: { tokensPerSecond } });
process.stdout.write(`picloud fake mode on ${app.url}\ndata: ${dataDir}\n`);

const stop = () => {
	void app.close().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
