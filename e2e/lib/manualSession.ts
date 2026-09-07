import type { Page } from "@playwright/test";

/** Manual sessions finish only when this page closes or its browser disconnects.
 * No timeout or unrelated failure is treated as a successful human dismissal. */
export function waitForManualPageClose(page: Page): Promise<void> {
	const browser = page.context().browser();
	if (page.isClosed() || (browser !== null && !browser.isConnected()))
		return Promise.resolve();
	return new Promise<void>((resolve) => {
		const finish = () => {
			page.off("close", finish);
			browser?.off("disconnected", finish);
			resolve();
		};
		page.once("close", finish);
		browser?.once("disconnected", finish);
	});
}
