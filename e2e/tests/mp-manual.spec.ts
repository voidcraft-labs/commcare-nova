import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import { tileWindow } from "../lib/windowTiling";

/**
 * Manual two-user session — NOT a test, a harness entry point.
 *
 * `npm run mp:manual` boots the same hermetic stack the smoke suite uses
 * (Firestore emulator + local Postgres + the production server), seeds the
 * shared two-user fixture, then this "spec" opens Ada (owner, LEFT window)
 * and Grace (editor, RIGHT window) on the SAME shared app and simply waits —
 * you drive both sides by hand over the real SSE stream + guarded writer +
 * reconciler. Close both windows (or Ctrl-C the terminal) to end the session;
 * the emulator and its data are torn down with it.
 *
 * Riding the Playwright runner (rather than a standalone script) is what
 * keeps this one code path with the smoke suite: the same `scripts/smoke.sh`
 * stack, the same seed + forged-cookie storageStates, and the same managed
 * `webServer` production build. The project only registers when
 * `MP_MANUAL=1` (playwright.config.ts), so a bare `playwright test` — CI's
 * full-suite run included — can never wander into an open-ended wait.
 *
 * No `attachErrorGuard`: a human poking at two live sessions is allowed to
 * cause errors — surfacing them is the point of looking.
 */

interface ManualManifest {
	appId: string;
	userA: { name: string; email: string };
	userB: { name: string; email: string };
	stateFileA: string;
	stateFileB: string;
	baseUrl: string;
}

test("manual two-user session — close BOTH windows (or Ctrl-C) to end", async ({
	browser,
}) => {
	// The session lives until the human closes it.
	test.setTimeout(0);
	const mp: ManualManifest = JSON.parse(
		readFileSync(
			path.join(process.cwd(), "e2e", ".auth", "multiplayer.json"),
			"utf8",
		),
	);

	const open = async (storageState: string, side: "left" | "right") => {
		const context = await browser.newContext({
			storageState,
			baseURL: mp.baseUrl,
			// Let the page fill the half-screen window instead of a fixed 1280×720.
			viewport: null,
		});
		const page = await context.newPage();
		await tileWindow(page, side);
		await page.goto(`/build/${mp.appId}`);
		return page;
	};

	const ada = await open(mp.stateFileA, "left");
	const grace = await open(mp.stateFileB, "right");

	console.log(
		`\n[mp:manual] LEFT  = ${mp.userA.name} <${mp.userA.email}> (Project owner)` +
			`\n[mp:manual] RIGHT = ${mp.userB.name} <${mp.userB.email}> (editor)` +
			`\n[mp:manual] Both are on the shared app — edits, presence, and follow propagate live.` +
			`\n[mp:manual] Close BOTH windows (or Ctrl-C here) to end the session.\n`,
	);

	// Resolve when each window is gone; a Cmd-Q / browser disconnect rejects the
	// waits, which reads as "gone" too.
	await Promise.all([
		ada.waitForEvent("close", { timeout: 0 }).catch(() => undefined),
		grace.waitForEvent("close", { timeout: 0 }).catch(() => undefined),
	]);
});
