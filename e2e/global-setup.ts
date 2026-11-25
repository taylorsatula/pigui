// Launch Chromium once, before any spec runs. On a machine without Chromium's system libraries the browser exits
// with 127 and its log says "error while loading shared libraries: libnspr4.so"; failing here turns 27 identical
// spec deaths into one message with the remedy in it.
import { chromium } from "@playwright/test";

export default async function globalSetup(): Promise<void> {
	let browser;
	try {
		browser = await chromium.launch();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/error while loading shared libraries|libnspr4|exit code 127/i.test(message)) {
			throw new Error(
				"Playwright's Chromium cannot launch: its system libraries are missing (the log says something like 'error while loading shared libraries: libnspr4.so' and the process exits with 127). " +
					"Run `npx playwright install --with-deps chromium`. See the README, \"Test\".",
			);
		}
		throw error;
	}
	await browser.close();
}
