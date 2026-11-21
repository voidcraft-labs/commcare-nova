import type { Locator, Page } from "@playwright/test";
import { expect, seedFor, test } from "../../lib/appFixtures";
import { openBuilder } from "../../lib/pageLoads";
import { SORT_BY_SEED } from "../../lib/sortBySeed";

/**
 * The running case list's Sort by, as each platform offers it. The list
 * sorts by a value it hides, under the name "Feeling Sick", then by name.
 * Web Apps lists the list's shown sort fields for a list of columns, and a
 * pick of the one already picked turns it around. Android lists every named
 * field, the hidden one included, and breaks a pick's ties by the order the
 * list held before it. The case store orders the rows each time.
 */

const NAMES = SORT_BY_SEED.patients.map((patient) => patient.name);

/** The patients in the order the list shows them. */
async function listedPatients(main: Locator): Promise<string[]> {
	const texts = await main
		.getByRole("list", { name: "Cases", exact: true })
		.getByRole("listitem")
		.allTextContents();
	return texts.flatMap((text) => NAMES.filter((name) => text.includes(name)));
}

async function expectOrder(main: Locator, expected: readonly string[]) {
	await expect
		.poll(() => listedPatients(main), { timeout: 20_000 })
		.toEqual([...expected]);
}

async function pick(page: Page, main: Locator, name: RegExp) {
	await main.getByRole("button", { name: "Sort by", exact: true }).click();
	const item = page.getByRole("menuitem", { name });
	await expect(item).toBeVisible();
	await item.click();
}

test("the case list's Sort by orders the list as Web Apps and Android do", {
	tag: "@seed:sort-by",
}, async ({ scenario, page }) => {
	const { sortBy } = seedFor(scenario, "sort-by");
	test.setTimeout(120_000);
	const main = page.locator("main");
	const identity = page.getByRole("button", { name: /^Running as / });

	await test.step("Web Apps opens on the list's own order and offers the shown sort field", async () => {
		await openBuilder(page, sortBy.route);
		await page.getByRole("button", { name: "Preview", exact: true }).click();
		await expect(identity).toHaveAccessibleName(/ in Web Apps\. /, {
			timeout: 20_000,
		});
		await expectOrder(main, ["Ben Osei", "Ada Okafor", "Cy Mensah"]);
		await main.getByRole("button", { name: "Sort by", exact: true }).click();
		await expect(page.getByRole("menuitem")).toHaveCount(1);
		await page.getByRole("menuitem", { name: /^Name/ }).click();
	});

	await test.step("a pick orders by name, and a second pick turns it around", async () => {
		await expectOrder(main, ["Ada Okafor", "Ben Osei", "Cy Mensah"]);
		await pick(page, main, /^Name, sorted down/);
		await expectOrder(main, ["Cy Mensah", "Ben Osei", "Ada Okafor"]);
	});

	await test.step("typing in the filter lets the pick go on Web Apps", async () => {
		const filter = main.getByRole("textbox", { name: "Filter results" });
		await filter.fill("o");
		await expectOrder(main, ["Ben Osei", "Ada Okafor", "Cy Mensah"]);
		await filter.fill("");
	});

	await test.step("Android lists every named field, the hidden one under its name", async () => {
		await identity.click();
		await page.getByRole("menuitemradio", { name: /^Android/ }).click();
		await expect(identity).toHaveAccessibleName(/ on Android\. /);
		await main.getByRole("button", { name: "Start", exact: true }).click();
		await main
			.getByRole("button", {
				name: new RegExp(`^${SORT_BY_SEED.moduleName}`),
			})
			.click();
		await expectOrder(main, ["Ben Osei", "Ada Okafor", "Cy Mensah"]);
		await main.getByRole("button", { name: "Sort by", exact: true }).click();
		await expect(page.getByRole("menuitem")).toHaveCount(3);
		await expect(
			page.getByRole("menuitem", { name: "Name, sort 2, sorted up" }),
		).toBeVisible();
		await expect(
			page.getByRole("menuitem", { name: "Village", exact: true }),
		).toBeVisible();
		await expect(
			page.getByRole("menuitem", {
				name: `${SORT_BY_SEED.sortName}, sort 1, sorted down`,
			}),
		).toBeVisible();
		await page.getByRole("menuitem", { name: "Village", exact: true }).click();
	});

	await test.step("a pick on Android keeps the order before it for its ties", async () => {
		await expectOrder(main, ["Cy Mensah", "Ada Okafor", "Ben Osei"]);
		// Feeling Sick puts Ben first; Ada and Cy tie, and stay in the
		// village order the list held.
		await pick(page, main, new RegExp(`^${SORT_BY_SEED.sortName}`));
		await expectOrder(main, ["Ben Osei", "Cy Mensah", "Ada Okafor"]);
	});
});

/**
 * A form's submission that lands on the list starts it afresh, as both
 * platforms do: Web Apps opens the list's own address again, and Android
 * shows a new list. The Sort by pick goes with it, so the list shows its own
 * order (`lib/preview/caseListReturn.ts`, a forward return).
 */
test("a form's submission that lands on the list shows the list in its own order again", {
	tag: "@seed:sort-by",
}, async ({ scenario, page }) => {
	const { sortBy } = seedFor(scenario, "sort-by");
	test.setTimeout(120_000);
	const main = page.locator("main");
	const identity = page.getByRole("button", { name: /^Running as / });
	const ownOrder = ["Ben Osei", "Ada Okafor", "Cy Mensah"];

	/** The patient's visit opened from the list through their details, and
	 *  sent by its button: Submit in Web Apps, Finish on Android. */
	async function submitVisitFor(name: string, send: "Submit" | "Finish") {
		const submit = main.getByRole("button", { name: send, exact: true });
		await main
			.getByRole("button", { name: new RegExp(`^View details for ${name}`) })
			.click();
		await main.getByRole("button", { name: "Continue", exact: true }).click();
		await main.getByRole("button", { name: "Visit", exact: true }).click();
		await expect(submit).toBeEnabled({ timeout: 20_000 });
		await submit.click();
		await expect(submit).toHaveCount(0, { timeout: 20_000 });
	}

	await test.step("Web Apps: a pick by name, then a visit submitted, lands on the list in its own order", async () => {
		await openBuilder(page, sortBy.route);
		await page.getByRole("button", { name: "Preview", exact: true }).click();
		await expect(identity).toHaveAccessibleName(/ in Web Apps\. /, {
			timeout: 20_000,
		});
		await expectOrder(main, ownOrder);
		await pick(page, main, /^Name/);
		await expectOrder(main, ["Ada Okafor", "Ben Osei", "Cy Mensah"]);
		await submitVisitFor("Cy Mensah", "Submit");
		await expectOrder(main, ownOrder);
	});

	await test.step("Android: a pick by village, then a visit submitted, lands on the list in its own order", async () => {
		await identity.click();
		await page.getByRole("menuitemradio", { name: /^Android/ }).click();
		await expect(identity).toHaveAccessibleName(/ on Android\. /);
		await main.getByRole("button", { name: "Start", exact: true }).click();
		await main
			.getByRole("button", {
				name: new RegExp(`^${SORT_BY_SEED.moduleName}`),
			})
			.click();
		await expectOrder(main, ownOrder);
		await pick(page, main, /^Village/);
		await expectOrder(main, ["Cy Mensah", "Ada Okafor", "Ben Osei"]);
		await submitVisitFor("Ada Okafor", "Finish");
		await expectOrder(main, ownOrder);
	});
});
