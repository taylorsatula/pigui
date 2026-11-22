import { expect, startSession, test } from "./fixtures.ts";

test.describe("the app around a session", () => {
	test("the sidebar lists the sessions under way, navigates between them, and signals one that needs attention", async ({ page }) => {
		await startSession(page, "What does greet() return?");
		await expect(page.locator(".session-status")).toHaveText("Replied");
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
		const underWay = drawer.getByRole("list", { name: "Under way" });
		// Newest first, one line each, with a mark in the colour of its status.
		await expect(underWay.getByRole("link")).toHaveCount(2);
		await expect(underWay.getByRole("link").first()).toContainText("What does greet() return?");
		await expect(underWay.getByRole("link", { name: /Add a shout\(\) function/ })).toContainText("Question waiting");
		await expect(underWay.getByRole("link", { name: /Add a shout\(\) function/ }).locator(".indicator")).toHaveClass(/attention/);
		await underWay.getByRole("link", { name: /What does greet\(\) return\?/ }).tap();
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
		await expect(drawer.getByRole("list", { name: "Under way" }).getByRole("link", { name: /What is in src\?/ })).toBeVisible();
		await expect(drawer.getByText(/^Inactive/)).toBeHidden();
	});

	test("on a wide screen the sidebar can be put away, and stays put away after a reload", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await startSession(page, "What is in src?");
		const sidebar = page.getByRole("navigation", { name: "Sessions" });
		await expect(sidebar).toBeVisible();
		// Memory is on in this server, so nothing in the sidebar speaks of it (memory.spec.ts has it off).
		await expect(sidebar.getByText("Memory is off")).toHaveCount(0);
		await page.getByRole("button", { name: "Hide the sidebar" }).click();
		await expect(sidebar).toBeHidden();
		await page.reload();
		await expect(page.getByText("Short answer:")).toBeVisible();
		await expect(sidebar).toBeHidden();
		await page.getByRole("button", { name: /^Sessions/ }).click();
		await expect(sidebar).toBeVisible();
		await page.reload();
		await expect(sidebar).toBeVisible();
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
		await expect(page.locator(".is-person .chip").first()).toHaveText("@src/greet.ts");
		await expect(page.locator(".is-person .said")).toHaveText("Look at @src/greet.ts then #release-notes mail me@example.com about #12 ");
	});
});
