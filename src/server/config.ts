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
	onPrem?: OnPrem | undefined;
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
	compactionModel?: ModelRef | undefined;
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
	modelsUnloadAfterMs?: number | undefined;
};

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

/** Read the configuration from environment variables; every variable is documented in README.md. */
export function readConfig(env: NodeJS.ProcessEnv): Config {
	// Order of validation is the order below: the fake-mode stand-in first, then the OnPrem refusals, then every
	// variable in the order they are documented, so the first thing the operator must fix is the first reported.
	const fake = parseFlag(env.PIGUI_FAKE, "PIGUI_FAKE");
	const onPrem = parseOnOff(env.PIGUI_ONPREM, "PIGUI_ONPREM", false);
	if (onPrem) {
		refuseOnPremConflicts(env);
	} else if ((env.PIGUI_ALLOWED_HOSTS ?? "").trim() !== "") {
		throw new ConfigError(
			"PIGUI_ALLOWED_HOSTS applies only with PIGUI_ONPREM=on: a server is reached through Tailscale alone and checks no host name. Remove it, or set PIGUI_ONPREM=on.",
		);
	}

	const rawDataDir = env.PIGUI_DATA_DIR;
	if (rawDataDir === undefined || rawDataDir.trim() === "") {
		throw new ConfigError("PIGUI_DATA_DIR is not set. Set it to the directory pigui keeps its database and workspaces in.");
	}
	const dataDir = resolve(rawDataDir);

	const host = env.PIGUI_HOST ?? "127.0.0.1";
	if (!isLoopback(host)) {
		throw new ConfigError(
			`PIGUI_HOST is ${host}, which is not a loopback address. pigui listens on loopback only; reach it through Tailscale serve, or in OnPrem from this computer's browser, instead.`,
		);
	}

	const port = parseInteger(env.PIGUI_PORT, "PIGUI_PORT", onPrem ? 2025 : 8787, 0, 65535);
	const pushSubject = parsePushSubject(env.PIGUI_PUSH_SUBJECT);
	const allowedLogins = parseLogins(env.PIGUI_ALLOWED_LOGINS);
	const spendCap = parseSpendCap(env.PIGUI_SPEND_CAP);
	const compactionModel = parseCompactionModel(env.PIGUI_COMPACTION_MODEL);
	// OnPrem runs the agent as the person, with their own gh and git credentials, so a token here would be ignored.
	const agentGitHubToken = onPrem ? undefined : parseAgentToken(env.PIGUI_AGENT_GH_TOKEN, fake);
	// The sandbox confines the agent; in OnPrem there is nothing to confine, so the variable is not consulted at all.
	const sandbox = !onPrem && parseOnOff(env.PIGUI_SANDBOX, "PIGUI_SANDBOX", true);
	const memory: MemoryConfig = {
		provider: env.PIGUI_MEMORY_PROVIDER?.trim() || "lunaroute",
		embedModel: env.PIGUI_MEMORY_EMBED_MODEL?.trim() || "emb-qwen3",
		embedUrl: parseHttpUrl(env.PIGUI_MEMORY_EMBED_URL, "PIGUI_MEMORY_EMBED_URL"),
	};
	// Validated only in OnPrem: elsewhere a non-empty value already threw above.
	const hosts = onPrem ? parseHostNames(env.PIGUI_ALLOWED_HOSTS) : undefined;
	const modelsUnloadAfterMs = parseModelsUnload(env.PIGUI_MODELS_UNLOAD);

	return {
		onPrem: onPrem ? { home: resolve(env.HOME?.trim() || homedir()), hosts: hosts ?? [] } : undefined,
		dataDir,
		host,
		port,
		pushSubject,
		allowedLogins,
		spendCap,
		compactionModel,
		fake,
		agentGitHubToken,
		sandbox,
		memory,
		modelsUnloadAfterMs,
	};
}

function isLoopback(host: string): boolean {
	if (host === "localhost") return true;
	if (isIP(host) === 4) return host.startsWith("127.");
	return host === "::1";
}

function parseFlag(value: string | undefined, name: string): boolean {
	if (value === undefined || value === "" || value === "0" || value === "false") return false;
	if (value === "1" || value === "true") return true;
	throw new ConfigError(`${name} must be 1 or true to enable it, or 0, false or unset to leave it off, not ${JSON.stringify(value)}. Set it to 1 for the fake mode, or remove it.`);
}

function parseOnOff(value: string | undefined, name: string, fallback: boolean): boolean {
	if (value === undefined || value === "") return fallback;
	if (value === "on") return true;
	if (value === "off") return false;
	throw new ConfigError(`${name} must be on or off, not ${JSON.stringify(value)}. Set it to on or off, or remove it to use the default (${fallback ? "on" : "off"}).`);
}

function parseInteger(value: string | undefined, name: string, fallback: number, min: number, max: number): number {
	if (value === undefined || value === "") return fallback;
	const parsed = /^[0-9]+$/.test(value.trim()) ? Number(value.trim()) : NaN;
	if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
		throw new ConfigError(`${name} must be a whole number from ${min} to ${max}, not ${JSON.stringify(value)}. Set it to a port number in that range, or remove it to use the default ${fallback}.`);
	}
	return parsed;
}

function parseLogins(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((login) => login.trim().toLowerCase())
		.filter((login) => login.length > 0);
}

function parseSpendCap(value: string | undefined): number | undefined {
	const given = value?.trim() ?? "";
	if (given === "") return undefined;
	const parsed = /^[0-9]+(\.[0-9]+)?$/.test(given) ? Number(given) : NaN;
	// A cap of zero is the way to say "no cap" without removing the variable.
	if (parsed === 0) return undefined;
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new ConfigError(`PIGUI_SPEND_CAP must be a positive number of US dollars, not ${JSON.stringify(value)}. Set it to an amount such as 25, or to 0 or empty for no cap.`);
	}
	return parsed;
}

/** `provider/modelId`; the model ID may itself contain slashes, as on OpenRouter. */
function parseCompactionModel(value: string | undefined): ModelRef | undefined {
	const given = value?.trim() ?? "";
	if (given === "") return undefined;
	const slash = given.indexOf("/");
	const provider = slash === -1 ? "" : given.slice(0, slash).trim();
	const modelId = slash === -1 ? "" : given.slice(slash + 1).trim();
	if (slash === -1 || provider === "" || modelId === "") {
		throw new ConfigError(`PIGUI_COMPACTION_MODEL must be provider/modelId, as Pi names models (for example anthropic/claude-sonnet-4-5), not ${JSON.stringify(value)}. Split the provider and the model ID with a single slash.`);
	}
	return { provider, modelId };
}

function parseAgentToken(value: string | undefined, fake: boolean): string | undefined {
	const token = value?.trim() ?? "";
	if (token !== "") return token;
	if (fake) return undefined;
	throw new ConfigError(
		"PIGUI_AGENT_GH_TOKEN is not set. Set it to a fine-grained GitHub token with read-only access (Contents and Metadata: read) for the repositories the agent works on; pigui uses its own credentials for its GitHub work and gives the agent only this one.",
	);
}

/** `never`, the default, or whole minutes from 1 to a day. */
function parseModelsUnload(value: string | undefined): number | undefined {
	const given = value?.trim() ?? "";
	if (given === "" || given === "never") return undefined;
	// The same rule deploy/lib.sh's unload_valid applies (both installers source it): decimal digits, 1 to 1440.
	const minutes = /^[0-9]+$/.test(given) ? Number(given) : NaN;
	if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
		throw new ConfigError(`PIGUI_MODELS_UNLOAD must be never, or a whole number of idle minutes from 1 to 1440, not ${JSON.stringify(value)}. Set it to never to keep the models loaded, or to the minutes of idle time after which to release them.`);
	}
	return minutes * 60_000;
}

/**
 * OnPrem gives the agent the person's own access, so the settings that confine it or stand in for the person's own
 * credentials mean nothing there. Given anyway, they say the operator expects a protection that is not in place, so pigui refuses to start.
 */
function refuseOnPremConflicts(env: NodeJS.ProcessEnv): void {
	if (env.PIGUI_SANDBOX === "on") {
		throw new ConfigError(
			"PIGUI_SANDBOX=on cannot be combined with PIGUI_ONPREM=on: OnPrem runs agent commands as you, with your full access, so there is no sandbox to turn on. Remove PIGUI_SANDBOX, or set PIGUI_ONPREM=off.",
		);
	}
	if ((env.PIGUI_AGENT_GH_TOKEN ?? "").trim() !== "") {
		throw new ConfigError(
			"PIGUI_AGENT_GH_TOKEN cannot be combined with PIGUI_ONPREM=on: OnPrem's agent uses your own gh and git credentials, so the token would be ignored. Remove PIGUI_AGENT_GH_TOKEN, or set PIGUI_ONPREM=off.",
		);
	}
}

/**
 * `PIGUI_ALLOWED_HOSTS`: host names, without a scheme or port, such as the computer's MagicDNS name. Each is one a page on this
 * computer cannot be pointed at by someone else's DNS, which is what the host check guards against.
 */
function parseHostNames(value: string | undefined): string[] {
	const names = (value ?? "")
		.split(",")
		.map((name) => name.trim().toLowerCase().replace(/\.$/, ""))
		.filter((name) => name !== "");
	const hostName = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
	for (const name of names) {
		if (!hostName.test(name)) {
			throw new ConfigError(`PIGUI_ALLOWED_HOSTS must be host names separated by commas, without a scheme or port (for example mac.tail1234.ts.net), not ${JSON.stringify(name)}. Remove the scheme and port and keep only the host names.`);
		}
	}
	return names;
}

function parseHttpUrl(value: string | undefined, name: string): string | undefined {
	const given = value?.trim() ?? "";
	if (given === "") return undefined;
	let url: URL;
	try {
		url = new URL(given);
	} catch {
		throw new ConfigError(`${name} must be an http: or https: URL, not ${JSON.stringify(value)}. Set it to the http: or https: URL that serves the embeddings endpoint, or remove it to use the provider's default.`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new ConfigError(`${name} must be an http: or https: URL, not ${JSON.stringify(value)}. Set it to the http: or https: URL that serves the embeddings endpoint, or remove it to use the provider's default.`);
	}
	return url.href;
}

function parsePushSubject(value: string | undefined): string {
	const subject = value === undefined || value === "" ? "mailto:pigui@localhost" : value;
	if (!/^(mailto:|https:\/\/)/.test(subject)) {
		throw new ConfigError(`PIGUI_PUSH_SUBJECT must start with mailto: or https://, not ${JSON.stringify(subject)}. Set it to a mailto: address or an https: URL that identifies you to the push service.`);
	}
	return subject;
}
