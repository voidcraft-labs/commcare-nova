import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";

/**
 * Open-ended, forged-session visual-QA harness for the patient case workspace.
 * Registered only when CASE_WORKSPACE_MANUAL=1, so CI can never enter the
 * forever-wait. Close the browser window (or Ctrl-C) when the review is done.
 */

interface CaseWorkspaceManifest {
	baseUrl: string;
	caseWorkspace: {
		appId: string;
		moduleUuid: string;
		caseType: string;
		caseCount: number;
		caseIds: string[];
		routes: {
			search: string;
			results: string;
			details: string;
			firstCase: string;
		};
	};
}

test("manual case-workspace session — close the window (or Ctrl-C) to end", async ({
	page,
}) => {
	test.setTimeout(0);
	const seed: CaseWorkspaceManifest = JSON.parse(
		readFileSync(path.join(process.cwd(), "e2e", ".auth", "seed.json"), "utf8"),
	);

	await page.goto(seed.caseWorkspace.routes.results);

	const absolute = (route: string) => new URL(route, seed.baseUrl).href;
	console.log(
		`\n[case:manual] ${seed.caseWorkspace.caseCount} seeded ${seed.caseWorkspace.caseType} cases` +
			`\n[case:manual] Search  ${absolute(seed.caseWorkspace.routes.search)}` +
			`\n[case:manual] Results ${absolute(seed.caseWorkspace.routes.results)}` +
			`\n[case:manual] Details ${absolute(seed.caseWorkspace.routes.details)}` +
			`\n[case:manual] Record  ${absolute(seed.caseWorkspace.routes.firstCase)}` +
			"\n[case:manual] Close the browser window (or Ctrl-C here) to end.\n",
	);

	await page.waitForEvent("close", { timeout: 0 }).catch(() => undefined);
});
