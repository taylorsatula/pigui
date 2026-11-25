// The screensaver's idle watch: five minutes without any input, then it shows. Any input re-arms the wait and dismisses it.

export const IDLE_MS = 5 * 60 * 1000;

/** Inputs that count as "the person is here", listened for in the capture phase on the window. */
export const INPUT_EVENTS = ["pointerdown", "keydown", "touchstart", "wheel", "scroll"] as const;

/** The timer half, separate from the DOM half so it can be tested with fake timers. */
export function idleTimer(callback: () => void, timeoutMs: number): { reset: () => void; cancel: () => void } {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const arm = () => {
		clearTimeout(timer);
		timer = setTimeout(callback, timeoutMs);
	};
	arm();
	return { reset: arm, cancel: () => clearTimeout(timer) };
}
