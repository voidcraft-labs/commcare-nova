import { resolve } from "node:path";
import type { Page, Route } from "@playwright/test";
import { testUuid } from "@/__tests__/helpers/uuid";
import type {} from "../../lib/builder-users-readiness-client";
import { componentPeer } from "../../lib/componentPeer";
import { expect, test } from "../../lib/fixtures";

test.use({ actionTimeout: 10_000 });

const catalogResponse = {
	success: true,
	value: {
		projectId: "native-users-project",
		projectRevision: "0",
		definitions: [],
	},
};
async function mount(page: Page) {
	const boundary = resolve("e2e/lib/builder-users-readiness-boundary.ts");
	const peer = await componentPeer(
		"e2e/lib/builder-users-readiness-client.tsx",
		[],
		{
			"@/lib/lookup/actions": boundary,
			"@/lib/organization/actions": boundary,
			"@/lib/preview/engine/caseDataBinding": boundary,
		},
	);
	await page.route("**/native/users/organization", (route) =>
		route.fulfill({
			json: {
				success: true,
				data: {
					revision: "0",
					locations: ["north", "south", "west"].map((name, index) => ({
						id: testUuid(`users-place-${name}`),
						levelUuid: testUuid("users-clinic-level"),
						parentId: null,
						siteCode: name,
						name,
						externalId: null,
						latitude: null,
						longitude: null,
						values: {},
						archivedAt: null,
						orderKey: `a${index}`,
					})),
				},
			},
		}),
	);
	await page.route("**/native/users/count", (route) =>
		route.fulfill({ json: { kind: "count", count: 0 } }),
	);
	return peer;
}
async function close(
	page: Page,
	peer: Awaited<ReturnType<typeof componentPeer>>,
) {
	try {
		await page.evaluate(() => window.disposeUsersReadiness?.());
	} finally {
		try {
			await page.close();
		} finally {
			await peer.close();
		}
	}
}

test("Users authoring keeps collection adds and existing row edits disabled until the real catalog read completes", async ({
	page,
}) => {
	const peer = await mount(page);
	let held: Route | undefined;
	let released = false;
	await page.route("**/native/users/catalog", (route) => {
		held = route;
	});
	try {
		await page.goto(peer.origin);
		await expect.poll(() => held !== undefined).toBe(true);
		await expect(
			page.locator('[data-builder-resource="lookup-catalog"]'),
		).toHaveAttribute("data-state", "loading");
		const before = await page.evaluate(() => window.usersReadiness?.snapshot());
		const users = page.getByRole("region", {
			name: "Users and personas",
			exact: true,
		});
		const personas = users.getByRole("region", {
			name: "Personas",
			exact: true,
		});
		const add = personas.getByRole("button", {
			name: "Add persona",
			exact: true,
		});
		await expect(add).toBeDisabled();
		for (const name of ["Add worker information", "Add role"])
			await expect(
				users.getByRole("button", { name, exact: true }),
			).toBeDisabled();
		await personas
			.getByRole("button", { name: "Asha Nurse", exact: true })
			.click();
		await expect(personas.getByLabel("Name", { exact: true })).toBeDisabled();
		await expect(
			personas.getByRole("combobox", { name: "Role", exact: true }),
		).toBeDisabled();
		await expect(
			personas.getByRole("button", { name: "Remove persona", exact: true }),
		).toBeDisabled();
		await expect(
			personas.getByRole("button", { name: "Make main", exact: true }),
		).toBeDisabled();
		await expect(
			personas.getByRole("combobox", { name: "Add a place", exact: true }),
		).toBeDisabled();
		const information = users.getByRole("region", {
			name: "Worker information",
			exact: true,
		});
		await information.getByRole("button", { name: /^District/ }).click();
		await expect(information.getByRole("textbox")).toHaveCount(3);
		for (const control of await information.getByRole("textbox").all())
			await expect(control).toBeDisabled();
		await expect(information.getByRole("switch")).toBeDisabled();
		const roles = users.getByRole("region", { name: "Roles", exact: true });
		await roles.getByRole("button", { name: /^Nurse/ }).click();
		await expect(roles.getByRole("textbox")).toHaveCount(3);
		for (const control of await roles.getByRole("textbox").all())
			await expect(control).toBeDisabled();
		await users
			.getByRole("button", {
				name: "Show built-in worker information",
				exact: true,
			})
			.click();
		await expect(
			users.getByRole("button", {
				name: "Hide built-in worker information",
				exact: true,
			}),
		).toBeVisible();
		expect(
			await page.evaluate(() => window.usersReadiness?.snapshot()),
		).toEqual(before);
		const request = held;
		if (!request) throw new Error("Missing catalog read");
		expect(request.request().postDataJSON()).toEqual(["native-users-project"]);
		await request.fulfill({ json: catalogResponse });
		released = true;
		await expect(
			page.locator('[data-builder-resource="lookup-catalog"]'),
		).toHaveAttribute("data-state", "ready");
		await expect(add).toBeEnabled();
		await add.click();
		await expect(
			personas.getByLabel("Name", { exact: true }).last(),
		).toBeFocused();
		await expect
			.poll(
				async () =>
					Object.keys(
						(await page.evaluate(() => window.usersReadiness?.snapshot()))
							?.personas ?? {},
					).length,
			)
			.toBe(2);
	} finally {
		try {
			if (held && !released) await held.abort();
		} finally {
			await close(page, peer);
		}
	}
});

test("Users authoring keeps an unfinished role draft and a cancelable removal through failed catalog refresh and retry", async ({
	page,
}) => {
	const peer = await mount(page);
	let requests = 0;
	let held: Route | undefined;
	let refresh: Promise<void> | undefined;
	let released = false;
	await page.route("**/native/users/catalog", async (route) => {
		requests += 1;
		if (requests === 2) {
			held = route;
			return;
		}
		await route.fulfill({ json: catalogResponse });
	});
	try {
		await page.goto(peer.origin);
		const resource = page.locator('[data-builder-resource="lookup-catalog"]');
		await expect(resource).toHaveAttribute("data-state", "ready");
		const users = page.getByRole("region", {
			name: "Users and personas",
			exact: true,
		});
		const personas = users.getByRole("region", {
			name: "Personas",
			exact: true,
		});
		await personas
			.getByRole("button", { name: "Asha Nurse", exact: true })
			.click();
		await personas
			.getByRole("button", { name: "Remove persona", exact: true })
			.click();
		const remove = personas.getByRole("button", {
			name: "Remove",
			exact: true,
		});
		await expect(remove).toBeEnabled();
		const roles = users.getByRole("region", { name: "Roles", exact: true });
		await roles.getByRole("button", { name: /^Nurse/ }).click();
		const name = roles.getByLabel("Name", { exact: true });
		await name.fill("District nurse draft");
		const before = await page.evaluate(() => window.usersReadiness?.snapshot());
		refresh = page.evaluate(async () => {
			await window.usersReadiness?.refresh();
		});
		await expect.poll(() => held !== undefined).toBe(true);
		await expect(resource).toHaveAttribute("data-state", "loading");
		await expect(name).toBeDisabled();
		await expect(name).toHaveValue("District nurse draft");
		await expect(remove).toBeDisabled();
		await expect(
			personas.getByRole("button", { name: "Cancel", exact: true }),
		).toBeEnabled();
		const request = held;
		if (!request) throw new Error("Missing refresh request");
		await request.fulfill({
			json: {
				success: false,
				code: "internal_error",
				message: "Definitions unavailable",
			},
		});
		released = true;
		await refresh;
		await expect(resource).toHaveAttribute("data-state", "error");
		await expect(name).toHaveValue("District nurse draft");
		await expect(name).toBeDisabled();
		expect(
			await page.evaluate(() => window.usersReadiness?.snapshot()),
		).toEqual(before);
		await personas.getByRole("button", { name: "Cancel", exact: true }).click();
		await expect(
			personas.getByRole("button", { name: "Remove persona", exact: true }),
		).toBeDisabled();
		await users
			.getByRole("alert")
			.getByRole("button", { name: "Try again", exact: true })
			.click();
		await expect(resource).toHaveAttribute("data-state", "ready");
		expect(requests).toBe(3);
		await expect(name).toBeEnabled();
		await expect(name).toHaveValue("District nurse draft");
		await name.press("Enter");
		await expect
			.poll(async () =>
				Object.values(
					(await page.evaluate(() => window.usersReadiness?.snapshot()))
						?.userTypes ?? {},
				).map((role) => role.name),
			)
			.toEqual(["District nurse draft"]);
	} finally {
		try {
			if (held && !released) await held.abort();
			if (refresh) await refresh;
		} finally {
			await close(page, peer);
		}
	}
});

test("Users authoring leaves viewer disclosures readable while the catalog loads", async ({
	page,
}) => {
	const peer = await mount(page);
	let held: Route | undefined;
	await page.route("**/native/users/catalog", (route) => {
		held = route;
	});
	try {
		await page.goto(`${peer.origin}/?viewer=1`);
		await expect.poll(() => held !== undefined).toBe(true);
		const users = page.getByRole("region", {
			name: "Users and personas",
			exact: true,
		});
		await users
			.getByRole("button", { name: "Asha Nurse", exact: true })
			.click();
		const personaName = users
			.getByRole("region", { name: "Personas", exact: true })
			.getByLabel("Name", { exact: true });
		await expect(personaName).toHaveValue("Asha");
		await expect(personaName).toBeDisabled();
		for (const name of [
			"Add persona",
			"Add role",
			"Add worker information",
			"Remove persona",
		])
			await expect(
				users.getByRole("button", { name, exact: true }),
			).toHaveCount(0);
		await users
			.getByRole("button", {
				name: "Show built-in worker information",
				exact: true,
			})
			.click();
		await expect(
			users.getByRole("button", {
				name: "Hide built-in worker information",
				exact: true,
			}),
		).toBeVisible();
	} finally {
		try {
			if (held) await held.abort();
		} finally {
			await close(page, peer);
		}
	}
});
