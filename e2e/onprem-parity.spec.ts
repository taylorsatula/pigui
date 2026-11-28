// OnPrem local-mode parity test: real ~ workspace, draft persistence across reload/back, no repo delivery controls.
import { expect, test } from "./fixtures.ts";

test.use({ onPrem: true });

test("OnPrem starts at ~, preserves draft across reload and back, and omits repo delivery buttons", async ({ page, errors }) => {
	await page.goto("/");
	await page.getByRole("link", { name: "This computer" }).tap();
	const task = page.getByRole("textbox", { name: "Describe the task…" });
	await task.fill("Half a thought");
	await page.reload();
	await expect(task).toHaveValue("Half a thought");
	await page.getByRole("link", { name: "Back to New session" }).tap();
	await page.getByRole("link", { name: "This computer" }).tap();
	await expect(task).toHaveValue("Half a thought");
	await task.fill("What does greet() return?");
	await page.getByRole("button", { name: "Send", exact: true }).tap();
	await expect(page).toHaveURL(/\/s\/\d+$/);
	await expect(page.locator(".session-status")).toHaveText("Replied");
	await expect(page.locator(".subtitle .where")).toHaveText("~");
	await expect(page.getByRole("button", { name: "View changes" })).toHaveCount(0);
	expect(errors).toEqual([]);
});
