import type { Page } from "@playwright/test";
import { approveThrough, expect, startSession, test } from "./fixtures.ts";

async function noHorizontalScroll(page: Page): Promise<void> {
	const widths = await page.evaluate(() => [document.documentElement.scrollWidth, document.body.scrollWidth, window.innerWidth]);
	expect(Math.max(widths[0] ?? 0, widths[1] ?? 0)).toBeLessThanOrEqual(widths[2] ?? 0);
}

test.describe("platform fit", () => {
	test.use({ viewport: { width: 375, height: 740 } });

	test("never scrolls horizontally at 375 px", async ({ page }) => {
		await page.goto("/");
		await noHorizontalScroll(page);
		await startSession(page, `Add a shout() function — ${"averyveryverylongwordwithoutanyspaces".repeat(4)}`);
		await approveThrough(page);
		await expect(page.getByRole("region", { name: "Report" })).toBeVisible({ timeout: 30_000 });
		for (const summary of await page.locator("details.work > summary").all()) await summary.tap();
		for (const summary of await page.locator("details.call > summary").all()) await summary.tap();
		await noHorizontalScroll(page);
		await page.getByRole("region", { name: "Report" }).getByRole("button", { name: "View changes" }).tap();
		await page.locator("details.diff-file > summary").first().tap();
		await noHorizontalScroll(page);
		await page.getByRole("button", { name: "Done" }).tap();
		await page.getByRole("button", { name: /^Sessions/ }).tap();
		await noHorizontalScroll(page);
	});

	test("touch targets are at least 44 points", async ({ page }) => {
		await startSession(page, "Add a shout() function");
		await expect(page.getByRole("region", { name: "Questions waiting for your answer" })).toBeVisible();
		const small = await page.evaluate(() =>
			[...document.querySelectorAll("button, a.button, a.row, label.option, summary, select")]
				.filter((element) => element.getClientRects().length > 0)
				.map((element) => ({ element: element.textContent?.trim().slice(0, 30) ?? element.tagName, box: element.getBoundingClientRect() }))
				.filter(({ box }) => box.height < 44 || box.width < 44)
				.map(({ element, box }) => `${element}: ${Math.round(box.width)}x${Math.round(box.height)}`),
		);
		expect(small).toEqual([]);
	});
	});

test("the serif, the sans and the monospace are served with the app and used where each belongs", async ({ page }) => {
	await startSession(page, "Add a shout() function");
	await expect(page.getByRole("region", { name: "Questions waiting for your answer" })).toBeVisible();
	const loaded = await page.evaluate(async () => {
		await document.fonts.ready;
		return [...document.fonts].filter((face) => face.status === "loaded").map((face) => `${face.family} ${face.style} ${face.weight}`);
	});
	expect(loaded).toEqual(expect.arrayContaining(["Source Serif 4 normal 200 900", "IBM Plex Sans normal 100 700", "IBM Plex Mono normal 400"]));
	const fonts = await page.evaluate(() =>
		[".said", ".markdown.agent", ".session-status"].map((selector) => getComputedStyle(document.querySelector(selector) as Element).fontFamily),
	);
	expect(fonts[0]).toMatch(/^"Source Serif 4"/);
	expect(fonts[1]).toMatch(/^"IBM Plex Sans"/);
	expect(fonts[2]).toMatch(/^"IBM Plex Mono"/);
});

test.describe("dark mode", () => {
	test.use({ viewport: { width: 375, height: 740 } });

	test("works in dark mode without console errors", async ({ page, errors }) => {
		await page.emulateMedia({ colorScheme: "dark" });
		await startSession(page, "Add a shout() function");
		await expect(page.getByRole("region", { name: "Questions waiting for your answer" })).toBeVisible();
		const background = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
		expect(background).toBe("rgb(1, 4, 5)");
		const text = await page.evaluate(() => getComputedStyle(document.body).color);
		expect(text).toBe("rgb(226, 236, 234)");
		await page.getByRole("button", { name: "Send answers" }).tap();
		await page.getByRole("button", { name: "Approve" }).tap();
		await expect(page.getByRole("region", { name: "Report" })).toBeVisible({ timeout: 30_000 });
		await page.getByRole("button", { name: /^Sessions/ }).tap();
		expect(errors).toEqual([]);
	});
});

test.describe("recovery", () => {
	test("the phone catches up on its own after a server restart", async ({ page, server }) => {
		await startSession(page, "Add a shout() function");
		const questions = page.getByRole("region", { name: "Questions waiting for your answer" });
		await expect(questions).toBeVisible();
		await server.restart();
		await questions.getByRole("button", { name: "Send answers" }).tap();
		await expect(page.getByRole("region", { name: "Plan: Add shout()" }).getByText("Waiting for your approval")).toBeVisible();
		await page.getByRole("button", { name: "Approve" }).tap();
		await expect(page.getByRole("region", { name: "Report" })).toBeVisible({ timeout: 30_000 });
		// The transcript is whole: nothing was lost or duplicated across the restart.
		await expect(page.locator(".is-person")).toHaveCount(1);
		await expect(page.getByRole("region", { name: "Answered questions" })).toHaveCount(1);
	});
});
