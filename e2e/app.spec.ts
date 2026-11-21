import { expect, startSession, test } from "./fixtures.ts";

test.describe("the app around a session", () => {
	test("the drawer navigates between sessions and signals one that needs attention", async ({ page }) => {
		await startSession(page, "What does greet() return?");
		await expect(page.locator(".status-pill")).toHaveText("Replied");
		const first = page.url();
		await startSession(page, "Add a shout() function");
		await expect(page.getByRole("region", { name: "Questions waiting for your answer" })).toBeVisible();

		// The first session's reply was seen while it was open. A new reply arrives while the second is on screen.
		await expect(page.getByTestId("attention-dot")).toBeHidden();
		const id = /#\/s\/(\d+)/.exec(first)?.[1];
		const sent = await page.request.post(`/api/sessions/${id}/messages`, {
			data: { requestId: `e2e-${Date.now()}`, text: "And what about farewell?", attachments: [] },
		});
		expect(sent.ok()).toBe(true);
		await expect(page.getByTestId("attention-dot")).toBeVisible();

		await page.getByRole("button", { name: /^Sessions, 1 needs you$/ }).tap();
		const drawer = page.getByRole("navigation", { name: "Sessions" });
		const needsYou = drawer.getByRole("region", { name: "Needs you" });
		await expect(needsYou.getByRole("link", { name: /What does greet\(\) return\?/ })).toBeVisible();
		await expect(needsYou.getByRole("link", { name: /Add a shout\(\) function/ })).toContainText("Question waiting");
		await needsYou.getByRole("link", { name: /What does greet\(\) return\?/ }).tap();
		await expect(page).toHaveURL(first);
		await expect(drawer).not.toHaveClass(/open/);
		await expect(page.getByTestId("attention-dot")).toBeHidden();
	});

	test("archiving is undone from the toast", async ({ page }) => {
		await startSession(page, "What is in src?");
		await expect(page.getByText("Short answer:")).toBeVisible();
		const url = page.url();
		await page.getByRole("button", { name: "Archive session" }).tap();
		const toast = page.getByRole("status").filter({ hasText: "Session archived." });
		await expect(toast).toBeVisible();
		await expect(page).toHaveURL(/#\/$/);
		await toast.getByRole("button", { name: "Undo" }).tap();
		await expect(page).toHaveURL(url);
		await page.getByRole("button", { name: /^Sessions/ }).tap();
		const drawer = page.getByRole("navigation", { name: "Sessions" });
		await expect(drawer.getByRole("region", { name: "Needs you" }).getByRole("link", { name: /What is in src\?/ })).toBeVisible();
		await expect(drawer.getByText(/^Archived/)).toBeHidden();
	});

	test("the @ and # pickers narrow as the person types and insert the reference", async ({ page }) => {
		await page.goto("/");
		const composer = page.getByRole("textbox", { name: "Describe the task…" });
		await expect(composer).toBeEnabled();
		await composer.pressSequentially("Look at @");
		const files = page.getByRole("listbox", { name: "Files" });
		await expect(files.getByRole("option")).toHaveCount(8);
		await composer.pressSequentially("greet");
		await expect(files.getByRole("option")).toHaveCount(2);
		await expect(files.getByRole("option").first()).toHaveText("@src/greet.ts");
		await files.getByRole("button", { name: "@src/greet.ts" }).tap();
		await expect(composer).toHaveValue("Look at @src/greet.ts ");
		await composer.pressSequentially("then #rel");
		const skills = page.getByRole("listbox", { name: "Skills" });
		await expect(skills.getByRole("option")).toHaveCount(1);
		await expect(skills).toContainText("Write release notes");
		await skills.getByRole("button", { name: /#release-notes/ }).tap();
		await expect(composer).toHaveValue("Look at @src/greet.ts then #release-notes ");
		// Not inside ordinary text: an email or an issue number.
		await composer.pressSequentially("mail me@exa");
		await expect(page.getByRole("listbox")).toBeHidden();
		await composer.pressSequentially("mple.com about #12");
		await expect(page.getByRole("listbox")).toBeHidden();
		await composer.pressSequentially(" ");
		await page.getByRole("button", { name: "Send", exact: true }).tap();
		await expect(page.locator(".person .chip").first()).toHaveText("@src/greet.ts");
		await expect(page.locator(".person .bubble")).toHaveText("Look at @src/greet.ts then #release-notes mail me@example.com about #12 ");
	});
});
