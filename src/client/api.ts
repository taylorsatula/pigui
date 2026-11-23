// HTTP calls. Every request that changes something carries a request ID, kept until it succeeds, so a send retried on
// a flaky connection takes effect once.
import type {
	AnswerCardBody,
	ApiError,
	Bootstrap,
	BranchList,
	CreatedSession,
	CreateSessionBody,
	DeliveryResult,
	FileList,
	RepoSummary,
	ScriptLine,
	SentMessage,
	SessionDiff,
	SkillSummary,
	SpeechBody,
	SpeechScriptBody,
	UploadedAttachment,
} from "../shared/api.ts";
import type { CardAnswer } from "../shared/session.ts";
import { store } from "./store.ts";

export class RequestFailed extends Error {
	readonly status: number;
	readonly hint: string | undefined;

	constructor(status: number, body: ApiError) {
		super(body.error);
		this.status = status;
		this.hint = body.hint;
	}
}

export function newRequestId(): string {
	const bytes = new Uint8Array(12);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const RETRIES = 3;

/**
 * What to say when picloud does not answer: opened at localhost, it is OnPrem on this computer; otherwise it is reached
 * through Tailscale, whether a server or OnPrem on a computer of the tailnet.
 */
function unreachable(): ApiError {
	const here = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
	if (here) return { error: "picloud cannot be reached.", hint: "Check that picloud is running on this computer." };
	const onPrem = store.get().bootstrap?.onPrem !== undefined;
	return { error: "picloud cannot be reached.", hint: onPrem ? "Check that Tailscale is connected, and that picloud is running on its computer." : "Check that Tailscale is connected." };
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
	let lastError: unknown;
	// Network failures are retried with the same body, request ID included; answers from the server are final.
	for (let attempt = 0; attempt < RETRIES; attempt++) {
		let response: Response;
		try {
			const init: RequestInit = { method, headers: body === undefined ? {} : { "content-type": "application/json" } };
			if (body !== undefined) init.body = JSON.stringify(body);
			response = await fetch(path, init);
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
			continue;
		}
		const json = (await response.json().catch(() => ({ error: `The server answered ${response.status}.` }))) as T & ApiError;
		if (!response.ok) throw new RequestFailed(response.status, json);
		return json;
	}
	throw new RequestFailed(0, lastError instanceof Error ? unreachable() : { error: unreachable().error });
}

/** A POST the person can stop with `signal`, for reading aloud; nothing is retried, since a tap starts it again. */
async function stoppable(path: string, body: unknown, signal: AbortSignal): Promise<Response> {
	let response: Response;
	try {
		response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
	} catch (error) {
		if (signal.aborted) throw error;
		throw new RequestFailed(0, unreachable());
	}
	if (!response.ok) throw new RequestFailed(response.status, (await response.json().catch(() => ({ error: `The server answered ${response.status}.` }))) as ApiError);
	return response;
}

/** The messages of a newline-delimited JSON response (the live stream, a speech script) as they arrive. */
export async function* lines<T>(response: Response): AsyncGenerator<T> {
	if (response.body === null) return;
	const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
	let buffer = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) return;
		buffer += value;
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (line.trim() !== "") yield JSON.parse(line) as T;
			newline = buffer.indexOf("\n");
		}
	}
}

export const api = {
	bootstrap: () => call<Bootstrap>("GET", "/api/bootstrap"),
	repos: () => call<RepoSummary[]>("GET", "/api/repos"),
	branches: (repo: string) => call<BranchList>("GET", `/api/repos/${repo}/branches`),
	repoFiles: (repo: string, ref: string) => call<FileList>("GET", `/api/repos/${repo}/files?ref=${encodeURIComponent(ref)}`),
	repoSkills: (repo: string, ref: string) => call<SkillSummary[]>("GET", `/api/repos/${repo}/skills?ref=${encodeURIComponent(ref)}`),
	localFiles: (dir: string) => call<FileList>("GET", `/api/local/files?dir=${encodeURIComponent(dir)}`),
	localSkills: (dir: string) => call<SkillSummary[]>("GET", `/api/local/skills?dir=${encodeURIComponent(dir)}`),
	sessionFiles: (id: number) => call<FileList>("GET", `/api/sessions/${id}/files`),
	sessionSkills: (id: number) => call<SkillSummary[]>("GET", `/api/sessions/${id}/skills`),
	create: (body: CreateSessionBody) => call<CreatedSession>("POST", "/api/sessions", body),
	send: (id: number, requestId: string, text: string, attachments: string[]) =>
		call<SentMessage>("POST", `/api/sessions/${id}/messages`, { requestId, text, attachments }),
	answer: (id: number, cardId: string, answer: CardAnswer) =>
		call<object>("POST", `/api/sessions/${id}/answer`, { requestId: newRequestId(), cardId, answer } satisfies AnswerCardBody),
	stop: (id: number) => call<object>("POST", `/api/sessions/${id}/stop`),
	continue: (id: number) => call<object>("POST", `/api/sessions/${id}/continue`),
	budget: (id: number, cap: number) => call<object>("POST", `/api/sessions/${id}/budget`, { cap }),
	deliver: (id: number, action: "push" | "pr") => call<DeliveryResult>("POST", `/api/sessions/${id}/deliver`, { action }),
	diff: (id: number) => call<SessionDiff>("GET", `/api/sessions/${id}/diff`),
	archive: (id: number, archived: boolean) => call<object>("POST", `/api/sessions/${id}/archive`, { archived }),
	seen: (id: number) => call<object>("POST", `/api/sessions/${id}/seen`),
	retrySetup: (id: number) => call<object>("POST", `/api/sessions/${id}/retry-setup`),
	subscribe: (subscription: PushSubscriptionJSON) => call<object>("POST", "/api/push/subscribe", subscription),

	/** A reply's speakable script, given segment by segment as the server writes it; resolves once it is complete. */
	async speechScript(id: number, text: string, signal: AbortSignal, segment: (text: string) => void): Promise<void> {
		const response = await stoppable(`/api/sessions/${id}/speech-script`, { text } satisfies SpeechScriptBody, signal);
		for await (const line of lines<ScriptLine>(response)) {
			if (line.t === "segment") segment(line.text);
			else if (line.t === "done") return;
			else throw new RequestFailed(response.status, line);
		}
		throw new RequestFailed(0, { error: "The connection closed before the reply was ready to read.", hint: "Tap the speaker to try again." });
	},

	/** One segment of a script, read aloud. */
	async speech(text: string, signal: AbortSignal): Promise<Blob> {
		return (await stoppable("/api/speech", { text } satisfies SpeechBody, signal)).blob();
	},

	async upload(file: Blob, name: string): Promise<UploadedAttachment> {
		const response = await fetch("/api/uploads", {
			method: "POST",
			headers: { "content-type": file.type || "application/octet-stream", "x-filename": encodeURIComponent(name) },
			body: file,
		});
		const json = (await response.json()) as UploadedAttachment & ApiError;
		if (!response.ok) throw new RequestFailed(response.status, json);
		return json;
	},
};

/** What to tell the person about a failed call. */
export function describeFailure(error: unknown): { message: string; hint?: string } {
	if (error instanceof RequestFailed) return error.hint === undefined ? { message: error.message } : { message: error.message, hint: error.hint };
	return { message: error instanceof Error ? error.message : "Something went wrong." };
}
