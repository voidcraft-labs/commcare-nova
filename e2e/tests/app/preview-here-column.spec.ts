import type { Locator, Page } from "@playwright/test";
import { expect, seedFor, test } from "../../lib/appFixtures";
import { HERE_COLUMN_SEED } from "../../lib/previewRuntimeSeeds";

/**
 * A case list whose calculated column is a raw `here()`. The column fills
 * from the browser's real position (Chromium's geolocation override, which
 * reaches `watchPosition`) as CommCare prints two doubles, and re-reads on
 * Android's rule: a move of a few metres leaves the list as it is, a move past
 * 30 metres from the position the list shows reads it again. The accuracy is
 * coarser than 1,600 metres, so the watch keeps running through every move.
 */

const WAITING =
	"Columns that use your location stay blank until your browser shares it.";
const REFUSED =
	"Your browser isn't sharing your location, so columns that use it stay blank. You can allow location for this site in your browser's settings.";
const ACCURACY = 2000;
/** Each position with the text CommCare prints for it: Java's
 * `Double.toString` of the latitude and of the longitude. */
const START = { latitude: 40, longitude: -74, text: "40.0 -74.0" };
/** About 10 metres north of the start. */
const SMALL_MOVE = {
	latitude: 40.00009,
	longitude: -74,
	text: "40.00009 -74.0",
};
/** About 40 metres north of the start, the position the list last showed. */
const LARGE_MOVE = {
	latitude: 40.00036,
	longitude: -74,
	text: "40.00036 -74.0",
};
const at = ({
	latitude,
	longitude,
}: {
	latitude: number;
	longitude: number;
}) => ({
	latitude,
	longitude,
	accuracy: ACCURACY,
});

declare global {
	interface Window {
		hereWatch?: {
			/** Positions the page's watch callbacks have received. */
			delivered(): number;
			/** Every text a row of the Cases list has shown. */
			shown(): string[];
			release(): void;
		};
	}
}

/**
 * Holds Chromium's own positions until the test releases them, so the note
 * a list shows before any position arrives is observable; counts the
 * positions delivered, so a move that must not re-read the list is known to
 * have reached it. The positions are the browser's, never fabricated.
 */
async function holdBrowserPositions(page: Page) {
	await page.addInitScript(() => {
		const api = navigator.geolocation;
		const native = api.watchPosition.bind(api);
		let holding = true;
		let delivered = 0;
		const held: Array<() => void> = [];
		const shown = new Set<string>();
		api.watchPosition = (success, error, options) =>
			native(
				(position) => {
					const deliver = () => {
						delivered += 1;
						success(position);
					};
					if (holding) held.push(deliver);
					else deliver();
				},
				error,
				options,
			);
		new MutationObserver(() => {
			for (const cell of document.querySelectorAll(
				'main [aria-label="Cases"] li',
			))
				shown.add(cell.textContent ?? "");
		}).observe(document, {
			subtree: true,
			childList: true,
			characterData: true,
		});
		window.hereWatch = {
			delivered: () => delivered,
			shown: () => [...shown],
			release() {
				holding = false;
				for (const deliver of held.splice(0)) deliver();
			},
		};
	});
}

async function openList(page: Page, route: string): Promise<Locator> {
	const main = page.locator("main");
	await page.goto(route);
	await expect(
		page.getByRole("button", { name: "Preview", exact: true }),
	).toBeVisible({ timeout: 20_000 });
	await page.getByRole("button", { name: "Preview", exact: true }).click();
	const row = main
		.getByRole("list", { name: "Cases", exact: true })
		.getByRole("listitem")
		.filter({ hasText: HERE_COLUMN_SEED.caseName });
	await expect(row).toBeVisible({ timeout: 20_000 });
	return row;
}

test("a here() column fills once the browser shares its position and re-reads past 30 metres", {
	tag: "@seed:here-column",
}, async ({ scenario, page, context, baseURL }) => {
	const { hereColumn } = seedFor(scenario, "here-column");
	test.setTimeout(90_000);
	await context.grantPermissions(["geolocation"], { origin: baseURL });
	await context.setGeolocation(at(START));
	await holdBrowserPositions(page);
	const main = page.locator("main");
	const note = main.locator("[data-here-location-note]");
	const row = await openList(page, hereColumn.route);

	await test.step("before a position arrives, the list says why the column is blank", async () => {
		await expect(note).toContainText(WAITING);
		const share = note.getByRole("button", {
			name: "Share your location",
			exact: true,
		});
		await expect(share).toBeVisible();
		await expect(row).not.toContainText(START.text);
		await share.click();
		await page.evaluate(() => window.hereWatch?.release());
	});

	await test.step("the shared position fills the column as two Java doubles", async () => {
		await expect(row).toContainText(START.text, { timeout: 20_000 });
		await expect(note).toHaveCount(0);
	});

	await test.step("a move of about 10 metres leaves the list as it is", async () => {
		const before = await page.evaluate(
			() => window.hereWatch?.delivered() ?? 0,
		);
		await context.setGeolocation(at(SMALL_MOVE));
		await expect
			.poll(() => page.evaluate(() => window.hereWatch?.delivered() ?? 0))
			.toBeGreaterThan(before);
		await expect(row).toContainText(START.text);
	});

	await test.step("a move of about 40 metres from the shown position reads the list again", async () => {
		await context.setGeolocation(at(LARGE_MOVE));
		await expect(row).toContainText(LARGE_MOVE.text, {
			timeout: 20_000,
		});
		const shown = await page.evaluate(() => window.hereWatch?.shown() ?? []);
		expect(shown.some((text) => text.includes(SMALL_MOVE.text))).toBe(false);
	});
});

test("a here() column stays blank and says so when the browser refuses its position", {
	tag: "@seed:here-column",
}, async ({ scenario, page, context, baseURL }) => {
	const { hereColumn } = seedFor(scenario, "here-column");
	test.setTimeout(60_000);
	// Granting nothing for the origin denies every other permission,
	// geolocation included: the browser's own refusal, not a stub.
	await context.grantPermissions([], { origin: baseURL });
	const main = page.locator("main");
	const note = main.locator("[data-here-location-note]");
	const row = await openList(page, hereColumn.route);
	await expect(note).toHaveAttribute("data-here-location-note", "refused", {
		timeout: 20_000,
	});
	await expect(note).toContainText(REFUSED);
	await expect(note.getByRole("button")).toHaveCount(0);
	await expect(row).toContainText(HERE_COLUMN_SEED.caseName);
});
