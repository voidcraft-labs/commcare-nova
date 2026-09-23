import { componentPeer } from "../../lib/componentPeer";
import { expect, test } from "../../lib/fixtures";

let peer: Awaited<ReturnType<typeof componentPeer>>;
test.beforeAll(async () => {
	peer = await componentPeer("e2e/lib/app-header-client.tsx");
});
test.afterAll(async () => {
	await peer?.close();
});

test("header fits changing intrinsic slots and returns to one row without rebuilding controls", async ({
	page,
}) => {
	await page.setViewportSize({ width: 680, height: 800 });
	await page.goto(peer.origin);
	const header = page.locator("[data-app-header]");
	const worker = header.getByRole("button", { name: "Worker controls" });
	const document = header.getByRole("button", { name: "Document controls" });
	const account = header.getByRole("button", { name: "Account", exact: true });
	const wide = page.getByRole("button", {
		name: "Change worker control width",
	});
	const banner = page.getByRole("button", {
		name: "Toggle impersonation banner",
	});
	await expect(worker).toBeVisible();
	const original = await document.elementHandle();
	if (!original) throw new Error("Missing document controls");
	try {
		for (const change of [wide, banner, wide, banner]) {
			await change.click();
			await expect
				.poll(() =>
					header.evaluate((element) => {
						const rects = [...element.querySelectorAll("button, a[href]")].map(
							(control) => control.getBoundingClientRect(),
						);
						return rects.every(
							(a, i) =>
								a.left >= 0 &&
								a.right <= window.innerWidth &&
								rects
									.slice(i + 1)
									.every(
										(b) =>
											a.right <= b.left ||
											b.right <= a.left ||
											a.bottom <= b.top ||
											b.bottom <= a.top,
									),
						);
					}),
				)
				.toBe(true);
			await worker.click();
			await document.click();
			await account.click();
		}
		await expect(page.getByLabel("Control clicks")).toHaveText("12");
		await page.setViewportSize({ width: 1440, height: 800 });
		await expect(header).toHaveAttribute("data-header-layout", "standard");
		expect(
			await document.evaluate(
				(element, previous) => element === previous,
				original,
			),
		).toBe(true);
	} finally {
		await original.dispose();
	}
});
