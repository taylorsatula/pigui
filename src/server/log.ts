// Structured logs for the service journal. Callers pass identifiers, counts, durations and fixed reason strings only:
// never message text, tool output, file contents, tokens or other credentials. `Fields` keeps the values scalar so a
// whole object cannot slip in by accident.

export type Fields = Record<string, string | number | boolean | undefined>;

export type Logger = {
	info(event: string, fields?: Fields): void;
	warn(event: string, fields?: Fields): void;
	error(event: string, fields?: Fields): void;
};

export function createLogger(write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Logger {
	const emit = (level: string, event: string, fields?: Fields): void => {
		write(JSON.stringify({ level, event, ...fields }));
	};
	return {
		info: (event, fields) => emit("info", event, fields),
		warn: (event, fields) => emit("warn", event, fields),
		error: (event, fields) => emit("error", event, fields),
	};
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/** An error's class and a short code, never its message, which can quote content (a path, a command, a reply). */
export function errorKind(error: unknown): string {
	if (error instanceof Error) {
		const code = (error as { code?: unknown }).code;
		return typeof code === "string" ? `${error.name}:${code}` : error.name;
	}
	return typeof error;
}
