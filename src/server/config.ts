import { isIP } from "node:net";
import { resolve } from "node:path";
import type { ModelRef } from "@earendil-works/pi-durable";

export type Config = {
	/** Database, workspaces, uploads, push keys and (in fake mode) the local GitHub stand-in. */
	dataDir: string;
	host: string;
	port: number;
	/** VAPID subject sent to push services: a `mailto:` or `https:` URL that identifies the operator. */
	pushSubject: string;
	/** Tailscale logins allowed in; empty allows everyone who can reach the server through the tailnet. */
	allowedLogins: string[];
	/** Default per-session spend cap in US dollars; undefined means no cap. */
	spendCap: number | undefined;
	/** The model that writes compaction checkpoints; undefined means each session's own model. */
	compactionModel: ModelRef | undefined;
	/** Scripted model and a local GitHub stand-in: the whole product without credentials. */
	fake: boolean;
	/** The read-only GitHub token agent commands get as GH_TOKEN, never picloud's own; required in real mode. */
	agentGitHubToken: string | undefined;
	/** Landlock around every agent command and file tool (`PICLOUD_SANDBOX`, on unless `off`). */
	sandbox: boolean;
};

export class ConfigError extends Error {}

/** Read the configuration from environment variables; every variable is documented in README.md. */
export function readConfig(env: NodeJS.ProcessEnv): Config {
	const fake = flag(env.PICLOUD_FAKE, "PICLOUD_FAKE");
	const dataDir = env.PICLOUD_DATA_DIR;
	if (dataDir === undefined || dataDir.trim() === "") {
		throw new ConfigError("PICLOUD_DATA_DIR is not set. Set it to the directory picloud keeps its database and workspaces in.");
	}
	const host = env.PICLOUD_HOST ?? "127.0.0.1";
	if (!isLoopback(host)) {
		throw new ConfigError(
			`PICLOUD_HOST is ${host}, which is not a loopback address. picloud listens on loopback only; Tailscale serve is the way in.`,
		);
	}
	return {
		dataDir: resolve(dataDir),
		host,
		port: integer(env.PICLOUD_PORT, "PICLOUD_PORT", 8787, 0, 65535),
		pushSubject: pushSubject(env.PICLOUD_PUSH_SUBJECT),
		allowedLogins: (env.PICLOUD_ALLOWED_LOGINS ?? "")
			.split(",")
			.map((login) => login.trim().toLowerCase())
			.filter((login) => login.length > 0),
		spendCap: dollars(env.PICLOUD_SPEND_CAP),
		compactionModel: modelRef(env.PICLOUD_COMPACTION_MODEL),
		fake,
		agentGitHubToken: agentToken(env.PICLOUD_AGENT_GH_TOKEN, fake),
		sandbox: onOff(env.PICLOUD_SANDBOX, "PICLOUD_SANDBOX"),
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
		throw new ConfigError(`PICLOUD_SPEND_CAP must be a positive number of US dollars, not ${JSON.stringify(value)}.`);
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
		throw new ConfigError(`PICLOUD_COMPACTION_MODEL must be provider/modelId, as Pi names models (for example anthropic/claude-sonnet-4-5), not ${JSON.stringify(value)}.`);
	}
	return { provider, modelId };
}

function agentToken(value: string | undefined, fake: boolean): string | undefined {
	const token = value?.trim() ?? "";
	if (token !== "") return token;
	if (fake) return undefined;
	throw new ConfigError(
		"PICLOUD_AGENT_GH_TOKEN is not set. Set it to a read-only fine-grained GitHub token (Contents and Metadata: read) for the agent's commands; picloud keeps GH_TOKEN for its own GitHub work.",
	);
}

function onOff(value: string | undefined, name: string): boolean {
	if (value === undefined || value === "" || value === "on") return true;
	if (value === "off") return false;
	throw new ConfigError(`${name} must be on or off, not ${JSON.stringify(value)}.`);
}

function pushSubject(value: string | undefined): string {
	const subject = value === undefined || value === "" ? "mailto:picloud@localhost" : value;
	if (!/^(mailto:|https:\/\/)/.test(subject)) {
		throw new ConfigError(`PICLOUD_PUSH_SUBJECT must start with mailto: or https://, not ${JSON.stringify(subject)}.`);
	}
	return subject;
}
