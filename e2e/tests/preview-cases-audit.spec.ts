import { resolve } from "node:path";
import { componentPeer } from "../lib/componentPeer";
import { expect, test } from "../lib/fixtures";
import type {} from "../lib/preview-cases-client";

const longCaseName =
	"ClientWithAnExtremelyLongImportedCaseNameThatHasNoNaturalWordBreaks";
const longModuleName =
	"CommunityFollowUpAndMedicationAdministrationResultsForTheNorthernServiceArea";
const longFormName =
	"CompleteTheCommunityFollowUpAndMedicationReconciliationWorkflow";

test("Preview case cards reflow at their own width and retain independent native cell actions", async ({
	page,
}) => {
	const boundary = resolve("e2e/lib/preview-cases-boundary.ts");
	const peer = await componentPeer("e2e/lib/preview-cases-client.tsx", [], {
		"@/lib/preview/engine/caseDataBinding": boundary,
		"@/lib/preview/engine/lookupDataBinding": boundary,
		"@/lib/preview/entryPointLaunchAction": boundary,
		"@/lib/auth/hooks/useAuth": boundary,
	});
	try {
		await page.setViewportSize({ width: 320, height: 720 });
		await page.goto(peer.origin);
		const action = page.getByRole("button", { name: /^View details for/ });
		await expect(action).toBeVisible();
		await expect(page.getByRole("heading", { level: 1 })).toHaveText(
			longModuleName,
		);
		const title = page.getByRole("heading", { level: 1 });
		expect(
			await title.evaluate((node) => node.scrollWidth <= node.clientWidth),
		).toBe(true);
		const phone = page.getByRole("link", { name: "Call +1 202 555 0123" });
		const disclosure = page.getByRole("button", {
			name: "Unavailable. More information",
		});
		for (const control of [phone, disclosure]) {
			const box = await control.boundingBox();
			if (!box) throw new Error("Missing cell action");
			expect(box.height).toBeGreaterThanOrEqual(44);
			expect(box.width).toBeGreaterThanOrEqual(44);
		}
		await expect(phone).toHaveAttribute("href", "tel:+1 202 555 0123");
		await phone.evaluate((node) =>
			node.addEventListener("click", (event) => event.preventDefault()),
		);
		await phone.click();
		await expect(title).toHaveText(longModuleName);
		await disclosure.click();
		await expect(page.getByText("Why this value is shown")).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.getByText("Why this value is shown")).toBeHidden();
		await expect(title).toHaveText(longModuleName);
		await action.focus();
		await page.keyboard.press("Enter");
		await expect(title).toHaveText(longCaseName);
		expect(
			await title.evaluate((node) => node.scrollWidth <= node.clientWidth),
		).toBe(true);
		await page.getByRole("button", { name: "Continue", exact: true }).click();
		const form = page.getByRole("button", { name: longFormName });
		await expect(form).toBeVisible();
		expect(
			await form.evaluate((node) => node.scrollWidth <= node.clientWidth),
		).toBe(true);
		await page.getByRole("button", { name: "Back", exact: true }).click();
		await page
			.getByRole("button", { name: "Back to results", exact: true })
			.click();
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth,
			),
		).toBe(true);

		// Widths bracket each authored column-count transition after the screen's
		// 48px inner gutters. The assertion measures actual field geometry.
		for (const [count, threshold] of [
			[3, 624],
			[4, 720],
			[5, 816],
			[6, 944],
		] as const) {
			await page.evaluate(
				(count) => window.previewCasesAudit.setCount(count),
				count,
			);
			await expect(page.locator("[data-case-result-field]")).toHaveCount(count);
			await page.setViewportSize({ width: threshold - 16, height: 900 });
			const fields = page.locator("[data-case-result-field]");
			await expect
				.poll(async () => {
					const first = await fields.nth(0).boundingBox(),
						second = await fields.nth(1).boundingBox();
					return first !== null && second !== null && second.y > first.y;
				})
				.toBe(true);
			await page.setViewportSize({ width: threshold + 16, height: 900 });
			await expect
				.poll(async () => {
					const first = await fields.nth(0).boundingBox(),
						second = await fields.nth(1).boundingBox();
					return (
						first !== null &&
						second !== null &&
						second.y === first.y &&
						second.x > first.x
					);
				})
				.toBe(true);
		}
		await page.evaluate(() => window.previewCasesAudit.setCount(7));
		await page.setViewportSize({ width: 1200, height: 900 });
		await expect(page.locator("[data-case-result-field]")).toHaveCount(7);
		const fields = page.locator("[data-case-result-field]");
		const first = await fields.nth(0).boundingBox(),
			last = await fields.nth(6).boundingBox();
		if (!first || !last) throw new Error("Missing seven-field layout");
		expect(last.y).toBeGreaterThan(first.y);
	} finally {
		try {
			if (!page.isClosed())
				await page.evaluate(() => window.previewCasesAudit?.dispose());
		} finally {
			try {
				await page.close();
			} finally {
				await peer.close();
			}
		}
	}
});

test("Several-case selection survives pagination in order and rejects a validation response from an old Project", async ({
	page,
}) => {
	page.setDefaultTimeout(10_000);
	const boundary = resolve("e2e/lib/preview-cases-boundary.ts");
	const peer = await componentPeer("e2e/lib/preview-cases-client.tsx", [], {
		"@/lib/preview/engine/caseDataBinding": boundary,
		"@/lib/preview/engine/lookupDataBinding": boundary,
		"@/lib/preview/entryPointLaunchAction": boundary,
		"@/lib/auth/hooks/useAuth": boundary,
	});
	const release = Promise.withResolvers<void>();
	const validations: string[][] = [];
	await page.route(`${peer.origin}/validate-selection`, async (route) => {
		const ids: string[] = route.request().postDataJSON();
		validations.push(ids);
		if (validations.length === 1) await release.promise;
		await route.fulfill({ json: [...ids].reverse() });
	});
	try {
		await page.goto(peer.origin);
		await expect(
			page.getByRole("button", { name: /^View details for/ }),
		).toBeVisible();
		await page.evaluate(() => window.previewCasesAudit.several());
		await page.getByRole("checkbox", { name: /^Choose Patient 2,/ }).check();
		await page.getByRole("button", { name: "Next", exact: true }).click();
		await page.getByRole("checkbox", { name: /^Choose Patient 51,/ }).check();
		await page.getByRole("button", { name: "Review selected cases" }).click();
		await expect(page.getByRole("dialog").getByRole("listitem")).toHaveText([
			/Patient 2/,
			/Patient 51/,
		]);
		await page
			.getByRole("button", { name: "Back to results", exact: true })
			.click();
		await page.getByRole("button", { name: "Continue", exact: true }).click();
		await expect.poll(() => validations.length).toBe(1);
		expect(validations[0]).toEqual(["patient-2", "patient-51"]);
		await page.evaluate(() => window.previewCasesAudit.refresh());
		const lateReply = page.waitForResponse((response) =>
			response.url().endsWith("/validate-selection"),
		);
		release.resolve();
		await (await lateReply).finished();
		await expect(
			page.getByText("0 cases selected", { exact: true }),
		).toBeVisible();
		expect(
			await page.evaluate(() => window.previewCasesAudit.target()),
		).toBeUndefined();
		await page.getByRole("checkbox", { name: /^Choose Patient 2,/ }).check();
		await page.getByRole("checkbox", { name: /^Choose Patient 1,/ }).check();
		await page.getByRole("button", { name: "Continue", exact: true }).click();
		await page
			.getByRole("button", { name: /^CompleteTheCommunityFollowUp/ })
			.click();
		await expect
			.poll(() =>
				page.evaluate(() =>
					window.previewCasesAudit
						.target()
						?.cases?.map((value) => value.caseId),
				),
			)
			.toEqual(["patient-2", "patient-1"]);
	} finally {
		release.resolve();
		try {
			if (!page.isClosed())
				await page.evaluate(() => window.previewCasesAudit?.dispose());
		} finally {
			await page.close();
			await peer.close();
		}
	}
});
