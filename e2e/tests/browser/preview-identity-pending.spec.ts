import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { componentPeer } from "../../lib/componentPeer";
import { expect, test } from "../../lib/fixtures";
import type {} from "../../lib/preview-identity-client";
import { IDENTITY_FIRST_NAME } from "../../lib/previewIdentityFixture";
import { NAVIGATION_CASES } from "../../lib/previewNavigationFixture";

/**
 * Until the signed-in member's session resolves, the session is not yet the
 * worker's: it holds none of the worker's keys, and a device refuses a read
 * of a key its worker lacks. Every screen of the peer reads the worker's
 * first name, which every device holds, so a screen that read it before the
 * worker arrived would show a refusal no phone shows. Each test opens a
 * screen while the session is still waiting, sees it wait without ever
 * drawing a refusal, resolves the session, and sees the screen open with the
 * worker's value. A menu that skips to results draws no case before the
 * worker arrives either: the rows it opens on are the default search's, which
 * Preview runs once the session is the worker's, and on Web Apps a Search
 * button condition that reads the worker decides whether it opens on the
 * worker's list or on those Results at all.
 */

test.use({ reducedMotion: "reduce", serviceWorkers: "block" });

let peer: Awaited<ReturnType<typeof componentPeer>>;

test.beforeAll(async () => {
	const boundary = resolve("e2e/lib/preview-identity-boundary.ts");
	peer = await componentPeer("e2e/lib/preview-identity-client.tsx", [], {
		"@/lib/preview/engine/caseDataBinding": boundary,
		"@/lib/preview/engine/lookupDataBinding": boundary,
		"@/lib/preview/entryPointLaunchAction": boundary,
		"@/lib/auth/hooks/useAuth": boundary,
		"@/lib/lookup/actions": boundary,
		"@/lib/deployment/actions": boundary,
		"@/lib/doc/platformChangePreflight": boundary,
		"@/lib/preview/app-tests/actions": boundary,
		"@/components/builder/app-setup/AppSetupWorkspace": boundary,
		"@/components/builder/case-operations/CaseOperationDetailCanvas": boundary,
		"@/components/builder/case-operations/CaseOperationsCanvas": boundary,
		"@/components/builder/conditions/DisplayConditionCanvas": boundary,
		"@/components/builder/data-review/DataReviewScreen": boundary,
		"@/components/builder/form-links/FormLinkDetailCanvas": boundary,
		"@/components/builder/form-links/FormLinksCanvas": boundary,
		"@/components/builder/project-data/ProjectDataWorkspace": boundary,
		"@/components/builder/case-list-config/CaseListConfigWorkspace": boundary,
	});
});
test.afterAll(async () => {
	await peer?.close();
});

/** Open the peer with the session still waiting, recording whether a
 *  refusal, or the worker's first case, is ever drawn, however briefly. */
async function openWaiting(page: Page) {
	await page.addInitScript((caseName: string) => {
		const seen = { refusal: false, caseDrawn: false };
		Object.assign(window, { refusalSeen: seen });
		new MutationObserver(() => {
			if (
				document.querySelector(
					"[data-preview-data-refusal], [data-form-refusal]",
				) !== null
			)
				seen.refusal = true;
			if (document.body?.textContent?.includes(caseName) === true)
				seen.caseDrawn = true;
		}).observe(document, {
			childList: true,
			subtree: true,
			characterData: true,
		});
	}, NAVIGATION_CASES[0]);
	await page.setViewportSize({ width: 390, height: 800 });
	await page.goto(`${peer.origin}/`);
	return page.locator("main");
}

/** Hold the waiting screen long enough for any read of the empty session to
 *  have been drawn, then let the worker arrive. `drawsNoCase` also holds
 *  that no case was drawn while the session waited. */
async function releaseAfterWaiting(page: Page, drawsNoCase = false) {
	await page.evaluate(() => new Promise((done) => setTimeout(done, 1_000)));
	expect(await refusalSeen(page)).toBe(false);
	if (drawsNoCase) expect(await caseDrawn(page)).toBe(false);
	await page.evaluate(() => window.previewIdentity.release());
}

function refusalSeen(page: Page): Promise<boolean> {
	return page.evaluate(
		() =>
			(window as unknown as { refusalSeen: { refusal: boolean } }).refusalSeen
				.refusal,
	);
}

function caseDrawn(page: Page): Promise<boolean> {
	return page.evaluate(
		() =>
			(window as unknown as { refusalSeen: { caseDrawn: boolean } }).refusalSeen
				.caseDrawn,
	);
}

async function close(page: Page) {
	if (!page.isClosed())
		await page.evaluate(() => window.previewIdentity?.dispose());
}

test("a form whose question starts on a worker key waits for the worker, then opens with the worker's value", async ({
	page,
}) => {
	try {
		const main = await openWaiting(page);
		await main
			.getByRole("button", { name: /^Worker visits\b/ })
			.click({ timeout: 20_000 });
		await main
			.getByRole("button", { name: /^Worker visit\b/ })
			.click({ timeout: 20_000 });
		await expect(
			main
				.getByRole("status")
				.filter({ hasText: "This form is getting ready." }),
		).toBeVisible({ timeout: 20_000 });
		await releaseAfterWaiting(page);

		await expect(main.getByLabel("Who")).toHaveValue(IDENTITY_FIRST_NAME, {
			timeout: 20_000,
		});
		expect(await refusalSeen(page)).toBe(false);
	} finally {
		await close(page);
	}
});

test("a Search screen whose field starts on a worker key waits for the worker, then fills the field", async ({
	page,
}) => {
	try {
		const main = await openWaiting(page);
		await main
			.getByRole("button", { name: /^Find patients\b/ })
			.click({ timeout: 20_000 });
		await expect(
			main
				.getByRole("status")
				.filter({ hasText: "This search is getting ready." }),
		).toBeVisible({ timeout: 20_000 });
		await expect(main.getByLabel("Patient name")).toHaveCount(0);
		await releaseAfterWaiting(page);

		await expect(main.getByLabel("Patient name")).toHaveValue(
			IDENTITY_FIRST_NAME,
			{ timeout: 20_000 },
		);
		expect(await refusalSeen(page)).toBe(false);
	} finally {
		await close(page);
	}
});

for (const menu of ["Patients nearby", "Patients today"]) {
	test(`${menu}, which skips to results, draws no case until the worker arrives, then opens on the default search's Results`, async ({
		page,
	}) => {
		try {
			const main = await openWaiting(page);
			await main
				.getByRole("button", { name: new RegExp(`^${menu}\\b`) })
				.click({ timeout: 20_000 });
			await releaseAfterWaiting(page, true);

			await expect(main.getByText(NAVIGATION_CASES[0])).toBeVisible({
				timeout: 20_000,
			});
			/* Results, not the worker's list: the list would carry the
			 * Search action's button beside its cases. */
			await expect(
				main.getByRole("button", { name: "Search", exact: true }),
			).toHaveCount(0);
			expect(await refusalSeen(page)).toBe(false);
		} finally {
			await close(page);
		}
	});
}
