import { isIP } from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ModelRef } from "@earendil-works/pi-durable";

/** Long-term memory's embeddings; memory is on only where a key or an explicit URL makes them reachable. */
export type MemoryConfig = {
	/** The Pi provider whose stored credential signs embedding requests. */
	provider: string;
	embedModel: string;
	/** Undefined: the provider's base URL in Pi's catalog plus /embeddings. */
	embedUrl: string | undefined;
};

/**
 * pigui OnPrem (`PIGUI_ONPREM=on`): it runs on the person's own computer, as them, with their home directory. Agent
 * commands get their environment and credentials, unconfined; local sessions work in any directory. It answers to
 * localhost, and to `hosts`: the names it is reached by through `tailscale serve`, from a phone on the tailnet.
 */
export type OnPrem = { home: string; hosts: string[] };

export type Config = {
	/** Undefined on a server. */
	onPrem: OnPrem | undefined;
	/** Database, workspaces, uploads, push keys and (in fake mode) the local GitHub stand-in. */
	dataDir: string;
	host: string;
	port: number;
	/** VAPID subject sent to push services: a `mailto:` or `https:` URL that identifies the operator. */
	pushSubject: string;
	/**
	 * Tailscale logins allowed in; empty allows everyone who can reach pigui through the tailnet. In OnPrem it applies
	 * to what comes through Tailscale, not to the computer's own browser at localhost.
	 */
	allowedLogins: string[];
	/** Default per-session spend cap in US dollars; undefined means no cap. */
	spendCap: number | undefined;
	/** The model that writes compaction checkpoints; undefined means each session's own model. */
	compactionModel: ModelRef | undefined;
	/** Scripted model and a local GitHub stand-in: the whole product without credentials. */
	fake: boolean;
	/** The read-only GitHub token agent commands get as GH_TOKEN, never pigui's own; required in real mode, never in OnPrem. */
	agentGitHubToken: string | undefined;
	/** Landlock around every agent command and file tool (`PIGUI_SANDBOX`, on unless `off`; always off in OnPrem). */
	sandbox: boolean;
	memory: MemoryConfig;
	/**
	 * How the local speech and memory models are held (`PIGUI_MODELS_UNLOAD`): undefined, loaded as pigui starts and
	 * kept; otherwise loaded on first use and released after this many milliseconds idle.
	 */
	modelsUnloadAfterMs: number | undefined;
};

export class ConfigError extends Error {}

/** Read the configuration from environment variables; every variable is documented in README.md. */
export function readConfig(env: NodeJS.ProcessEnv): Config {
	const fake = flag(env.PIGUI_FAKE, "PIGUI_FAKE");
	const onPrem = onOff(env.PIGUI_ONPREM, "PIGUI_ONPREM", false);
	if (onPrem) refuseWithOnPrem(env);
	else if ((env.PIGUI_ALLOWED_HOSTS ?? "").trim() !== "") {
		throw new ConfigError(
			"PIGUI_ALLOWED_HOSTS applies only with PIGUI_ONPREM=on: a server is reached through Tailscale alone and checks no host name. Remove it, or turn OnPrem on.",
		);
	}
	const dataDir = env.PIGUI_DATA_DIR;
	if (dataDir === undefined || dataDir.trim() === "") {
		throw new ConfigError("PIGUI_DATA_DIR is not set. Set it to the directory pigui keeps its database and workspaces in.");
	}
	const host = env.PIGUI_HOST ?? "127.0.0.1";
	if (!isLoopback(host)) {
		throw new ConfigError(
			`PIGUI_HOST is ${host}, which is not a loopback address. pigui listens on loopback only; Tailscale serve, or in OnPrem this computer's browser, is the way in.`,
		);
	}
	return {
		onPrem: onPrem ? { home: resolve(env.HOME?.trim() || homedir()), hosts: hostNames(env.PIGUI_ALLOWED_HOSTS) } : undefined,
		dataDir: resolve(dataDir),
		host,
		port: integer(env.PIGUI_PORT, "PIGUI_PORT", onPrem ? 2025 : 8787, 0, 65535),
		pushSubject: pushSubject(env.PIGUI_PUSH_SUBJECT),
		allowedLogins: (env.PIGUI_ALLOWED_LOGINS ?? "")
			.split(",")
			.map((login) => login.trim().toLowerCase())
			.filter((login) => login.length > 0),
		spendCap: dollars(env.PIGUI_SPEND_CAP),
		compactionModel: modelRef(env.PIGUI_COMPACTION_MODEL),
		fake,
		agentGitHubToken: onPrem ? undefined : agentToken(env.PIGUI_AGENT_GH_TOKEN, fake),
		sandbox: !onPrem && onOff(env.PIGUI_SANDBOX, "PIGUI_SANDBOX", true),
		memory: {
			provider: env.PIGUI_MEMORY_PROVIDER?.trim() || "lunaroute",
			embedModel: env.PIGUI_MEMORY_EMBED_MODEL?.trim() || "emb-qwen3",
			embedUrl: httpUrl(env.PIGUI_MEMORY_EMBED_URL, "PIGUI_MEMORY_EMBED_URL"),
		},
		modelsUnloadAfterMs: unloadAfter(env.PIGUI_MODELS_UNLOAD),
	};
}

function isLoopback(host: string): boolean {
	if (host === "localhost") return true;
	if (isIP(host) === 4) return host.startsWith("127.");
	return host === "::1";
}

function flag(value: string | undefined, name: string): boolean {
	if (value === undefined || value === "" || value === "0" || value === "false") return false;
	if (value === "1" || value === "true") return true;
	throw new ConfigError(`${name} must be 1 or 0, not ${JSON.stringify(value)}.`);
}

function integer(value: string | undefined, name: string, fallback: number, min: number, max: number): number {
	if (value === undefined || value === "") return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
		throw new ConfigError(`${name} must be a whole number from ${min} to ${max}, not ${JSON.stringify(value)}.`);
	}
	return parsed;
}

function dollars(value: string | undefined): number | undefined {
	if (value === undefined || value === "" || value === "0") return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new ConfigError(`PIGUI_SPEND_CAP must be a positive number of US dollars, not ${JSON.stringify(value)}.`);
	}
	return parsed;
}

/** `provider/modelId`; the model ID may itself contain slashes, as on OpenRouter. */
function modelRef(value: string | undefined): ModelRef | undefined {
	if (value === undefined || value.trim() === "") return undefined;
	const slash = value.indexOf("/");
	const provider = value.slice(0, slash).trim();
	const modelId = value.slice(slash + 1).trim();
	if (slash === -1 || provider === "" || modelId === "") {
		throw new ConfigError(`PIGUI_COMPACTION_MODEL must be provider/modelId, as Pi names models (for example anthropic/claude-sonnet-4-5), not ${JSON.stringify(value)}.`);
	}
	return { provider, modelId };
}

function agentToken(value: string | undefined, fake: boolean): string | undefined {
	const token = value?.trim() ?? "";
	if (token !== "") return token;
	if (fake) return undefined;
	throw new ConfigError(
		"PIGUI_AGENT_GH_TOKEN is not set. Set it to a read-only fine-grained GitHub token (Contents and Metadata: read) for the agent's commands; pigui keeps GH_TOKEN for its own GitHub work.",
	);
}

/** `never`, the default, or whole minutes from 1 to a day. */
function unloadAfter(value: string | undefined): number | undefined {
	const given = value?.trim() ?? "";
	if (given === "" || given === "never") return undefined;
	const minutes = Number(given);
	if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
		throw new ConfigError(`PIGUI_MODELS_UNLOAD must be never, or a whole number of idle minutes from 1 to 1440, not ${JSON.stringify(value)}.`);
	}
	return minutes * 60_000;
}

function onOff(value: string | undefined, name: string, fallback: boolean): boolean {
	if (value === undefined || value === "") return fallback;
	if (value === "on") return true;
	if (value === "off") return false;
	throw new ConfigError(`${name} must be on or off, not ${JSON.stringify(value)}.`);
}

/**
 * OnPrem gives the agent the person's own access, so the settings that confine it or stand in for the person's own
 * credentials mean nothing there. Given anyway, they say the operator expects a protection that is not in place, so pigui refuses to start.
 */
function refuseWithOnPrem(env: NodeJS.ProcessEnv): void {
	if (env.PIGUI_SANDBOX === "on") {
		throw new ConfigError(
			"PIGUI_SANDBOX=on cannot be combined with PIGUI_ONPREM=on: OnPrem runs agent commands as you, with your full access, so there is no sandbox. Remove PIGUI_SANDBOX, or turn OnPrem off.",
		);
	}
	if ((env.PIGUI_AGENT_GH_TOKEN ?? "").trim() !== "") {
		throw new ConfigError(
			"PIGUI_AGENT_GH_TOKEN cannot be combined with PIGUI_ONPREM=on: OnPrem's agent uses your own gh and git credentials. Remove PIGUI_AGENT_GH_TOKEN, or turn OnPrem off.",
		);
	}
}

/**
 * `PIGUI_ALLOWED_HOSTS`: host names, without a port, such as the computer's MagicDNS name. Each is one a page on this
 * computer cannot be pointed at by someone else's DNS, which is what the host check guards against.
 */
function hostNames(value: string | undefined): string[] {
	const names = (value ?? "")
		.split(",")
		.map((name) => name.trim().toLowerCase().replace(/\.$/, ""))
		.filter((name) => name !== "");
	for (const name of names) {
		if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(name)) {
			throw new ConfigError(`PIGUI_ALLOWED_HOSTS must be host names separated by commas, without a scheme or port (for example mac.tail1234.ts.net), not ${JSON.stringify(name)}.`);
		}
	}
	return names;
}

function httpUrl(value: string | undefined, name: string): string | undefined {
	if (value === undefined || value.trim() === "") return undefined;
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new ConfigError(`${name} must be an http: or https: URL, not ${JSON.stringify(value)}.`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new ConfigError(`${name} must be an http: or https: URL, not ${JSON.stringify(value)}.`);
	return url.href;
}

function pushSubject(value: string | undefined): string {
	const subject = value === undefined || value === "" ? "mailto:pigui@localhost" : value;
	if (!/^(mailto:|https:\/\/)/.test(subject)) {
		throw new ConfigError(`PIGUI_PUSH_SUBJECT must start with mailto: or https://, not ${JSON.stringify(subject)}.`);
	}
	return subject;
}
