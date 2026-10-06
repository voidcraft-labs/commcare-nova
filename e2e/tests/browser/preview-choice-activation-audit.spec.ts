import { resolve } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { componentPeer } from "../../lib/componentPeer";
import { attachErrorGuard, closePageWithUnload } from "../../lib/errorGuard";
import { test as base, expect } from "../../lib/fixtures";
import type {} from "../../lib/preview-choice-activation-client";

type ChoiceKind = "radio" | "checkbox";
interface ChoiceApp {
	page: Page;
	age: Locator;
	error: Locator;
	submissions: unknown[][];
	prepare(age?: string): Promise<void>;
}
async function closeOwnedPages(page: Page, popups: Page[]) {
	const closures = await Promise.allSettled([
		closePageWithUnload(page),
		...popups.map((popup) => popup.close()),
	]);
	const failures = closures.flatMap((result) =>
		result.status === "rejected" ? [result.reason] : [],
	);
	if (failures.length)
		throw new AggregateError(failures, "Choice pages failed to close");
}
const test = base.extend<{ choiceApp: ChoiceApp }>({
	choiceApp: async ({ page }, use) => {
		const boundary = resolve("e2e/lib/preview-form-lifecycle-boundary.ts");
		const peer = await componentPeer(
			"e2e/lib/preview-choice-activation-client.tsx",
			[],
			{
				"@/lib/preview/engine/caseDataBinding": boundary,
				"@/lib/preview/engine/lookupDataBinding": boundary,
				"@/lib/preview/entryPointLaunchAction": boundary,
				"@/lib/auth/hooks/useAuth": boundary,
				"@/lib/lookup/actions": boundary,
			},
		);
		let guard: Awaited<ReturnType<typeof attachErrorGuard>> | undefined;
		const popups: Page[] = [];
		const capturePopup = (popup: Page) => popups.push(popup);
		page.on("popup", capturePopup);
		try {
			guard = await attachErrorGuard(page, peer.origin);
			const submissions: unknown[][] = [];
			await page.route(`${peer.origin}/submission`, async (route) => {
				submissions.push(route.request().postDataJSON());
				await route.fulfill({
					json: { kind: "error", message: "Transport unavailable. Try again." },
				});
			});
			await page.goto(peer.origin);
			const age = page.getByRole("textbox", { name: /Question 2.*Age/ });
			await expect(age).toBeVisible();
			await expect(
				page.locator('[data-preview-engine-ready="true"]'),
			).toBeVisible();
			const error = page.getByText(
				await page.evaluate(() => window.previewChoiceActivation.error),
				{ exact: true },
			);
			await use({
				page,
				age,
				error,
				submissions,
				async prepare(value = "121") {
					await page
						.getByRole("textbox", { name: /Question 1.*Name/ })
						.fill("Fictional visitor");
					await age.fill(value);
					await page.evaluate(() => window.previewChoiceActivation.settled());
					await expect(age).toBeFocused();
					await expect(error).toBeHidden();
				},
			});
		} finally {
			page.off("popup", capturePopup);
			try {
				if (!page.isClosed())
					await page.evaluate(() => window.previewChoiceActivation?.dispose());
			} finally {
				try {
					await closeOwnedPages(page, popups);
					await guard?.assertNoErrors();
				} finally {
					await peer.close();
				}
			}
		}
	},
});
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

function choice(page: Page, kind: ChoiceKind) {
	const control = page.getByRole(kind, {
		name: kind === "radio" ? "Email" : "Service one",
		exact: true,
	});
	return {
		control,
		label: page.locator("label.pv-choice-row").filter({ has: control }),
	};
}
async function point(label: Locator) {
	await label.scrollIntoViewIfNeeded();
	const box = await label.boundingBox();
	if (!box) throw new Error("Choice label has no browser box");
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
async function expectChosen(
	app: ChoiceApp,
	control: Locator,
	kind: ChoiceKind,
) {
	await expect(control).toBeChecked();
	await expect(control).toBeFocused();
	await expect(app.error).toBeVisible();
	const observed = await app.page.evaluate(() =>
		window.previewChoiceActivation.observation(),
	);
	expect(observed.age).toMatchObject({
		value: "121",
		touched: true,
		valid: false,
	});
	expect(observed.changes).toHaveLength(1);
	expect(observed.changes[0]).toMatchObject({ kind, trusted: true });
}

for (const kind of ["radio", "checkbox"] as const) {
	for (const pointer of ["mouse", "touch"] as const) {
		test(`the first ${pointer} choice on a ${kind} survives multiline blur validation and retains native keyboard focus`, async ({
			choiceApp: app,
		}) => {
			await app.prepare();
			const { control, label } = choice(app.page, kind);
			if (pointer === "mouse") await label.click();
			else {
				const target = await point(label);
				await app.page.touchscreen.tap(target.x, target.y);
			}
			await expectChosen(app, control, kind);
			await app.page.keyboard.press(kind === "radio" ? "ArrowUp" : "Space");
			await expect(control).not.toBeChecked();
			if (kind === "radio")
				await expect(
					app.page.getByRole("radio", { name: "Phone", exact: true }),
				).toBeFocused();
			else await expect(control).toBeFocused();
			const changes = await app.page.evaluate(
				() => window.previewChoiceActivation.observation().changes,
			);
			expect(changes).toHaveLength(2);
			expect(changes.every((event) => event.trusted)).toBe(true);
			await expect(app.error).toBeVisible();
		});
	}

	test(`a ${kind} press released outside cancels, and a later ordinary press can return inside`, async ({
		choiceApp: app,
	}) => {
		await app.prepare();
		const { control, label } = choice(app.page, kind);
		const target = await point(label);
		await app.page.mouse.move(target.x, target.y);
		await app.page.mouse.down();
		await app.page.mouse.move(3, 3);
		await app.page.mouse.up();
		await expect(control).not.toBeChecked();
		await expect(app.age).toBeFocused();
		await expect(app.error).toBeHidden();
		expect(
			await app.page.evaluate(
				() => window.previewChoiceActivation.observation().changes,
			),
		).toHaveLength(0);
		await app.page.mouse.move(target.x, target.y);
		await app.page.mouse.down();
		await app.page.mouse.move(3, 3);
		await app.page.mouse.move(target.x, target.y);
		await app.page.mouse.up();
		await expectChosen(app, control, kind);
	});
}

test("native keyboard activation still reveals the prior invalid answer", async ({
	choiceApp: app,
}) => {
	await app.prepare();
	const { control } = choice(app.page, "checkbox");
	await control.focus();
	await app.page.keyboard.press("Space");
	await expectChosen(app, control, "checkbox");
});

test("a disabled native choice receives a trusted coordinate click without selecting", async ({
	choiceApp: app,
}) => {
	await app.prepare();
	const { control, label } = choice(app.page, "radio");
	const target = await point(label);
	await control.evaluate((input: HTMLInputElement) => {
		input.disabled = true;
	});
	// A locator click refuses a disabled label before browser dispatch.
	await app.page.mouse.click(target.x, target.y);
	await expect(control).not.toBeChecked();
	await expect(control).not.toBeFocused();
	expect(
		await app.page.evaluate(
			() => window.previewChoiceActivation.observation().changes,
		),
	).toHaveLength(0);
});

for (const button of ["right", "middle"] as const) {
	test(`${button} choice presses preserve native label behavior without adding focus`, async ({
		choiceApp: app,
		browserName,
	}) => {
		await app.prepare("35");
		const { control, label } = choice(app.page, "checkbox");
		await label.click({ button });
		await app.page.evaluate(() => window.previewChoiceActivation.settled());
		// The independent baseline forwards a native checkbox click in WebKit;
		// Chromium leaves it unchecked. The focus guard preserves each default.
		if (browserName === "webkit") await expect(control).toBeChecked();
		else await expect(control).not.toBeChecked();
		await expect(control).not.toBeFocused();
		const changes = await app.page.evaluate(
			() => window.previewChoiceActivation.observation().changes,
		);
		expect(changes).toEqual(
			browserName === "webkit"
				? [{ kind: "checkbox", value: "on", trusted: true }]
				: [],
		);
	});
}

test("an authored choice link keeps its native popup and does not select its containing option", async ({
	choiceApp: app,
}) => {
	await app.prepare("35");
	await app.page.context().route("https://example.invalid/help", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<title>Help destination</title>",
		}),
	);
	const popups: Page[] = [];
	const capturePopup = (popup: Page) => popups.push(popup);
	app.page.on("popup", capturePopup);
	try {
		await app.page
			.getByRole("link", { name: "Read help", exact: true })
			.click();
		await expect.poll(() => popups.length).toBe(1);
		await expect(popups[0]).toHaveURL("https://example.invalid/help");
		await expect(popups[0]).toHaveTitle("Help destination");
		for (const radio of await app.page.getByRole("radio").all())
			await expect(radio).not.toBeChecked();
		expect(
			await app.page.evaluate(
				() => window.previewChoiceActivation.observation().changes,
			),
		).toHaveLength(0);
	} finally {
		app.page.off("popup", capturePopup);
	}
});

test("a trusted touch scroll cancels choice activation", async ({
	choiceApp: app,
	browserName,
}) => {
	test.skip(
		browserName !== "chromium",
		"Native touch-scroll dispatch uses Chromium CDP",
	);
	await app.prepare();
	const { control, label } = choice(app.page, "checkbox");
	const target = await point(label);
	const cdp = await app.page.context().newCDPSession(app.page);
	try {
		await cdp.send("Input.dispatchTouchEvent", {
			type: "touchStart",
			touchPoints: [{ id: 1, ...target, radiusX: 2, radiusY: 2 }],
		});
		for (const distance of [20, 60, 110])
			await cdp.send("Input.dispatchTouchEvent", {
				type: "touchMove",
				touchPoints: [
					{
						id: 1,
						x: target.x,
						y: target.y - distance,
						radiusX: 2,
						radiusY: 2,
					},
				],
			});
		await cdp.send("Input.dispatchTouchEvent", {
			type: "touchEnd",
			touchPoints: [],
		});
		await expect
			.poll(() =>
				app.page.evaluate(
					() => window.previewChoiceActivation.observation().pointerCancelled,
				),
			)
			.toBe(true);
		await expect(control).not.toBeChecked();
		await expect(app.age).toBeFocused();
		expect(
			await app.page.evaluate(
				() => window.previewChoiceActivation.observation().changes,
			),
		).toHaveLength(0);
	} finally {
		await cdp.detach();
	}
});

test("invalid Submit still refuses and a corrected local clock draft submits exactly once", async ({
	choiceApp: app,
}) => {
	await app.prepare();
	const submit = app.page.getByRole("button", { name: "Submit", exact: true });
	await submit.click();
	await expect(app.age).toHaveAttribute("aria-invalid", "true");
	await expect(app.error).toBeVisible();
	await expect(app.page.getByRole("alert")).toHaveText(
		"Review the highlighted question.",
	);
	expect(app.submissions).toHaveLength(0);
	await app.age.fill("35");
	const clock = app.page.getByRole("textbox", { name: /Question 5.*Time/ });
	await clock.fill("2:30 PM");
	await expect(clock).toBeFocused();
	await submit.click();
	await expect(app.page.getByRole("alert")).toHaveText(
		"Transport unavailable. Try again.",
	);
	expect(app.submissions).toHaveLength(1);
	expect(app.submissions[0]?.[0]).toMatchObject({
		kind: "registration",
		primary: {
			caseName: "Fictional visitor",
			properties: { age: 35, clock: "14:30:00.000Z" },
		},
	});
});
