// The service entry point. Real mode checks Pi's sign-in before it touches anything, so a fresh install that has not
// been signed in exits with instructions instead of creating a data directory it cannot use.
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { startApp } from "./app.ts";
import { ConfigError, readConfig } from "./config.ts";
import { createLogger, errorKind } from "./log.ts";
import { loadPiModels, NotSignedIn } from "./pi.ts";

async function main(): Promise<void> {
	const log = createLogger();
	let config;
	try {
		config = readConfig(process.env);
	} catch (error) {
		exitOnConfigError(error);
	}
	let pi;
	let agentDir: string;
	if (config.fake) {
		// Fake mode never reads the operator's Pi configuration: it gets an empty one of its own.
		agentDir = process.env.PI_CODING_AGENT_DIR ?? (await mkdtemp(join(tmpdir(), "picloud-pi-")));
		await mkdir(agentDir, { recursive: true });
	} else {
		agentDir = getAgentDir();
		try {
			const loaded = await loadPiModels(agentDir);
			pi = { models: loaded.runtime, defaultModel: loaded.defaultModel };
		} catch (error) {
			if (error instanceof NotSignedIn) {
				process.stderr.write(`${error.message}\n`);
				process.exit(78);
			}
			throw error;
		}
	}
	let app;
	try {
		app = await startApp(pi === undefined ? { config, agentDir } : { config, agentDir, pi });
	} catch (error) {
		// A sandbox that does not work on this machine is a configuration problem too: restarting cannot fix it.
		exitOnConfigError(error);
	}
	process.stdout.write(`picloud is listening on ${app.url}${config.fake ? " (fake mode)" : ""}\n`);
	let stopping = false;
	const stop = (signal: string) => {
		if (stopping) return;
		stopping = true;
		log.info("stopping", { signal });
		app.close().then(
			() => process.exit(0),
			(error: unknown) => {
				log.error("stop.failed", { error: errorKind(error) });
				process.exit(1);
			},
		);
	};
	process.on("SIGTERM", () => stop("SIGTERM"));
	process.on("SIGINT", () => stop("SIGINT"));
}

/** Exit with code 2 and the message for a configuration problem; rethrow anything else. */
function exitOnConfigError(error: unknown): never {
	if (error instanceof ConfigError) {
		process.stderr.write(`${error.message}\n`);
		process.exit(2);
	}
	throw error;
}

main().catch((error: unknown) => {
	process.stderr.write(`picloud failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
