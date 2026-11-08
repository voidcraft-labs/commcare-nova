import { resolve } from "node:path";
import type {} from "../../lib/choice-answer-client";
import { componentPeer } from "../../lib/componentPeer";
import { expect, test } from "../../lib/fixtures";

for (const platform of ["web", "android"]) {
	test(`stale choice diagnostic and repair routes on ${platform}`, async ({
		page,
	}) => {
		const boundary = resolve("e2e/lib/choice-answer-boundary.ts");
		const peer = await componentPeer(
			"e2e/lib/choice-answer-client.tsx",
			[],
			Object.fromEntries(
				[
					"@/lib/preview/engine/caseDataBinding",
					"@/lib/preview/engine/lookupDataBinding",
					"@/lib/preview/entryPointLaunchAction",
					"@/lib/auth/hooks/useAuth",
					"@/lib/lookup/actions",
					"@/lib/deployment/actions",
					"@/lib/doc/platformChangePreflight",
					"@/lib/preview/xpath/browserWorkerClient",
				].map((name) => [name, boundary]),
			),
		);
		try {
			await page.goto(`${peer.origin}/?${platform}`);
			const panel = page.locator("[data-choice-answer-check]");
			await expect(panel).toContainText('stage holds "retired"');
			await expect(panel).toContainText(
				platform === "web" ? "Web Apps cannot display" : "Android can leave",
			);
			expect(await page.evaluate(() => window.choiceCheckAudit.answer())).toBe(
				"retired",
			);
			await expect(page.getByRole("radio")).toHaveCount(0);
			await page.getByRole("button", { name: "View selected record" }).click();
			await expect(page.getByRole("dialog")).toContainText("retired");
			await page.keyboard.press("Escape");
			await expect(page.getByRole("dialog")).toHaveCount(0);
			await page.getByRole("button", { name: "Edit question" }).click();
			expect(
				await page.evaluate(() => window.choiceCheckAudit.previewing()),
			).toBe(false);
			await expect(page).toHaveURL(/choice-check/);
			await page.evaluate(() => window.choiceCheckAudit.resume());
			await expect(panel).toBeVisible();
			// The real document gate removes the preload; the committed engine
			// entry must discard the diagnostic and open an ordinary blank question.
			await page.evaluate(() => window.choiceCheckAudit.repair());
			await page.getByRole("button", { name: "Try again" }).click();
			await expect(panel).toHaveCount(0);
			await expect(
				page.getByRole("radio", { name: "Yes", exact: true }),
			).toBeVisible();
		} finally {
			try {
				if (!page.isClosed())
					await page.evaluate(() => window.choiceCheckAudit?.dispose());
			} finally {
				await peer.close();
			}
		}
	});
}
