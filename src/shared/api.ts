// HTTP payloads. Request bodies are pi-schema schemas, so the server validates exactly the shapes the client types
// against; responses are plain types.
import { arr, bool, lit, num, obj, oneOf, opt, type Static, str, union } from "@earendil-works/pi-schema";

const RequestId = str({ minLength: 8, maxLength: 100, description: "Client-chosen ID that makes a retried request idempotent" });
const Repo = str({ pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", maxLength: 200 });
const BranchName = str({ minLength: 1, maxLength: 250, pattern: "^[^\\s~^:?*\\[\\\\]+$" });
const MessageText = str({ maxLength: 100_000 });
const AttachmentIds = arr(str({ pattern: "^[a-f0-9]{32}$" }), { maxItems: 20 });

/** A directory on this computer as the person typed it: absolute, or starting with `~`. */
const LocalDir = str({ minLength: 1, maxLength: 4096 });

/** What starts any session: the first message. */
const Opening = { requestId: RequestId, text: str({ minLength: 1, maxLength: 100_000 }), attachments: AttachmentIds };

/** A repository session, on a new or continued branch; or, in picloud OnPrem only, a local session in a directory. */
export const CreateSessionBody = union([
	obj({
		...Opening,
		place: lit("repo"),
		repo: Repo,
		start: union([obj({ kind: lit("new"), base: BranchName }), obj({ kind: lit("continue"), branch: BranchName })]),
	}),
	obj({ ...Opening, place: lit("local"), dir: LocalDir }),
]);
export type CreateSessionBody = Static<typeof CreateSessionBody>;

export const SendMessageBody = obj({
	requestId: RequestId,
	text: MessageText,
	attachments: AttachmentIds,
});
export type SendMessageBody = Static<typeof SendMessageBody>;

const QuestionAnswerSchema = obj({
	questionId: str({ maxLength: 100 }),
	selected: arr(str({ maxLength: 100 }), { maxItems: 50 }),
	text: opt(str({ maxLength: 20_000 })),
});

export const AnswerCardBody = obj({
	requestId: RequestId,
	cardId: str({ maxLength: 200 }),
	answer: union([
		obj({ kind: lit("questions"), answers: arr(QuestionAnswerSchema, { maxItems: 50 }) }),
		obj({ kind: lit("text"), text: str({ minLength: 1, maxLength: 100_000 }) }),
		obj({ kind: lit("approve") }),
		obj({ kind: lit("revise"), feedback: str({ minLength: 1, maxLength: 100_000 }) }),
	]),
});
export type AnswerCardBody = Static<typeof AnswerCardBody>;

export const DeliverBody = obj({ action: oneOf(["push", "pr"]) });
export type DeliverBody = Static<typeof DeliverBody>;

export const BudgetBody = obj({ cap: num({ exclusiveMinimum: 0, maximum: 100_000 }) });
export type BudgetBody = Static<typeof BudgetBody>;

export const ArchiveBody = obj({ archived: bool() });
export type ArchiveBody = Static<typeof ArchiveBody>;

/** Star a directory on this computer, or unstar it (picloud OnPrem only). */
export const StarDirBody = obj({ dir: LocalDir, starred: bool() });
export type StarDirBody = Static<typeof StarDirBody>;

export const PushSubscriptionBody = obj(
	{
		endpoint: str({ pattern: "^https://", maxLength: 2000 }),
		keys: obj({ p256dh: str({ maxLength: 200 }), auth: str({ maxLength: 100 }) }, { open: true }),
	},
	{ open: true },
);
export type PushSubscriptionBody = Static<typeof PushSubscriptionBody>;

/**
 * The most text one segment of speech holds. Kokoro reads at most 510 phonemes a call and cuts off the rest; letters
 * read one by one ("A P I") take two and a half phonemes a character, the most any speakable text does, so a segment
 * this long is always read whole.
 */
export const SPEECH_SEGMENT_CHARS = 200;

/** A reply's Markdown, as the phone shows it, to be rewritten as a speakable script. */
export const SpeechScriptBody = obj({ text: str({ minLength: 1, maxLength: 100_000 }) });
export type SpeechScriptBody = Static<typeof SpeechScriptBody>;

/** One segment of a speakable script, to be read aloud. */
export const SpeechBody = obj({ text: str({ minLength: 1, maxLength: SPEECH_SEGMENT_CHARS }) });
export type SpeechBody = Static<typeof SpeechBody>;

/**
 * The speakable script, one line of newline-delimited JSON per message: each segment as soon as its sentence is
 * written, then `done`, or `error` when the model failed partway, after the response had begun.
 */
export type ScriptLine = { t: "segment"; text: string } | { t: "done" } | ({ t: "error" } & ApiError);

/** Every error response: what went wrong and, where there is one, what the person can do next. */
export type ApiError = {
	error: string;
	hint?: string;
};

/** Whether long-term memory is on, with what model; or why it is off, worded for the person who can turn it on. */
export type MemoryStatus = { on: true; model: string } | { on: false; reason: string };

export type Bootstrap = {
	fake: boolean;
	vapidPublicKey: string;
	lastRepo?: string;
	/** Whether this server reads replies aloud: built with speech and its model in place, or in fake mode. */
	speech: boolean;
	memory: MemoryStatus;
	/**
	 * Present when picloud runs on the person's own computer (PICLOUD_ONPREM): their home directory, where a local
	 * session starts unless another directory is chosen, and which the app shows as `~`.
	 */
	onPrem?: { home: string };
};

export type RepoSummary = {
	name: string;
	defaultBranch: string;
	description?: string;
};

export type BranchList = {
	defaultBranch: string;
	branches: string[];
};

export type FileList = {
	files: string[];
	truncated: boolean;
};

export type SkillSummary = {
	name: string;
	description: string;
};

export type CreatedSession = {
	id: number;
};

/** Where a sent message went: a waiting card, the running run, or a new run. */
export type MessageRoute = "card" | "steer" | "run";

export type SentMessage = {
	route: MessageRoute;
};

export type UploadedAttachment = {
	id: string;
	name: string;
	mimeType: string;
	size: number;
};

export type DiffFile = {
	path: string;
	/** Previous path of a rename. */
	from?: string;
	status: "added" | "modified" | "deleted" | "renamed";
	added: number;
	removed: number;
	binary: boolean;
	/** Unified diff hunks; empty for binary files and truncated past a size limit. */
	patch: string;
	truncated: boolean;
};

export type SessionDiff = {
	base: string;
	files: DiffFile[];
	/** Working-tree changes Pi has not committed; not part of a delivery. */
	uncommitted: number;
};

export type DeliveryResult = {
	pushed: string;
	pr?: { number: number; url: string; created: boolean };
};
