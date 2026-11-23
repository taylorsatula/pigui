// Subagents: agents the person defines in files, each run as its own Durable conversation, driven here through the
// scripted model's [agents] lines (the session's side) and its agents' own script ($ commands, [wait]).
import assert from "node:assert/strict";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, type TestContext, test } from "node:test";
import type { Context } from "@earendil-works/chord/context";
import { type ConversationId, type EntryRecord, UsageDoc } from "@earendil-works/pi-durable";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { AGENT_RESULT_ENTRY, AGENT_STOPPED_ENTRY, type AgentRow, type SessionDoc, sessionRow } from "../src/shared/session.ts";
import { spentOf } from "../src/shared/spend.ts";
import { readDefinitions } from "../src/server/subagents/definitions.ts";
import { context, modelText, TestServer } from "./helpers.ts";

const PROBE = "---\ndescription: Runs what it is told\ntools: bash, read\n---\nYou run the commands in your task and report what they print.\n";

/** A definition file in the server's agents folder, read at its next use. */
async function define(server: TestServer, name: string, text: string): Promise<void> {
	await writeFile(join(server.dataDir, "agents", `${name}.md`), text);
}

async function setLimit(server: TestServer, text: string): Promise<void> {
	await writeFile(join(server.dataDir, "subagent-settings.json"), text);
}

function rows(doc: Readonly<SessionDoc>): readonly AgentRow[] {
	return doc.agents ?? [];
}

function statuses(doc: Readonly<SessionDoc>): string[] {
	return rows(doc).map((row) => row.status);
}

/** The session's tool results of `tool`, as the model read them. */
async function results(server: TestServer, id: number, tool: string): Promise<{ text: string; isError: boolean }[]> {
	return (await server.entries(id)).flatMap((entry) => {
		const message = entry.model?.[0];
		return message?.role === "toolResult" && message.toolName === tool ? [{ text: modelText(entry), isError: message.isError }] : [];
	});
}

function ofKind(entries: readonly EntryRecord[], kind: string): EntryRecord[] {
	return entries.filter((entry) => entry.kind === kind);
}

/** What the parent's model is told by `lines`: the session's agent runs them as one round of calls. */
function delegate(...lines: string[]): string {
	return ["Delegate [agents]", ...lines].join("\n");
}

function hangUntilAborted(context: Context): Promise<void> {
	return new Promise((_resolve, reject) => {
		context.abortSignal?.addEventListener("abort", () => reject(new Error("cut off")), { once: true });
	});
}

describe("a subagent's run", () => {
	let server: TestServer;
	before(async () => {
		server = await TestServer.start();
		await define(server, "probe", PROBE);
	});
	after(() => server.close());

	const sandboxed = (t: TestContext): boolean => {
		if (server.app.sandbox !== undefined) return true;
		t.diagnostic("Landlock or the sandbox launcher is unavailable here, so confinement is not checked");
		return false;
	};

	test("a foreground agent's answer is the call's result, from commands run where and as the session's are", async (t) => {
		const id = await server.createSession(delegate(`agent probe fg $ pwd $ echo "$HOME" $ cat ${join(server.dataDir, "picloud.sqlite")}`));
		const done = await server.settled(id);
		const row = rows(done)[0];
		assert.equal(row?.status, "done");
		assert.equal(row?.background, false);
		assert.equal(row?.runs, 1);
		const [result] = await results(server, id, "Agent");
		assert.ok(result !== undefined);
		assert.match(result.text, new RegExp(`^Agent ${row?.id} \\(probe, "Task 1"\\) finished`));
		assert.match(result.text, /Answer 1: \$ pwd/);
		assert.ok(result.text.includes(`$ pwd\n${server.workspace(id)}\n`), result.text);
		assert.ok(result.text.includes(`${server.scratch(id)}/home`), "the agent's home is its session's");
		if (sandboxed(t)) assert.match(result.text, /Permission denied/, "the database is out of the agent's reach, as of the session's agent");
		assert.equal(done.outcome?.kind, "replied");
	});

	test("an agent sees the project's instructions and skills as its session does, and only its own tools", async () => {
		const id = await server.createSession(delegate("agent probe fg tell me"));
		const done = await server.settled(id);
		const agent = rows(done)[0]!.id;
		const sections = async (conversation: number) =>
			Object.assign({}, ...(await server.entries(conversation)).flatMap((entry) => (entry.kind === "pi.system" ? [(entry.model?.[0] as { sections?: Record<string, string> }).sections ?? {}] : []))) as Record<string, string>;
		const parent = await sections(id);
		const child = await sections(agent);
		assert.match(child.project_context ?? "", /# Working on greeter/);
		assert.match(child.skills ?? "", /release-notes/);
		assert.equal(child.project_context, parent.project_context);
		assert.equal(child.skills, parent.skills);
		assert.match(child.instructions ?? "", /^<instructions>\n# Environment\nWorking directory: .*\nGit repository: yes\nBranch: pi\/delegate-agents-\d+\nPlatform: \w+\n\nYou run the commands/);
		// Nothing of the session's own agent: its prompt, its tools, nor Agent itself.
		assert.equal(child.picloud, undefined);
		assert.match(parent.subagents ?? "", /- probe: Runs what it is told/);
		assert.match(parent.subagents ?? "", /- thought-partner: /);
		const tools = (await server.entries(agent)).flatMap((entry) => (entry.kind === "pi.system" ? ((entry.model?.[0] as { toolsAdded?: { name: string }[] }).toolsAdded ?? []) : [])).map((tool) => tool.name);
		assert.deepEqual(tools, ["bash", "read"]);
	});

	test("a steer reaches a running agent; one still queued and one already done refuse it", async () => {
		await setLimit(server, '{ "maxInFlight": 1 }');
		try {
			const id = await server.createSession(delegate("agent probe bg [wait] first", "agent probe bg [wait] second"));
			const both = await server.until(id, (doc) => statuses(doc).join() === "running,queued", "one running, one queued");
			const [running, waiting] = rows(both);
			await server.send(id, delegate(`steer ${waiting!.id} hurry`, `steer ${running!.id} wrap up`));
			await server.until(id, (doc) => rows(doc)[0]?.status === "done", "the steered agent's answer");
			const steers = await results(server, id, "steer_subagent");
			const refused = steers.find((result) => /is queued and has not started/.test(result.text));
			assert.equal(refused?.isError, true);
			assert.ok(steers.some((result) => /gets the message after its current tool round/.test(result.text) && !result.isError));
			const answer = ofKind(await server.entries(id), AGENT_RESULT_ENTRY).at(-1);
			assert.match(answer === undefined ? "" : modelText(answer), /finished\. Its answer:\n\nSteered: wrap up/);
			await server.until(id, (doc) => rows(doc)[1]?.status === "running", "the second agent starting");
			await server.send(id, delegate(`steer ${running!.id} again`));
			await server.settled(id, "the third steer");
			const last = (await results(server, id, "steer_subagent"))[2]!;
			assert.match(last.text, new RegExp(`run has ended.*resume: ${running!.id}`));
			assert.equal(last.isError, true);
			await server.post(`/api/sessions/${id}/stop`);
			await server.until(id, (doc) => statuses(doc).every((status) => status !== "running" && status !== "queued"), "the stop");
		} finally {
			await setLimit(server, '{ "maxInFlight": 4 }');
		}
	});

	test("a resumed agent goes on with its conversation, after waiting its turn", async () => {
		await setLimit(server, '{ "maxInFlight": 1 }');
		try {
			const id = await server.createSession(delegate("agent probe fg remember this"));
			const first = await server.settled(id);
			const agent = rows(first)[0]!;
			await server.send(id, delegate("agent probe bg [wait] busy"));
			await server.until(id, (doc) => rows(doc)[1]?.status === "running", "the other agent running");
			await server.settled(id);
			await server.send(id, delegate(`resume ${agent.id} bg and now this`));
			const queuedResume = await server.until(id, (doc) => rows(doc)[0]?.status === "queued", "the resume waiting its turn");
			assert.equal(rows(queuedResume)[1]!.status, "running");
			assert.equal(rows(queuedResume)[0]!.runs, 2);
			assert.equal(rows(queuedResume)[0]!.id, agent.id, "a resume keeps the agent's id");
			assert.notEqual(rows(queuedResume)[0]!.task, agent.task, "a resume is a new run");
			await server.post(`/api/sessions/${id}/agents/${rows(queuedResume)[1]!.id}/stop`);
			await server.until(id, (doc) => rows(doc)[0]?.status === "done", "the resumed run's answer");
			const answers = (await server.entries(agent.id)).filter((entry) => entry.kind === "pi.assistant").map(modelText);
			assert.match(answers.at(-1) ?? "", /^Answer 2: and now this/);
			const resumes = await results(server, id, "Agent");
			assert.match(resumes.at(-1)!.text, new RegExp(`Agent ${agent.id} \\(probe\\) is queued`));
			await server.settled(id, "the parent reading the answer");
		} finally {
			await setLimit(server, '{ "maxInFlight": 4 }');
		}
	});

	test("resuming an agent that is running, or one that is not this session's, is refused", async () => {
		const id = await server.createSession(delegate("agent probe bg [wait] busy"));
		const running = await server.until(id, (doc) => rows(doc)[0]?.status === "running", "the agent running");
		const agent = rows(running)[0]!.id;
		await server.send(id, delegate(`resume ${agent} bg more`, "resume 999999 fg more", `agent nobody fg hi`));
		await server.settled(id, "the refusals");
		const refused = (await results(server, id, "Agent")).slice(1);
		const said = (pattern: RegExp) => refused.find((result) => pattern.test(result.text));
		assert.ok(said(new RegExp(`Agent ${agent} is running, so it cannot be resumed\\. Use steer_subagent`)));
		assert.ok(said(/There is no agent 999999 in this session/));
		assert.ok(said(/There is no agent type nobody\. Available: probe, thought-partner/));
		assert.equal(refused.length, 3);
		assert.ok(refused.every((result) => result.isError));
		await server.post(`/api/sessions/${id}/stop`);
	});
});

describe("the queue", () => {
	test("with two at a time, two of four agents run, and each that ends lets the oldest waiting one start", async () => {
		const server = await TestServer.start();
		try {
			await define(server, "probe", PROBE);
			await setLimit(server, '{ "maxInFlight": 2 }');
			const id = await server.createSession(delegate(...["a", "b", "c", "d"].map((name) => `agent probe bg [wait] ${name}`)));
			const started = await server.until(id, (doc) => statuses(doc).join() === "running,running,queued,queued" && doc.outcome?.kind === "waiting-agents", "two running, two queued");
			const [first] = rows(started);
			const byTask = [...rows(started)].sort((a, b) => a.task - b.task);
			assert.deepEqual(byTask.map((row) => row.status), ["running", "running", "queued", "queued"], "the oldest runs run first");
			assert.equal(sessionRow(started as SessionDoc).label, "Waiting on agents");
			assert.equal(sessionRow(started as SessionDoc).tone, "working");
			await server.send(id, delegate(`steer ${first!.id} done`));
			const next = await server.until(id, (doc) => statuses(doc).join() === "done,running,running,queued", "the third agent starting");
			assert.ok(rows(next)[2]!.startedAt !== undefined);
			await server.post(`/api/sessions/${id}/stop`);
			const stopped = await server.until(id, (doc) => statuses(doc).join() === "done,stopped,stopped,stopped", "everything stopped");
			// The two running and the one queued each tell the parent, once.
			await server.app.supervisor.idle();
			assert.equal(ofKind(await server.entries(id), AGENT_STOPPED_ENTRY).length, 3);
			assert.equal(stopped.outcome?.kind, "stopped");
		} finally {
			await server.close();
		}
	});
});

describe("background answers", () => {
	test("a background answer reaches the parent once, across a restart before its delivery, and starts the parent's next run", async () => {
		let reached: () => void = () => {};
		const atAnswer = new Promise<void>((resolve) => {
			reached = resolve;
		});
		const server = await TestServer.start({
			faults: {
				beforeAgentResult: async (context) => {
					reached();
					await hangUntilAborted(context);
				},
			},
		});
		try {
			await define(server, "probe", PROBE);
			const id = await server.createSession(delegate("agent probe bg look around"));
			await atAnswer;
			// The agent has answered and its run is held before the commit that sends the answer on; the parent's own
			// run ends meanwhile, with nothing to do but wait.
			const waiting = await server.until(id, (doc) => doc.outcome?.kind === "waiting-agents" && doc.activeRun === undefined, "the parent waiting");
			assert.equal(rows(waiting)[0]!.status, "running");
			assert.equal(waiting.notified.length, 0, "waiting on agents notifies no one");
			assert.equal(server.push.sent.length, 0);
			await server.restart({ faults: {} });
			const done = await server.until(id, (doc) => rows(doc)[0]?.status === "done" && doc.outcome?.kind === "replied", "the answer after the restart");
			const entries = await server.entries(id);
			const answers = ofKind(entries, AGENT_RESULT_ENTRY);
			assert.equal(answers.length, 1, "the answer is sent once");
			const data = answers[0]!.data as { agent: number; status: string; text: string };
			assert.equal(data.agent, rows(done)[0]!.id);
			assert.equal(data.status, "done");
			assert.match(data.text, /^Answer 1: look around/);
			assert.match(modelText(answers[0]!), new RegExp(`^Agent ${data.agent} \\(probe, "Task 1"\\) finished\\. Its answer:\\n\\nAnswer 1: look around`));
			// The answer started the parent's next run, which the supervisor followed to its end.
			const replies = entries.filter((entry) => entry.kind === "pi.assistant").map(modelText);
			assert.match(replies.at(-1) ?? "", new RegExp(`^Noted: Agent ${data.agent} \\(probe`));
		} finally {
			await server.close();
		}
	});
});

describe("stopping agents", () => {
	let server: TestServer;
	before(async () => {
		server = await TestServer.start();
		await define(server, "probe", PROBE);
	});
	after(() => server.close());

	test("Stop ends a queued and a running agent, each of which the parent learns of, and the session's Stop ends the rest", async () => {
		await setLimit(server, '{ "maxInFlight": 1 }');
		try {
			const id = await server.createSession(delegate("agent probe bg [wait] a", "agent probe bg [wait] b", "agent probe bg [wait] c"));
			const started = await server.until(id, (doc) => statuses(doc).join() === "running,queued,queued" && doc.activeRun === undefined, "one running, two queued");
			const [a, b, c] = rows(started);
			await server.post(`/api/sessions/${id}/agents/${b!.id}/stop`);
			await server.until(id, (doc) => statuses(doc).join() === "running,stopped,queued", "the queued one stopped");
			await server.post(`/api/sessions/${id}/agents/${a!.id}/stop`);
			await server.until(id, (doc) => statuses(doc).join() === "stopped,stopped,running", "the running one stopped, and the next one started");
			const notes = ofKind(await server.entries(id), AGENT_STOPPED_ENTRY);
			assert.deepEqual(notes.map((note) => (note.data as { agent: number }).agent).sort(), [a!.id, b!.id].sort());
			assert.match(modelText(notes[0]!), /was stopped by the person before it finished/);
			await server.post(`/api/sessions/${id}/stop`);
			const stopped = await server.until(id, (doc) => statuses(doc).join() === "stopped,stopped,stopped", "the session's Stop");
			assert.equal(stopped.outcome?.kind, "stopped");
			assert.equal(ofKind(await server.entries(id), AGENT_STOPPED_ENTRY).length, 3);
			await assert.rejects(server.post(`/api/sessions/${id}/agents/${c!.id + 100000}/stop`), (error: { status?: number }) => error.status === 404);
		} finally {
			await setLimit(server, '{ "maxInFlight": 4 }');
		}
	});

	test("a foreground agent stopped from the phone answers its call with the stop", async () => {
		const id = await server.createSession(delegate("agent probe fg [wait] forever"));
		const running = await server.until(id, (doc) => rows(doc)[0]?.status === "running", "the agent running");
		await server.post(`/api/sessions/${id}/agents/${rows(running)[0]!.id}/stop`);
		await server.settled(id);
		const [result] = await results(server, id, "Agent");
		assert.match(result!.text, /was stopped by the person before it finished/);
		assert.equal(ofKind(await server.entries(id), AGENT_STOPPED_ENTRY).length, 0, "a foreground agent's stop is its call's result");
	});

	test("archiving a session stops its agents first", async () => {
		const id = await server.createSession(delegate("agent probe bg [wait] forever"));
		await server.until(id, (doc) => rows(doc)[0]?.status === "running", "the agent running");
		await server.post(`/api/sessions/${id}/archive`, { archived: true });
		const archived = await server.until(id, (doc) => rows(doc)[0]?.status === "stopped", "the agent stopped");
		assert.equal(archived.archived, true);
	});
});

describe("the report and the end of a turn", () => {
	test("the report is refused while agents work, and a turn that ends with agents running waits for them", async () => {
		const server = await TestServer.start();
		try {
			await define(server, "probe", PROBE);
			const id = await server.createSession(delegate("agent probe bg [wait] forever"));
			await server.until(id, (doc) => doc.outcome?.kind === "waiting-agents", "waiting on agents");
			await server.send(id, delegate("report"));
			await server.settled(id);
			const waiting = await server.until(id, (doc) => doc.outcome?.kind === "waiting-agents", "waiting on agents again");
			const [report] = await results(server, id, "file_report");
			assert.equal(report!.isError, true);
			assert.equal(report!.text, "1 agent is still running or queued. Its answer arrives as a message; file the report after it has.");
			assert.equal(waiting.report, undefined);
			assert.equal(waiting.continuations, 0, "no automatic continuation");
			assert.equal(sessionRow(waiting as SessionDoc).label, "Waiting on agents");
			await server.app.supervisor.idle();
			assert.equal((await server.session(id))!.notified.length, 0, "and no notification");
			await server.post(`/api/sessions/${id}/stop`);
			const stopped = await server.until(id, (doc) => rows(doc)[0]?.status === "stopped" && doc.outcome?.kind === "stopped", "stopped");
			assert.equal(sessionRow(stopped as SessionDoc).label, "Stopped");
		} finally {
			await server.close();
		}
	});
});

describe("an Agent call and the report in one round", () => {
	test("whichever comes first, no agent works for a run whose report is filed", async () => {
		const server = await TestServer.start();
		try {
			await define(server, "probe", PROBE);
			// The agent first: the round runs in call order, so it exists by the time the report checks, which refuses.
			const first = await server.createSession(delegate("agent probe bg [wait] forever", "report"));
			const waiting = await server.until(first, (doc) => doc.outcome?.kind === "waiting-agents", "waiting on agents");
			const [refused] = await results(server, first, "file_report");
			assert.equal(refused?.isError, true);
			assert.equal(refused?.text, "1 agent is still running or queued. Its answer arrives as a message; file the report after it has.");
			assert.equal(waiting.report, undefined);
			// The report first: it is filed, and the agent after it is refused, so nothing works after the report.
			const second = await server.createSession(delegate("report", "agent probe bg [wait] forever"));
			const reported = await server.until(second, (doc) => doc.outcome?.kind === "reported" && doc.activeRun === undefined, "reported");
			const [filed] = await results(server, second, "file_report");
			assert.equal(filed?.isError, false);
			const [agent] = await results(server, second, "Agent");
			assert.equal(agent?.isError, true);
			assert.equal(agent?.text, "This run's report is filed, so no agent can start in it. Start agents before the report, and file it once their answers are in.");
			assert.deepEqual(rows(reported), []);
			await server.post(`/api/sessions/${first}/stop`);
		} finally {
			await server.close();
		}
	});
});

describe("spend", () => {
	test("a session's spend counts its agents', and reaching the cap stops them and tells the person once", async () => {
		const server = await TestServer.start();
		try {
			await define(server, "probe", PROBE);
			const id = await server.createSession(delegate("agent probe bg [wait] one", "agent probe bg [wait] two"));
			await server.until(id, (doc) => statuses(doc).join() === "running,running" && doc.outcome?.kind === "waiting-agents", "both running");
			const usage = (conversation: number) => server.app.harness.snapshot(UsageDoc, conversation as ConversationId, context);
			const own = spentOf(await usage(id));
			// A cap a little over what the session has spent: only the agents, still working, can reach it.
			const sofar = own + (await Promise.all(rows((await server.session(id))!).map(async (row) => spentOf(await usage(row.id))))).reduce((sum, spent) => sum + spent, 0);
			const cap = Math.ceil((sofar + 0.005) * 1000) / 1000;
			await server.post(`/api/sessions/${id}/budget`, { cap });
			const over = await server.until(id, (doc) => doc.outcome?.kind === "budget" && rows(doc).every((row) => row.status === "stopped"), "the cap", 60_000);
			const agents = await Promise.all(rows(over).map(async (row) => spentOf(await usage(row.id))));
			assert.ok(agents.every((spent) => spent > 0), "each agent spent");
			assert.equal(spentOf(await usage(id)), own, "the session's own agent spent nothing more");
			assert.ok(own < cap && own + agents.reduce((sum, spent) => sum + spent, 0) >= cap, "its agents' spend took the session to its cap");
			await server.app.supervisor.idle();
			const after = (await server.session(id))!;
			assert.deepEqual(after.notified.filter((key) => key.startsWith("budget:")), [`budget:${cap}`]);
			assert.equal(after.outcome?.kind, "budget");
			await assert.rejects(server.send(id, "Go on"), (error: { status?: number }) => error.status === 409);
		} finally {
			await server.close();
		}
	});
});

describe("definitions and the setting", () => {
	let server: TestServer;
	before(async () => {
		server = await TestServer.start();
	});
	after(() => server.close());

	test("a definition missing a field, on an unknown model, with none of its tools, or asking for what picloud does not do is refused with why", async () => {
		const refusals: Record<string, string> = {
			nodesc: "---\ntools: read\n---\nHello.\n",
			badmodel: "---\ndescription: On a model there is not\ntools: read\nmodel: nowhere/nothing\n---\nHello.\n",
			remembers: "---\ndescription: Wants memory\ntools: read\nmemory: project\n---\nHello.\n",
			appender: "---\ndescription: Wants the session's prompt too\nprompt_mode: append\n---\nHello.\n",
			extender: "---\ndescription: Wants every extension\nextensions: true\n---\nHello.\n",
			picker: "---\ndescription: Wants some extensions\nextensions: [web]\n---\nHello.\n",
			preloader: "---\ndescription: Wants skills preloaded\nskills: [release-notes]\n---\nHello.\n",
			nothere: "---\ndescription: Only tools there are not\ntools: teleport, file_report\n---\nHello.\n",
		};
		for (const [name, text] of Object.entries(refusals)) await define(server, name, text);
		const id = await server.createSession(delegate(...Object.keys(refusals).map((name) => `agent ${name} fg hi`)));
		const done = await server.settled(id);
		assert.equal(rows(done).length, 0, "no refused agent starts");
		const refused = await results(server, id, "Agent");
		const said = (pattern: RegExp) => assert.ok(refused.some((result) => result.isError && pattern.test(result.text)), `${pattern}: ${refused.map((result) => result.text).join(" | ")}`);
		said(/The agent nodesc cannot run: description is required\. Its file is agents\/nodesc\.md/);
		said(/The agent badmodel cannot run: model nowhere\/nothing is not one of Pi's configured models/);
		said(/The agent remembers cannot run: "memory" is a field picloud does not support/);
		said(/The agent appender cannot run: prompt_mode "append" is not supported/);
		said(/The agent extender cannot run: extensions must be false or left out/);
		said(/The agent picker cannot run: extensions must be false or left out/);
		said(/The agent preloader cannot run: skills must be true or false/);
		// picloud's own tools are the session's agent's alone, so they count as missing too.
		said(/The agent nothere cannot run: none of its tools is available here \(teleport, file_report\)/);
		const sections = (await server.entries(id)).flatMap((entry) => (entry.kind === "pi.system" ? [(entry.model?.[0] as { sections?: Record<string, string> }).sections?.subagents ?? ""] : []));
		assert.doesNotMatch(sections.join("\n"), new RegExp(Object.keys(refusals).join("|")), "refused agents are not offered");
	});

	test("pi-subagents' fields work as written: the coding tools without a tools field, no skills list with skills: false, and only the tools that exist", async () => {
		await define(server, "plain", "---\ndescription: Codes without skills\ndisplay_name: Plain\nprompt_mode: replace\nextensions: false\nskills: false\n---\nYou answer.\n");
		await define(server, "partial", "---\ndescription: Searches\ntools: read, grep, find\nskills: true\n---\nYou answer.\n");
		const id = await server.createSession(delegate("agent plain fg hi", "agent partial fg hi"));
		const done = await server.settled(id);
		assert.deepEqual(statuses(done), ["done", "done"]);
		const system = async (conversation: number) => {
			const entries = (await server.entries(conversation)).filter((entry) => entry.kind === "pi.system").map((entry) => entry.model?.[0] as { sections?: Record<string, string>; toolsAdded?: { name: string }[] });
			return { sections: Object.assign({}, ...entries.map((entry) => entry.sections ?? {})) as Record<string, string>, tools: entries.flatMap((entry) => entry.toolsAdded ?? []).map((tool) => tool.name) };
		};
		const parent = await system(id);
		const byType = (type: string) => rows(done).find((row) => row.type === type)!.id;
		const plain = await system(byType("plain"));
		const partial = await system(byType("partial"));
		assert.deepEqual([...plain.tools].sort(), ["bash", "edit", "read", "write"], "the coding tools, as installed");
		assert.equal(plain.sections.skills, undefined, "skills: false leaves the skills list out");
		assert.match(plain.sections.project_context ?? "", /# Working on greeter/);
		assert.match(partial.sections.skills ?? "", /release-notes/);
		assert.match(parent.sections.skills ?? "", /release-notes/, "the session's agent keeps its skills list");
		assert.deepEqual(partial.tools, ["read"]);
		assert.match(parent.sections.subagents ?? "", /- partial: Searches Here it has read; grep and find are not available in picloud\./);
		assert.match(parent.sections.subagents ?? "", /- plain: Codes without skills\n/);
	});

	test("every bundled definition is accepted, but for a model that is not configured here", async () => {
		const tools = new Set([...createCodingTools().tools!.map((tool) => tool.name), "Agent", "steer_subagent"]);
		const coding = createCodingTools().tools!.map((tool) => tool.name);
		const bundled = join(import.meta.dirname, "..");
		const configured = await readDefinitions(bundled, { tools, coding, runs: async () => true });
		assert.deepEqual(configured.refused, [], "with their models configured, every bundled agent runs");
		assert.deepEqual(configured.agents.map((agent) => agent.name).sort(), ["implementer", "scout", "thought-partner", "verifier"]);
		const scout = configured.agents.find((agent) => agent.name === "scout")!;
		assert.deepEqual(scout.tools, ["read", "bash"]);
		assert.deepEqual(scout.missing, ["grep", "find", "ls"]);
		assert.equal(scout.skills, false);
		assert.deepEqual(configured.agents.find((agent) => agent.name === "implementer")!.tools, coding);
		const here = await readDefinitions(bundled, { tools, coding, runs: async () => false });
		for (const refusal of here.refused) assert.match(refusal.reason, /^model lunaroute\/[\w.-]+ is not one of Pi's configured models$/, refusal.file);
		assert.deepEqual(here.agents.map((agent) => agent.name), ["thought-partner"]);
	});

	test("an edit to a definition applies at its next use, with no restart", async () => {
		await define(server, "later", "---\ndescription: Not ready\ntools: read\n---\n");
		const id = await server.createSession(delegate("agent later fg hi"));
		await server.settled(id);
		assert.match((await results(server, id, "Agent"))[0]!.text, /the body, the agent's prompt, is empty/);
		await define(server, "later", "---\ndescription: Ready now\ntools: read\nmodel: picloud-fake/scripted\nthinking: low\nmax_turns: 3\ncolor: blue\n---\nYou answer.\n");
		await server.send(id, delegate("agent later fg hi again"));
		const done = await server.settled(id);
		assert.equal(rows(done)[0]?.status, "done");
		const agent = await server.app.harness.conversation(rows(done)[0]!.id as ConversationId, context);
		const configured = await agent!.agent(context);
		assert.equal(configured.maxTurns, 3);
		assert.equal(configured.thinkingLevel, "low");
		assert.deepEqual(configured.model, { provider: "picloud-fake", modelId: "scripted" });
	});

	test("a settings file that does not validate refuses dispatch, and leaves a queued agent queued while anything could wake it", async () => {
		await define(server, "probe", PROBE);
		await setLimit(server, '{ "maxInFlight": 2 }');
		try {
			const id = await server.createSession(delegate("agent probe bg [wait] a", "agent probe bg [wait] b", "agent probe bg [wait] c"));
			const started = await server.until(id, (doc) => statuses(doc).join() === "running,running,queued" && doc.activeRun === undefined, "two running, one queued");
			const [a, b] = rows(started);
			await setLimit(server, '{ "maxInFlight": 0 }');
			await server.send(id, delegate("agent probe bg d"));
			await server.settled(id);
			const refused = (await results(server, id, "Agent")).at(-1)!;
			assert.equal(refused.isError, true);
			assert.match(refused.text, /^No agent can start: .*subagent-settings\.json is not valid: .*maxInFlight/);
			// One running agent ends: the queued one looks again, finds the file broken, and waits for the other.
			await setLimit(server, "{ not json");
			await server.post(`/api/sessions/${id}/agents/${a!.id}/stop`);
			await server.until(id, (doc) => statuses(doc).join() === "stopped,running,queued", "the first one stopped");
			await new Promise((resolve) => setTimeout(resolve, 200));
			assert.equal(statuses((await server.session(id))!).join(), "stopped,running,queued", "the queued one stays queued");
			assert.equal(rows((await server.session(id))!).length, 3, "nothing else was dispatched");
			// Fixed, it starts when the next one ends.
			await setLimit(server, '{ "maxInFlight": 1 }');
			await server.post(`/api/sessions/${id}/agents/${b!.id}/stop`);
			await server.until(id, (doc) => statuses(doc).join() === "stopped,stopped,running", "the queued one starting");
			// With nothing left to wake it, a queued agent ends with the file's error rather than waiting for ever.
			await server.send(id, delegate("agent probe bg [wait] e"));
			await server.until(id, (doc) => statuses(doc).join() === "stopped,stopped,running,queued", "another queued");
			await setLimit(server, "{ not json");
			await server.post(`/api/sessions/${id}/agents/${rows((await server.session(id))!)[2]!.id}/stop`);
			const failed = await server.until(id, (doc) => rows(doc)[3]?.status === "failed", "the queued one failing");
			assert.equal(rows(failed)[3]!.reason, "settings");
			await server.until(id, (doc) => doc.outcome?.kind === "replied", "the parent reading the failure");
			const told = ofKind(await server.entries(id), AGENT_RESULT_ENTRY).at(-1)!;
			assert.match(modelText(told), /failed: It could not start: .*subagent-settings\.json could not be read as JSON/);
		} finally {
			await setLimit(server, '{ "maxInFlight": 4 }');
		}
	});
});

describe("the agents folder and the settings file", () => {
	test("are created at startup only when missing, and an existing folder is never touched", async () => {
		const server = await TestServer.start();
		try {
			const folder = join(server.dataDir, "agents");
			const bundled = join(import.meta.dirname, "..", "agents");
			const files = (await readdir(bundled)).sort();
			assert.deepEqual((await readdir(folder)).sort(), files);
			for (const file of files) assert.deepEqual(await readFile(join(folder, file)), await readFile(join(bundled, file)), file);
			assert.deepEqual(JSON.parse(await readFile(join(server.dataDir, "subagent-settings.json"), "utf8")), { maxInFlight: 4 });
			// The person's folder: all but one definition removed, one of their own added, the setting changed.
			for (const file of files.filter((name) => name !== "scout.md")) await rm(join(folder, file));
			await define(server, "mine", PROBE);
			await setLimit(server, '{ "maxInFlight": 2 }');
			await server.restart();
			assert.deepEqual((await readdir(folder)).sort(), ["mine.md", "scout.md"]);
			assert.deepEqual(JSON.parse(await readFile(join(server.dataDir, "subagent-settings.json"), "utf8")), { maxInFlight: 2 });
		} finally {
			await server.close();
		}
	});
});
