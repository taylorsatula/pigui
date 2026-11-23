// A server without an embedder. app.spec.ts checks that a server with one shows no notice.
import { expect, startSession, test } from "./fixtures.ts";

test.use({ memory: "off" });

test("when memory is off the session picker says so and why, on a phone and on a wide screen", async ({ page }) => {
	await startSession(page, "What is in src?");
	await page.getByRole("button", { name: /^Sessions/ }).tap();
	const notice = page.getByRole("dialog", { name: "Sessions" }).getByRole("status").filter({ hasText: "Memory is off" });
	await expect(notice).toBeVisible();
	await expect(notice).toContainText("PICLOUD_FAKE_MEMORY=off");

	await page.setViewportSize({ width: 1280, height: 800 });
	await page.reload();
	await page.getByRole("button", { name: /^Sessions/ }).click();
	await expect(notice).toBeVisible();
});
