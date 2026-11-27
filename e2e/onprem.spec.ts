// pigui OnPrem in the browser: a server on this computer, opened at localhost, whose new sessions start on this
// computer at ~, or in a repository from the full-screen picker. Rows and tiles spawn the blank screen; the first
// send creates the session.
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { approveThrough, expect, startSession, test } from "./fixtures.ts";

test.use({ onPrem: true });

test.describe("pigui OnPrem", () => {
	test("a new session starts on this computer, at ~, and replies there", async ({ page, errors }) => {
		await page.goto("/");
		await expect(page.getByRole("button", { name: "This computer" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Repository" })).toBeVisible();
		await expect(page.locator("body")).not.toContainText("Tailscale");
		await page.getByRole("button", { name: "This computer" }).tap();
		const composer = page.getByRole("textbox", { name: "Describe the task…" });
		await expect(composer).toBeFocused();
		await expect(page.locator(".subtitle .where")).toHaveText("~");
		await composer.fill("What is in this directory?");
		await page.getByRole("button", { name: "Send", exact: true }).tap();
		await expect(page).toHaveURL(/#\/s\/\d+/);
		await expect(page.getByText("Short answer:")).toBeVisible();
		await expect(page.locator(".subtitle .where")).toHaveText("~");
		// It works in place: there is no branch, so no diff to view.
		await expect(page.getByRole("button", { name: "View changes" })).toHaveCount(0);
		await page.getByRole("button", { name: /^Sessions/ }).tap();
		const entry = page.getByRole("dialog", { name: "Sessions" }).getByRole("link", { name: /What is in this directory\?/ });
		await expect(entry.locator(".row-where")).toHaveText("~");
		await expect(entry.locator(".row-status")).toHaveText("Replied");
		expect(errors).toEqual([]);
	});

	test("a planned task lands at ~ and its report offers no push or pull request", async ({ page, server }) => {
		await page.goto("/");
		await page.getByRole("button", { name: "This computer" }).tap();
		await page.getByRole("textbox", { name: "Describe the task…" }).fill("Add a shout() function");
		await page.getByRole("button", { name: "Send", exact: true }).tap();
		await expect(page.locator(".subtitle .where")).toHaveText("~");
		await approveThrough(page);
		const report = page.getByRole("region", { name: "Report" });
		await expect(report).toBeVisible({ timeout: 30_000 });
		await expect(report.getByRole("button", { name: "Open pull request" })).toHaveCount(0);
		await expect(report.getByRole("button", { name: "Push branch" })).toHaveCount(0);
		await expect(report.getByRole("button", { name: "Keep working" })).toBeVisible();
		expect(existsSync(join(server.home!, "src", "shout.ts"))).toBe(true);
	});

	test("starred and recent repository rows continue the branch they name, and five recents are offered", async ({ page, errors }) => {
		// Fill Recent with repository fixtures: three new branches off main, then notes on its drafts branch last so it is newest.
		for (let i = 0; i < 3; i += 1) {
			const created = await page.request.post("/api/sessions", {
				data: { requestId: `splash-greeter-${i}-${Math.random().toString(16).slice(2)}`, place: "repo", repo: "demo/greeter", start: { kind: "new", base: "main" }, text: "Hello", attachments: [] },
			});
			expect(created.ok()).toBe(true);
		}
		for (let i = 0; i < 2; i += 1) {
			const created = await page.request.post("/api/sessions", {
				data: { requestId: `splash-notes-${i}-${Math.random().toString(16).slice(2)}`, place: "repo", repo: "demo/notes", start: { kind: "new", base: "main" }, text: "Hello", attachments: [] },
			});
			expect(created.ok()).toBe(true);
		}
		const notesDrafts = await page.request.post("/api/sessions", {
			data: { requestId: `splash-notes-drafts-${Math.random().toString(16).slice(2)}`, place: "repo", repo: "demo/notes", start: { kind: "continue", branch: "drafts" }, text: "Hello", attachments: [] },
		});
		expect(notesDrafts.ok()).toBe(true);

		await page.goto("/");
		const recent = page.getByRole("region", { name: "Recent" });
		// Five rows at most, even though six working places exist.
		await expect(recent.locator(".place-row")).toHaveCount(5);
		for (const sub of await recent.locator(".place-sub").all()) await expect(sub).toHaveText(/^(pi\/|drafts)/);

		// Star demo/notes; the row joins the starred list above the recents, continuing its newest branch. Which branch
		// that is depends on when the runs settle, so read it from the row.
		const star = await page.request.post("/api/repos/starred", { data: { repo: "demo/notes", starred: true } });
		expect(star.ok()).toBe(true);
		await page.reload();
		const starred = page.getByRole("region", { name: "Starred" });
		await expect(starred.locator(".place-name")).toHaveText(["demo/notes"]);
		const branch = (await starred.locator(".place-sub").textContent())!.replace("continue ", "");
		expect(branch).toMatch(/^(pi\/.+|drafts)$/);
		await starred.locator(".place-choose").tap();
		const composer = page.getByRole("textbox", { name: "Describe the task…" });
		await expect(composer).toBeFocused();
		await expect(page.locator(".subtitle .where")).toHaveText(`demo/notes · continue ${branch}`);
		await composer.fill("What is on this branch?");
		await page.getByRole("button", { name: "Send", exact: true }).tap();
		await expect(page.locator(".subtitle .where")).toHaveText(`demo/notes · ${branch}`);
		expect(errors).toEqual([]);
	});

	test("the repository picker prefills the most recent repository on its default branch, and Start session spawns it", async ({ page }) => {
		await page.goto("/");
		await page.getByRole("button", { name: "Repository" }).tap();
		const picker = page.getByRole("dialog", { name: "Start from a repository" });
		await expect(picker).toBeVisible();
		await expect(picker.getByRole("combobox", { name: "Repository" })).toHaveValue(/^demo\/(greeter|notes)$/);
		// The prefilled branch is the repository's own default branch, labelled (default).
		await expect(picker.getByRole("combobox", { name: "Start from" })).toHaveValue("main");
		await expect(picker.getByRole("radio", { name: "New branch" })).toBeChecked();
		await picker.getByRole("button", { name: "Start session" }).tap();
		await expect(picker).toHaveCount(0);
		const composer = page.getByRole("textbox", { name: "Describe the task…" });
		await expect(composer).toBeFocused();
		const where = await page.locator(".subtitle .where").textContent();
		expect(where).toMatch(/^demo\/(greeter|notes) · new branch from main$/);
		await composer.fill("What does greet() return?");
		await page.getByRole("button", { name: "Send", exact: true }).tap();
		await expect(page.getByText("Short answer:")).toBeVisible();
		await expect(page.locator(".subtitle .where")).toContainText(" · pi/");
	});

	test("a reload mid-draft returns to the blank screen with the words kept", async ({ page }) => {
		await page.goto("/");
		await page.getByRole("button", { name: "This computer" }).tap();
		const composer = page.getByRole("textbox", { name: "Describe the task…" });
		await composer.fill("Half a thought");
		await page.reload();
		await expect(page.locator(".subtitle .where")).toHaveText("~");
		await expect(page.getByRole("textbox", { name: "Describe the task…" })).toHaveValue("Half a thought");
		// And the back button returns to the splash with the words kept there too.
		await page.getByRole("button", { name: "Back to New session" }).tap();
		await expect(page).toHaveURL(/#\/$/);
		await page.getByRole("button", { name: "This computer" }).tap();
		await expect(page.getByRole("textbox", { name: "Describe the task…" })).toHaveValue("Half a thought");
	});
});
