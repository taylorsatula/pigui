// picloud OnPrem in the browser: a server on this computer, opened at localhost, whose new sessions start in a
// directory here (the home directory unless changed), with a repository the other choice.
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { approveThrough, expect, startSession, test } from "./fixtures.ts";

test.use({ onPrem: true });

test.describe("picloud OnPrem", () => {
	test("a new session starts on this computer, in ~ unless changed, and replies there", async ({ page, errors }) => {
		await page.goto("/");
		await expect(page.getByRole("radio", { name: "This computer" })).toBeChecked();
		await expect(page.getByRole("textbox", { name: "Directory" })).toHaveValue("~");
		await expect(page.locator("body")).not.toContainText("Tailscale");
		await startSession(page, "What is in this directory?");
		await expect(page.getByText("Short answer:")).toBeVisible();
		await expect(page.locator(".subtitle .where")).toHaveText("~");
		// It works in place: there is no branch, so no diff to view.
		await expect(page.getByRole("button", { name: "View changes" })).toHaveCount(0);
		await page.getByRole("button", { name: /^Sessions/ }).tap();
		const entry = page.getByRole("dialog", { name: "Sessions" }).getByRole("link", { name: /What is in this directory\?/ });
		await expect(entry.locator(".row-where")).toHaveText("~");
		await expect(entry.locator(".row-status")).toHaveText("Replied");
		await expect(page.locator("body")).not.toContainText("Tailscale");
		expect(errors).toEqual([]);
	});

	test("a planned task lands in the chosen directory, and its report offers no push or pull request", async ({ page, server }) => {
		await mkdir(join(server.home!, "project"));
		await page.goto("/");
		await page.getByRole("textbox", { name: "Directory" }).fill("~/project");
		await page.getByRole("textbox", { name: "Describe the task…" }).fill("Add a shout() function");
		await page.getByRole("button", { name: "Send", exact: true }).tap();
		await expect(page.locator(".subtitle .where")).toHaveText("~/project");
		await approveThrough(page);
		const report = page.getByRole("region", { name: "Report" });
		await expect(report).toBeVisible({ timeout: 30_000 });
		await expect(report.getByRole("button", { name: "Open pull request" })).toHaveCount(0);
		await expect(report.getByRole("button", { name: "Push branch" })).toHaveCount(0);
		await expect(report.getByRole("button", { name: "Keep working" })).toBeVisible();
		expect(existsSync(join(server.home!, "project", "src", "shout.ts"))).toBe(true);
	});

	test("directories worked in are offered under the field, the five most recent, with starred ones pinned above them", async ({ page, server, errors }) => {
		const directory = page.getByRole("textbox", { name: "Directory" });
		await mkdir(join(server.home!, "stars"));
		await page.goto("/");
		await directory.fill("~/stars");
		await page.getByRole("textbox", { name: "Describe the task…" }).fill("What is here?");
		await page.getByRole("button", { name: "Send", exact: true }).tap();
		await expect(page.locator(".subtitle .where")).toHaveText("~/stars");

		await page.goto("/");
		const recent = page.getByRole("region", { name: "Recent" });
		const starred = page.getByRole("region", { name: "Starred" });
		await expect(recent.locator(".dir-path").first()).toHaveText("~/stars");
		await expect(starred).toHaveCount(0);
		await recent.getByRole("button", { name: "Star ~/stars" }).tap();
		await expect(starred.locator(".dir-path")).toHaveText(["~/stars"]);
		await expect(recent.getByText("~/stars")).toHaveCount(0);
		// Choosing one fills the field, and the field's star says it is starred.
		await starred.getByRole("button", { name: /^~\/stars/ }).tap();
		await expect(directory).toHaveValue("~/stars");
		await expect(starred.getByRole("button", { name: /^~\/stars/ })).toHaveAttribute("aria-current", "true");
		await expect(page.getByRole("button", { name: "Star this directory" })).toHaveAttribute("aria-pressed", "true");

		// A directory not yet worked in is starred from the field. Stars are the server's, so they outlast a reload.
		await mkdir(join(server.home!, "later"));
		await directory.fill("~/later/");
		await page.getByRole("button", { name: "Star this directory" }).tap();
		await expect(starred.locator(".dir-path")).toHaveText(["~/later", "~/stars"]);
		await page.reload();
		await expect(starred.locator(".dir-path")).toHaveText(["~/later", "~/stars"]);
		await starred.getByRole("button", { name: "Star ~/stars" }).tap();
		await expect(starred.locator(".dir-path")).toHaveText(["~/later"]);
		await expect(recent.getByText("~/stars")).toBeVisible();

		// However many directories have been worked in, five are offered; every starred one is.
		for (const name of ["d1", "d2", "d3", "d4", "d5", "d6"]) {
			await mkdir(join(server.home!, name));
			const created = await page.request.post("/api/sessions", { data: { requestId: `recent-${name}-request`, place: "local", dir: `~/${name}`, text: "Hello", attachments: [] } });
			expect(created.ok()).toBe(true);
		}
		await expect(recent.locator(".dir-path")).toHaveText(Array<RegExp>(5).fill(/^~\/d\d$/));
		await expect(starred.locator(".dir-path")).toHaveText(["~/later"]);
		expect(errors).toEqual([]);
	});

	test("a repository is still a choice, on a branch of its own", async ({ page }) => {
		await page.goto("/");
		await page.getByRole("radio", { name: "A repository" }).tap();
		await expect(page.getByRole("combobox", { name: "Repository" })).toHaveValue("demo/greeter");
		await expect(page.getByRole("textbox", { name: "Directory" })).toHaveCount(0);
		const composer = page.getByRole("textbox", { name: "Describe the task…" });
		await expect(composer).toBeEnabled();
		await composer.fill("What does greet() return?");
		await page.getByRole("button", { name: "Send", exact: true }).tap();
		await expect(page.getByText("Short answer:")).toBeVisible();
		await expect(page.locator(".subtitle .where")).toContainText("demo/greeter · pi/");
	});
});
