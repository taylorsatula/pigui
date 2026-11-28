// Focused real-browser parity suite: proves full visual and functional parity of the greenfield HTML/CSS/VanillaJS UI
// across workflows, overlays, streaming, subagents, OnPrem, speech, and mobile/dark platform fit.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, startSession, test } from "./fixtures.ts";

async function noHorizontalScroll(page: import("@playwright/test").Page): Promise<void> {
	const [docWidth, bodyWidth, innerWidth] = await page.evaluate(() => [
		document.documentElement.scrollWidth,
		document.body.scrollWidth,
		window.innerWidth,
	]);
	expect(Math.max(docWidth, bodyWidth)).toBeLessThanOrEqual(innerWidth);
}

test.describe("greenfield HTML parity", () => {
	test("full tap workflow: repo picker, questions, plan approval, report, PR, and changes diff sheet", async ({ page, errors }) => {
		await startSession(page, "Add a shout() function with a test");
		const questions = page.getByRole("region", { name: "Questions waiting for your answer" });
		await expect(questions).toBeVisible();
		await expect(questions.getByRole("radio", { name: /One !/ })).toBeChecked();
		await questions.getByText("Three !!!").tap();
		await questions.getByRole("button", { name: "Send answers" }).tap();

		const plan = page.getByRole("region", { name: "Plan: Add shout()" });
		await expect(plan.getByText("Waiting for your approval")).toBeVisible();
		await expect(plan.getByRole("button", { name: "Read aloud" })).toHaveCount(1);
		await plan.getByRole("button", { name: "Approve" }).tap();
		await expect(plan.getByText("Approved")).toBeVisible();

		const report = page.getByRole("region", { name: "Report" });
		await expect(report).toBeVisible({ timeout: 30_000 });
		await expect(page.getByRole("status").getByText("Report ready")).toBeVisible();

		await report.getByRole("button", { name: "View changes" }).tap();
		const sheet = page.getByRole("dialog", { name: "Changes" });
		await expect(sheet.getByText("2 files changed against main")).toBeVisible();
		const file = sheet.locator("details.diff-file", { has: page.locator(".diff-path", { hasText: /^src\/shout\.ts$/ }) });
		await file.locator("summary").tap();
		await expect(file.locator(".patch")).toContainText("export function shout");
		await sheet.getByRole("button", { name: "Done" }).tap();
		await expect(sheet).toBeHidden();

		await report.getByRole("button", { name: "Open pull request" }).tap();
		await expect(page.getByText("Opened PR #1.")).toBeVisible();
		await expect(report.getByRole("link", { name: "View PR #1" })).toBeVisible();
		expect(errors).toEqual([]);
	});

	test("session picker dialog: archive with Undo, Inactive restore, pin, instant sort, keyboard nav, and focus return", async ({ page, errors }) => {
		await startSession(page, "What does greet() return?");
		await expect(page.locator(".session-status")).toHaveText("Replied");
		const firstUrl = page.url();

		await startSession(page, "Add a shout() function");
		await expect(page.getByRole("region", { name: "Questions waiting for your answer" })).toBeVisible();
		const secondUrl = page.url();

		const menu = page.getByRole("button", { name: /^Sessions/ });
		await menu.tap();
		const picker = page.getByRole("dialog", { name: "Sessions" });
		await expect(picker).toBeVisible();
		await picker.getByRole("button", { name: "Archive Add a shout() function" }).tap();
		await expect(page).toHaveURL(/\/$/);
		await expect(page.getByText("Session archived.")).toBeVisible();

		// Undo returns directly to the archived session.
		await page.getByRole("button", { name: "Undo" }).tap();
		await expect(page).toHaveURL(secondUrl);

		// Archive again, then restore from Inactive folder on wide desktop with column sorting & Escape focus return.
		await page.setViewportSize({ width: 1280, height: 800 });
		await menu.click();
		await picker.getByRole("button", { name: "Archive Add a shout() function" }).click();
		await expect(page).toHaveURL(/\/$/);

		await page.goto(firstUrl);
		await menu.click();
		const nameCol = picker.getByRole("button", { name: "Name" });
		await nameCol.click();
		await expect(nameCol).toHaveAttribute("aria-pressed", "true");
		await picker.getByRole("button", { name: /Inactive/ }).click();
		await picker.getByRole("button", { name: "Restore Add a shout() function" }).click();
		await expect(page.getByText("Session restored.")).toBeVisible();

		await page.keyboard.press("Escape");
		await expect(picker).toBeHidden();
		await expect(menu).toBeFocused();
		expect(errors).toEqual([]);
	});

	test("live streaming calls, folding on halt, queued steering cancel, and server restart recovery", async ({ page, server }) => {
		await startSession(page, "Probe the machine [probe]\n$ sleep 8");
		await expect(page.locator(".work.live .live-call").last()).toBeVisible({ timeout: 15_000 });
		const composer = page.getByRole("textbox", { name: "Steer Pi while it works…" });
		await composer.fill("please stop early");
		await page.getByRole("button", { name: "Send", exact: true }).tap();
		const queued = page.locator(".entry.is-queued");
		await expect(queued).toBeVisible();
		await queued.getByRole("button", { name: "Cancel" }).tap();
		await expect(queued).toHaveCount(0);
		await page.getByRole("button", { name: "[ HALT WORK ]" }).tap();
		await expect(page.locator("details.work").last()).toBeVisible();
		await expect(page.locator(".work.live")).toHaveCount(0);

		// Restart mid-wait and verify SSE catches up without losing or duplicating entries.
		await startSession(page, "Add a shout() function");
		const questions = page.getByRole("region", { name: "Questions waiting for your answer" });
		await expect(questions).toBeVisible();
		await server.restart();
		await questions.getByRole("button", { name: "Send answers" }).tap();
		await expect(page.getByRole("region", { name: "Plan: Add shout()" }).getByText("Waiting for your approval")).toBeVisible();
		await page.getByRole("button", { name: "Approve" }).tap();
		await expect(page.getByRole("region", { name: "Report" })).toBeVisible({ timeout: 30_000 });
		await expect(page.locator(".is-person")).toHaveCount(1);
	});

	test("subagents badge, panel, live agent viewer, Stop, and folded agent result", async ({ page, server, errors }) => {
		await mkdir(join(server.agentDir, "agents"), { recursive: true });
		await writeFile(join(server.agentDir, "agents", "waiter.md"), "---\ndescription: Works until it is stopped\ntools: bash\n---\nYou wait.\n");
		await writeFile(join(server.dataDir, "subagent-settings.json"), '{ "maxInFlight": 1 }\n');
		await startSession(page, "Delegate [agents]\nagent waiter bg [wait] first\nagent waiter bg [wait] second");
		const agentsBtn = page.getByRole("button", { name: "Agents, 1 running, 1 queued" });
		await expect(agentsBtn).toBeVisible({ timeout: 15_000 });
		await expect(agentsBtn.locator(".count-badge")).toHaveText("2");

		await agentsBtn.tap();
		const panel = page.getByRole("dialog", { name: "Agents" });
		const rows = panel.locator(".agent-row");
		await expect(rows).toHaveCount(2);
		await expect(rows.nth(0)).toContainText("queued, next in line");

		// Focus on a Stop button survives live agent SSE updates without node replacement.
		const queuedStop = rows.nth(0).getByRole("button", { name: /^Stop / });
		await queuedStop.focus();
		await expect(queuedStop).toBeFocused();
		await page.waitForTimeout(1500);
		await expect(queuedStop).toBeFocused();

		await rows.nth(1).locator(".agent-open").tap();
		await expect(page).toHaveURL(/\/s\/\d+\/agent\/\d+$/);
		await expect(page.getByRole("textbox")).toHaveCount(0);
		await page.getByRole("button", { name: "Stop" }).tap();
		await expect(page.locator(".session-status")).toHaveText("Stopped");

		await page.getByRole("link", { name: "Back to the session" }).tap();
		await expect(page.getByRole("button", { name: "Agents, 1 running" })).toBeVisible();
		await page.getByRole("button", { name: "Agents, 1 running" }).tap();
		await panel.getByRole("button", { name: /^Stop / }).tap();
		await expect(page.locator(".system-note", { hasText: "was stopped." })).toHaveCount(2);
		expect(errors).toEqual([]);
	});

	test("autocomplete @/# pickers, Read aloud playback, and platform fit (375 px, 44 pt targets, 3 fonts, dark mode)", async ({ page, server, errors }) => {
		const skillDir = join(server.agentDir, "skills", "release-notes");
		await mkdir(skillDir, { recursive: true });
		await writeFile(join(skillDir, "SKILL.md"), "---\nname: release-notes\ndescription: Draft release notes\n---\nSummarize.\n");

		await page.setViewportSize({ width: 375, height: 740 });
		await startSession(page, "What does greet() return?");
		await expect(page.locator(".session-status")).toHaveText("Replied");

		// @ file and # skill pickers narrow and insert cleanly.
		const composer = page.getByRole("textbox", { name: "Write to Pi…" });
		await composer.fill("@gre");
		const files = page.getByRole("listbox", { name: "Files" });
		await expect(files.getByRole("button", { name: "@src/greet.ts" })).toBeVisible();
		await files.getByRole("button", { name: "@src/greet.ts" }).tap();
		await expect(composer).toHaveValue("@src/greet.ts ");

		await composer.fill("#rel");
		const skills = page.getByRole("listbox", { name: "Skills" });
		await expect(skills.getByRole("button", { name: /#release-notes/ })).toBeVisible();
		await skills.getByRole("button", { name: /#release-notes/ }).tap();
		await expect(composer).toHaveValue("#release-notes ");
		await composer.fill("");

		// Read aloud prepares, plays, and stops cleanly.
		const speak = page.getByRole("button", { name: "Read aloud" });
		await speak.tap();
		const stop = page.getByRole("button", { name: "Stop reading aloud" });
		await expect(stop).toBeVisible();
		await stop.tap();
		await expect(speak).toBeVisible();

		// Zero horizontal overflow, 44pt targets, self-hosted fonts, and dark mode colors.
		await noHorizontalScroll(page);
		const tooSmall = await page.evaluate(() =>
			[...document.querySelectorAll("button, a")]
				.map((el) => ({ label: el.getAttribute("aria-label") || el.textContent?.trim(), box: el.getBoundingClientRect() }))
				.filter(({ box }) => box.width > 0 && box.height > 0 && (box.width < 44 || box.height < 44)),
		);
		expect(tooSmall).toEqual([]);

		const fonts = await page.evaluate(async () => {
			await document.fonts.ready;
			return [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replaceAll('"', ""));
		});
		expect(fonts).toEqual(expect.arrayContaining(["Source Serif 4", "IBM Plex Sans", "IBM Plex Mono"]));

		await page.emulateMedia({ colorScheme: "dark" });
		const colors = await page.evaluate(() => ({
			bg: getComputedStyle(document.documentElement).backgroundColor,
			text: getComputedStyle(document.body).color,
		}));
		expect(colors).toEqual({ bg: "rgb(1, 4, 5)", text: "rgb(226, 236, 234)" });
		expect(errors).toEqual([]);
	});

	test("long second turn never evicts turn 1, and Load earlier survives SSE reconnect without duplicating entries", async ({ page, server }) => {
		await startSession(page, "What does greet() return?");
		await expect(page.locator(".session-status")).toHaveText("Replied");
		const composer = page.getByRole("textbox", { name: "Write to Pi…" });
		await composer.fill("Keep going [spin]");
		await page.getByRole("button", { name: "Send", exact: true }).tap();
		await expect.poll(() => page.locator(".work.live .live-call").count(), { timeout: 30_000 }).toBeGreaterThan(55);
		await expect(page.locator(".is-person .said").first()).toHaveText("What does greet() return?");
		await page.getByRole("button", { name: "[ HALT WORK ]" }).tap();
		await expect(page.locator(".session-status")).toHaveText("Stopped");
		await expect(page.locator(".is-person .said").first()).toHaveText("What does greet() return?");

		// Reload so SSR starts at the latest 50-entry window with a Load earlier button, paginate once, then reconnect SSE via restart.
		await page.reload();
		const earlier = page.locator('[data-action="load-earlier"]');
		await expect(earlier).toBeVisible();
		const beforeFirst = Number(await earlier.getAttribute("data-before"));
		await earlier.tap();
		await expect
			.poll(async () => {
				if ((await earlier.count()) === 0) return 0;
				if (await earlier.isDisabled()) return beforeFirst;
				return Number(await earlier.getAttribute("data-before"));
			})
			.toBeLessThan(beforeFirst);
		const beforeSecond = (await earlier.count()) > 0 ? Number(await earlier.getAttribute("data-before")) : 0;

		// Restart server to force SSE reconnect; cursor must NOT reset back up to beforeFirst.
		await server.restart();
		await page.waitForTimeout(400);
		if (beforeSecond === 0) {
			await expect(earlier).toHaveCount(0);
		} else {
			expect(Number(await earlier.getAttribute("data-before"))).toBe(beforeSecond);
			while ((await earlier.count()) > 0) {
				const prev = Number(await earlier.getAttribute("data-before"));
				await earlier.tap();
				await expect
					.poll(async () => ((await earlier.count()) === 0 ? 0 : (await earlier.isDisabled()) ? prev : Number(await earlier.getAttribute("data-before"))))
					.toBeLessThan(prev);
			}
		}
		// No duplicate data-block-key entries anywhere in the transcript.
		const dupes = await page.evaluate(() => {
			const keys = [...document.querySelectorAll("#transcript [data-block-key]")].map((el) => el.getAttribute("data-block-key"));
			return keys.filter((k, i) => keys.indexOf(k) !== i);
		});
		expect(dupes).toEqual([]);
	});
});
