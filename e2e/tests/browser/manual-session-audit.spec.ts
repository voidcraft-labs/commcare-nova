import { expect, test } from "../../lib/fixtures";
import { waitForManualPageClose } from "../../lib/manualSession";

test("manual session waits own each native page close and handle already-closed pages", async ({
	browser,
}) => {
	const context = await browser.newContext();
	try {
		const first = await context.newPage();
		const second = await context.newPage();
		let secondFinished = false;
		const firstClosed = waitForManualPageClose(first);
		const secondClosed = waitForManualPageClose(second).then(() => {
			secondFinished = true;
		});
		await first.close();
		await firstClosed;
		expect(secondFinished).toBe(false);
		await second.close();
		await secondClosed;
		await waitForManualPageClose(first);
	} finally {
		await context.close();
	}
});
