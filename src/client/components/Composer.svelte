<script lang="ts">
	// The composer: a text field with an attachment button and a send button that becomes Stop while Pi works and nothing
	// is typed. `@` opens a picker of the repository's files and `#` one of Pi's skills; both narrow as the person types.
	import type { SkillSummary } from "../../shared/api.ts";
	import { activeTrigger, insertReference, narrow, type Trigger } from "../../shared/references.ts";
	import { api, describeFailure, newRequestId, RequestFailed } from "../api.ts";
	import { type Draft, loadDraft, saveDraft } from "../drafts.ts";
	import { shrinkPhoto } from "../images.ts";
	import { showToast } from "../store.svelte.ts";
	import Icon from "./Icons.svelte";

	type ComposerProps = {
		draftKey: string;
		placeholder: string;
		running: boolean;
		disabled?: boolean;
		/** Changes whenever something asks the composer to take focus. */
		focusToken: number;
		/** Take focus when shown, and whenever it can be typed in again, where the device has a keyboard (see KEYBOARD). */
		autoFocus?: boolean;
		files: () => Promise<string[]>;
		skills: () => Promise<SkillSummary[]>;
		onSend: (text: string, attachments: string[], requestId: string) => Promise<void>;
		onStop?: () => Promise<void>;
	};

	let { draftKey, placeholder, running, disabled, focusToken, autoFocus, files, skills, onSend, onStop }: ComposerProps = $props();

	const PICKER_SIZE = 8;

	/**
	 * A device with a keyboard and a mouse or trackpad. There Return sends, Shift+Return writes a new line, and the field
	 * takes focus as a session opens. On a touch keyboard Return is the only way to write a new line, the send button sits
	 * beside it, and focusing the field would raise the keyboard over the conversation, so neither applies.
	 */
	const KEYBOARD = "(hover: hover) and (pointer: fine)";

	// The draft starts from storage and is then the person's to change; a draftKey change is reloaded by the effect below.
	// svelte-ignore state_referenced_locally
	let draft = $state<Draft>(loadDraft(draftKey));
	let trigger = $state<Trigger | undefined>(undefined);
	let candidates = $state<{ files?: string[]; skills?: SkillSummary[] }>({});
	let sending = $state(false);
	let uploading = $state(0);
	let input = $state<HTMLTextAreaElement | null>(null);
	let picker = $state<HTMLInputElement | null>(null);
	// Where the caret goes after an inserted reference renders; set before the next keystroke can arrive.
	let caret = $state<number | undefined>(undefined);

	$effect(() => {
		draft = loadDraft(draftKey);
		candidates = {};
		trigger = undefined;
	});
	$effect(() => {
		if (focusToken > 0) input?.focus();
	});
	$effect(() => {
		// Read draftKey so this re-runs when the session changes, as it did on the draftKey dependency before.
		void draftKey;
		if (autoFocus === true && disabled !== true && matchMedia(KEYBOARD).matches) input?.focus();
	});
	$effect(() => {
		// Read draft.text so this re-runs as it changes.
		void draft.text;
		const element = input;
		if (element === null) return;
		element.style.height = "auto";
		// Measured against the visible viewport, which is all that is left above the keyboard.
		element.style.height = `${Math.min(element.scrollHeight, (window.visualViewport?.height ?? window.innerHeight) * 0.4)}px`;
	});
	$effect(() => {
		if (caret === undefined || input === null) return;
		input.focus();
		input.setSelectionRange(caret, caret);
		caret = undefined;
	});

	const update = (next: Draft) => {
		draft = next;
		saveDraft(draftKey, next);
	};

	const refreshTrigger = (text: string, caretPos: number) => {
		const found = activeTrigger(text, caretPos);
		trigger = found;
		if (found?.kind === "file" && candidates.files === undefined) {
			void files().then((list) => (candidates = { ...candidates, files: list }), () => (candidates = { ...candidates, files: [] }));
		}
		if (found?.kind === "skill" && candidates.skills === undefined) {
			void skills().then((list) => (candidates = { ...candidates, skills: list }), () => (candidates = { ...candidates, skills: [] }));
		}
	};

	const onInput = (event: Event) => {
		const element = event.currentTarget as HTMLTextAreaElement;
		update({ ...draft, text: element.value });
		refreshTrigger(element.value, element.selectionStart);
	};

	const choose = (value: string) => {
		const element = input;
		if (element === null || trigger === undefined) return;
		const inserted = insertReference(draft.text, trigger, element.selectionStart, value);
		caret = inserted.caret;
		update({ ...draft, text: inserted.text });
		trigger = undefined;
	};

	const attach = async (list: FileList | null) => {
		if (list === null) return;
		for (const file of Array.from(list)) {
			uploading += 1;
			try {
				const { blob, name } = await shrinkPhoto(file);
				const uploaded = await api.upload(blob, name);
				draft = { ...draft, attachments: [...draft.attachments, { id: uploaded.id, name: uploaded.name, image: uploaded.mimeType.startsWith("image/") }] };
				saveDraft(draftKey, draft);
			} catch (error) {
				showToast({ message: `Could not attach ${file.name}: ${describeFailure(error).message}` });
			} finally {
				uploading -= 1;
			}
		}
		if (picker !== null) picker.value = "";
	};

	const empty = $derived(draft.text.trim() === "" && draft.attachments.length === 0);
	const showStop = $derived(running && empty && onStop !== undefined);

	const send = async () => {
		if (empty || sending || uploading > 0) return;
		const requestId = draft.requestId ?? newRequestId();
		const pending = { ...draft, requestId };
		update(pending);
		sending = true;
		try {
			await onSend(pending.text, pending.attachments.map((attachment) => attachment.id), requestId);
			update({ text: "", attachments: [] });
			trigger = undefined;
		} catch (error) {
			// The server answered, so it did not act: a later send is a new request. Without an answer, keep the ID.
			if (error instanceof RequestFailed && error.status !== 0) update({ ...pending, requestId: undefined });
			const failure = describeFailure(error);
			showToast({ message: failure.hint === undefined ? failure.message : `${failure.message} ${failure.hint}` });
		} finally {
			sending = false;
		}
	};

	const list = $derived(
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
					})(),
	);
</script>

<form
	class="composer"
	aria-busy={sending}
	onsubmit={(event) => {
		event.preventDefault();
		void send();
	}}
>
	{#if trigger !== undefined && list.length > 0}
		<ul class="picker" role="listbox" aria-label={trigger.kind === "file" ? "Files" : "Skills"}>
			{#each list as item (item.value)}
				<li role="option" aria-selected="false">
					<button type="button" onmousedown={(event) => event.preventDefault()} onclick={() => choose(item.value)}>
						<span class="picker-value">{trigger.kind === "file" ? "@" : "#"}{item.value}</span>
						{#if item.detail !== ""}<span class="picker-detail">{item.detail}</span>{/if}
					</button>
				</li>
			{/each}
		</ul>
	{/if}
	{#if draft.attachments.length > 0 || uploading > 0}
		<div class="attachments">
			{#each draft.attachments as attachment (attachment.id)}
				<span class="chip">
					<Icon name="clip" size={14} /> {attachment.name}
					<button
						type="button"
						class="chip-remove"
						aria-label={`Remove ${attachment.name}`}
						onclick={() => update({ ...draft, attachments: draft.attachments.filter((item) => item.id !== attachment.id) })}
					>
						<Icon name="close" size={16} />
					</button>
				</span>
			{/each}
			{#if uploading > 0}
				<span class="chip">
					<span class="spinner" aria-hidden="true"></span> Uploading…
				</span>
			{/if}
		</div>
	{/if}
	<div class="field-line">
		<button type="button" class="icon-button" aria-label="Attach files or photos" disabled={disabled} onclick={() => picker?.click()}>
			<Icon name="clip" />
		</button>
		<input type="file" multiple hidden bind:this={picker} onchange={(event) => void attach(event.currentTarget.files)} />
		<textarea
			rows={1}
			value={draft.text}
			placeholder={placeholder}
			aria-label={placeholder}
			disabled={disabled}
			bind:this={input}
			oninput={onInput}
			onclick={(event) => refreshTrigger(draft.text, event.currentTarget.selectionStart)}
			onkeydown={(event) => {
				if (event.key === "Escape") trigger = undefined;
				// Not while an input method is composing: its Return confirms the text being composed.
				if (event.key !== "Enter" || event.isComposing) return;
				const plain = !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;
				const first = list[0];
				if (plain && matchMedia(KEYBOARD).matches) {
					event.preventDefault();
					// With a picker open, Return takes its first match rather than sending half a reference.
					if (first !== undefined) choose(first.value);
					else void send();
				} else if (event.metaKey || event.ctrlKey) {
					event.preventDefault();
					void send();
				}
			}}
			onblur={() => setTimeout(() => (trigger = undefined), 150)}
		></textarea>
		{#if showStop}
			<button type="button" class="icon-button send stop" aria-label="Stop" onclick={() => void onStop?.()}>
				<Icon name="stop" size={18} />
			</button>
		{:else}
			<button type="submit" class="icon-button send" aria-label="Send" disabled={empty || sending || uploading > 0 || disabled}>
				<Icon name="send" size={18} />
			</button>
		{/if}
	</div>
</form>
