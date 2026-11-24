import { expect, startSession, test } from "./fixtures.ts";

// Slow enough to watch the reply stream before its speaker appears, and to see the speaker prepare. A worker option, so
// it applies to the whole file.
test.use({ tokensPerSecond: 25 });

test.describe("reading aloud", () => {
	test("a finished reply gets a speaker, which prepares, plays and returns to idle", async ({ page, errors }) => {
		const scripts: string[] = [];
		page.on("request", (request) => {
			if (request.url().endsWith("/speech-script")) scripts.push(request.url());
		});
		await startSession(page, "What does greet() return?");
		const idle = page.getByRole("button", { name: "Read aloud" });
		// While the reply streams, it has no speaker.
		await expect(page.locator(".agent.streaming")).toBeVisible();
		await expect(idle).toHaveCount(0);
		await expect(page.locator(".session-status")).toHaveText("Replied");
		await expect(idle).toHaveCount(1);

		await idle.tap();
		await expect(page.getByRole("button", { name: "Preparing to read aloud" })).toBeVisible();
		const stop = page.getByRole("button", { name: "Stop reading aloud" });
		await expect(stop).toBeVisible();
		// The whole reply plays, segment after segment, and the speaker is idle again.
		await expect(idle).toBeVisible({ timeout: 30_000 });
		await expect(stop).toHaveCount(0);

		// Read again, the reply's script comes from memory: no second model call. Stop ends it at once.
		await idle.tap();
		await expect(stop).toBeVisible();
		await stop.tap();
		await expect(idle).toBeVisible();
		expect(scripts).toHaveLength(1);
		expect(errors).toEqual([]);
	});
});
