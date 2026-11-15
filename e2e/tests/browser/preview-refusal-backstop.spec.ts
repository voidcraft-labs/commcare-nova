import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { runtimeMessage } from "@/lib/preview/runtimeMessages";
import { componentPeer } from "../../lib/componentPeer";
import {
	attachErrorGuard,
	closePageWithUnload,
	type ErrorGuard,
} from "../../lib/errorGuard";
import type {} from "../../lib/preview-refusal-backstop-client";

/**
 * The form screen sits inside the running app's refusal backstop
 * (`PreviewShell` → `PreviewDataRefusalScope surface="form"`), so Core's data
 * refusal thrown while the form renders shows the form's refusal panel with
 * the form's Back, as a phone stops on the form, and never reaches the canvas
 * boundary. The peer runs the real shell and aliases FormScreen to a screen
 * that throws that refusal as it renders while Preview runs the app
 * (`e2e/lib/preview-refusal-backstop-form.ts`), since no product read reaches
 * the backstop today. Take the scope away, or its Back, or its retry when
 * Preview stops, and these fail.
 *
 * React reports an error a boundary catches through `console.error`, as Next's
 * production `onCaughtError` does, so each test takes exactly those reports
 * of the thrown refusal off its guard and holds every other error to it.
 */

test.use({ reducedMotion: "reduce", serviceWorkers: "block" });

let peer: Awaited<ReturnType<typeof componentPeer>>;

test.beforeAll(async () => {
	const boundary = resolve("e2e/lib/preview-section-paging-boundary.ts");
	peer = await componentPeer(
		"e2e/lib/preview-refusal-backstop-client.tsx",
		[],
		{
			"@/lib/preview/engine/caseDataBinding": boundary,
			"@/lib/preview/engine/lookupDataBinding": boundary,
			"@/lib/preview/entryPointLaunchAction": boundary,
			"@/lib/auth/hooks/useAuth": resolve(
				"e2e/lib/preview-refusal-backstop-auth.ts",
			),
			"@/lib/lookup/actions": boundary,
			"@/lib/deployment/actions": boundary,
			"@/lib/doc/platformChangePreflight": boundary,
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
			"@/components/builder/case-list-config/CaseListConfigWorkspace": boundary,
			"@/components/preview/screens/CaseListScreen": boundary,
			"@/components/preview/screens/FormScreen": resolve(
				"e2e/lib/preview-refusal-backstop-form.ts",
			),
		},
	);
});
test.afterAll(async () => {
	await peer?.close();
});

/** The messages of the refusals the peer's form screen throws. */
const THROWN = [
	"CommCare refuses this read: the instance “commcaresession” holds nothing on the device.",
	"XPath references a path that does not exist in the instance.",
];

async function withPeer(
	page: Page,
	refusal: "form" | "links" | "core-path",
	run: (page: Page) => Promise<void>,
) {
	const guard = await attachErrorGuard(page, peer.origin);
	try {
		await page.setViewportSize({ width: 390, height: 720 });
		await page.goto(`${peer.origin}/?refusal=${refusal}`);
		await run(page);
	} finally {
		try {
			if (!page.isClosed())
				await page.evaluate(() => window.refusalBackstop?.dispose());
		} finally {
			await closePageWithUnload(page);
			takeCaughtRefusals(guard);
			await guard.assertNoErrors();
		}
	}
}

/** Take React's reports of the caught refusal off the guard. */
function takeCaughtRefusals(guard: ErrorGuard) {
	const others = guard.errors.filter(
		(error) => !THROWN.some((message) => error.includes(message)),
	);
	guard.errors.splice(0, guard.errors.length, ...others);
}

function panel(page: Page) {
	return page.locator("[data-preview-data-refusal-surface]");
}

for (const [refusal, surface] of [
	["form", "form"],
	["core-path", "form"],
	["links", "links"],
] as const) {
	test(`a ${refusal} refusal thrown while the form renders shows the ${surface} panel with Back`, async ({
		page,
	}) => {
		await withPeer(page, refusal, async () => {
			const location = page.getByLabel("Location");
			await expect(location).toHaveText("form");
			const alert = page.getByRole("alert");
			await expect(alert).toBeVisible();
			await expect(panel(page)).toHaveAttribute(
				"data-preview-data-refusal-surface",
				surface,
			);
			await expect(panel(page)).toHaveAttribute(
				"data-preview-data-refusal",
				"worker-information",
			);
			await expect(alert.getByRole("heading")).toHaveText(
				runtimeMessage(
					"eng",
					surface === "form" ? "dataRefusalFormTitle" : "dataRefusalLinksTitle",
				),
			);
			const back = alert.getByRole("button", { name: "Back", exact: true });
			await expect(back).toBeVisible();

			/* The authoring canvas reads no worker's data, so leaving Preview
			 * tries the screen again and shows the form, not a phone's stop;
			 * running the app again meets the refusal again. */
			await page.evaluate(() => window.refusalBackstop.setPreviewing(false));
			await expect(page.getByText("Authoring the form")).toBeVisible();
			await expect(panel(page)).toHaveCount(0);
			await page.evaluate(() => window.refusalBackstop.setPreviewing(true));
			await expect(back).toBeVisible();

			await back.click();
			await expect(location).toHaveText("module");
			await expect(panel(page)).toBeHidden();
		});
	});
}
