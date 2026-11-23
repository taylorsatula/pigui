// The one setting: how many agents of a session run at once. A file in the data directory, written with its default
// when missing and read at every use, so an edit over SSH applies to the next agent that starts. A file that does not
// parse or validate is never guessed at: whoever reads it gets the error to pass on.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compile, int, obj, type Static } from "@earendil-works/pi-schema";

const Settings = obj({
	maxInFlight: int({ minimum: 1, maximum: 32, description: "Agents of one session running at once; the rest wait in order" }),
});
export type Settings = Static<typeof Settings>;

const DEFAULT: Settings = { maxInFlight: 4 };
const valid = compile(Settings);

function settingsFile(dataDir: string): string {
	return join(dataDir, "subagent-settings.json");
}

/** Write the default settings, only where there is no file: once there is one, it is the person's. */
export async function seedSettings(dataDir: string): Promise<void> {
	await writeFile(settingsFile(dataDir), `${JSON.stringify(DEFAULT, null, 2)}\n`, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "EEXIST") throw error;
	});
}

export async function readSettings(dataDir: string): Promise<Settings | { error: string }> {
	const file = settingsFile(dataDir);
	let value: unknown;
	try {
		value = JSON.parse(await readFile(file, "utf8"));
	} catch (error) {
		return { error: `${file} could not be read as JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (valid.check(value)) return value;
	const [first] = valid.errors(value);
	return { error: `${file} is not valid: ${first === undefined ? "it must be { \"maxInFlight\": 1 to 32 }" : `${first.path || "the file"} ${first.message}`}` };
}
