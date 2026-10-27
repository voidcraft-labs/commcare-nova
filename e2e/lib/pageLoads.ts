import { expect, type Page, type Response } from "@playwright/test";

/**
 * The one way a spec under `e2e/tests/app` or `e2e/tests/multiplayer` loads a
 * page. `e2e/lint/builderPageLoads.grit` refuses a bare `goto` or `reload`
 * there, so every load chooses between the two pairs below.
 *
 * Why a builder load is different: the builder refuses every edit while it
 * reads the Project's data-table catalog (`lib/doc/builderWriteAdmission.ts`).
 * A refused edit changes nothing and shows "Project data is still loading",
 * so a test that edits during the read passes while the read is quick and
 * fails when CI is slow. `openBuilder` and `reloadBuilder` return once the
 * read has landed. Edit access is a separate gate they do not check: a viewer
 * or a build still in progress refuses edits after the read too.
 *
 * Any load the lint cannot see starts the read again too: a link that opens a
 * builder page, or a history step that crosses documents. The new page reads
 * from scratch, so `expectBuilderDataLoaded` once it renders is enough. A
 * history step inside the builder moves through the History API and keeps the
 * loaded catalog.
 *
 * Two events restart the read on the page already open: a change to the
 * Project's data tables (the author's own or a peer's) and an access refresh
 * such as a reconnect. Until the new read begins the marker still reads ready
 * from the earlier one, so `expectBuilderDataLoaded` cannot tell a finished
 * read from one not yet started. A test that edits after one of these waits
 * for something only the new read produces, such as the changed table in a
 * picker.
 */

const LOOKUP_CATALOG = '[data-builder-resource="lookup-catalog"]';

/**
 * Waits until the builder on this page has loaded the Project's data-table
 * catalog. While the page streams, the marker can stand twice, once in
 * React's not yet revealed segment, so this waits until every copy reads
 * ready. A timeout names the states it last saw.
 */
export async function expectBuilderDataLoaded(page: Page): Promise<void> {
	await expectEveryCatalogMarker(
		page,
		"ready",
		"The builder's Project data never finished loading",
	);
}

/**
 * Waits until the builder on this page shows its catalog read in progress,
 * for a test that holds that read on purpose. The not yet revealed copy
 * described above is the server's render and always reads loading, so this
 * too waits on every copy: the live one reading loading is what it proves.
 */
export async function expectBuilderDataLoading(page: Page): Promise<void> {
	await expectEveryCatalogMarker(
		page,
		"loading",
		"The builder never showed its Project data loading",
	);
}

async function expectEveryCatalogMarker(
	page: Page,
	state: "loading" | "ready",
	message: string,
): Promise<void> {
	await expect
		.poll(
			async () => {
				const states = await page
					.locator(LOOKUP_CATALOG)
					.evaluateAll((markers) =>
						markers.map((marker) => marker.getAttribute("data-state")),
					);
				if (states.length === 0) return "no catalog marker on the page";
				return states.every((seen) => seen === state)
					? state
					: `catalog ${states.join(", ")}`;
			},
			{ message, timeout: 20_000 },
		)
		.toBe(state);
}

/** Loads a builder URL (`/build/...`) and waits for its Project data. */
export async function openBuilder(page: Page, url: string): Promise<void> {
	await page.goto(url);
	await expectBuilderDataLoaded(page);
}

/** Reloads a builder page and waits for its Project data. */
export async function reloadBuilder(page: Page): Promise<void> {
	await page.reload();
	await expectBuilderDataLoaded(page);
}

/**
 * Loads a page that holds no builder: the app list, Settings, the docs, a
 * local peer server. Takes and returns what `goto` does.
 */
export async function openPage(
	page: Page,
	url: string,
	options?: Parameters<Page["goto"]>[1],
): Promise<Response | null> {
	return await page.goto(url, options);
}

/** Reloads a page that holds no builder. */
export async function reloadPage(
	page: Page,
	options?: Parameters<Page["reload"]>[0],
): Promise<Response | null> {
	return await page.reload(options);
}
