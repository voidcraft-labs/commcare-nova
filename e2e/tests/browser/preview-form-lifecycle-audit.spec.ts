import { resolve } from "node:path";
import { componentPeer } from "../../lib/componentPeer";
import { expect, test } from "../../lib/fixtures";
import type {} from "../../lib/preview-form-lifecycle-client";

test("Submit commits the coordinate and clock currently being edited", async ({
	page,
}) => {
	const boundary = resolve("e2e/lib/preview-form-lifecycle-boundary.ts");
	const peer = await componentPeer(
		"e2e/lib/preview-form-lifecycle-client.tsx",
		[],
		{
			"@/lib/preview/engine/caseDataBinding": boundary,
			"@/lib/preview/engine/lookupDataBinding": boundary,
			"@/lib/preview/entryPointLaunchAction": boundary,
			"@/lib/auth/hooks/useAuth": boundary,
			"@/lib/lookup/actions": boundary,
		},
	);
	const submissions: unknown[][] = [];
	await page.route(`${peer.origin}/submission`, async (route) => {
		submissions.push(route.request().postDataJSON());
		await route.fulfill({
			json: { kind: "error", message: "Transport unavailable. Try again." },
		});
	});
	try {
		await page.goto(`${peer.origin}/?drafts`);
		const name = page.getByRole("textbox", { name: /Question 1.*Name/ });
		await expect(name).toBeVisible();
		await name.fill("Ada");
		const clock = page.getByRole("textbox", { name: /Question 4.*Time/ });
		await clock.fill("2:30 PM");
		await page
			.getByRole("button", { name: "Enter coordinates manually" })
			.click();
		await page
			.getByRole("spinbutton", { name: "Latitude", exact: true })
			.fill("40");
		const longitude = page.getByRole("spinbutton", {
			name: "Longitude",
			exact: true,
		});
		await longitude.fill("-74");
		await expect(longitude).toBeFocused();
		await page.getByRole("button", { name: "Submit", exact: true }).click();
		await expect(page.getByRole("alert")).toHaveText(
			"Transport unavailable. Try again.",
		);
		expect(submissions).toHaveLength(1);
		expect(submissions[0]?.[0]).toMatchObject({
			kind: "registration",
			primary: { properties: { place: "40 -74 0 0", clock: "14:30:00.000Z" } },
		});
		await clock.fill("3:45 PM");
		await page.getByRole("button", { name: "Submit", exact: true }).click();
		await expect.poll(() => submissions.length).toBe(2);
		expect(submissions[1]?.[0]).toMatchObject({
			kind: "registration",
			primary: { properties: { place: "40 -74 0 0", clock: "15:45:00.000Z" } },
		});
	} finally {
		try {
			if (!page.isClosed())
				await page.evaluate(() => window.previewFormLifecycleAudit?.dispose());
		} finally {
			await page.close();
			await peer.close();
		}
	}
});

test("Numeric answers remain editable and block submission until corrected", async ({
	page,
}) => {
	const boundary = resolve("e2e/lib/preview-form-lifecycle-boundary.ts");
	const peer = await componentPeer(
		"e2e/lib/preview-form-lifecycle-client.tsx",
		[],
		{
			"@/lib/preview/engine/caseDataBinding": boundary,
			"@/lib/preview/engine/lookupDataBinding": boundary,
			"@/lib/preview/entryPointLaunchAction": boundary,
			"@/lib/auth/hooks/useAuth": boundary,
			"@/lib/lookup/actions": boundary,
		},
	);
	const submissions: unknown[][] = [];
	await page.route(`${peer.origin}/submission`, async (route) => {
		submissions.push(route.request().postDataJSON());
		await route.fulfill({
			json: { kind: "error", message: "Transport unavailable. Try again." },
		});
	});
	try {
		await page.goto(`${peer.origin}/?numbers`);
		await page.getByRole("textbox", { name: /Question 1.*Name/ }).fill("Ada");
		const count = page.getByRole("textbox", { name: /Question 3.*Count/ });
		const quantity = page.getByRole("textbox", {
			name: /Question 4.*Quantity/,
		});
		const submit = page.getByRole("button", { name: "Submit", exact: true });
		await count.fill("2.5");
		await submit.click();
		await expect(count).toBeFocused();
		await expect(count).toHaveValue("2.5");
		await expect(count).toHaveAttribute("aria-invalid", "true");
		await expect(
			page.getByText("This question needs a whole number."),
		).toBeVisible();
		expect(submissions).toHaveLength(0);
		await count.fill("2");
		await quantity.fill("1e");
		await submit.click();
		await expect(quantity).toBeFocused();
		await expect(quantity).toHaveValue("1e");
		await expect(page.getByText("This question needs a number.")).toBeVisible();
		expect(submissions).toHaveLength(0);
		await quantity.fill("2.5");
		await submit.focus();
		await submit.press("Enter");
		await expect(page.getByRole("alert")).toHaveText(
			"Transport unavailable. Try again.",
		);
		expect(submissions).toHaveLength(1);
		await expect(count).toHaveValue("2");
		await expect(quantity).toHaveValue("2.5");
	} finally {
		try {
			if (!page.isClosed())
				await page.evaluate(() => window.previewFormLifecycleAudit?.dispose());
		} finally {
			await page.close();
			await peer.close();
		}
	}
});

test("Form submission waits for real file upload, preserves same-Project answers and retires a changed Project entry", async ({
	page,
}) => {
	page.setDefaultTimeout(10_000);
	const boundary = resolve("e2e/lib/preview-form-lifecycle-boundary.ts");
	const peer = await componentPeer(
		"e2e/lib/preview-form-lifecycle-client.tsx",
		[],
		{
			"@/lib/preview/engine/caseDataBinding": boundary,
			"@/lib/preview/engine/lookupDataBinding": boundary,
			"@/lib/preview/entryPointLaunchAction": boundary,
			"@/lib/auth/hooks/useAuth": boundary,
			"@/lib/lookup/actions": boundary,
		},
	);
	const upload = Promise.withResolvers<void>();
	const submissions: unknown[][] = [];
	const deletes: string[] = [];
	await page.route(`${peer.origin}/submission`, async (route) => {
		submissions.push(route.request().postDataJSON());
		await route.fulfill({
			json: { kind: "error", message: "Transport unavailable. Try again." },
		});
	});
	await page.route(
		`${peer.origin}/api/apps/native-form/attachments**`,
		async (route) => {
			const request = route.request();
			if (request.method() === "DELETE") {
				deletes.push(request.url());
				await route.fulfill({ status: 204 });
			} else if (new URL(request.url()).pathname.endsWith("/attachments"))
				await route.fulfill({
					json: {
						attachmentId: "photo-1",
						attachmentName: "photo-1.png",
						uploadUrl: `${peer.origin}/upload`,
						uploadContentType: "image/png",
						uploadHeaders: {},
					},
				});
			else
				await route.fulfill({
					json: {
						attachmentId: "photo-1",
						attachmentName: "photo-1.png",
						originalFilename: "picked.png",
						sizeBytes: 3,
					},
				});
		},
	);
	let uploadStarted = false;
	await page.route(`${peer.origin}/upload`, async (route) => {
		uploadStarted = true;
		await upload.promise;
		await route.fulfill({ status: 200 });
	});
	try {
		await page.goto(peer.origin);
		const name = page.getByRole("textbox", { name: /Question 1.*Name/ });
		await expect(name).toBeVisible();
		await page.getByRole("button", { name: "Submit", exact: true }).click();
		await expect(name).toBeFocused();
		await expect(
			page.getByText("Review the highlighted question."),
		).toBeVisible();
		expect(submissions).toHaveLength(0);
		await name.fill("Before upload");
		const entry = await page.evaluate(() =>
			window.previewFormLifecycleAudit.entry(),
		);
		await page.evaluate(() =>
			window.previewFormLifecycleAudit.refresh("project-a"),
		);
		await expect(name).toHaveValue("Before upload");
		expect(
			await page.evaluate(() => window.previewFormLifecycleAudit.entry()),
		).toBe(entry);
		await page.locator('input[type="file"]').setInputFiles({
			name: "picked.png",
			mimeType: "image/png",
			buffer: Buffer.from([1, 2, 3]),
		});
		await expect.poll(() => uploadStarted).toBe(true);
		await page.getByRole("button", { name: "Submit", exact: true }).click();
		await expect(
			page.getByRole("button", { name: "Submitting", exact: true }),
		).toBeDisabled();
		await expect(name).toBeDisabled();
		await expect(
			page.getByRole("button", { name: "Clear form", exact: true }),
		).toBeDisabled();
		expect(submissions).toHaveLength(0);
		upload.resolve();
		await expect(page.getByRole("alert")).toHaveText(
			"Transport unavailable. Try again.",
		);
		expect(submissions).toHaveLength(1);
		expect(submissions[0]?.[0]).toMatchObject({
			kind: "survey",
			entryKey: entry,
			attachmentRefs: [{ attachmentName: "photo-1.png" }],
		});
		expect(submissions[0]?.[2]).toEqual(
			expect.stringMatching(/^[0-9a-f]{64}$/),
		);
		await page.getByRole("button", { name: "Clear form", exact: true }).click();
		await expect(name).toHaveValue("");
		await expect(page.getByRole("alert")).toHaveCount(0);
		const clearedEntry = await page.evaluate(() =>
			window.previewFormLifecycleAudit.entry(),
		);
		expect(clearedEntry).not.toBe(entry);
		await name.fill("Fresh answer");
		await page.evaluate(() =>
			window.previewFormLifecycleAudit.refresh("project-b"),
		);
		await expect(name).toHaveValue("");
		await expect
			.poll(() => page.evaluate(() => window.previewFormLifecycleAudit.entry()))
			.not.toBe(clearedEntry);
		await expect.poll(() => deletes.length).toBe(1);
	} finally {
		upload.resolve();
		try {
			if (!page.isClosed())
				await page.evaluate(() => window.previewFormLifecycleAudit?.dispose());
		} finally {
			await page.close();
			await peer.close();
		}
	}
});
