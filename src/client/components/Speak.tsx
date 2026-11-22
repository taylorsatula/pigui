// The speaker under a reply and on the report card: quiet until tapped, a spinner while its first words are prepared,
// then a stop button while it reads. It shows only where the server reads aloud.
import type { JSX } from "preact";
import { speak, stopReading } from "../speech.ts";
import { useStore } from "../store.ts";
import { Icon } from "./Icons.tsx";

const LABELS = { idle: "Read aloud", preparing: "Preparing to read aloud", playing: "Stop reading aloud" } as const;

/** `id` names what is read, so the button knows its own reading and the script is kept for a replay. */
export function Speak(props: { id: string; session: number; markdown: string }): JSX.Element | null {
	const available = useStore((state) => state.bootstrap?.speech === true);
	const reading = useStore((state) => state.reading);
	if (!available) return null;
	const state = reading?.key === props.id ? reading.state : "idle";
	return (
		<button
			type="button"
			class={`icon-button speak ${state}`}
			aria-label={LABELS[state]}
			onClick={() => (state === "idle" ? speak(props.id, props.session, props.markdown) : stopReading())}
		>
			{state === "preparing" ? <span class="spinner" aria-hidden="true" /> : <Icon name={state === "playing" ? "stop" : "speaker"} size={20} />}
		</button>
	);
}
