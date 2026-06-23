import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

/**
 * Authenticated smoke checks, driven by the seeded session cookie in
 * `e2e/.auth/state.json` (the `authed` Playwright project's storageState).
 *
 * Coverage mirrors the user-described "create → builder → delete" loop without
 * spending a cent on the LLM: the apps are minted by `e2e/seed.ts` through the
 * real no-LLM `createApp`, opened here in the builder, and one is soft-deleted
 * through the actual UI Server Action.
 */

interface SeedManifest {
	userId: string;
	userEmail: string;
	openAppName: string;
	deleteAppName: string;
	deleteAppCount: number;
	openAppId: string;
	deleteAppIds: string[];
}

// Loaded in beforeAll, NOT at module scope: Playwright imports every spec to
// discover tests even under `--project=public` (the seed-less prod probe), so a
// top-level read would crash collection when e2e/.auth/seed.json is absent.
let seed: SeedManifest;

test.describe("authenticated builder", () => {
	test.beforeAll(() => {
		seed = JSON.parse(
			readFileSync(
				path.join(process.cwd(), "e2e", ".auth", "seed.json"),
				"utf8",
			),
		);
	});

	test("home lists the seeded apps and opens one in the builder", async ({
		page,
	}) => {
		await page.goto("/");

		// Signed-in landing for a returning user: the app list, not the marketing
		// landing. (If the session cookie were rejected we'd see "Sign in with
		// Google" here instead — a silent-auth-break canary.)
		await expect(
			page.getByRole("heading", { name: "Your Apps", level: 1 }),
		).toBeVisible();
		await expect(page.getByText(seed.openAppName)).toBeVisible();

		// Open the app — each card is a single <a href="/build/{id}">. getByRole's
		// `name` does a substring match, so the plain string suffices (no RegExp,
		// no regex-injection risk if a name ever contains a metachar).
		await page.getByRole("link", { name: seed.openAppName }).click();
		await page.waitForURL(new RegExp(`/build/${seed.openAppId}`));

		// An empty app opens into the chat-first builder (the structural
		// canvas/sidebar only appears once it has content). Assert the builder
		// chrome (Account menu) AND the page content (the chat composer) mounted —
		// the latter proves we rendered the page, not the error boundary.
		await expect(
			page.getByRole("button", { name: "Account menu" }),
		).toBeVisible({ timeout: 20_000 });
		await expect(
			page.getByRole("button", { name: "Attach a file" }),
		).toBeVisible();
		// Authed, not bounced to the landing page.
		await expect(
			page.getByRole("button", { name: "Sign in with Google" }),
		).toHaveCount(0);
	});

	test("/build/new renders the new-app builder (no LLM)", async ({ page }) => {
		await page.goto("/build/new");
		await expect(page).toHaveURL(/\/build\/new/);
		await expect(
			page.getByRole("button", { name: "Account menu" }),
		).toBeVisible({ timeout: 20_000 });
		await expect(
			page.getByRole("button", { name: "Attach a file" }),
		).toBeVisible();
	});

	test("GET /api/auth/get-session returns the seeded user", async ({
		request,
	}) => {
		// Proves the forged cookie → Better Auth → firestore-adapter read path
		// round-trips in the live app: if better-auth/better-call signing or the
		// adapter's session lookup drifted, this returns null.
		const res = await request.get("/api/auth/get-session");
		expect(res.status()).toBe(200);
		const body = (await res.json()) as { user?: { email?: string } } | null;
		expect(body?.user?.email).toBe(seed.userEmail);
	});

	test("delete an app through the UI moves it out of the active list", async ({
		page,
	}) => {
		await page.goto("/");

		// Count active throwaway cards by HEADING. AppListBody renders only the
		// active view, so a soft-deleted card leaves the DOM — but a *confirming*
		// card keeps its heading, so the count drops only on a real deletion (a
		// link-count would false-pass the moment the card flips out of <a>).
		const deleteHeadings = page.getByRole("heading", {
			name: seed.deleteAppName,
			level: 3,
		});
		// Wait for the list to render before counting — `count()` doesn't auto-wait
		// and would otherwise read 0 mid-hydration.
		await expect(deleteHeadings.first()).toBeVisible();
		const before = await deleteHeadings.count();
		expect(before).toBeGreaterThan(0);

		// Trash → confirm on the first throwaway card. The trash click flips THAT
		// card to a confirming state (re-rendered as a non-link); exactly one
		// confirm dialog is open at a time, so target Confirm at the page level.
		// This is the real deleteApp Server Action → softDeleteApp →
		// revalidatePath("/") round-trip.
		await page
			.getByRole("link", { name: seed.deleteAppName })
			.first()
			.getByRole("button", { name: "Delete app" })
			.click();
		await page.getByRole("button", { name: "Confirm delete" }).click();

		// One fewer active card, and the trash tab is present. Idempotent under
		// retries: the seed mints several throwaway apps, so each attempt consumes
		// a fresh one.
		await expect(deleteHeadings).toHaveCount(before - 1, { timeout: 15_000 });
		await expect(
			page.getByRole("tab", { name: "Recently deleted" }),
		).toBeVisible();
	});
});
