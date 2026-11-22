import type { Page } from "@playwright/test";
import { approveThrough, expect, startSession, test } from "./fixtures.ts";

async function noHorizontalScroll(page: Page): Promise<void> {
	const widths = await page.evaluate(() => [document.documentElement.scrollWidth, document.body.scrollWidth, window.innerWidth]);
	expect(Math.max(widths[0] ?? 0, widths[1] ?? 0)).toBeLessThanOrEqual(widths[2] ?? 0);
}

/** A theme already chosen on this device, as the drawer stores it. */
async function chosenTheme(page: Page, theme: string): Promise<void> {
	await page.addInitScript((name) => localStorage.setItem("picloud.theme", name), theme);
}

// The terminal theme changes the font, line height and every shape, so the layout checks run in it too.
for (const theme of ["system", "terminal"]) {
	test.describe(`platform fit, ${theme} theme`, () => {
		test.use({ viewport: { width: 375, height: 740 } });
		test.beforeEach(({ page }) => chosenTheme(page, theme));

		test("never scrolls horizontally at 375 px", async ({ page }) => {
			await page.goto("/");
			await noHorizontalScroll(page);
			await startSession(page, `Add a shout() function — ${"averyveryverylongwordwithoutanyspaces".repeat(4)}`);
			await approveThrough(page);
			await expect(page.getByRole("region", { name: "Report" })).toBeVisible({ timeout: 30_000 });
			for (const summary of await page.locator("details.activity > summary, details.thinking > summary").all()) await summary.tap();
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
}

test.describe("themes", () => {
	// The service worker would fetch app.js itself, past the route that holds it back.
	test.use({ serviceWorkers: "block" });

	test("Terminal is chosen in the drawer, applies at once, and is in place before the app runs after a reload", async ({ page }) => {
		await page.goto("/");
		await page.getByRole("button", { name: /^Sessions/ }).tap();
		const choice = page.getByRole("combobox", { name: "Theme" });
		await expect(choice).toHaveValue("system");
		await choice.selectOption("terminal");
		const root = page.locator("html");
		await expect(root).toHaveAttribute("data-theme", "terminal");
		await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute("content", "#0a0a0a");

		await page.route("**/app.js", (route) => route.abort());
		await page.reload();
		await expect(root).toHaveAttribute("data-theme", "terminal");
		expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe("rgb(10, 10, 10)");
		await page.unroute("**/app.js");
		await page.reload();
		await page.getByRole("button", { name: /^Sessions/ }).tap();
		await expect(choice).toHaveValue("terminal");
	});

	test("a card in Terminal is square, outlined in one pixel and monospace", async ({ page }) => {
		await chosenTheme(page, "terminal");
		await startSession(page, "Add a shout() function");
		const card = page.getByRole("region", { name: "Questions waiting for your answer" });
		await expect(card).toBeVisible();
		const style = await card.evaluate((element) => {
			const css = getComputedStyle(element);
			return { radius: css.borderTopLeftRadius, width: css.borderTopWidth, style: css.borderTopStyle, font: css.fontFamily };
		});
		expect(style).toEqual({ radius: "0px", width: "1px", style: "solid", font: expect.stringMatching(/monospace/) });
	});

	test("Light and Dark, when chosen, are exactly what System shows", async ({ page }) => {
		await page.goto("/");
		await page.getByRole("button", { name: /^Sessions/ }).tap();
		const choice = page.getByRole("combobox", { name: "Theme" });
		// Every token :root declares, as the page resolves it.
		const tokens = () =>
			page.evaluate(() => {
				const names = [...document.styleSheets]
					.flatMap((sheet) => [...sheet.cssRules])
					.filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule && rule.selectorText === ":root")
					.flatMap((rule) => [...rule.style].filter((name) => name.startsWith("--")));
				const style = getComputedStyle(document.documentElement);
				return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name)]));
			});
		for (const scheme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme: scheme });
			await choice.selectOption("system");
			const system = await tokens();
			expect(Object.keys(system).length).toBeGreaterThan(30);
			await page.emulateMedia({ colorScheme: scheme === "light" ? "dark" : "light" });
			await choice.selectOption(scheme);
			expect(await tokens()).toEqual(system);
		}
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
		expect(background).toBe("rgb(24, 23, 20)");
		const text = await page.evaluate(() => getComputedStyle(document.body).color);
		expect(text).toBe("rgb(235, 229, 213)");
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
		await page.getByRole("button", { name: /^Sessions/ }).tap();
		await expect(page.getByRole("status").filter({ hasText: "Connected" })).toBeVisible({ timeout: 30_000 });
		await page.locator(".backdrop").tap({ position: { x: 370, y: 400 } });
		await questions.getByRole("button", { name: "Send answers" }).tap();
		await expect(page.getByRole("region", { name: "Plan: Add shout()" }).getByText("Waiting for your approval")).toBeVisible();
		await page.getByRole("button", { name: "Approve" }).tap();
		await expect(page.getByRole("region", { name: "Report" })).toBeVisible({ timeout: 30_000 });
		// The transcript is whole: nothing was lost or duplicated across the restart.
		await expect(page.locator(".is-person")).toHaveCount(1);
		await expect(page.getByRole("region", { name: "Answered questions" })).toHaveCount(1);
	});
});
