import { componentPeer } from "../../lib/componentPeer";
import { expect, test } from "../../lib/fixtures";

/**
 * Android's home screen, as Preview running as Android plays it: Start and
 * Sync with server work; Saved and Incomplete show as the app's settings
 * show them on a phone, and Log out of CommCare always shows, each disabled
 * with its reason, which a screen reader reads as the button's description.
 */

let peer: Awaited<ReturnType<typeof componentPeer>>;
test.use({ actionTimeout: 10_000 });
test.beforeAll(async () => {
	peer = await componentPeer("e2e/lib/preview-device-home-client.tsx");
});
test.afterAll(async () => {
	await peer?.close();
});

test("the home screen shows Start, Sync with server and a disabled Log out, and Start opens the module list", async ({
	page,
}) => {
	await page.goto(peer.origin);
	const buttons = page.getByRole("button");
	await expect(buttons).toHaveText([
		"Start",
		"Sync with server",
		"Log out of CommCare",
	]);
	const logOut = page.getByRole("button", {
		name: "Log out of CommCare",
		exact: true,
	});
	await expect(logOut).toBeDisabled();
	await expect(logOut).toHaveAccessibleDescription(
		"In Preview, you can choose the worker from Running as at the top",
	);
	await page.getByRole("button", { name: "Start", exact: true }).click();
	await expect(page.getByText("The app's module list")).toBeVisible();
});

test("Saved and Incomplete show disabled with their reasons where the app's settings turn them on", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?saved&incomplete`);
	await expect(page.getByRole("button")).toHaveText([
		"Start",
		"Saved",
		"Incomplete",
		"Sync with server",
		"Log out of CommCare",
	]);
	const saved = page.getByRole("button", { name: "Saved", exact: true });
	const incomplete = page.getByRole("button", {
		name: "Incomplete",
		exact: true,
	});
	await expect(saved).toBeDisabled();
	await expect(saved).toHaveAccessibleDescription(
		"Preview doesn't keep sent forms. On a phone, this lists them.",
	);
	await expect(incomplete).toBeDisabled();
	await expect(incomplete).toHaveAccessibleDescription(
		"Preview doesn't keep unfinished forms. On a phone, this lists them.",
	);
});

test("Sync with server re-reads the worker's cases and states when it ran", async ({
	page,
}) => {
	// Preview syncs as it starts on Android, as a phone has synced before its
	// home screen shows.
	await page.clock.setFixedTime(new Date(2024, 0, 15, 9, 30));
	await page.goto(peer.origin);
	const sync = page.getByRole("button", {
		name: "Sync with server",
		exact: true,
	});
	const reads = page.getByLabel("Patient case reads");
	await expect(reads).toHaveText("0");
	await expect(sync).toHaveAccessibleDescription(
		/^You last synced with the server: .*2024.*9:30/,
	);
	await page.clock.setFixedTime(new Date(2024, 0, 15, 11, 5));
	await sync.click();
	await expect(reads).toHaveText("1");
	await expect(sync).toHaveAccessibleDescription(
		/^You last synced with the server: .*2024.*11:05/,
	);
});
