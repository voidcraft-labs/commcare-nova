import { Pool } from "pg";
import { expect, seedFor, test } from "../../lib/appFixtures";
import { openBuilder } from "../../lib/pageLoads";

test("returning to two choices from one list submits only the replacement pair", {
	tag: "@seed:independent-form-choices",
}, async ({ scenario, page }) => {
	const { appId, people } = seedFor(scenario, "independent-form-choices");
	const [first, second, third, fourth, filtered] = people;
	const main = page.locator("main");
	await openBuilder(page, `/build/${appId}`);
	await page.getByRole("button", { name: "Preview", exact: true }).click();
	await main.getByRole("button", { name: "People", exact: true }).click();
	await main
		.getByRole("button", { name: "Visit two people", exact: true })
		.click();

	const choose = async (step: string, person: string) => {
		const list = main.getByRole("region", { name: step, exact: true });
		await expect(
			list.getByRole("heading", { name: step, exact: true }),
		).toBeVisible();
		const details = (name: string) =>
			list.getByRole("button", {
				name: new RegExp(`^View details for ${name}\\b`),
			});
		await expect(details(person)).toBeVisible();
		await expect(details(filtered)).toHaveCount(0);
		await details(person).click();
		await list.getByRole("button", { name: "Continue", exact: true }).click();
	};
	await choose("First person", first);
	await choose("Second person", second);
	const note = main.getByRole("textbox", { name: "Visit note" });
	await expect(note).toBeVisible();
	await page.goBack();
	await expect(
		main.getByRole("region", { name: "Second person" }),
	).toBeVisible();
	await page.goBack();
	await choose("First person", third);
	await choose("Second person", fourth);
	const message = "Completed the visit";
	await note.fill(message);
	await main.getByRole("button", { name: "Submit", exact: true }).click();

	const connectionString = process.env.NOVA_DB_LOCAL_URL;
	if (!connectionString)
		throw new Error("This journey needs the local smoke database.");
	const pool = new Pool({ connectionString });
	try {
		await expect
			.poll(async () => {
				const result = await pool.query(
					`SELECT case_name, properties->>'first_note' AS first, properties->>'second_note' AS second
				 FROM cases WHERE app_id = $1 AND case_type = 'person' ORDER BY case_name`,
					[appId],
				);
				return result.rows;
			})
			.toEqual(
				people.map((name) => ({
					case_name: name,
					first: name === third ? message : null,
					second: name === fourth ? message : null,
				})),
			);
	} finally {
		await pool.end();
	}
});

test("a link installs both named choices from the same list", {
	tag: "@seed:independent-form-choices",
}, async ({ scenario, page }) => {
	const { appId, people } = seedFor(scenario, "independent-form-choices");
	await openBuilder(page, `/build/${appId}`);
	await page.getByRole("button", { name: "Preview", exact: true }).click();
	const main = page.locator("main");
	await main.getByRole("button", { name: "Notes", exact: true }).click();
	await main
		.getByRole("button", { name: "Open the assigned pair", exact: true })
		.click();
	await main.getByRole("textbox", { name: "Preparation note" }).fill("Ready");
	await main.getByRole("button", { name: "Submit", exact: true }).click();
	await expect(main.getByRole("textbox", { name: "Visit note" })).toBeVisible();
	const note = "Arrived through the assigned pair";
	await main.getByRole("textbox", { name: "Visit note" }).fill(note);
	await main.getByRole("button", { name: "Submit", exact: true }).click();
	const db = process.env.NOVA_DB_LOCAL_URL;
	if (!db) throw new Error("The paired visit needs the smoke database.");
	const pool = new Pool({ connectionString: db });
	try {
		await expect
			.poll(
				async () =>
					(
						await pool.query(
							`select case_name,properties->>'first_note' as first, properties->>'second_note' as second from cases where app_id=$1 and (properties->>'first_note'=$2 or properties->>'second_note'=$2) order by case_id`,
							[appId, note],
						)
					).rows,
			)
			.toEqual([
				{ case_name: people[0], first: note, second: null },
				{ case_name: people[1], first: null, second: note },
			]);
	} finally {
		await pool.end();
	}
});

test("Back skips a single matching contact that opened without confirmation", {
	tag: "@seed:independent-form-choices",
}, async ({ scenario, page }) => {
	const { appId, people } = seedFor(scenario, "independent-form-choices");
	await openBuilder(page, `/build/${appId}`);
	await page.getByRole("button", { name: "Preview", exact: true }).click();
	const main = page.locator("main");
	await main.getByRole("button", { name: "People", exact: true }).click();
	await main
		.getByRole("button", { name: "Visit with assigned contact", exact: true })
		.click();
	const person = main.getByRole("region", {
		name: "Person to visit",
		exact: true,
	});
	await person
		.getByRole("button", {
			name: new RegExp(`^View details for ${people[1]}\\b`),
		})
		.click();
	await person.getByRole("button", { name: "Continue", exact: true }).click();
	await expect(
		main.getByRole("textbox", { name: "Quick visit note" }),
	).toBeVisible();
	await page.goBack();
	await expect(person).toBeVisible();
	await expect(
		person.getByRole("button", {
			name: new RegExp(`^View details for ${people[2]}\\b`),
		}),
	).toBeVisible();
});
