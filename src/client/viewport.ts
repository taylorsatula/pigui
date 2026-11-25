// Keeping the end of the transcript in view. While the person is at the bottom, the transcript follows whatever grows
// there: streamed text, a taller composer, the keyboard opening. Once they scroll up to read, it stays put. The
// transcript is the only scroller in the app (a fixed-height shell; iOS cannot mis-hit unanchored bars), so all of this
// scrolls that element. Safe-area insets are CSS's, from env() in app.css; nothing here publishes them.

/** How close to the bottom still counts as being there, so a little drift does not stop the following. */
const AT_END = 120;

let following = true;

/** The transcript's scroll element, registered by the Transcript component; null until it mounts and after it unmounts. */
let scrollerElement: HTMLElement | null = null;

/** Register the transcript's scroll element. Pass null on teardown. Pages without a transcript fall back to the document. */
export function registerScroller(element: HTMLElement | null): void {
	scrollerElement = element;
}

function scroller(): Element {
	return scrollerElement ?? document.scrollingElement ?? document.documentElement;
}

function scrollTop(el: Element): number {
	return scrollerElement === null ? window.scrollY : (el as HTMLElement).scrollTop;
}

function viewportHeight(el: Element): number {
	return scrollerElement === null ? window.innerHeight : (el as HTMLElement).clientHeight;
}

function scrollTo(el: Element, top: number): void {
	if (scrollerElement === null) window.scrollTo(0, top);
	else (el as HTMLElement).scrollTop = top;
}

let frame = 0;

/** Scroll to the very bottom if the person is following, so the last lines sit above the composer. Batched into one frame. */
export function followEnd(): void {
	if (!following || frame !== 0) return;
	frame = requestAnimationFrame(() => {
		frame = 0;
		if (following) {
			const el = scroller();
			scrollTo(el, el.scrollHeight);
		}
	});
}

/** The person acted at the bottom (opened a session, sent a message): show the end whatever they were reading. */
export function pinToEnd(): void {
	following = true;
	followEnd();
}

/** Stop following, for content the person asked to insert where they are looking. */
export function stopFollowing(): void {
	following = false;
}

/**
 * Keep what is on screen where it is while content is inserted above it, as Safari has no scroll anchoring. Call
 * before the insert; call the returned function once the inserted content has rendered.
 */
export function keepPosition(): () => void {
	following = false;
	const el = scroller();
	const fromEnd = el.scrollHeight - scrollTop(el);
	return () => scrollTo(el, scroller().scrollHeight - fromEnd);
}

/**
 * Track scrolling and the visible viewport, which shrinks when the keyboard opens. `--viewport-height` sizes the
 * shell; iOS before 27.1 overlays the keyboard without resizing the page, so `dvh` cannot. Scrolls are caught on the
 * document in the capture phase, because scroll does not bubble but capture still sees the transcript's own scrolls.
 */
export function watchViewport(): () => void {
	const root = document.documentElement;
	const visual = window.visualViewport;
	const onScroll = () => {
		const el = scroller();
		following = el.scrollHeight - scrollTop(el) - viewportHeight(el) < AT_END;
	};
	const onResize = () => {
		// Pinch-zoom also shrinks the visual viewport; that is not less room.
		if ((visual?.scale ?? 1) <= 1) root.style.setProperty("--viewport-height", `${visual?.height ?? window.innerHeight}px`);
		followEnd();
	};
	onResize();
	document.addEventListener("scroll", onScroll, { capture: true, passive: true });
	window.addEventListener("resize", onResize);
	visual?.addEventListener("resize", onResize);
	return () => {
		document.removeEventListener("scroll", onScroll, { capture: true });
		window.removeEventListener("resize", onResize);
		visual?.removeEventListener("resize", onResize);
	};
}
