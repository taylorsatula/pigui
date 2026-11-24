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

const TAIL_LINES = 6;

/**
 * A shell-out that ended in failure, phrased for the person: which command, how it ended, and the last lines of its
 * output. Its message can quote repository content, so it belongs in the app, never in the logs.
 */
export class CommandError extends Error {
	readonly command: string;
	readonly exitCode: number | null;
	readonly stderr: string;
	readonly stdout: string;

	constructor(command: string, exitCode: number | null, stdout: string, stderr: string, cause?: unknown) {
		const combined = stderr.trim() || stdout.trim();
		const tail = combined === "" ? "" : combined.split("\n").slice(-TAIL_LINES).join("\n");
		const outcome = exitCode === null ? "could not run" : `exited with code ${exitCode}`;
		super(`${command} ${outcome}${tail === "" ? "" : `:\n${tail}`}`, cause === undefined ? undefined : { cause });
		this.name = "CommandError";
		this.command = command;
		this.exitCode = exitCode;
		this.stdout = stdout;
		this.stderr = stderr;
	}
}

/**
 * Run `program` with `args`, without a shell, and collect its output. Resolves only when the process exits 0; any other
 * outcome rejects with a `CommandError`. Output can carry repository content, so callers decide where it may go.
 */
export function run(program: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
	const label = [program, args[0]].filter((part) => part !== undefined && part !== "").join(" ");
	return new Promise((resolve, reject) => {
		const child = spawn(program, args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
			signal: options.signal,
		});
		const outChunks: Buffer[] = [];
		const errChunks: Buffer[] = [];
		const timer =
			options.timeoutMs === undefined ? undefined : setTimeout(() => child.kill("SIGTERM"), options.timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => outChunks.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(new CommandError(label, null, "", error.message, error));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			const out = Buffer.concat(outChunks).toString("utf8");
			const err = Buffer.concat(errChunks).toString("utf8");
			if (code === 0) resolve({ stdout: out, stderr: err });
			else reject(new CommandError(label, code, out, err));
		});
		// A child that never reads stdin would otherwise take the write down with EPIPE; its failure surfaces on close.
		child.stdin.on("error", () => {});
		child.stdin.end(options.input ?? "");
	});
}
