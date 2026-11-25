// What moves: the exit timing shared with the stylesheet, how a released drag decides where to settle, and the
// swipe-down gesture that dismisses a sheet or a toast.
import type { Action } from "svelte/action";

/** How long a leaving element takes, read from the stylesheet's --quick so the two cannot drift apart. */
export function exitMs(): number {
	return Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--quick")) || 200;
}

/** Below this, a touch is a tap that may still turn into a drag. */
const SLOP = 6;

/** The finger's speed is read over this much of its most recent movement, so one jittery sample does not decide. */
const SPEED_WINDOW = 100;

/**
 * How far momentum would carry a released drag: the speed in px/ms times what iOS's normal scroll deceleration
 * (0.998 per ms) adds up to. A drag settles where it would have landed, not where the finger let go, so a short
 * flick and a long slow drag are judged by one rule.
 */
function projected(position: number, speed: number): number {
	return position + (speed * 0.998) / (1 - 0.998);
}

/** Follows one axis of a finger and reports its speed in px/ms at release; a finger that came to rest has none. */
class FingerSpeed {
	#samples: { at: number; time: number }[] = [];

	add(at: number, time: number): void {
		this.#samples.push({ at, time });
		this.#samples = this.#samples.filter((sample) => time - sample.time <= SPEED_WINDOW);
	}

	at(time: number): number {
		const first = this.#samples[0];
		const last = this.#samples.at(-1);
		if (first === undefined || last === undefined || last.time === first.time || time - last.time > SPEED_WINDOW) return 0;
		return (last.at - first.at) / (last.time - first.time);
	}
}

export type SwipeDown = {
	/** Whether a touch on this target may start a drag; a sheet's content only when scrolled to its top. */
	canStart: (target: EventTarget | null) => boolean;
	/** Where, in px below its resting place, a released drag must be headed to dismiss, given the element's height. */
	distance: (height: number) => number;
	onDismiss: () => void;
	/** How much of the element is still showing while it is dragged, 0 to 1, then undefined when the drag ends. */
	onProgress?: (shown: number | undefined) => void;
	/** True while a finger is on the element. */
	onHold?: (held: boolean) => void;
};

/**
 * Drag an element down with the finger and let go to dismiss it, or to have it spring back. It tracks the finger
 * exactly, resists being pulled up, and hands the rest of the motion to the stylesheet's transitions, which start
 * from wherever the finger left it.
 */
export const swipeDown: Action<HTMLElement, SwipeDown> = (node, options) => {
	// The handlers outlive a render; they read the latest options when events arrive.
	let current = options;
	let drag: { x: number; y: number; moving: boolean; offset: number; speed: FingerSpeed } | undefined;

	const onStart = (event: TouchEvent) => {
		const touch = event.touches[0];
		if (event.touches.length !== 1 || touch === undefined || !current.canStart(event.target)) {
			drag = undefined;
			return;
		}
		drag = { x: touch.clientX, y: touch.clientY, moving: false, offset: 0, speed: new FingerSpeed() };
		drag.speed.add(touch.clientY, event.timeStamp);
		current.onHold?.(true);
	};

	const onMove = (event: TouchEvent) => {
		const touch = event.touches[0];
		if (drag === undefined || touch === undefined) return;
		const dx = touch.clientX - drag.x;
		const dy = touch.clientY - drag.y;
		drag.speed.add(touch.clientY, event.timeStamp);
		if (!drag.moving) {
			if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
			// Up or sideways is a scroll, not a dismissal.
			if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) {
				end(undefined);
				return;
			}
			drag.moving = true;
			node.classList.add("dragging");
		}
		event.preventDefault();
		drag.offset = dy >= 0 ? dy : -Math.sqrt(-dy);
		node.style.transform = `translateY(${drag.offset}px)`;
		current.onProgress?.(1 - Math.max(0, drag.offset) / node.offsetHeight);
	};

	/** `releasedAt` is when the finger lifted; undefined when the touch turned out not to be a drag. */
	const end = (releasedAt: number | undefined) => {
		if (drag === undefined) return;
		const { moving, offset, speed } = drag;
		drag = undefined;
		const { onHold, onProgress, distance, onDismiss } = current;
		onHold?.(false);
		if (!moving) return;
		node.classList.remove("dragging");
		node.style.transform = "";
		onProgress?.(undefined);
		if (releasedAt !== undefined && projected(offset, speed.at(releasedAt)) > distance(node.offsetHeight)) onDismiss();
	};
	const onEnd = (event: TouchEvent) => end(event.timeStamp);

	node.addEventListener("touchstart", onStart, { passive: true });
	node.addEventListener("touchmove", onMove, { passive: false });
	node.addEventListener("touchend", onEnd);
	node.addEventListener("touchcancel", onEnd);
	return {
		update(next: SwipeDown) {
			current = next;
		},
		destroy() {
			node.removeEventListener("touchstart", onStart);
			node.removeEventListener("touchmove", onMove);
			node.removeEventListener("touchend", onEnd);
			node.removeEventListener("touchcancel", onEnd);
		},
	};
};
