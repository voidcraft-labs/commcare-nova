import { componentPeer } from "../lib/componentPeer";
import { expect, test } from "../lib/fixtures";

let peer: Awaited<ReturnType<typeof componentPeer>>;
test.beforeAll(async () => {
	peer = await componentPeer("e2e/lib/case-workspace-client.tsx");
});
test.afterAll(async () => {
	await peer?.close();
});

test("column display confirmation cancels with native focus, then restores its draft with the latest label", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=date`);
	const trigger = page.getByRole("button", {
		name: "Display as: Date",
		exact: true,
	});
	await trigger.click();
	await page.getByRole("menuitem", { name: /^Text Show/ }).click();
	const dialog = page.getByRole("alertdialog");
	await expect(dialog).toContainText("The custom date format will be removed");
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect(trigger).toBeFocused();
	await expect(page.getByLabel("Saved column")).toContainText(
		'"pattern":"%d-%m-%Y"',
	);
	await trigger.click();
	await page.getByRole("menuitem", { name: /^Text Show/ }).click();
	await page
		.getByRole("button", { name: "Change display", exact: true })
		.click();
	await expect(page.getByLabel("Saved column")).toContainText('"kind":"plain"');
	await page.getByRole("button", { name: "Peer changes label" }).click();
	await page
		.getByRole("button", { name: "Display as: Text", exact: true })
		.click();
	await page.getByRole("menuitem", { name: /^Date Make/ }).click();
	await expect(page.getByLabel("Saved column")).toContainText(
		'"pattern":"%d-%m-%Y"',
	);
	await expect(page.getByLabel("Saved column")).toContainText(
		'"header":"Renamed by peer"',
	);
});

test("a native threshold blur preserves invalid drafts and commits corrected values and units", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=interval`);
	const input = page.getByRole("spinbutton", { name: "Overdue after" });
	for (const invalid of ["", "1.5", "0", "-2"]) {
		await input.fill(invalid);
		await page.getByRole("button", { name: "Leave inspector" }).click();
		await expect(input).toHaveValue(invalid);
		await expect(input).toHaveAttribute("aria-invalid", "true");
		const error = page.getByRole("alert");
		await expect(error).toHaveText("Enter a whole number greater than 0");
		await expect(input).toHaveAttribute(
			"aria-describedby",
			(await error.getAttribute("id")) ?? "",
		);
		await expect(page.getByLabel("Saved column")).toContainText(
			'"threshold":7',
		);
	}
	await input.fill("2");
	await expect(input).not.toHaveAttribute("aria-invalid", "true");
	await input.press("Tab");
	await expect(page.getByLabel("Saved column")).toContainText('"threshold":2');
	await page.getByRole("combobox", { name: "Unit", exact: true }).click();
	await page.getByRole("option", { name: "Weeks", exact: true }).click();
	await expect(page.getByLabel("Saved column")).toContainText('"unit":"weeks"');
});

for (const search of [false, true]) {
	test(`calculated column checks parent-value wrapping when Search is ${search ? "enabled" : "absent"}`, async ({
		page,
	}) => {
		await page.goto(
			`${peer.origin}/?scenario=${search ? "calculated-search" : "calculated"}`,
		);
		await page
			.getByRole("button", {
				name: "Value source: Other case information",
				exact: true,
			})
			.click();
		const choice = page.getByRole("menuitem", { name: /^Read as a number/ });
		if (search) {
			await expect(choice).toBeDisabled();
			await expect(choice).toContainText(
				"Search can show one parent property by itself",
			);
		} else {
			await expect(choice).toBeEnabled();
			await choice.click();
			await expect(page.getByLabel("Saved column")).toContainText(
				'"kind":"double"',
			);
		}
	});
}

test("column display restoration rechecks a retained calculation after Search is enabled", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=retained-calculation`);
	await page
		.getByRole("button", { name: "Display as: Calculated", exact: true })
		.click();
	await page.getByRole("menuitem", { name: /^Text Show/ }).click();
	await page
		.getByRole("button", { name: "Change display", exact: true })
		.click();
	await expect(page.getByLabel("Saved column")).toContainText('"kind":"plain"');
	await page.getByRole("button", { name: "Peer enables Search" }).click();
	await expect(page.getByLabel("Search enabled")).toHaveText("true");
	await page
		.getByRole("button", { name: "Display as: Text", exact: true })
		.click();
	await page.getByRole("menuitem", { name: /^Calculated Build/ }).click();
	await page
		.getByRole("button", { name: "Change display", exact: true })
		.click();
	await expect(page.getByLabel("Saved column")).toContainText(
		'"expression":{"kind":"term","term":{"kind":"literal","value":""}}',
	);
});

test("display choices for text information disable incompatible date formats in a native menu", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=text`);
	await page
		.getByRole("button", { name: "Display as: Text", exact: true })
		.click();
	for (const name of [/^Date Choose/, /^Time since Choose/])
		await expect(page.getByRole("menuitem", { name })).toBeDisabled();
	await expect(
		page.getByRole("menuitem", { name: /^Phone number/ }),
	).toBeEnabled();
	await page.keyboard.press("Escape");
	await expect(
		page.getByRole("button", { name: "Display as: Text", exact: true }),
	).toBeFocused();
});

for (const scenario of [
	"text",
	"date",
	"phone",
	"link",
	"mapping",
	"image-map",
	"interval",
	"calculated",
]) {
	test(`native ${scenario} card label edits commit while preserving every other column slot`, async ({
		page,
	}) => {
		await page.goto(`${peer.origin}/?scenario=${scenario}`);
		const saved = page.getByLabel("Saved column");
		const before = JSON.parse(await saved.innerText());
		await page
			.getByRole("textbox", { name: "Display label", exact: true })
			.fill("Updated label");
		await page.getByRole("button", { name: "Leave inspector" }).click();
		await expect
			.poll(async () => JSON.parse(await saved.innerText()))
			.toEqual({ ...before, header: "Updated label" });
	});
}

test("native date presets and custom patterns commit through the column owner", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=date`);
	await page.getByRole("button", { name: "Short", exact: true }).click();
	await expect(page.getByLabel("Saved column")).toContainText(
		'"pattern":"%m/%d/%Y"',
	);
	await page.getByRole("button", { name: "Custom", exact: true }).click();
	const pattern = page.getByRole("textbox", {
		name: "Custom date style",
		exact: true,
	});
	await pattern.fill("%Y-%m");
	await pattern.press("Tab");
	await expect(pattern).toHaveValue("%Y-%m");
	await page.getByRole("button", { name: "Leave inspector" }).click();
	await expect(page.getByLabel("Saved column")).toContainText(
		'"pattern":"%Y-%m"',
	);
});

test("native interval display and text edits preserve the threshold and property", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=interval-always`);
	await expect(
		page.getByText("Replaces the interval after it becomes overdue"),
	).toBeVisible();
	await page
		.getByRole("textbox", { name: "Text when overdue", exact: true })
		.fill("Aged out");
	await page.getByRole("button", { name: "Leave inspector" }).click();
	await expect(page.getByLabel("Saved column")).toContainText(
		'"text":"Aged out"',
	);
	await page
		.getByRole("button", { name: "Only when overdue", exact: true })
		.click();
	const flag = page.getByRole("textbox", { name: "Flag text", exact: true });
	await flag.fill("OVERDUE");
	await flag.press("Tab");
	await expect(page.getByLabel("Saved column")).toContainText(
		'"display":"flag"',
	);
	await expect(page.getByLabel("Saved column")).toContainText('"threshold":7');
	await expect(page.getByLabel("Saved column")).toContainText(
		'"text":"OVERDUE"',
	);
});

test("native link text refuses a blank label and commits replacement wording", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=link`);
	const text = page.getByRole("textbox", { name: "Link text", exact: true });
	await text.fill(" ");
	await page.getByRole("button", { name: "Leave inspector" }).click();
	await expect(text).toHaveValue("Open");
	await expect(page.getByLabel("Saved column")).toContainText(
		'"linkText":"Open"',
	);
	await text.fill("See the address");
	await text.press("Tab");
	await expect(page.getByLabel("Saved column")).toContainText(
		'"linkText":"See the address"',
	);
});

test("native mapping drafts reject invalid values, commit complete rows, and retain row identity on Enter", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=mapping`);
	const saved = page.getByLabel("Saved column");
	const before = await saved.innerText();
	await page.getByRole("button", { name: "Add value", exact: true }).click();
	const pending = page.getByRole("textbox", {
		name: "Value 3 saved value",
		exact: true,
	});
	const save = page.getByRole("button", { name: "Save value", exact: true });
	for (const invalid of ["", "not active", "active"]) {
		await pending.fill(invalid);
		await expect(save).toBeDisabled();
		await expect(saved).toHaveText(before);
	}
	await pending.fill("waiting");
	await page
		.getByRole("textbox", { name: "Value 3 display label", exact: true })
		.fill("Waiting");
	await expect(saved).toHaveText(before);
	await save.click();
	await expect
		.poll(async () => JSON.parse(await saved.innerText()).mapping)
		.toContainEqual({ value: "waiting", label: "Waiting" });
	const first = page.getByRole("textbox", {
		name: "Value 1 saved value",
		exact: true,
	});
	const handle = await first.elementHandle();
	await first.fill("registered");
	await first.press("Enter");
	await expect(first).toBeFocused();
	expect(
		await first.evaluate((element, previous) => element === previous, handle),
	).toBe(true);
	await expect
		.poll(async () => JSON.parse(await saved.innerText()).mapping)
		.toContainEqual({ value: "registered", label: "Active" });
	for (const invalid of ["", "not active", "inactive"]) {
		await first.fill(invalid);
		await page.getByRole("button", { name: "Leave inspector" }).click();
		await expect
			.poll(async () => JSON.parse(await saved.innerText()).mapping)
			.toContainEqual({ value: "registered", label: "Active" });
		await expect(
			page.getByText(
				/Enter a saved value\.|Saved values cannot contain spaces\.|That saved value already has a label\./,
			),
		).toBeVisible();
	}
	await first.fill("ready");
	await first.press("Enter");
	await expect
		.poll(async () => JSON.parse(await saved.innerText()).mapping)
		.toContainEqual({ value: "ready", label: "Active" });
});

test("native mapping reorder carries row DOM and removal moves focus to surviving controls", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=mapping`);
	const first = page.getByRole("textbox", {
		name: "Value 1 saved value",
		exact: true,
	});
	const second = page.getByRole("textbox", {
		name: "Value 2 saved value",
		exact: true,
	});
	const firstNode = await first.elementHandle(),
		secondNode = await second.elementHandle();
	await expect(
		page.getByRole("button", { name: "Move value 1 earlier", exact: true }),
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Move value 2 later", exact: true }),
	).toBeDisabled();
	await page
		.getByRole("button", { name: "Move value 1 later", exact: true })
		.click();
	await expect(first).toHaveValue("inactive");
	expect(
		await first.evaluate((node, previous) => node === previous, secondNode),
	).toBe(true);
	expect(
		await second.evaluate((node, previous) => node === previous, firstNode),
	).toBe(true);
	await page
		.getByRole("button", { name: "Move value 2 earlier", exact: true })
		.click();
	await expect(first).toHaveValue("active");
	await page
		.getByRole("button", { name: "Remove value 2", exact: true })
		.click();
	await expect(first).toBeFocused();
	await page
		.getByRole("button", { name: "Remove value 1", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Add value", exact: true }),
	).toBeFocused();
	await expect(page.getByLabel("Saved column")).toContainText('"mapping":[]');
});

test("native malformed-value guidance opens from keyboard and a touch target", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=malformed-cell`);
	const trigger = page.getByRole("button", {
		name: "not-a-date. More information",
	});
	await page.keyboard.press("Tab");
	await expect(trigger).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(
		page.getByText("Showing the original value because it isn't a valid date"),
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(trigger).toBeFocused();
	const bounds = await trigger.boundingBox();
	expect(bounds?.width).toBeGreaterThanOrEqual(44);
	expect(bounds?.height).toBeGreaterThanOrEqual(44);
	await trigger.click();
	await expect(
		page.getByRole("heading", { name: "Why this value is shown" }),
	).toBeVisible();
});

test("native image mapping stages a value until an actual library selection and preserves identity through edits", async ({
	page,
}) => {
	const firstId = "00000000-0000-7000-8000-000000005001",
		secondId = "00000000-0000-7000-8000-000000005002";
	const requests: string[] = [];
	await page.route("**/api/media/library?*", async (route) => {
		const url = new URL(route.request().url());
		requests.push(url.search);
		expect(url.searchParams.get("appId")).toBe("native-case-column");
		await route.fulfill({
			json: {
				assets: [firstId, secondId].map((id, index) => ({
					id,
					contentHash: "a".repeat(64),
					mimeType: "image/png",
					kind: "image",
					extension: "png",
					sizeBytes: 68,
					dimensions: { width: 1, height: 1 },
					originalFilename: index === 0 ? "alert.png" : "followup.png",
					status: "ready",
					createdAt: "2026-07-17T00:00:00.000Z",
				})),
				nextCursor: null,
			},
		});
	});
	await page.route("**/api/media/*?scope=*", async (route) => {
		await route.fulfill({
			contentType: "image/png",
			body: Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1YQAAAAASUVORK5CYII=",
				"base64",
			),
		});
	});
	await page.goto(`${peer.origin}/?scenario=image-map`);
	const saved = page.getByLabel("Saved column");
	await page.getByRole("button", { name: "Add value", exact: true }).click();
	const pending = page.getByRole("textbox", {
		name: "Value 1 saved value",
		exact: true,
	});
	for (const invalid of ["", "not active"]) {
		await pending.fill(invalid);
		await expect(
			page.getByRole("button", { name: "Attach", exact: true }),
		).toHaveCount(0);
	}
	await pending.fill("active");
	await expect(saved).toContainText('"mapping":[]');
	await page.getByRole("button", { name: "Attach", exact: true }).click();
	await page.getByRole("tab", { name: "Library", exact: true }).click();
	await page
		.getByRole("button", { name: "Choose alert.png", exact: true })
		.click();
	await expect
		.poll(async () => JSON.parse(await saved.innerText()).mapping)
		.toEqual([{ value: "active", assetId: firstId }]);
	const input = page.getByRole("textbox", {
		name: "Value 1 saved value",
		exact: true,
	});
	const node = await input.elementHandle();
	await input.fill("registered");
	await input.press("Enter");
	await expect(input).toBeFocused();
	expect(
		await input.evaluate((element, original) => element === original, node),
	).toBe(true);

	await page.getByRole("button", { name: "Add value", exact: true }).click();
	const pendingSecond = page.getByRole("textbox", {
		name: "Value 2 saved value",
		exact: true,
	});
	await pendingSecond.fill("registered");
	await expect(
		page.getByRole("group", { name: "Value 2 image", exact: true }),
	).toHaveCount(0);
	await pendingSecond.fill("waiting");
	await page.getByRole("button", { name: "Attach", exact: true }).click();
	await page.getByRole("tab", { name: "Library", exact: true }).click();
	await page
		.getByRole("button", { name: "Choose alert.png", exact: true })
		.click();
	const firstGroup = page.getByRole("group", {
		name: "Value 1 image",
		exact: true,
	});
	const secondGroup = page.getByRole("group", {
		name: "Value 2 image",
		exact: true,
	});
	const firstGroupNode = await firstGroup.elementHandle();
	const secondGroupNode = await secondGroup.elementHandle();
	await page
		.getByRole("button", { name: "Move value 1 later", exact: true })
		.click();
	expect(
		await secondGroup.evaluate(
			(element, original) => element === original,
			firstGroupNode,
		),
	).toBe(true);
	expect(
		await firstGroup.evaluate(
			(element, original) => element === original,
			secondGroupNode,
		),
	).toBe(true);
	await page
		.getByRole("button", { name: "Move value 2 earlier", exact: true })
		.click();
	const replace = firstGroup.getByRole("button", {
		name: "Replace image",
		exact: true,
	});
	const replaceNode = await replace.elementHandle();
	await replace.click();

	await page.getByRole("tab", { name: "Library", exact: true }).click();
	await page
		.getByRole("button", { name: "Choose followup.png", exact: true })
		.click();
	await expect
		.poll(async () => JSON.parse(await saved.innerText()).mapping)
		.toEqual([
			{ value: "registered", assetId: secondId },
			{ value: "waiting", assetId: firstId },
		]);
	await expect(replace).toBeFocused();
	expect(
		await replace.evaluate(
			(element, original) => element === original,
			replaceNode,
		),
	).toBe(true);
	await secondGroup
		.getByRole("button", { name: "Remove image", exact: true })
		.click();
	await firstGroup
		.getByRole("button", { name: "Remove image", exact: true })
		.click();
	await expect(saved).toContainText('"mapping":[]');
	await expect(
		page.getByRole("button", { name: "Add value", exact: true }),
	).toBeFocused();
	expect(requests.length).toBeGreaterThanOrEqual(2);
});

test("native column information chooser resolves inherited and duplicate labels without losing identity", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=property-labels`);
	const label = page.getByRole("textbox", {
		name: "Display label",
		exact: true,
	});
	await expect(label).toHaveValue("Name");
	await page
		.getByRole("button", { name: "Information from: Name", exact: true })
		.click();
	const search = page.getByRole("searchbox", {
		name: "Search information",
		exact: true,
	});
	await expect(search).toBeFocused();
	await search.fill("Score");
	await expect(
		page.getByRole("menuitem", {
			name: "Score Local score · Text",
			exact: true,
		}),
	).toBeVisible();
	await page
		.getByRole("menuitem", {
			name: "Score Household score · Text",
			exact: true,
		})
		.click();
	await expect(page.getByLabel("Saved column")).toContainText(
		'"field":"household_score"',
	);
	await expect(label).toHaveValue("Score");
	await page
		.getByRole("button", {
			name: "Information from: Score, Household score",
			exact: true,
		})
		.click();
	await page
		.getByRole("searchbox", { name: "Search information", exact: true })
		.fill("Risk");
	await expect(
		page.getByRole("menuitem", {
			name: "Risk First field · Text",
			exact: true,
		}),
	).toBeVisible();
	await page
		.getByRole("menuitem", { name: "Risk Second field · Text", exact: true })
		.click();
	await expect(page.getByLabel("Saved column")).toContainText(
		'"field":"risk-level"',
	);
	await page
		.getByRole("button", {
			name: "Information from: Risk, Second field",
			exact: true,
		})
		.click();
	await expect(
		page.getByRole("menuitem", { name: "External ID Text", exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("menuitem", { name: "Date opened Date", exact: true }),
	).toBeVisible();
	await page.keyboard.press("Escape");
});

test("native column selection cannot restore another column's retained display draft", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=column-identity`);
	await page
		.getByRole("button", { name: "Display as: Date", exact: true })
		.click();
	await page.getByRole("menuitem", { name: /^Text Show/ }).click();
	await page
		.getByRole("button", { name: "Change display", exact: true })
		.click();
	await page
		.getByRole("button", { name: "Open other column", exact: true })
		.click();
	await expect(
		page.getByRole("textbox", { name: "Display label", exact: true }),
	).toHaveValue("Other birthday");
	await page
		.getByRole("button", { name: "Display as: Text", exact: true })
		.click();
	await page.getByRole("menuitem", { name: /^Date Make/ }).click();
	await expect(page.getByLabel("Saved column")).toContainText(
		'"pattern":"%Y-%m-%d"',
	);
});
