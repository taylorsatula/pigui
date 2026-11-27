// pigui OnPrem in the browser: a server on this computer, opened at localhost, whose new sessions start in a
// directory here (the home directory unless changed), with a repository the other choice behind the +.
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { approveThrough, expect, startSession, test } from "./fixtures.ts";

test.use({ onPrem: true });

test.describe("pigui OnPrem", () => {
	test("a new session starts on this computer, in ~ unless changed, and replies there", async ({ page, errors }) => {
		await page.goto("/");
		await expect(page.getByRole("button", { name: "This computer" })).toBeVisible();
		await expect(page.locator(".place-line")).toHaveText("~");
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
		// A directory other than ~ is one of the choices behind the + popover.
		await page.getByRole("button", { name: "More" }).tap();
		const popover = page.getByRole("dialog", { name: "More places" });
		await popover.getByRole("radio", { name: "Directory" }).tap();
		await popover.getByRole("textbox", { name: "Directory" }).fill("~/project");
		await expect(page.locator(".place-line")).toHaveText("~/project");
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

	test("the starred repositories and directories are offered, and the three most recent repositories are the newest", async ({ page, server, errors }) => {
		// A local session whose directory is not on any cow path: starring it makes it one.
		await mkdir(join(server.home!, "stars"));
		await page.goto("/");
		await page.getByRole("button", { name: "More" }).tap();
		const popover = page.getByRole("dialog", { name: "More places" });
		await popover.getByRole("radio", { name: "Directory" }).tap();
		await popover.getByRole("textbox", { name: "Directory" }).fill("~/stars");
		await page.getByRole("textbox", { name: "Describe the task…" }).fill("What is here?");
		await page.getByRole("button", { name: "Send", exact: true }).tap();
		await expect(page.locator(".subtitle .where")).toHaveText("~/stars");

		// Stars are the server's, so they outlast a reload; the Starred section only appears once something is starred.
		await page.goto("/");
		await expect(page.getByRole("region", { name: "Starred" })).toHaveCount(0);
		const star = await page.request.post("/api/local/starred", { data: { dir: join(server.home!, "stars"), starred: true } });
		expect(star.ok()).toBe(true);
		const repoStar = await page.request.post("/api/repos/starred", { data: { repo: "demo/notes", starred: true } });
		expect(repoStar.ok()).toBe(true);
		await page.reload();

		const starred = page.getByRole("region", { name: "Starred" });
		await expect(starred.locator(".place-name")).toHaveText(["demo/notes", "~/stars"]);
		// Tapping a starred directory selects it for the next session.
		await starred.getByRole("button", { name: "~/stars Directory" }).tap();
		await expect(page.locator(".place-line")).toHaveText("~/stars");
		// Tapping a starred repository selects it, on a new branch from the default branch.
		await starred.getByRole("button", { name: "demo/notes Repository" }).tap();
		await expect(page.locator(".place-line")).toHaveText("demo/notes · new branch from main");
		// Unstarring from the row takes it off the list.
		await starred.getByRole("button", { name: "Star demo/notes" }).tap();
		await expect(starred.locator(".place-name")).toHaveText(["~/stars"]);

		// The three most recent repository/branch pairs, whatever the start kind.
		for (const name of ["demo/greeter", "demo/greeter", "demo/notes", "demo/greeter"]) {
			const created = await page.request.post("/api/sessions", {
				data: { requestId: `splash-recent-${name}-${Math.random().toString(16).slice(2)}`, place: "repo", repo: name, start: { kind: "new", base: "main" }, text: "Hello", attachments: [] },
			});
			expect(created.ok()).toBe(true);
		}
		await page.goto("/");
		const recent = page.getByRole("region", { name: "Recent" });
		await expect(recent.locator(".place-row")).toHaveCount(3);
		await expect(recent.locator(".place-sub").first()).toHaveText(/^pi\//);
		// Starring a recent row's repository promotes it to the starred list.
		await recent.getByRole("button", { name: /Star demo\// }).first().tap();
		await expect(page.getByRole("region", { name: "Starred" }).locator(".place-name").first()).toContainText("/");
		expect(errors).toEqual([]);
	});

	test("a repository is still a choice, on a branch of its own", async ({ page }) => {
		await page.goto("/");
		await page.getByRole("button", { name: "More" }).tap();
		const popover = page.getByRole("dialog", { name: "More places" });
		// The repository picker is not prefilled; the branch picker is greyed out until a repository is.
		await expect(popover.getByRole("combobox", { name: "Repository" })).toHaveValue("");
		await expect(popover.getByRole("combobox", { name: "Start from" })).toBeDisabled();
		await popover.getByRole("combobox", { name: "Repository" }).selectOption("demo/greeter");
		await expect(popover.getByRole("combobox", { name: "Start from" })).toBeEnabled();
		await expect(popover.getByRole("combobox", { name: "Start from" })).toHaveValue("main");
		// The popover stays open; the choice is already the page's.
		await expect(page.locator(".place-line")).toHaveText("demo/greeter · new branch from main");
		const composer = page.getByRole("textbox", { name: "Describe the task…" });
		await expect(composer).toBeEnabled();
		await composer.fill("What does greet() return?");
		await page.getByRole("button", { name: "Send", exact: true }).tap();
		await expect(page.getByText("Short answer:")).toBeVisible();
		await expect(page.locator(".subtitle .where")).toContainText("demo/greeter · pi/");
	});
});
