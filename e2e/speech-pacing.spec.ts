import { expect, startSession, test } from "./fixtures.ts";

// The script streams far faster than it is read, as a real model's does, so the synthesizer sets the pace.
test.use({ tokensPerSecond: 400 });

/** Each segment's audio answers after 0.6 of its own length, as Kokoro's does on two vCPU (fake audio is 20 ms a character). */
const SYNTHESIS_MS_PER_CHAR = 12;

test("a reading that opens on a short sentence plays on without a gap after it", async ({ page, errors }) => {
	await page.addInitScript(() => {
		const events: Array<{ type: string; at: number }> = [];
		(window as unknown as { audioEvents: typeof events }).audioEvents = events;
		const watched = new WeakSet<HTMLMediaElement>();
		const play = HTMLMediaElement.prototype.play;
		HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
			if (!watched.has(this)) {
				watched.add(this);
				for (const type of ["playing", "ended"]) this.addEventListener(type, () => events.push({ type, at: performance.now() }));
			}
			return play.call(this);
		};
	});
	await page.route("**/api/speech", async (route) => {
		const asked = Date.now();
		const { text } = route.request().postDataJSON() as { text: string };
		const response = await route.fetch();
		await new Promise((resolve) => setTimeout(resolve, SYNTHESIS_MS_PER_CHAR * text.length - (Date.now() - asked)));
		await route.fulfill({ response });
	});
	// The reply opens with a short sentence, then repeats the question: a long one, which takes longer to synthesize than
	// the short one takes to play.
	await startSession(page, "What does greet() return when it is given an empty name, and does the test suite check that case anywhere, or would a new test be needed to cover it properly?");
	await expect(page.locator(".session-status")).toHaveText("Replied");
	const idle = page.getByRole("button", { name: "Read aloud" });
	await idle.tap();
	await expect(page.getByRole("button", { name: "Stop reading aloud" })).toBeVisible();
	await expect(idle).toBeVisible({ timeout: 30_000 });

	const events = await page.evaluate(() => (window as unknown as { audioEvents: Array<{ type: string; at: number }> }).audioEvents);
	// The first `ended` is the moment of silence that unlocks audio in the tap; the reading's own segments follow it.
	const segments = events.slice(2);
	const gaps: number[] = [];
	for (let index = 1; index + 1 < segments.length; index += 2) {
		const ended = segments[index];
		const next = segments[index + 1];
		if (ended?.type === "ended" && next?.type === "playing") gaps.push(Math.round(next.at - ended.at));
	}
	expect(segments.filter((event) => event.type === "playing").length).toBeGreaterThanOrEqual(4);
	expect(gaps.length).toBeGreaterThanOrEqual(3);
	for (const gap of gaps) expect(gap, `gaps between segments: ${gaps.join(", ")} ms`).toBeLessThan(250);
	expect(errors).toEqual([]);
});
