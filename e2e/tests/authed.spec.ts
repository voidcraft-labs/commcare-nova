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
	openAppId: string;
	deleteAppId: string;
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

		// Open the app — each card is a single <a href="/build/{id}">.
		await page
			.getByRole("link", { name: new RegExp(seed.openAppName) })
			.click();
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

		// While idle the card is a <a href="/build/{id}"> — scope the trash button
		// to it. Clicking trash flips the card to a confirming state (it re-renders
		// as a non-link, so DON'T re-scope to `a` here); exactly one confirm
		// dialog is open at a time, so target it at the page level.
		const deleteCard = page.getByRole("link", {
			name: new RegExp(seed.deleteAppName),
		});
		await expect(deleteCard).toBeVisible();
		await deleteCard.getByRole("button", { name: "Delete app" }).click();

		// Confirm → the real `deleteApp` Server Action → softDeleteApp →
		// revalidatePath("/").
		await page.getByRole("button", { name: "Confirm delete" }).click();

		// After the soft-delete revalidates, the active card is gone and the trash
		// tab appears.
		await expect(
			page.getByRole("link", { name: new RegExp(seed.deleteAppName) }),
		).toHaveCount(0, { timeout: 15_000 });
		await expect(
			page.getByRole("tab", { name: "Recently deleted" }),
		).toBeVisible();
	});
});
