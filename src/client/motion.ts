// What moves: the exit timing shared with the stylesheet, and the swipe-down gesture that dismisses a sheet or a toast.
import type { RefObject } from "preact";
import { useEffect, useRef } from "preact/hooks";

/** How long a leaving element takes, read from the stylesheet's --quick so the two cannot drift apart. */
export function exitMs(): number {
	return Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--quick")) || 240;
}

/** Below this, a touch is a tap that may still turn into a drag. */
const SLOP = 6;

type SwipeDown = {
	/** The element that moves. */
	element: RefObject<HTMLElement>;
	/** Whether a touch on this target may start a drag; a sheet's content only when scrolled to its top. */
	canStart: (target: EventTarget | null) => boolean;
	/** How far, in px, a drag must go to dismiss, given the element's height. */
	distance: (height: number) => number;
	/** A flick faster than this, in px/ms, dismisses however short it was. */
	velocity: number;
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
export function useSwipeDown(options: SwipeDown): void {
	// The handlers outlive a render; they read the latest options when events arrive.
	const latest = useRef(options);
	latest.current = options;
	useEffect(() => {
		const element = latest.current.element.current;
		if (element === null) return;
		let drag: { x: number; y: number; moving: boolean; offset: number; lastY: number; lastT: number; speed: number } | undefined;

		const onStart = (event: TouchEvent) => {
			const touch = event.touches[0];
			if (event.touches.length !== 1 || touch === undefined || !latest.current.canStart(event.target)) {
				drag = undefined;
				return;
			}
			drag = { x: touch.clientX, y: touch.clientY, moving: false, offset: 0, lastY: touch.clientY, lastT: event.timeStamp, speed: 0 };
			latest.current.onHold?.(true);
		};

		const onMove = (event: TouchEvent) => {
			const touch = event.touches[0];
			if (drag === undefined || touch === undefined) return;
			const dx = touch.clientX - drag.x;
			const dy = touch.clientY - drag.y;
			if (!drag.moving) {
				if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
				// Up or sideways is a scroll, not a dismissal.
				if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) {
					end(false);
					return;
				}
				drag.moving = true;
				element.classList.add("dragging");
			}
			event.preventDefault();
			drag.offset = dy >= 0 ? dy : -Math.sqrt(-dy);
			drag.speed = (touch.clientY - drag.lastY) / Math.max(1, event.timeStamp - drag.lastT);
			drag.lastY = touch.clientY;
			drag.lastT = event.timeStamp;
			element.style.transform = `translateY(${drag.offset}px)`;
			latest.current.onProgress?.(1 - Math.max(0, drag.offset) / element.offsetHeight);
		};

		const end = (finished: boolean) => {
			if (drag === undefined) return;
			const { moving, offset, speed } = drag;
			drag = undefined;
			const { onHold, onProgress, distance, velocity, onDismiss } = latest.current;
			onHold?.(false);
			if (!moving) return;
			element.classList.remove("dragging");
			element.style.transform = "";
			onProgress?.(undefined);
			if (finished && (offset > distance(element.offsetHeight) || speed > velocity)) onDismiss();
		};
		const onEnd = () => end(true);

		element.addEventListener("touchstart", onStart, { passive: true });
		element.addEventListener("touchmove", onMove, { passive: false });
		element.addEventListener("touchend", onEnd);
		element.addEventListener("touchcancel", onEnd);
		return () => {
			element.removeEventListener("touchstart", onStart);
			element.removeEventListener("touchmove", onMove);
			element.removeEventListener("touchend", onEnd);
			element.removeEventListener("touchcancel", onEnd);
		};
	}, []);
}
