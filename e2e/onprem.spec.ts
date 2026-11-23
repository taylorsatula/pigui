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
		await expect(page.getByRole("navigation", { name: "Sessions" }).getByRole("link", { name: /What is in this directory\?/ })).toHaveAttribute("title", "Replied · ~");
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
