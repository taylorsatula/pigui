// Keeping the end of the transcript in view. While the person is at the bottom, the page follows whatever grows there:
// streamed text, a taller composer, a banner, the keyboard opening. Once they scroll up to read, it stays put.
// Safe-area insets are CSS's, from env() in app.css; nothing here publishes them.

/** How close to the bottom still counts as being there, so a little drift does not stop the following. */
const AT_END = 120;

let following = true;

function scroller(): Element {
	return document.scrollingElement ?? document.documentElement;
}

let frame = 0;

/** Scroll to the very bottom if the person is following, so the last lines sit above the composer. Batched into one frame. */
export function followEnd(): void {
	if (!following || frame !== 0) return;
	frame = requestAnimationFrame(() => {
		frame = 0;
		if (following) window.scrollTo(0, scroller().scrollHeight);
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
	const fromEnd = scroller().scrollHeight - window.scrollY;
	return () => window.scrollTo(0, scroller().scrollHeight - fromEnd);
}


/**
 * Track scrolling and the visible viewport, which shrinks when the keyboard opens. `--viewport-height` sizes things
 * that must fit above the keyboard; iOS before 27.1 overlays the keyboard without resizing the page, so `dvh` cannot.
 */
export function watchViewport(): () => void {
	const root = document.documentElement;
	const visual = window.visualViewport;
	const onScroll = () => {
		following = scroller().scrollHeight - window.scrollY - window.innerHeight < AT_END;
	};
	const onResize = () => {
		// Pinch-zoom also shrinks the visual viewport; that is not less room.
		if ((visual?.scale ?? 1) <= 1) root.style.setProperty("--viewport-height", `${visual?.height ?? window.innerHeight}px`);
		followEnd();
	};
	onResize();
	window.addEventListener("scroll", onScroll, { passive: true });
	window.addEventListener("resize", onResize);
	visual?.addEventListener("resize", onResize);
	return () => {
		window.removeEventListener("scroll", onScroll);
		window.removeEventListener("resize", onResize);
		visual?.removeEventListener("resize", onResize);
	};
}
