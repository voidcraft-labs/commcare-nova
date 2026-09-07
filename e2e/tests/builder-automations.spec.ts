import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { componentPeer } from "../lib/componentPeer";
import { expect, test } from "../lib/fixtures";

let peer: Awaited<ReturnType<typeof componentPeer>>;
test.use({ actionTimeout: 10_000 });
test.beforeAll(async () => {
	peer = await componentPeer("e2e/lib/builder-automations-client.tsx", [], {
		"@/lib/organization/actions": resolve(
			"e2e/lib/builder-automations-boundary.ts",
		),
		"@/lib/automations/actions": resolve(
			"e2e/lib/builder-automations-boundary.ts",
		),
	});
});
test.afterAll(async () => {
	await peer?.close();
});
async function open(page: Page, viewer = false) {
	await page.route("**/automation-organization", (route) =>
		route.fulfill({
			json: { success: true, data: { revision: "1", locations: [] } },
		}),
	);
	await page.goto(`${peer.origin}/?viewer=${viewer}`);
	await expect(
		page.getByRole("heading", { name: "Automations", exact: true }),
	).toBeAttached();
}
async function choose(page: Page, label: string, option: string) {
	await page.getByRole("combobox", { name: label, exact: true }).click();
	await page.getByRole("option", { name: option, exact: true }).click();
}
async function edit(page: Page, name: string) {
	await page.getByRole("button", { name: new RegExp(name) }).click();
	await page
		.getByRole("button", { name: "Edit automation", exact: true })
		.click();
	await expect(
		page.getByRole("textbox", { name: "Name", exact: true }),
	).toBeFocused();
}

test("native automation creation keeps refused drafts local, saves through the real gate, and restores removal focus", async ({
	page,
}) => {
	await page.setViewportSize({ width: 420, height: 850 });
	await open(page);
	const saved = page.getByLabel("Saved automations");
	const before = await saved.innerText();
	await page
		.getByRole("button", { name: "Add automation", exact: true })
		.click();
	const dialog = page.getByRole("dialog");
	const name = dialog.getByRole("textbox", { name: "Name", exact: true });
	await expect(name).toBeFocused();
	await name.fill("");
	await dialog
		.getByRole("button", { name: "Save automation", exact: true })
		.click();
	await expect(dialog.getByRole("alert")).toBeVisible();
	await expect(name).toHaveAttribute("aria-invalid", "true");
	await expect(saved).toHaveText(before);
	await name.fill("New follow-up");
	await choose(page, "Automation type", "Conditional alert");
	await expect(name).toHaveValue("New follow-up");
	await choose(page, "Automation type", "Automatic case update");
	const box = await dialog.evaluate((element) => ({
		width: element.clientWidth,
		scroll: element.scrollWidth,
		left: element.getBoundingClientRect().left,
		right: element.getBoundingClientRect().right,
	}));
	expect(box.left).toBeGreaterThanOrEqual(0);
	expect(box.right).toBeLessThanOrEqual(420);
	expect(box.scroll - box.width).toBeLessThanOrEqual(1);
	await dialog
		.getByRole("button", { name: "Save automation", exact: true })
		.click();
	await expect(dialog).toHaveCount(0);
	await expect
		.poll(async () =>
			JSON.parse(await saved.innerText()).map(
				(rule: { name: string }) => rule.name,
			),
		)
		.toContain("New follow-up");
	await edit(page, "New follow-up");
	await page
		.getByRole("button", { name: "Remove automation", exact: true })
		.click();
	const confirmation = page.getByRole("alert");
	await expect(confirmation).toBeFocused();
	await confirmation
		.getByRole("button", { name: "Cancel", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Remove automation", exact: true }),
	).toBeFocused();
	await page
		.getByRole("button", { name: "Remove automation", exact: true })
		.click();
	await page
		.getByRole("alert")
		.getByRole("button", { name: "Remove automation", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Add automation", exact: true }),
	).toBeFocused();
	await expect(saved).toHaveText(before);
});

test("native automation surveys retain malformed reminder text and enforce partial-submission dependencies", async ({
	page,
}) => {
	await open(page);
	await edit(page, "Send follow-up");
	await choose(page, "Schedule content type", "SMS survey");
	const intervals = page.getByRole("textbox", {
		name: "Reminder intervals in minutes",
		exact: true,
	});
	await intervals.fill("5,10,");
	await expect(intervals).toHaveValue("5,10,");
	await page.getByRole("textbox", { name: "Name", exact: true }).click();
	await expect(intervals).toHaveValue("5, 10");
	await intervals.fill("5,,10");
	await page
		.getByRole("button", { name: "Save automation", exact: true })
		.click();
	await expect(intervals).toHaveValue("5,,10");
	await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
	await expect(page.getByLabel("Saved automations")).not.toContainText(
		"sms-survey",
	);
	await intervals.fill("5,10");
	const partial = page.getByRole("checkbox", {
		name: "Submit partially completed forms",
		exact: true,
	});
	const updates = page.getByRole("checkbox", {
		name: /^Include case updates in partial submissions/,
	});
	await expect(updates).toBeDisabled();
	await partial.click();
	await updates.click();
	await partial.click();
	await expect(updates).not.toBeChecked();
	await expect(updates).toBeDisabled();
	await page
		.getByRole("button", { name: "Save automation", exact: true })
		.click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect
		.poll(
			async () =>
				JSON.parse(
					(await page.getByLabel("Saved automations").textContent()) ?? "",
				).find((rule: { name: string }) => rule.name === "Send follow-up")
					.schedule.events[0].content,
		)
		.toMatchObject({
			kind: "sms-survey",
			reminderIntervalsMinutes: [5, 10],
			submitPartiallyCompletedForms: false,
			includeCaseUpdatesInPartialSubmissions: false,
		});
});

test("native automation timed schedules preserve weekdays and prevent duplicate fixed event days", async ({
	page,
}) => {
	await open(page);
	await edit(page, "Send follow-up");
	await choose(page, "Schedule type", "Timed repeating schedule");
	await choose(page, "CommCare HQ schedule form", "Weekly");
	await page
		.getByRole("button", { name: "Add schedule event", exact: true })
		.click();
	const days = page.getByRole("combobox", {
		name: "Day in CommCare HQ schedule",
		exact: true,
	});
	await expect(days).toHaveCount(2);
	await days.nth(1).click();
	await expect(
		page.getByRole("option", {
			name: "Monday (already selected)",
			exact: true,
		}),
	).toBeDisabled();
	await page.keyboard.press("Escape");
	await choose(page, "Start weekday", "Thursday");
	await expect(days.nth(0)).toContainText("Monday");
	await expect(days.nth(1)).toContainText("Tuesday");
	await choose(page, "CommCare HQ schedule form", "Monthly");
	await days.first().click();
	await page
		.getByRole("option", { name: "Last day of the month", exact: true })
		.click();
	await page
		.getByRole("button", { name: "Add schedule event", exact: true })
		.click();
	await expect(days.nth(0)).toContainText("Day 1");
	await expect(days.nth(1)).toContainText("Last day of the month");
	await page
		.getByRole("button", { name: "Save automation", exact: true })
		.click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect
		.poll(async () =>
			JSON.parse(
				(await page.getByLabel("Saved automations").textContent()) ?? "",
			)
				.find((rule: { name: string }) => rule.name === "Send follow-up")
				.schedule.events.map((event: { day: number }) => event.day),
		)
		.toEqual([1, -1]);
});

test("native automation viewers can read every saved control and peer replacement refuses stale edits", async ({
	page,
}) => {
	await open(page, true);
	await expect(
		page.getByRole("button", { name: "Add automation", exact: true }),
	).toHaveCount(0);
	await page.getByRole("button", { name: /Close resolved visits/ }).click();
	await page
		.getByRole("button", { name: "View full definition", exact: true })
		.click();
	await expect(
		page.getByRole("textbox", { name: "Name", exact: true }),
	).toHaveValue("Close resolved visits");
	await expect(
		page.getByRole("textbox", { name: "Name", exact: true }),
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Save automation", exact: true }),
	).toHaveCount(0);
	await page.goto(`${peer.origin}/`);
	await edit(page, "Close resolved visits");
	await page
		.getByRole("textbox", { name: "Name", exact: true })
		.fill("My local work");
	// A peer's update enters through the production mutation hook while this dialog is open.
	await page
		.getByRole("button", {
			name: "Peer renames rule",
			exact: true,
			includeHidden: true,
		})
		.evaluate((button: HTMLButtonElement) => button.click());
	await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
		"A co-editor saved a newer version",
	);
	await expect(
		page.getByRole("textbox", { name: "Name", exact: true }),
	).toHaveValue("My local work");
	await expect(
		page.getByRole("button", { name: "Save automation", exact: true }),
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Remove automation", exact: true }),
	).toBeDisabled();
	await page
		.getByRole("button", {
			name: "Peer removes rule",
			exact: true,
			includeHidden: true,
		})
		.evaluate((button: HTMLButtonElement) => button.click());
	await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
		"A co-editor removed this automation",
	);
	await expect(page.getByRole("dialog").getByRole("alert")).not.toContainText(
		"reopen",
	);
});

test("native automation preview keeps the last guide on transport loss, replaces copied text, and clears authoritative refusals", async ({
	page,
	context,
}) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"], {
		origin: peer.origin,
	});
	let calls = 0;
	const requests: unknown[] = [];
	await page.route("**/automation-preview", async (route) => {
		requests.push(route.request().postDataJSON());
		calls += 1;
		if (calls === 2) {
			await route.abort("failed");
			return;
		}
		if (calls === 4) {
			await route.fulfill({
				json: {
					success: false,
					code: "conflict",
					message: "The saved automation changed. Reopen it to continue.",
				},
			});
			return;
		}
		const request = route.request().postDataJSON();
		const refreshed = calls === 3;
		await route.fulfill({
			json: {
				success: true,
				data: {
					automationUuid: request.automationUuid,
					blueprintSeq: 3,
					organizationRevision: refreshed ? "2" : "1",
					matching: { status: "counted", currentMatchCount: refreshed ? 5 : 4 },
					omittedCriteria: [],
					setupGuide: {
						title: refreshed ? "Refreshed guide" : "First guide",
						requiredPlan: "Data Cleanup (Pro or higher)",
						steps: [refreshed ? "Refreshed setup step." : "First setup step."],
						caveats: ["This guide does not run the automation."],
					},
					executesLocally: false,
				},
			},
		});
	});
	await open(page);
	await page.getByRole("button", { name: /Close resolved visits/ }).click();
	await page
		.getByRole("button", { name: "Count matching cases", exact: true })
		.click();
	await expect(
		page.getByText("First setup step.", { exact: true }),
	).toBeVisible();
	expect(requests).toHaveLength(1);
	expect(requests[0]).toMatchObject({
		appId: "native-automations",
		expectedAutomation: { name: "Close resolved visits", kind: "case-update" },
	});
	await page.getByRole("button", { name: "Copy guide", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Copied", exact: true }),
	).toBeVisible();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
		"First setup step.",
	);
	await page
		.getByRole("button", { name: "Refresh count and guide", exact: true })
		.click();
	await expect(page.getByRole("alert")).toContainText(
		"Couldn't refresh this automation",
	);
	await expect(
		page.getByText("First setup step.", { exact: true }),
	).toBeVisible();
	await page
		.getByRole("button", { name: "Refresh count and guide", exact: true })
		.click();
	await expect(
		page.getByText("Refreshed setup step.", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Copy guide", exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Copied", exact: true }),
	).toHaveCount(0);
	await page.getByRole("button", { name: "Copy guide", exact: true }).click();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
		"Refreshed setup step.",
	);
	await page
		.getByRole("button", { name: "Refresh count and guide", exact: true })
		.click();
	await expect(page.getByRole("alert")).toContainText(
		"The saved automation changed",
	);
	await expect(
		page.getByText("Refreshed setup step.", { exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Count matching cases", exact: true }),
	).toBeEnabled();
});

test("native automation messages and recipient filters preserve literal text and structural case identity through the real gate", async ({
	page,
}) => {
	await open(page);
	await edit(page, "Send follow-up");
	await page
		.getByRole("textbox", { name: "Message", exact: true })
		.fill("Literal {case.case_name}");
	await page
		.getByRole("button", { name: "Add case property reference", exact: true })
		.click();
	const property = page.getByRole("textbox", {
		name: "Message reference property 2",
		exact: true,
	});
	await property.fill("owner");
	await expect(property).toHaveAttribute("aria-invalid", "true");
	await expect(
		page.getByText(/“owner” is reserved by CommCare HQ in messages/),
	).toBeVisible();
	await property.fill("case_name");
	await expect(property).not.toHaveAttribute("aria-invalid", "true");
	await page
		.getByRole("button", { name: "Add literal text", exact: true })
		.click();
	await page
		.getByRole("textbox", { name: "Message literal text 3", exact: true })
		.fill(" done");
	await page
		.getByRole("button", {
			name: "Add owner or recipient reference",
			exact: true,
		})
		.click();
	await choose(page, "Message context source 4", "Message recipient");
	await choose(page, "Recipient 1", "Case owner");
	await page
		.getByRole("button", { name: "Add recipient filter", exact: true })
		.click();
	await page
		.getByRole("textbox", { name: "Exact literal value 1", exact: true })
		.fill("  north  ");
	await page
		.getByRole("button", { name: "Add accepted value", exact: true })
		.click();
	await choose(page, "Value 2 type", "Value from this case");
	await choose(page, "Case property", "state");
	await page
		.getByRole("button", { name: "Save automation", exact: true })
		.click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	const rule = JSON.parse(
		(await page.getByLabel("Saved automations").textContent()) ?? "",
	).find((item: { name: string }) => item.name === "Send follow-up");
	expect(rule.schedule.events[0].content.message.parts).toEqual([
		{ kind: "text", text: "Literal {case.case_name}" },
		{
			kind: "case-property",
			scope: "case",
			caseType: "visit",
			property: "case_name",
		},
		{ kind: "text", text: " done" },
		{ kind: "context-property", context: "recipient", property: "name" },
	]);
	expect(rule.userDataFilters[0].values).toEqual([
		{ kind: "literal", value: "  north  " },
		{ kind: "case-property", caseType: "visit", property: "state" },
	]);
});

test("native automation row removal retains keyboard focus on surviving identities and the add fallback", async ({
	page,
}) => {
	await open(page);
	await edit(page, "Close resolved visits");
	for (const [add, remove] of [
		["Add property condition", "Remove condition"],
		["Add property change", "Remove change"],
	]) {
		await page.getByRole("button", { name: add, exact: true }).click();
		await page.getByRole("button", { name: add, exact: true }).click();
		const rows = page.getByRole("button", { name: remove, exact: true });
		const before = await rows.count();
		await rows.first().click();
		await expect(rows).toHaveCount(before - 1);
		await expect(rows.first()).toBeFocused();
	}
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await edit(page, "Send follow-up");
	await choose(page, "Schedule type", "Timed repeating schedule");
	await page
		.getByRole("button", { name: "Add schedule event", exact: true })
		.click();
	const events = page.getByRole("button", {
		name: "Remove event",
		exact: true,
	});
	await expect(events).toHaveCount(2);
	await events.first().click();
	await expect(events).toHaveCount(1);
	await expect(events.first()).toBeFocused();
	await events.first().click();
	await expect(
		page.getByRole("button", { name: "Add schedule event", exact: true }),
	).toBeFocused();
});
