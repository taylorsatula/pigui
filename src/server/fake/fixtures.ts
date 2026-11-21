// The repositories fake mode serves. Small, but real: a TypeScript project whose tests run with `node --test`, a project
// AGENTS.md and a Pi skill (both loaded by Pi's own loaders), a binary file, and a second branch to continue.

type FixtureBranch = {
	name: string;
	/** Files written (or, when null, deleted) on top of the branch it starts from, in one commit. */
	files: Record<string, string | Uint8Array | null>;
	message: string;
};

export type FixtureRepo = {
	name: string;
	description: string;
	defaultBranch: string;
	files: Record<string, string | Uint8Array>;
	/** Further branches, each cut from the default branch. */
	branches: FixtureBranch[];
};

// A 1x1 PNG: enough for a reference to a binary file to be recognised as one.
const PIXEL = Uint8Array.from(
	Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
		"base64",
	),
);

const FIXTURE_OWNER = "demo";

export const FIXTURE_REPOS: FixtureRepo[] = [
	{
		name: `${FIXTURE_OWNER}/greeter`,
		description: "A tiny greeting library",
		defaultBranch: "main",
		files: {
			"README.md": "# greeter\n\nA tiny greeting library. Run the tests with `node --test`.\n",
			"AGENTS.md": "# Working on greeter\n\n- Run the tests with `node --test` before committing.\n- Keep functions small and exported from `src/`.\n",
			"package.json": `${JSON.stringify({ name: "greeter", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
			"src/greet.ts": 'export function greet(name: string): string {\n\treturn `Hello, ${name}!`;\n}\n',
			"test/greet.test.ts":
				'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { greet } from "../src/greet.ts";\n\ntest("greets by name", () => {\n\tassert.equal(greet("Ada"), "Hello, Ada!");\n});\n',
			"docs/guide.md": "# Guide\n\nCall `greet(name)` to greet someone.\n",
			"assets/logo.png": PIXEL,
			".pi/skills/release-notes/SKILL.md":
				"---\nname: release-notes\ndescription: Write release notes for the commits on the current branch.\n---\n\n# Release notes\n\n1. List the commits on the branch with `git log --oneline origin/main..HEAD`.\n2. Group them by user-facing change.\n3. Write the notes to `docs/RELEASE_NOTES.md` and commit them.\n",
		},
		branches: [
			{
				name: "feature/farewell",
				message: "Add farewell",
				files: {
					"src/farewell.ts": 'export function farewell(name: string): string {\n\treturn `Goodbye, ${name}.`;\n}\n',
				},
			},
		],
	},
	{
		name: `${FIXTURE_OWNER}/notes`,
		description: "Plain-text notes",
		defaultBranch: "main",
		files: {
			"README.md": "# notes\n\nShort notes in Markdown.\n",
			"notes/ideas.md": "# Ideas\n\n- Write more tests.\n",
		},
		branches: [
			{
				name: "drafts",
				message: "Draft a todo list",
				files: { "notes/todo.md": "# Todo\n\n- Nothing yet.\n" },
			},
		],
	},
];
