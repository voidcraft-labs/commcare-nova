import { resolve } from "node:path";
import { componentPeer } from "../../lib/componentPeer";
import { expect, test } from "../../lib/fixtures";

/**
 * The identity menu chooses where Preview runs as well as who it runs as:
 * its Runs on group lists Web Apps and Android, a platform the app does not
 * declare shown disabled with the reason rather than hidden, and the
 * trigger's icon is the platform's glyph. Choosing the other platform starts
 * the app again from app entry, which on Android is the phone's home screen.
 */

let peer: Awaited<ReturnType<typeof componentPeer>>;
test.use({ actionTimeout: 10_000 });
test.beforeAll(async () => {
	const boundary = resolve("e2e/lib/builder-session-controls-boundary.ts");
	peer = await componentPeer("e2e/lib/preview-identity-menu-client.tsx", [], {
		"@/lib/preview/app-tests/actions": boundary,
		"@/lib/preview/engine/caseDataBinding": boundary,
	});
});
test.afterAll(async () => {
	await peer?.close();
});

test("Runs on lists both platforms, and choosing Android starts the app again on the phone's home screen", async ({
	page,
}) => {
	await page.goto(peer.origin);
	await page
		.getByRole("button", { name: "Toggle Preview", exact: true })
		.click();
	const trigger = page.getByRole("button", { name: /^Running as / });
	await expect(trigger).toHaveAccessibleName(
		"Running as Preview as me in Web Apps. Change who Preview runs as or where.",
	);
	await expect(trigger.locator('[data-platform-glyph="web-apps"]')).toHaveCount(
		1,
	);
	await expect(page.getByLabel("Location")).toHaveText("form");
	await trigger.click();
	const runsOn = page.getByRole("group", { name: "Runs on" });
	await expect(runsOn).toBeVisible();
	await expect(page.getByRole("group", { name: "Running as" })).toBeVisible();
	const webApps = page.getByRole("menuitemradio", { name: /^Web Apps/ });
	const android = page.getByRole("menuitemradio", { name: /^Android/ });
	await expect(webApps).toHaveAttribute("aria-checked", "true");
	await expect(webApps).toContainText("The browser app on CommCare HQ");
	await expect(android).toHaveAttribute("aria-checked", "false");
	await expect(android).toContainText("The CommCare app on a phone or tablet");
	await expect(android).toBeEnabled();
	await android.click();
	await expect(page.getByLabel("Preview platform")).toHaveText("android");
	await expect(page.getByLabel("Location")).toHaveText("home");
	await expect(page.getByLabel("At the device home")).toHaveText("true");
	await expect(trigger).toHaveAccessibleName(
		"Running as Preview as me on Android. Change who Preview runs as or where.",
	);
	await expect(trigger.locator('[data-platform-glyph="android"]')).toHaveCount(
		1,
	);
	// Choosing the platform already running changes nothing.
	await trigger.click();
	await page.getByRole("menuitemradio", { name: /^Android/ }).click();
	await expect(page.getByLabel("Preview platform")).toHaveText("android");
	await trigger.click();
	await page.getByRole("menuitemradio", { name: /^Web Apps/ }).click();
	await expect(page.getByLabel("Preview platform")).toHaveText("web-apps");
	await expect(page.getByLabel("At the device home")).toHaveText("false");
});

test("an app that runs only on Android shows Web Apps disabled with the reason", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?runs-on=android`);
	await page
		.getByRole("button", { name: "Toggle Preview", exact: true })
		.click();
	const trigger = page.getByRole("button", { name: /^Running as / });
	await expect(trigger).toHaveAccessibleName(
		"Running as Preview as me on Android. Change who Preview runs as or where.",
	);
	await trigger.click();
	const webApps = page.getByRole("menuitemradio", { name: /^Web Apps/ });
	await expect(webApps).toBeDisabled();
	await expect(webApps).toContainText("This app runs only on Android");
	await expect(
		page.getByRole("menuitemradio", { name: /^Android/ }),
	).toHaveAttribute("aria-checked", "true");
	await webApps.click({ force: true });
	await expect(page.getByLabel("Preview platform")).toHaveText("android");
});
