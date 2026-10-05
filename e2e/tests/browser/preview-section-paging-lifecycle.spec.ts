import { resolve } from "node:path";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import type { submitFormAction } from "@/lib/preview/engine/caseDataBinding";
import type { SubmissionResult } from "@/lib/preview/engine/caseDataBindingTypes";
import { componentPeer } from "../../lib/componentPeer";
import { attachErrorGuard, closePageWithUnload } from "../../lib/errorGuard";
import {
	capturePhoneRuntime,
	refuseOutsidePhonePeer,
	selectWorkerLanguage,
} from "../../lib/phoneRuntimeEvidence";
import type {} from "../../lib/preview-section-paging-client";

test.use({ reducedMotion: "reduce", serviceWorkers: "block" });

type RecordedSubmission = Parameters<typeof submitFormAction>;

const paging = test.extend<{
	pagingPeer: { submissions: RecordedSubmission[] };
}>({
	pagingPeer: [
		async ({ page, context }, use, testInfo) => {
			const boundary = resolve("e2e/lib/preview-section-paging-boundary.ts");
			const peer = await componentPeer(
				"e2e/lib/preview-section-paging-client.tsx",
				[],
				{
					"@/lib/preview/engine/caseDataBinding": boundary,
					"@/lib/preview/engine/lookupDataBinding": boundary,
					"@/lib/preview/entryPointLaunchAction": boundary,
					"@/lib/auth/hooks/useAuth": boundary,
					"@/lib/lookup/actions": boundary,
					"@/lib/preview/app-tests/actions": boundary,
					"@/components/builder/app-setup/AppSetupWorkspace": boundary,
					"@/components/builder/case-operations/CaseOperationDetailCanvas":
						boundary,
					"@/components/builder/case-operations/CaseOperationsCanvas": boundary,
					"@/components/builder/conditions/DisplayConditionCanvas": boundary,
					"@/components/builder/data-review/DataReviewScreen": boundary,
					"@/components/builder/form-links/FormLinkDetailCanvas": boundary,
					"@/components/builder/form-links/FormLinksCanvas": boundary,
					"@/components/builder/project-data/ProjectDataWorkspace": boundary,
					"@/components/builder/case-list-config/CaseListConfigWorkspace":
						boundary,
					"@/components/preview/screens/CaseListScreen": boundary,
				},
			);
			try {
				const guard = await attachErrorGuard(page, peer.origin);
				const refused = await refuseOutsidePhonePeer(context, peer.origin);
				const submissions: RecordedSubmission[] = [];
				try {
					// This one controlled POST is an in-process response boundary.
					// It never reaches the peer server or persists an app/case/receipt.
					await page.route(`${peer.origin}/submission`, async (route) => {
						if (route.request().method() !== "POST") {
							refused.push(
								`${route.request().method()} ${route.request().url()}`,
							);
							await route.abort("blockedbyclient");
							return;
						}
						submissions.push(route.request().postDataJSON());
						const result = {
							kind: "survey",
							caseDatabasePatch: { rows: [], indices: [] },
						} satisfies SubmissionResult;
						await route.fulfill({ json: result });
					});
					await page.setViewportSize({ width: 390, height: 720 });
					await page.goto(peer.origin);
					await ready(page);
					await selectWorkerLanguage(page, "Español");
					await ready(page);
					await expect(
						page.getByRole("heading", { name: "Inicio", exact: true }),
					).toBeVisible();
					try {
						await use({ submissions });
					} catch (error) {
						if (!page.isClosed()) await capture(page, testInfo, "failure");
						throw error;
					}
				} finally {
					try {
						if (!page.isClosed())
							await page.evaluate(() => window.sectionPagingAudit?.dispose());
					} finally {
						try {
							await closePageWithUnload(page);
						} finally {
							await guard.assertNoErrors();
							expect(refused).toEqual([]);
						}
					}
				}
			} finally {
				await peer.close();
			}
		},
		{ auto: true },
	],
});

async function ready(page: Page) {
	await page.evaluate(() => window.sectionPagingAudit.settled());
	await expect(
		page.locator('[data-preview-engine-ready="true"]'),
	).toBeVisible();
}

function status(page: Page) {
	return page
		.getByRole("navigation", { name: "Secciones", exact: true })
		.getByRole("status");
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
	const observation = await page.evaluate(() => {
		const nav = document.querySelector(
			'nav[aria-label="Secciones"], nav[aria-label="Sections"]',
		);
		const focus = document.activeElement;
		return {
			...window.sectionPagingAudit.observation(),
			headings: [...document.querySelectorAll("h2")].map((node) => ({
				text: node.textContent,
				visible: node.getClientRects().length > 0,
			})),
			selectedStep: nav?.querySelector('[aria-current="step"]')?.textContent,
			status: nav?.querySelector('[role="status"]')?.textContent,
			statusVisible: nav ? nav.getClientRects().length > 0 : false,
			focus: {
				tag: focus?.tagName,
				text: focus?.textContent,
				label: focus?.getAttribute("aria-label"),
			},
			viewport: {
				width: window.innerWidth,
				height: window.innerHeight,
				bodyWidth: document.body.scrollWidth,
			},
		};
	});
	await capturePhoneRuntime(page, testInfo, name, observation);
	return observation;
}

async function nextToDetails(page: Page) {
	await page.getByRole("button", { name: "Siguiente", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Datos", exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Datos", exact: true }),
	).toBeFocused();
	await expect(status(page)).toHaveText("Sección 2 de 3: Datos");
}

for (const width of [320, 390]) {
	paging(
		`Clear retires the previous section announcement in a fresh entry at ${width}px`,
		async ({ page }, testInfo) => {
			await page.setViewportSize({ width, height: 720 });
			const initial = await windowObservation(page);
			await expect(status(page)).toBeEmpty();
			await nextToDetails(page);
			await page
				.getByRole("textbox", { name: /Nombre del trabajador/ })
				.fill("Visitor");
			await capture(page, testInfo, "user-turn-details");
			await page
				.getByRole("button", { name: "Borrar formulario", exact: true })
				.click();
			await ready(page);
			await expect(
				page.getByRole("heading", { name: "Inicio", exact: true }),
			).toBeVisible();
			await expect
				.poll(async () => (await windowObservation(page)).entry?.entryKey)
				.not.toBe(initial.entry?.entryKey);
			const after = await capture(page, testInfo, "fresh-entry-after-clear");
			expect.soft(after.status?.trim()).toBe("");
			await expect
				.soft(page.getByRole("heading", { name: "Inicio", exact: true }))
				.not.toBeFocused();
			await expect(
				page
					.getByRole("navigation", { name: "Secciones" })
					.locator('[aria-current="step"]'),
			).toContainText("Inicio");
			expect(after.values.name).toBe("");
			expect(after.document).toBe(initial.document);
			// Repeated ordinary turns still announce and focus after retirement.
			await nextToDetails(page);
			await page.getByRole("button", { name: "Atrás", exact: true }).click();
			await expect(status(page)).toHaveText("Sección 1 de 3: Inicio");
			await expect(
				page.getByRole("heading", { name: "Inicio", exact: true }),
			).toBeFocused();
			await nextToDetails(page);
			await capture(page, testInfo, "new-entry-repeated-turns");
		},
	);
}

paging(
	"a refused forward jump retires the previous announcement and focuses the invalid intermediate page",
	async ({ page }, testInfo) => {
		const initial = await windowObservation(page);
		await nextToDetails(page);
		const name = page.getByRole("textbox", { name: /Nombre del trabajador/ });
		await name.fill("Visitor");
		await page.getByRole("button", { name: "Siguiente", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "Revisión", exact: true }),
		).toBeFocused();
		await page.getByRole("button", { name: "Atrás", exact: true }).click();
		await expect(name).toBeVisible();
		await name.fill("");
		await page.getByRole("button", { name: "Atrás", exact: true }).click();
		await expect(status(page)).toHaveText("Sección 1 de 3: Inicio");
		await page
			.getByRole("navigation", { name: "Secciones" })
			.getByRole("button", { name: /Revisión/ })
			.click();
		await expect(
			page.getByRole("heading", { name: "Datos", exact: true }),
		).toBeVisible();
		await expect(name).toBeFocused();
		const after = await capture(page, testInfo, "invalid-intermediate-page");
		await expect(page.locator('p[role="alert"]')).toHaveText(
			"Revise la pregunta resaltada.",
		);
		await expect(
			page.getByText("Este campo es obligatorio", { exact: true }),
		).toBeVisible();
		expect.soft(after.status?.trim()).toBe("");
		await expect(
			page
				.getByRole("navigation", { name: "Secciones" })
				.locator('[aria-current="step"]'),
		).toContainText("Datos");
		expect(after.entry?.entryKey).toBe(initial.entry?.entryKey);
		expect(after.document).toBe(initial.document);
	},
);

paging(
	"ordinary Submit routes through PreviewShell and reopens the retained form without the completed entry announcement or focus",
	async ({ page, pagingPeer }, testInfo) => {
		await nextToDetails(page);
		await page
			.getByRole("textbox", { name: /Nombre del trabajador/ })
			.fill("Visitor");
		await page.getByRole("button", { name: "Siguiente", exact: true }).click();
		await expect(status(page)).toHaveText("Sección 3 de 3: Revisión");
		const previous = await capture(page, testInfo, "previous-entry-review");
		await expect(
			page.getByRole("heading", { name: "Revisión", exact: true }),
		).toBeFocused();
		await page.getByRole("button", { name: "Enviar", exact: true }).click();
		await expect.poll(() => pagingPeer.submissions.length).toBe(1);
		expect(pagingPeer.submissions[0]?.[0]).toMatchObject({
			kind: "survey",
			formUuid: previous.formUuid,
			entryKey: previous.entry?.entryKey,
			attachmentRefs: [],
		});
		expect(pagingPeer.submissions[0]?.[1]).toBe("native-section-paging");
		expect(pagingPeer.submissions[0]?.[2]).toMatch(/^[0-9a-f]{64}$/);
		await expect
			.poll(async () => (await windowObservation(page)).pathname)
			.toBe(`/build/native-section-paging/${previous.moduleUuid}`);
		await expect
			.poll(async () => (await windowObservation(page)).entry?.formUuid)
			.toBeUndefined();
		await expect(
			page.getByRole("heading", { name: "Revisión", exact: true }),
		).toHaveCount(0);
		const module = await capture(
			page,
			testInfo,
			"production-module-after-submit",
		);
		expect(module.activeSection).toBeUndefined();
		await page.getByRole("button", { name: "Visit", exact: true }).click();
		await ready(page);
		await expect(
			page.getByRole("heading", { name: "Inicio", exact: true }),
		).toBeVisible();
		await expect
			.poll(async () => (await windowObservation(page)).pathname)
			.toBe(`/build/native-section-paging/${previous.formUuid}`);
		const after = await capture(page, testInfo, "fresh-entry-retained-screen");
		await testInfo.attach("controlled-submission-transport", {
			body: Buffer.from(JSON.stringify(pagingPeer.submissions, null, 2)),
			contentType: "application/json",
		});
		expect(previous.retainedBodyIdentity).toBeTruthy();
		expect(after.retainedBodyIdentity).toBe(previous.retainedBodyIdentity);
		expect(after.entry?.entryKey).toBeTruthy();
		expect(after.entry?.entryKey).not.toBe(previous.entry?.entryKey);
		expect(after.values.name).toBe("");
		expect(after.document).toBe(previous.document);
		expect.soft(after.status?.trim()).toBe("");
		await expect
			.soft(page.getByRole("heading", { name: "Inicio", exact: true }))
			.not.toBeFocused();
		await expect(
			page
				.getByRole("navigation", { name: "Secciones" })
				.locator('[aria-current="step"]'),
		).toContainText("Inicio");
		expect(pagingPeer.submissions).toHaveLength(1);
	},
);

async function windowObservation(page: Page) {
	return page.evaluate(() => window.sectionPagingAudit.observation());
}
