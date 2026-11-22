import { approveThrough, expect, startSession, test } from "./fixtures.ts";

test.describe("the tap flow", () => {
	test("new session through question, plan approval and report to an opened pull request", async ({ page, errors }) => {
		await startSession(page, "Add a shout() function with a test");
		const questions = page.getByRole("region", { name: "Questions waiting for your answer" });
		await expect(questions).toBeVisible();
		await expect(questions.getByRole("radio", { name: /One !/ })).toBeChecked();
		await questions.getByText("Three !!!").tap();
		await questions.getByRole("button", { name: "Send answers" }).tap();

		const plan = page.getByRole("region", { name: "Plan: Add shout()" });
		await expect(plan.getByText("Waiting for your approval")).toBeVisible();
		await plan.getByRole("button", { name: "Approve" }).tap();
		await expect(plan.getByText("Approved")).toBeVisible();

		const report = page.getByRole("region", { name: "Report" });
		await expect(report).toBeVisible({ timeout: 30_000 });
		await expect(page.getByRole("status").getByText("Report ready")).toBeVisible();
		await report.getByRole("button", { name: "Open pull request" }).tap();
		await expect(page.getByText("Opened PR #1.")).toBeVisible();
		await expect(report.getByRole("link", { name: "View PR #1" })).toBeVisible();
		expect(errors).toEqual([]);
	});

	test("once the turn is over, each stretch of work is folded to one line, and opens to its thinking and calls", async ({ page }) => {
		await startSession(page, "Add a shout() function");
		await approveThrough(page);
		await expect(page.getByRole("region", { name: "Report" })).toBeVisible({ timeout: 30_000 });

		const work = page.locator("details.work");
		const first = work.first();
		await expect(first.locator(".thought").first()).toBeHidden();
		await first.locator(":scope > summary").tap();
		await expect(first.locator(".thought").first()).toBeVisible();

		const last = work.last();
		await expect(last.locator(":scope > summary")).toContainText("Wrote 2 files");
		const call = last.locator("details.call").first();
		await expect(call).toBeHidden();
		await last.locator(":scope > summary").tap();
		await expect(call).toBeVisible();
		await expect(call.locator(".io").first()).toBeHidden();
		await call.locator(":scope > summary").tap();
		await expect(call.getByText("Input")).toBeVisible();
		await expect(call.locator(".io").first()).toContainText("src/shout.ts");
	});

	test("while the agent works its calls show as they happen, and fold away when the turn ends", async ({ page }) => {
		await startSession(page, "Keep going [spin]");
		// Nothing to open while it works: each call is a block with its command and what it printed last.
		const live = page.locator(".work.live").last();
		await expect(live.locator(".live-call").nth(2)).toBeVisible({ timeout: 15_000 });
		await expect(live.locator(".live-call").first().locator(".call-command")).toHaveText("$ echo turn 0");
		await expect(live.locator(".live-call").first().locator(".tail")).toHaveText("turn 0");
		await page.getByRole("button", { name: "Stop" }).tap();
		const folded = page.locator("details.work").last();
		await expect(folded).toBeVisible();
		await expect(folded).not.toHaveAttribute("open");
		await expect(folded.locator("details.call").first()).toBeHidden();
		await expect(page.locator(".work.live")).toHaveCount(0);
	});

	test("a waiting card is answered by typing in the composer", async ({ page }) => {
		await startSession(page, "Add a shout() function");
		await expect(page.getByRole("region", { name: "Questions waiting for your answer" })).toBeVisible();
		const composer = page.getByRole("textbox", { name: "Answer in your own words…" });
		await composer.fill("Whatever you recommend is fine");
		await page.getByRole("button", { name: "Send", exact: true }).tap();
		await expect(page.getByText("You replied: “Whatever you recommend is fine”")).toBeVisible();
		await expect(page.getByRole("textbox", { name: "Ask for changes to the plan…" })).toBeVisible();
	});

	test("the diff lists each file with its counts and opens to its patch", async ({ page }) => {
		await startSession(page, "Add a shout() function");
		await approveThrough(page);
		const report = page.getByRole("region", { name: "Report" });
		await expect(report).toBeVisible({ timeout: 30_000 });
		await report.getByRole("button", { name: "View changes" }).tap();
		const sheet = page.getByRole("dialog", { name: "Changes" });
		await expect(sheet.getByText("2 files changed against main")).toBeVisible();
		const file = sheet.locator("details.diff-file").filter({ has: page.locator(".diff-path", { hasText: /^src\/shout\.ts$/ }) });
		await expect(file.locator(".diff-counts")).toHaveText("+5 −0");
		await expect(file.locator(".patch")).toBeHidden();
		await file.locator(":scope > summary").tap();
		await expect(file.locator(".patch .add").first()).toContainText("+import { greet }");
		await sheet.getByRole("button", { name: "Done" }).tap();
		await expect(sheet).toBeHidden();
	});
});
