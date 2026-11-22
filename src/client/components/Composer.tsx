// The composer: an input pill with an attachment button and a send button that becomes Stop while Pi works and nothing
// is typed. `@` opens a picker of the repository's files and `#` one of Pi's skills; both narrow as the person types.
import type { ComponentChildren, JSX } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { SkillSummary } from "../../shared/api.ts";
import { activeTrigger, insertReference, narrow, type Trigger } from "../../shared/references.ts";
import { api, describeFailure, newRequestId, RequestFailed } from "../api.ts";
import { type Draft, loadDraft, saveDraft } from "../drafts.ts";
import { shrinkPhoto } from "../images.ts";
import { showToast } from "../store.ts";
import { followEnd } from "../viewport.ts";
import { Icon } from "./Icons.tsx";

type ComposerProps = {
	draftKey: string;
	placeholder: string;
	running: boolean;
	disabled?: boolean;
	/** Changes whenever something asks the composer to take focus. */
	focusToken: number;
	files: () => Promise<string[]>;
	skills: () => Promise<SkillSummary[]>;
	onSend: (text: string, attachments: string[], requestId: string) => Promise<void>;
	onStop?: () => Promise<void>;
};

const PICKER_SIZE = 8;

export function Composer(props: ComposerProps): JSX.Element {
	const [draft, setDraft] = useState<Draft>(() => loadDraft(props.draftKey));
	const [trigger, setTrigger] = useState<Trigger | undefined>(undefined);
	const [candidates, setCandidates] = useState<{ files?: string[]; skills?: SkillSummary[] }>({});
	const [sending, setSending] = useState(false);
	const [uploading, setUploading] = useState(0);
	const input = useRef<HTMLTextAreaElement>(null);
	const picker = useRef<HTMLInputElement>(null);
	// Where the caret goes after an inserted reference renders; set before the next keystroke can arrive.
	const caretAfterRender = useRef<number | undefined>(undefined);
	useLayoutEffect(() => {
		const caret = caretAfterRender.current;
		if (caret === undefined || input.current === null) return;
		caretAfterRender.current = undefined;
		input.current.focus();
		input.current.setSelectionRange(caret, caret);
	});

	useEffect(() => {
		setDraft(loadDraft(props.draftKey));
		setCandidates({});
		setTrigger(undefined);
	}, [props.draftKey]);
	useEffect(() => {
		if (props.focusToken > 0) input.current?.focus();
	}, [props.focusToken]);
	useEffect(() => {
		const element = input.current;
		if (element === null) return;
		element.style.height = "auto";
		// Measured against the visible viewport, which is all that is left above the keyboard.
		element.style.height = `${Math.min(element.scrollHeight, (window.visualViewport?.height ?? window.innerHeight) * 0.4)}px`;
	}, [draft.text]);

	const update = (next: Draft) => {
		setDraft(next);
		saveDraft(props.draftKey, next);
	};

	const refreshTrigger = (text: string, caret: number) => {
		const found = activeTrigger(text, caret);
		setTrigger(found);
		if (found?.kind === "file" && candidates.files === undefined) {
			void props.files().then((files) => setCandidates((current) => ({ ...current, files })), () => setCandidates((current) => ({ ...current, files: [] })));
		}
		if (found?.kind === "skill" && candidates.skills === undefined) {
			void props.skills().then((skills) => setCandidates((current) => ({ ...current, skills })), () => setCandidates((current) => ({ ...current, skills: [] })));
		}
	};

	const onInput = (event: Event) => {
		const element = event.target as HTMLTextAreaElement;
		update({ ...draft, text: element.value });
		refreshTrigger(element.value, element.selectionStart);
	};

	const choose = (value: string) => {
		const element = input.current;
		if (element === null || trigger === undefined) return;
		const inserted = insertReference(draft.text, trigger, element.selectionStart, value);
		caretAfterRender.current = inserted.caret;
		update({ ...draft, text: inserted.text });
		setTrigger(undefined);
	};

	const attach = async (files: FileList | null) => {
		if (files === null) return;
		for (const file of Array.from(files)) {
			setUploading((count) => count + 1);
			try {
				const { blob, name } = await shrinkPhoto(file);
				const uploaded = await api.upload(blob, name);
				setDraft((current) => {
					const next = { ...current, attachments: [...current.attachments, { id: uploaded.id, name: uploaded.name, image: uploaded.mimeType.startsWith("image/") }] };
					saveDraft(props.draftKey, next);
					return next;
				});
			} catch (error) {
				showToast({ message: `Could not attach ${file.name}: ${describeFailure(error).message}` });
			} finally {
				setUploading((count) => count - 1);
			}
		}
		if (picker.current !== null) picker.current.value = "";
	};

	const empty = draft.text.trim() === "" && draft.attachments.length === 0;
	const showStop = props.running && empty && props.onStop !== undefined;

	const send = async () => {
		if (empty || sending || uploading > 0) return;
		const requestId = draft.requestId ?? newRequestId();
		const pending = { ...draft, requestId };
		update(pending);
		setSending(true);
		try {
			await props.onSend(pending.text, pending.attachments.map((attachment) => attachment.id), requestId);
			update({ text: "", attachments: [] });
			setTrigger(undefined);
		} catch (error) {
			// The server answered, so it did not act: a later send is a new request. Without an answer, keep the ID.
			if (error instanceof RequestFailed && error.status !== 0) update({ ...pending, requestId: undefined } as Draft);
			const failure = describeFailure(error);
			showToast({ message: failure.hint === undefined ? failure.message : `${failure.message} ${failure.hint}` });
		} finally {
			setSending(false);
		}
	};

	const list =
		trigger === undefined
			? []
			: trigger.kind === "file"
				? narrow(candidates.files ?? [], trigger.query, PICKER_SIZE).map((value) => ({ value, detail: "" }))
				: (() => {
						const skills = candidates.skills ?? [];
						return narrow(skills.map((skill) => skill.name), trigger.query, PICKER_SIZE).map((value) => ({
							value,
							detail: skills.find((skill) => skill.name === value)?.description ?? "",
						}));
					})();

	return (
		<form
			class="composer"
			aria-busy={sending}
			onSubmit={(event) => {
				event.preventDefault();
				void send();
			}}
		>
			{trigger !== undefined && list.length > 0 ? (
				<ul class="picker" role="listbox" aria-label={trigger.kind === "file" ? "Files" : "Skills"}>
					{list.map((item) => (
						<li key={item.value} role="option" aria-selected="false">
							<button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => choose(item.value)}>
								<span class="picker-value">
									{trigger.kind === "file" ? "@" : "#"}
									{item.value}
								</span>
								{item.detail === "" ? null : <span class="picker-detail">{item.detail}</span>}
							</button>
						</li>
					))}
				</ul>
			) : null}
			{draft.attachments.length > 0 || uploading > 0 ? (
				<div class="attachments">
					{draft.attachments.map((attachment) => (
						<span class="chip" key={attachment.id}>
							<Icon name="clip" size={14} /> {attachment.name}
							<button
								type="button"
								class="chip-remove"
								aria-label={`Remove ${attachment.name}`}
								onClick={() => update({ ...draft, attachments: draft.attachments.filter((item) => item.id !== attachment.id) })}
							>
								<Icon name="close" size={16} />
							</button>
						</span>
					))}
					{uploading > 0 ? (
						<span class="chip">
							<span class="spinner" aria-hidden="true" /> Uploading…
						</span>
					) : null}
				</div>
			) : null}
			<div class="pill">
				<button type="button" class="icon-button" aria-label="Attach files or photos" disabled={props.disabled} onClick={() => picker.current?.click()}>
					<Icon name="clip" />
				</button>
				<input ref={picker} type="file" multiple hidden onChange={(event) => void attach((event.target as HTMLInputElement).files)} />
				<textarea
					ref={input}
					rows={1}
					value={draft.text}
					placeholder={props.placeholder}
					aria-label={props.placeholder}
					disabled={props.disabled}
					onInput={onInput}
					onClick={(event) => refreshTrigger(draft.text, (event.target as HTMLTextAreaElement).selectionStart)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
							event.preventDefault();
							void send();
						}
						if (event.key === "Escape") setTrigger(undefined);
					}}
					onBlur={() => setTimeout(() => setTrigger(undefined), 150)}
				/>
				{showStop ? (
					<button type="button" class="icon-button send stop" aria-label="Stop" onClick={() => void props.onStop?.()}>
						<Icon name="stop" size={18} />
					</button>
				) : (
					<button type="submit" class="icon-button send" aria-label="Send" disabled={empty || sending || uploading > 0 || props.disabled}>
						<Icon name="send" size={18} />
					</button>
				)}
			</div>
		</form>
	);
}

/**
 * The bar at the bottom that holds the composer and anything about to need the person. Its height is published as
 * `--dock-height` so toasts rise just above it, and when it grows the transcript's end stays in view.
 */
export function ComposerDock(props: { children: ComponentChildren }): JSX.Element {
	const dock = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const element = dock.current;
		if (element === null) return;
		const root = document.documentElement;
		const observer = new ResizeObserver(() => {
			root.style.setProperty("--dock-height", `${element.offsetHeight}px`);
			followEnd();
		});
		observer.observe(element);
		return () => {
			observer.disconnect();
			root.style.removeProperty("--dock-height");
		};
	}, []);
	return (
		<div ref={dock} class="composer-dock">
			{props.children}
		</div>
	);
}
