import { expect, type Page, type Response } from "@playwright/test";

/**
 * The one way a spec under `e2e/tests/app` or `e2e/tests/multiplayer` loads a
 * page. `e2e/lint/builderPageLoads.grit` refuses a bare `goto` or `reload`
 * there, so every load chooses between the two pairs below.
 *
 * Why a builder load is different: every page load starts the builder's read
 * of the Project's data-table catalog again, and the builder refuses every
 * edit until that read lands (`lib/doc/builderWriteAdmission.ts`). A refused
 * edit changes nothing and shows "Project data is still loading", so a test
 * that edits straight after the load passes while the read is quick and fails
 * when CI is slow. `openBuilder` and `reloadBuilder` return only once the
 * builder accepts edits.
 *
 * A history step (`goBack` / `goForward`) inside the builder moves through
 * the History API and keeps the loaded catalog. A step that crosses documents
 * is a page load: follow it with `expectBuilderEditable` before editing.
 */

const LOOKUP_CATALOG = '[data-builder-resource="lookup-catalog"]';

/**
 * Waits until the builder on this page accepts edits. While the page streams,
 * the marker can stand twice, once in React's not yet revealed segment, so
 * this waits until every copy reads ready.
 */
export async function expectBuilderEditable(page: Page): Promise<void> {
	await expect
		.poll(
			async () =>
				await page
					.locator(LOOKUP_CATALOG)
					.evaluateAll(
						(markers) =>
							markers.length > 0 &&
							markers.every(
								(marker) => marker.getAttribute("data-state") === "ready",
							),
					),
			{ timeout: 20_000 },
		)
		.toBe(true);
}

/** Loads a builder URL (`/build/...`) and waits until it accepts edits. */
export async function openBuilder(page: Page, url: string): Promise<void> {
	await page.goto(url);
	await expectBuilderEditable(page);
}

/** Reloads a builder page and waits until it accepts edits. */
export async function reloadBuilder(page: Page): Promise<void> {
	await page.reload();
	await expectBuilderEditable(page);
}

/**
 * Loads a page that holds no builder: the app list, Settings, the docs, a
 * local peer server. Returns the navigation's response, as `goto` does.
 */
export async function openPage(
	page: Page,
	url: string,
): Promise<Response | null> {
	return await page.goto(url);
}

/** Reloads a page that holds no builder. */
export async function reloadPage(page: Page): Promise<void> {
	await page.reload();
}
