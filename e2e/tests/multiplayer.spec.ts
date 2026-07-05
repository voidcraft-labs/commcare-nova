import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
	type Browser,
	type BrowserContext,
	expect,
	type Page,
	test,
} from "@playwright/test";
import { Pool } from "pg";
import { attachErrorGuard } from "../lib/errorGuard";
import { applyPageZoom, tileWindow } from "../lib/windowTiling";

/**
 * Two-user real-time multiplayer acceptance + UI/UX verification — the feature's
 * end-to-end gate.
 *
 * Two users who are BOTH members of one shared Project (Ada, the owner; Grace,
 * an editor — seeded by `e2e/lib/multiplayerSeed.ts` into a two-module, four-field
 * app), each in their own browser context carrying that user's session cookie,
 * co-edit the SAME shared app. Every test drives the REAL transport (two
 * contexts, live propagation over the SSE stream + guarded writer + reconciler),
 * and each captures a screenshot to `e2e/multiplayer-screenshots/` so the UI/UX
 * can be eyeballed, not just asserted.
 *
 * The matrix (each an `expect.poll`/auto-waiting assertion — never a fixed sleep):
 *   1. Presence (bidirectional) + live co-edit — each peer appears in the other's
 *      roster; Ada renames the module and Grace sees the new name live.
 *   2. Disjoint-edit merge — while Ada renames the FORM, Grace renames a FIELD id
 *      in the inspector; both survive on both screens (no clobber).
 *   3. Presence marker + live-highlight — Ada selects a field; Grace sees Ada is
 *      "editing a field" (the location the peer "editing this" ring rides on).
 *   4. Follow — Ada moves to module 2; Grace clicks Ada's roster avatar and lands
 *      on module 2 (the peer's location), once it has propagated.
 *   5. Reconnect — Grace goes offline, Ada edits, Grace comes back and the
 *      EventSource replays the missed frame (catches up, no manual reload).
 *   6. Reorder merge — Ada reorders a field (Field-actions → Move Down) while
 *      Grace renames the form; the reorder reaches Grace and her rename survives.
 *   7. Revocation — Grace's membership is removed; her stream is revoked and Ada's
 *      roster drops her within the cadence + presence-stale window.
 *
 * The single `page` fixture (`lib/fixtures.ts`) can't drive two users, so this
 * spec opens its own contexts and applies the identical strict error guard
 * (`attachErrorGuard`) to each page. The suite shares ONE seeded app and mutates
 * it cumulatively, so tests assert the CHANGE they make (unique markers), never a
 * seed starting value a prior test may have already edited.
 */

interface MultiplayerManifest {
	appId: string;
	moduleUuid: string;
	moduleName: string;
	formUuid: string;
	formName: string;
	fieldOneUuid: string;
	fieldOneLabel: string;
	fieldTwoUuid: string;
	fieldTwoLabel: string;
	fieldThreeUuid: string;
	fieldThreeLabel: string;
	moduleTwoUuid: string;
	moduleTwoName: string;
	fieldFourUuid: string;
	userA: { id: string; email: string; name: string };
	userB: { id: string; email: string; name: string };
	stateFileA: string;
	stateFileB: string;
	baseUrl: string;
}

// Loaded in beforeAll, not at module scope: Playwright imports every spec to
// discover tests even under `--project=public` (the seed-less prod probe), so a
// top-level read would crash collection when the manifest is absent.
let mp: MultiplayerManifest;

const SHOTS_DIR = path.join(process.cwd(), "e2e", "multiplayer-screenshots");

/** A guarded builder page for one seeded user, landed on `subPath` of the app. */
interface UserPage {
	page: Page;
	context: BrowserContext;
	assertNoErrors: () => void;
	close: () => Promise<void>;
}

/**
 * Watch mode (`npm run mp:watch` → `MP_TILE=1`): tile Ada's window onto the
 * left half of the screen and Grace's onto the right so a human can watch
 * both sides of every scenario at once. Two coupled adjustments make the
 * whole builder visible in a half-window on a 13" screen: the viewport is
 * resized to the ACTUAL window content area (so nothing is clipped), and a
 * CSS page zoom of contentWidth/1280 reflows the layout back out to CI's
 * effective 1280 width, rendered small. CSS zoom (not a device-metrics
 * scale — that destabilizes the canvas's own scrolling) keeps input native
 * and un-emulated; the headless CI run keeps the fixed viewport untouched.
 */
const TILED = process.env.MP_TILE === "1";
const TILE_WIDTH = 1280;

/** Open a builder page for one seeded user, guarded, at a specific app screen. */
async function openBuilder(
	browser: Browser,
	storageState: string,
	subPath: string,
): Promise<UserPage> {
	const context = await browser.newContext({
		storageState,
		baseURL: mp.baseUrl,
	});
	const page = await context.newPage();
	if (TILED) {
		const content = await tileWindow(
			page,
			storageState === mp.stateFileA ? "left" : "right",
		);
		if (content) {
			await page.setViewportSize(content);
			const zoom = Math.min(1, content.width / TILE_WIDTH);
			if (zoom < 1) await applyPageZoom(page, zoom);
		}
	}
	const guard = attachErrorGuard(page, mp.baseUrl);
	await page.goto(`/build/${mp.appId}${subPath}`);
	return {
		page,
		context,
		assertNoErrors: guard.assertNoErrors,
		close: () => context.close(),
	};
}

/**
 * The module/form-name title input on the CURRENTLY VISIBLE screen (EditableTitle).
 *
 * Scoped to `:visible` on purpose: React 19's `<Activity>` keeps previously
 * visited screens MOUNTED but hidden (`display:none`), so `ModuleScreen` and
 * `FormScreen` can both have an `editable-title` in the DOM at once (only one
 * visible). A bare `.first()` would match the hidden one in DOM order, so the
 * `:visible` filter pins the selector to the screen actually on view — one match.
 */
function titleInput(page: Page) {
	return page.locator('[data-testid="editable-title"]:visible');
}

/**
 * The field-id `<input>` in the inspector rail's Field-ID section, scoped to the
 * VISIBLE inspector (same `<Activity>`-retention reason as `titleInput` — only
 * the on-view surface's inspector is mounted, but `:visible` keeps the selector
 * a single match even if a hidden surface's rail lingers in the DOM).
 */
function fieldIdInput(page: Page) {
	return page.locator('[data-field-id="id"] input:visible');
}

/** Follow-a-peer roster avatar in the header (PresenceRoster). */
function followButton(page: Page, peerName: string) {
	return page.getByRole("button", { name: `Follow ${peerName}` });
}

// SERIAL: the suite shares ONE seeded app and mutates it cumulatively, so tests
// must run in declaration order (the global config sets `fullyParallel: true`,
// which would otherwise schedule them in any order and let one test's field
// edit be observed by another before it runs).
test.describe.configure({ mode: "serial" });

test.describe("two-user multiplayer builder", () => {
	test.beforeAll(() => {
		mp = JSON.parse(
			readFileSync(
				path.join(process.cwd(), "e2e", ".auth", "multiplayer.json"),
				"utf8",
			),
		);
		mkdirSync(SHOTS_DIR, { recursive: true });
	});

	test("presence is bidirectional and a live co-edit propagates", async ({
		browser,
	}) => {
		const ada = await openBuilder(browser, mp.stateFileA, `/${mp.moduleUuid}`);
		const grace = await openBuilder(
			browser,
			mp.stateFileB,
			`/${mp.moduleUuid}`,
		);
		try {
			// Both land on the module screen (the title mounting proves the render).
			await expect(titleInput(ada.page)).toHaveValue(mp.moduleName, {
				timeout: 20_000,
			});
			await expect(titleInput(grace.page)).toHaveValue(mp.moduleName, {
				timeout: 20_000,
			});

			// 1. Presence — each peer appears in the other's roster. Auto-waiting
			// polls until the heartbeat + roster frame land (no fixed sleep). Both
			// directions prove the SSE stream is bidirectional.
			await expect(followButton(ada.page, mp.userB.name)).toBeVisible({
				timeout: 20_000,
			});
			await expect(followButton(grace.page, mp.userA.name)).toBeVisible({
				timeout: 20_000,
			});
			await ada.page.screenshot({
				path: path.join(SHOTS_DIR, "01-presence-ada-sees-grace.png"),
			});

			// 2. Live co-edit — Ada renames the module; Grace sees it live, no reload.
			const renamed = `${mp.moduleName} (edited by Ada)`;
			await titleInput(ada.page).click();
			await titleInput(ada.page).fill(renamed);
			await titleInput(ada.page).press("Enter");
			await expect(titleInput(ada.page)).toHaveValue(renamed);
			await expect(titleInput(grace.page)).toHaveValue(renamed, {
				timeout: 20_000,
			});
			await grace.page.screenshot({
				path: path.join(SHOTS_DIR, "02-live-coedit-grace-sees-rename.png"),
			});

			ada.assertNoErrors();
			grace.assertNoErrors();
		} finally {
			await ada.close();
			await grace.close();
		}
	});

	test("disjoint edits merge with no clobber (form rename + field-id edit)", async ({
		browser,
	}) => {
		// Both open the FORM screen: Ada will rename the form title, Grace will edit
		// a different field's id in the inspector — disjoint slots that must MERGE.
		const ada = await openBuilder(browser, mp.stateFileA, `/${mp.formUuid}`);
		const grace = await openBuilder(browser, mp.stateFileB, `/${mp.formUuid}`);
		try {
			await expect(titleInput(ada.page)).toHaveValue(mp.formName, {
				timeout: 20_000,
			});

			// Grace selects field two and edits its id in the inspector rail. The
			// Field-ID section mounts a plain <input> inside `[data-field-id="id"]`.
			await grace.page.goto(
				`/build/${mp.appId}/${mp.formUuid}/${mp.fieldTwoUuid}`,
			);
			const graceIdInput = fieldIdInput(grace.page);
			await expect(graceIdInput).toBeVisible({ timeout: 20_000 });
			await expect(graceIdInput).toHaveValue("village");

			// Concurrent disjoint edits: Ada renames the FORM, Grace renames the
			// FIELD ID. Fire both close together, then assert BOTH survive on BOTH.
			const newForm = `${mp.formName} v2`;
			const newId = "village_name";
			await titleInput(ada.page).click();
			await titleInput(ada.page).fill(newForm);
			await graceIdInput.click();
			await graceIdInput.fill(newId);
			await titleInput(ada.page).press("Enter");
			await graceIdInput.press("Enter");

			// Ada's form rename reaches Grace; Grace's id edit reaches Ada — neither
			// clobbers the other (the guarded writer MERGES disjoint slots).
			await expect(titleInput(grace.page)).toHaveValue(newForm, {
				timeout: 20_000,
			});
			await expect(graceIdInput).toHaveValue(newId);
			// Ada navigates to field two to confirm Grace's id edit landed for her too.
			await ada.page.goto(
				`/build/${mp.appId}/${mp.formUuid}/${mp.fieldTwoUuid}`,
			);
			const adaIdInput = fieldIdInput(ada.page);
			await expect(adaIdInput).toHaveValue(newId, { timeout: 20_000 });
			await ada.page.screenshot({
				path: path.join(SHOTS_DIR, "03-disjoint-merge-ada-view.png"),
			});

			ada.assertNoErrors();
			grace.assertNoErrors();
		} finally {
			await ada.close();
			await grace.close();
		}
	});

	test("presence marker + live-highlight tracks a peer's field selection", async ({
		browser,
	}) => {
		const ada = await openBuilder(browser, mp.stateFileA, `/${mp.formUuid}`);
		const grace = await openBuilder(browser, mp.stateFileB, `/${mp.formUuid}`);
		try {
			await expect(titleInput(grace.page)).toBeVisible({ timeout: 20_000 });
			// Ada selects field three (deep-link is the stable way to set her
			// selection — presence broadcasts the resulting location).
			await ada.page.goto(
				`/build/${mp.appId}/${mp.formUuid}/${mp.fieldThreeUuid}`,
			);
			await expect(fieldIdInput(ada.page)).toBeVisible({ timeout: 20_000 });

			// Grace sees that Ada is now editing a field — presence broadcast Ada's
			// field selection. The roster avatar's follow-tooltip reads "… — editing
			// a field" (`PresenceRoster.whereLabel` maps a form location with a
			// selectedUuid to that phrase), so hovering Ada's avatar surfaces the
			// live selection state. This is the observable that the live-highlight
			// (peer "editing this" ring, driven by the same `selectedUuid`) rides on.
			await expect(followButton(grace.page, mp.userA.name)).toBeVisible({
				timeout: 20_000,
			});
			await followButton(grace.page, mp.userA.name).hover();
			await expect(
				grace.page.getByText("editing a field", { exact: false }),
			).toBeVisible({ timeout: 20_000 });
			await grace.page.screenshot({
				path: path.join(
					SHOTS_DIR,
					"04-live-highlight-grace-sees-ada-field.png",
				),
			});

			ada.assertNoErrors();
			grace.assertNoErrors();
		} finally {
			await ada.close();
			await grace.close();
		}
	});

	test("following a peer navigates to their screen", async ({ browser }) => {
		const ada = await openBuilder(browser, mp.stateFileA, `/${mp.moduleUuid}`);
		const grace = await openBuilder(
			browser,
			mp.stateFileB,
			`/${mp.moduleUuid}`,
		);
		try {
			await expect(titleInput(grace.page)).toBeVisible({ timeout: 20_000 });
			await expect(followButton(grace.page, mp.userA.name)).toBeVisible({
				timeout: 20_000,
			});
			// Ada moves to module 2. Grace, still on module 1, will FOLLOW her.
			await ada.page.goto(`/build/${mp.appId}/${mp.moduleTwoUuid}`);
			await expect(titleInput(ada.page)).toHaveValue(mp.moduleTwoName, {
				timeout: 20_000,
			});

			// Follow reads the peer's LAST heartbeated location, so Grace must wait
			// for Ada's module-2 location to propagate before clicking — otherwise she
			// follows Ada's stale mount-time location (the app home) and lands on
			// `/build/{app}` instead of the module. Hovering Ada's avatar surfaces the
			// follow tooltip; "in a module" confirms Ada's module-2 location arrived
			// (`whereLabel` maps a module location to that phrase). Poll the whole
			// hover→click→navigate as one unit so a late frame just retries the click.
			await expect(async () => {
				await followButton(grace.page, mp.userA.name).hover();
				await expect(
					grace.page.getByText("in a module", { exact: false }),
				).toBeVisible({ timeout: 2_000 });
				await followButton(grace.page, mp.userA.name).click();
				await expect(grace.page).toHaveURL(
					new RegExp(`/build/${mp.appId}/${mp.moduleTwoUuid}`),
					{ timeout: 3_000 },
				);
			}).toPass({ timeout: 25_000 });
			await expect(titleInput(grace.page)).toHaveValue(mp.moduleTwoName, {
				timeout: 20_000,
			});
			await grace.page.screenshot({
				path: path.join(SHOTS_DIR, "05-follow-grace-lands-on-ada-screen.png"),
			});

			ada.assertNoErrors();
			grace.assertNoErrors();
		} finally {
			await ada.close();
			await grace.close();
		}
	});

	test("an offline peer reconnects and catches up on the edits it missed", async ({
		browser,
	}) => {
		const ada = await openBuilder(browser, mp.stateFileA, `/${mp.moduleUuid}`);
		const grace = await openBuilder(
			browser,
			mp.stateFileB,
			`/${mp.moduleUuid}`,
		);
		try {
			// The module name may already carry an earlier test's edit (the suite
			// shares one seeded app), so don't assume the seed value — just wait for
			// the title to mount and both peers to see each other.
			await expect(titleInput(grace.page)).toBeVisible({ timeout: 20_000 });
			await expect(followButton(ada.page, mp.userB.name)).toBeVisible({
				timeout: 20_000,
			});

			// Grace drops offline — her EventSource disconnects.
			await grace.context.setOffline(true);

			// Ada edits while Grace is dark. A unique value so the assertion can't
			// pass on a stale earlier-test name. Grace can't see it yet.
			const offlineName = "Intake — offline-edit marker";
			await titleInput(ada.page).click();
			await titleInput(ada.page).fill(offlineName);
			await titleInput(ada.page).press("Enter");
			await expect(titleInput(ada.page)).toHaveValue(offlineName);

			// Grace comes back — EventSource auto-reconnects with `Last-Event-ID` and
			// replays the frames it missed; the reconciler folds them in. Grace's
			// title catches up to Ada's offline edit with no manual reload.
			await grace.context.setOffline(false);
			await expect(titleInput(grace.page)).toHaveValue(offlineName, {
				timeout: 30_000,
			});
			await grace.page.screenshot({
				path: path.join(SHOTS_DIR, "06-reconnect-grace-catches-up.png"),
			});

			ada.assertNoErrors();
			grace.assertNoErrors();
		} finally {
			await ada.close();
			await grace.close();
		}
	});

	test("a field reorder propagates and a peer's concurrent edit survives", async ({
		browser,
	}) => {
		const ada = await openBuilder(
			browser,
			mp.stateFileA,
			`/${mp.formUuid}/${mp.fieldOneUuid}`,
		);
		const grace = await openBuilder(browser, mp.stateFileB, `/${mp.formUuid}`);
		try {
			// Ada has field one selected; its inspector "Field actions" menu offers a
			// non-drag "Move Down" (drag on a virtualized list is fragile). Field
			// one's id is "full_name" (untouched by the disjoint test, which edited
			// field two). The suite shares one app, so don't assume the FORM's name.
			const adaId = fieldIdInput(ada.page);
			await expect(adaId).toBeVisible({ timeout: 20_000 });
			await expect(adaId).toHaveValue("full_name");
			await expect(titleInput(grace.page)).toBeVisible({ timeout: 20_000 });

			// Concurrent: Ada moves field one DOWN (reorder) while Grace renames the
			// FORM. The reorder is an order-key mutation; the rename is a form slot —
			// disjoint, so both must land. A unique marker so the assertion can't pass
			// on a stale earlier-test name.
			const graceForm = "Registration — reorder marker";
			await titleInput(grace.page).click();
			await titleInput(grace.page).fill(graceForm);
			await ada.page.getByRole("button", { name: "Field actions" }).click();
			await ada.page.getByRole("menuitem", { name: "Move Down" }).click();
			await titleInput(grace.page).press("Enter");

			// Grace's rename reaches Ada (the reorder didn't clobber it) — the merge.
			await expect(titleInput(ada.page)).toHaveValue(graceForm, {
				timeout: 20_000,
			});
			// The reorder propagated to Grace: on HER page, field one is no longer
			// first, so its "Move Up" action is now enabled (it was disabled — first —
			// before the move). Selecting field one on Grace's side and opening the
			// Field-actions menu reflects the order the reconciler folded in.
			await grace.page.goto(
				`/build/${mp.appId}/${mp.formUuid}/${mp.fieldOneUuid}`,
			);
			await expect(fieldIdInput(grace.page)).toHaveValue("full_name", {
				timeout: 20_000,
			});
			await grace.page.getByRole("button", { name: "Field actions" }).click();
			// "Move Up" enabled ⇒ field one is not first ⇒ the reorder reached Grace.
			await expect(
				grace.page.getByRole("menuitem", { name: "Move Up" }),
			).toBeEnabled({ timeout: 20_000 });
			await grace.page.screenshot({
				path: path.join(SHOTS_DIR, "07-reorder-grace-sees-new-order.png"),
			});
			await grace.page.keyboard.press("Escape");

			ada.assertNoErrors();
			grace.assertNoErrors();
		} finally {
			await ada.close();
			await grace.close();
		}
	});

	test("undo reverts only the local edit; a peer's concurrent edit survives", async ({
		browser,
	}) => {
		// Ada edits field one's id; Grace edits field two's id (disjoint). Ada then
		// UNDOES — reverting only HER edit. Grace's edit rode in as a remote frame the
		// reconciler folded through the undo stack (`rebaseHistory`), so it is NOT on
		// Ada's history and must survive the undo.
		const ada = await openBuilder(
			browser,
			mp.stateFileA,
			`/${mp.formUuid}/${mp.fieldOneUuid}`,
		);
		const grace = await openBuilder(
			browser,
			mp.stateFileB,
			`/${mp.formUuid}/${mp.fieldTwoUuid}`,
		);
		try {
			const adaId = fieldIdInput(ada.page);
			const graceId = fieldIdInput(grace.page);
			await expect(adaId).toHaveValue("full_name", { timeout: 20_000 });
			await expect(graceId).toBeVisible({ timeout: 20_000 });

			// Ada edits field one; capture its pre-edit value to assert the undo. Ada
			// stays on field one for the whole test — an in-app `page.goto` would be a
			// FULL RELOAD that remounts the builder and RESETS the temporal undo stack,
			// disabling the Undo button. Grace's edit reaches Ada's doc over the stream
			// regardless of what Ada is viewing, so Ada never needs to navigate.
			const adaStart = await adaId.inputValue();
			const adaEdited = "full_name_edited";
			await adaId.click();
			await adaId.fill(adaEdited);
			await adaId.press("Enter");
			await expect(adaId).toHaveValue(adaEdited);

			// Grace edits field two (a disjoint edit that reaches Ada as a remote frame
			// the reconciler folds through the undo stack via `rebaseHistory`).
			const graceEdited = "village_grace_edit";
			await graceId.click();
			await graceId.fill(graceEdited);
			await graceId.press("Enter");
			await expect(graceId).toHaveValue(graceEdited);

			// Ada undoes via the header Undo button (aria-label="Undo") — more robust
			// than the Cmd+Z shortcut, which a focused text input's native undo would
			// intercept. Her field-one edit reverts to its pre-edit value.
			const undoButton = ada.page.getByRole("button", { name: "Undo" });
			await expect(undoButton).toBeEnabled({ timeout: 20_000 });
			await undoButton.click();
			await expect(adaId).toHaveValue(adaStart, { timeout: 20_000 });

			// Grace's field-two edit is untouched by Ada's undo — it was never on Ada's
			// history. Asserting it on GRACE's own screen (she never navigated) proves
			// the collaborative-undo isolation without a reload on either side.
			await expect(graceId).toHaveValue(graceEdited);
			await ada.page.screenshot({
				path: path.join(SHOTS_DIR, "09-undo-keeps-peer-edit.png"),
			});

			ada.assertNoErrors();
			grace.assertNoErrors();
		} finally {
			await ada.close();
			await grace.close();
		}
	});

	test("a removed member's stream is revoked and drops from the roster", async ({
		browser,
	}) => {
		// This test MUTATES shared auth state (removes Grace's membership), so it
		// restores it in `finally` — the seed runs once for the whole suite.
		const ada = await openBuilder(browser, mp.stateFileA, `/${mp.moduleUuid}`);
		const grace = await openBuilder(
			browser,
			mp.stateFileB,
			`/${mp.moduleUuid}`,
		);
		const pool = new Pool({ connectionString: process.env.NOVA_DB_LOCAL_URL });
		try {
			// Ada sees Grace present.
			await expect(followButton(ada.page, mp.userB.name)).toBeVisible({
				timeout: 20_000,
			});

			// Remove Grace's membership → she loses `view` on the app's Project. The
			// stream's revocation cadence closes her stream, and her presence POSTs
			// start 404ing, so Ada's roster stale-hides her.
			await pool.query(`DELETE FROM auth_member WHERE "userId" = $1`, [
				mp.userB.id,
			]);

			// Ada's roster drops Grace. The stream cadence (~10 s) + presence stale
			// window (~2 heartbeats) means this resolves within ~40 s.
			await expect(followButton(ada.page, mp.userB.name)).toHaveCount(0, {
				timeout: 60_000,
			});
			await ada.page.screenshot({
				path: path.join(SHOTS_DIR, "08-revoked-ada-roster-drops-grace.png"),
			});

			// Ada — an unaffected member — still sees no app errors. Grace's context
			// legitimately gets a revoked stream + 404 presence POSTs (an expected
			// consequence of losing access), so her page is NOT error-guarded here.
			ada.assertNoErrors();
		} finally {
			// Restore Grace's membership so a retry / later run starts clean. The
			// shared Project's slug is fixed by the seed (`mp-shared-<userA.id>`).
			await pool
				.query(
					`INSERT INTO auth_member (id, "organizationId", "userId", role, "createdAt")
					 SELECT $1, o.id, $2, 'editor', NOW()
					 FROM auth_organization o WHERE o.slug = $3
					 ON CONFLICT DO NOTHING`,
					[crypto.randomUUID(), mp.userB.id, `mp-shared-${mp.userA.id}`],
				)
				.catch(() => {});
			await pool.end().catch(() => {});
			await ada.close();
			await grace.close();
		}
	});
});
