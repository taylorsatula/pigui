import { spawn } from "node:child_process";

export type RunOptions = {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	input?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
};

export type RunResult = {
	stdout: string;
	stderr: string;
};

/**
 * A failed shell-out, worded for the person: which command, how it ended, and the tail of what it printed. Its message
 * can quote repository content, so it goes to the phone, never to the logs.
 */
export class CommandError extends Error {
	readonly command: string;
	readonly exitCode: number | null;
	readonly stderr: string;
	readonly stdout: string;

	constructor(command: string, exitCode: number | null, stdout: string, stderr: string, cause?: unknown) {
		const tail = (stderr.trim() || stdout.trim()).split("\n").slice(-6).join("\n");
		const how = exitCode === null ? "could not run" : `exited with code ${exitCode}`;
		super(`${command} ${how}${tail === "" ? "" : `:\n${tail}`}`, cause === undefined ? undefined : { cause });
		this.name = "CommandError";
		this.command = command;
		this.exitCode = exitCode;
		this.stdout = stdout;
		this.stderr = stderr;
	}
}

/** Run a program without a shell and collect its output; rejects with a `CommandError` unless it exits 0. */
export function run(program: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
	const label = `${program} ${args[0] ?? ""}`.trim();
	return new Promise((resolve, reject) => {
		const child = spawn(program, args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
			signal: options.signal,
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		const timer =
			options.timeoutMs === undefined ? undefined : setTimeout(() => child.kill("SIGTERM"), options.timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(new CommandError(label, null, "", error.message, error));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			const out = Buffer.concat(stdout).toString("utf8");
			const err = Buffer.concat(stderr).toString("utf8");
			if (code === 0) resolve({ stdout: out, stderr: err });
			else reject(new CommandError(label, code, out, err));
		});
		child.stdin.on("error", () => {});
		child.stdin.end(options.input ?? "");
	});
}
