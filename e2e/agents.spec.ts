import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, startSession, test } from "./fixtures.ts";

async function noHorizontalScroll(page: Page): Promise<void> {
	const widths = await page.evaluate(() => [document.documentElement.scrollWidth, document.body.scrollWidth, window.innerWidth]);
	expect(Math.max(widths[0] ?? 0, widths[1] ?? 0)).toBeLessThanOrEqual(widths[2] ?? 0);
}

test.describe("agents", () => {
	test.use({ viewport: { width: 375, height: 740 } });

	test("the Agents button counts the agents at work, its panel lists them and opens one, and Stop ends them", async ({ page, server, errors }) => {
		// The files the person edits over SSH: an agent that works until it is stopped, and one at a time.
		await mkdir(join(server.agentDir, "agents"), { recursive: true });
		await writeFile(join(server.agentDir, "agents", "waiter.md"), "---\ndescription: Works until it is stopped\ntools: bash\n---\nYou wait.\n");
		await writeFile(join(server.dataDir, "subagent-settings.json"), '{ "maxInFlight": 1 }\n');
		await startSession(page, "Delegate [agents]\nagent waiter bg [wait] first\nagent waiter bg [wait] second");

		const button = page.getByRole("button", { name: "Agents, 1 running, 1 queued" });
		await expect(button).toBeVisible();
		await expect(button.locator(".count-badge")).toHaveText("2");
		await expect(page.locator(".session-status")).toHaveText("Waiting on agents");
		await button.tap();

		const panel = page.getByRole("dialog", { name: "Agents" });
		await expect(panel).toBeVisible();
		const rows = panel.locator(".agent-row");
		await expect(rows).toHaveCount(2);
		// Newest first: the second, waiting its turn, above the first, at work.
		await expect(rows.nth(0)).toContainText("queued, next in line");
		await expect(rows.nth(0).locator(".indicator")).toHaveClass(/\bidle\b/);
		await expect(rows.nth(1).locator(".indicator")).toHaveClass(/\bworking\b/);
		await expect(rows.nth(1).locator(".agent-detail")).toContainText(/pigui-fake\/scripted · (bash|thinking|writing).* · \d+ turns? · [\d.]+k? tokens/);
		await expect(rows.nth(1).locator(".agent-type")).toHaveText("waiter");
		await noHorizontalScroll(page);
		await page.keyboard.press("Escape");
		await expect(panel).toBeHidden();
		await expect(button).toBeFocused();

		// The running one, in its viewer: its conversation as it goes, with nothing to send, and Stop.
		await button.tap();
		// Several calls of one round start in no set order: the older takes the place, whichever it is.
		const first = await rows.nth(1).locator(".agent-description").textContent();
		const second = await rows.nth(0).locator(".agent-description").textContent();
		await rows.nth(1).locator(".agent-open").tap();
		await expect(page).toHaveURL(/#\/s\/\d+\/agent\/\d+$/);
		await expect(page.getByRole("heading", { name: first ?? "" })).toBeVisible();
		await expect(page.locator(".session-status")).toHaveText("Working");
		await expect(page.locator(".work.live .call-command").first()).toHaveText("$ sleep 0.2");
		await expect(page.getByRole("textbox")).toHaveCount(0);
		await noHorizontalScroll(page);
		await page.getByRole("button", { name: "Stop" }).tap();
		await expect(page.locator(".session-status")).toHaveText("Stopped");
		await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);

		// Back in the session, the second has started; Stop in the panel ends it.
		await page.getByRole("link", { name: "Back to the session" }).tap();
		await expect(page.getByRole("button", { name: "Agents, 1 running" })).toBeVisible();
		await page.getByRole("button", { name: "Agents, 1 running" }).tap();
		await panel.getByRole("button", { name: `Stop waiter: ${second}` }).tap();
		await expect(rows.nth(0)).toContainText("stopped");
		await expect(panel.getByRole("button", { name: /^Stop/ })).toHaveCount(0);
		await panel.getByRole("button", { name: "Close" }).tap();
		await expect(page.getByRole("button", { name: "Agents", exact: true })).toBeVisible();
		await expect(page.locator(".session-status")).toHaveText("Stopped");

		// The parent was told of each stop, as a quiet line.
		await expect(page.locator(".entry.is-agent-stopped")).toHaveCount(2);
		expect(errors).toEqual([]);
	});

	test("a background agent's answer is its own block, folded to its first lines, and opens to the whole of it", async ({ page, server, errors }) => {
		await mkdir(join(server.agentDir, "agents"), { recursive: true });
		await writeFile(join(server.agentDir, "agents", "lister.md"), "---\ndescription: Lists what it is asked to\ntools: bash\n---\nYou list.\n");
		await startSession(page, "Delegate [agents]\nagent lister bg $ printf 'one\\ntwo\\nthree\\nfour\\nfive\\n'");
		const answer = page.locator("details.agent-result");
		await expect(answer).toBeVisible({ timeout: 30_000 });
		await expect(answer.locator(".agent-result-head")).toContainText("lister");
		await expect(answer.locator(".agent-result-head")).toContainText("answered");
		await expect(answer.locator(".markdown")).toBeHidden();
		await answer.locator("summary").tap();
		await expect(answer.locator(".markdown")).toContainText("five");
		// The call that started it is one line of the turn's work, titled with the agent and its task.
		await page.locator("details.work > summary").first().tap();
		await expect(page.locator("details.call .call-summary").filter({ hasText: "Agent lister: Task 1" })).toBeVisible();
		await noHorizontalScroll(page);
		expect(errors).toEqual([]);
	});
});
