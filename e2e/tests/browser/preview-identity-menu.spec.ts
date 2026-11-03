import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { componentPeer } from "../../lib/componentPeer";
import { expect, test } from "../../lib/fixtures";

/**
 * The identity menu chooses where Preview runs as well as who it runs as:
 * its Runs on group lists Web Apps and Android, a platform the app does not
 * declare shown disabled with the reason rather than hidden, and the
 * trigger's icon is the platform's glyph. Choosing the other platform starts
 * the app again from app entry, which on Android is the phone's home screen.
 * Under Running as, Release claimed cases shows while the running worker
 * holds cases it claimed from a search, counted each time the menu opens.
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

/** Answer the menu's claim count, which it reads each time it opens. The
 *  running worker holds `counts[n]` claims at the n-th opening, and the last
 *  count holds from then on. */
async function answerClaimCounts(page: Page, counts: readonly number[]) {
	const requests: unknown[] = [];
	await page.route("**/claimed-cases/count", async (route) => {
		requests.push(route.request().postDataJSON());
		const count = counts[Math.min(requests.length, counts.length) - 1] ?? 0;
		await route.fulfill({ json: { kind: "count", count } });
	});
	return requests;
}

test("Runs on lists both platforms, and choosing Android starts the app again on the phone's home screen", async ({
	page,
}) => {
	await answerClaimCounts(page, [0]);
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
	await answerClaimCounts(page, [0]);
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

test("Release claimed cases shows the running worker's count, releases them, and leaves once none are held", async ({
	page,
}) => {
	const countRequests = await answerClaimCounts(page, [3, 0]);
	const releaseRequests: unknown[] = [];
	await page.route("**/claimed-cases/release", async (route) => {
		releaseRequests.push(route.request().postDataJSON());
		await route.fulfill({ json: { kind: "released", released: 3 } });
	});
	await page.goto(peer.origin);
	await page
		.getByRole("button", { name: "Toggle Preview", exact: true })
		.click();
	const trigger = page.getByRole("button", { name: /^Running as / });
	const release = page.getByRole("menuitem", { name: /^Release \d+ claimed/ });
	const revision = page.getByLabel("Patient data revision");
	await expect(revision).toHaveText("0");

	await trigger.click();
	await expect(
		page.getByRole("menuitem", {
			name: "Release 3 claimed cases",
			exact: true,
		}),
	).toBeVisible();
	expect(countRequests).toEqual([{ appId: "native-identity-menu" }]);
	await release.click();
	await expect
		.poll(() => releaseRequests)
		.toEqual([{ appId: "native-identity-menu" }]);
	// The released cases leave the device: every case type's rows reload.
	await expect(revision).toHaveText("1");
	await expect(
		page.getByText("Released 3 cases this worker claimed from a search"),
	).toBeVisible();
	await expect(
		page.getByText(
			"Their device no longer holds them, unless the worker holds them another way.",
		),
	).toBeVisible();

	// The worker holds no claims now, so the menu offers nothing to release.
	await trigger.click();
	await expect.poll(() => countRequests.length).toBe(2);
	await expect(page.getByRole("group", { name: "Running as" })).toBeVisible();
	await expect(release).toHaveCount(0);
	await page.keyboard.press("Escape");
});
