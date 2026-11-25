import { defineConfig } from "@playwright/test";

// Chromium at a phone's size, with touch: the app is used from a phone.
export default defineConfig({
	testDir: "e2e",
	globalSetup: "./e2e/global-setup.ts",
	timeout: 60_000,
	expect: { timeout: 15_000 },
	fullyParallel: false,
	workers: 3,
	reporter: [["list"]],
	use: {
		browserName: "chromium",
		viewport: { width: 390, height: 844 },
		deviceScaleFactor: 1,
		isMobile: true,
		hasTouch: true,
		trace: "off",
	},
});
