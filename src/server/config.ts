import { isIP } from "node:net";
import { resolve } from "node:path";

export type Config = {
	/** Database, workspaces, uploads, push keys and (in fake mode) the local GitHub stand-in. */
	dataDir: string;
	host: string;
	port: number;
	/** VAPID subject sent to push services: a `mailto:` or `https:` URL that identifies the operator. */
	pushSubject: string;
	/** Tailscale logins allowed in; empty allows everyone who can reach the server through the tailnet. */
	allowedLogins: string[];
	/** Tool rounds one run may take. */
	maxTurns: number;
	/** Default per-session spend cap in US dollars; undefined means no cap. */
	spendCap: number | undefined;
	/** Scripted model and a local GitHub stand-in: the whole product without credentials. */
	fake: boolean;
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
		maxTurns: integer(env.PICLOUD_MAX_TURNS, "PICLOUD_MAX_TURNS", 150, 1, 100_000),
		spendCap: dollars(env.PICLOUD_SPEND_CAP),
		fake,
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

function pushSubject(value: string | undefined): string {
	const subject = value === undefined || value === "" ? "mailto:picloud@localhost" : value;
	if (!/^(mailto:|https:\/\/)/.test(subject)) {
		throw new ConfigError(`PICLOUD_PUSH_SUBJECT must start with mailto: or https://, not ${JSON.stringify(subject)}.`);
	}
	return subject;
}
