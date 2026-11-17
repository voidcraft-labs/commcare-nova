import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import {
	KEPT_REFRESH_BUTTON,
	KEPT_REFRESH_BUTTON_PENDING,
} from "@/components/builder/keptListModel";
import type { PublishResponseBody } from "@/components/builder/publishOutcome";
import { endpointWireFixture } from "@/lib/commcare/__tests__/endpointWireFixture";
import type {
	DeploymentActionResult,
	DeploymentView,
	KeptRefreshView,
} from "@/lib/deployment/actions";
import { hqPlaceUrl } from "@/lib/deployment/hqPlaceUrl";
import {
	APP_PREVIEW_NOTE,
	BASELINE_UNKNOWN_SENTENCE,
	HQ_CHANGED_MESSAGE,
	LOOKUP_ADOPTION_NOTE,
} from "@/lib/deployment/remoteChanges";
import { WEB_APPS_ONLY_HAS_NO_CCZ } from "@/lib/deployment/runtimeTarget";
import { buildSetupArtifact } from "@/lib/deployment/setupArtifact";
import {
	type DeploymentConfirmationNeeded,
	type DeploymentResource,
	NO_DEPLOYMENT_PHASE_OUTCOMES,
} from "@/lib/deployment/types";
import {
	ANOTHER_SPACE_NEW_APP_LINE,
	broughtInFromLine,
	CONNECTION_CHECK_FAILED,
	DRIFT_STOP_EDITOR_LINE,
	DRIFT_STOP_LEAVE_HEADING,
	notPublishedYetLine,
	STOP_PUBLISHING_FAILED,
	STOP_PUBLISHING_UNANSWERED,
	stoppedPublishingLine,
} from "@/lib/publish/bringInCopy";
import type { FirstPublishView } from "@/lib/publish/firstPublishChangeIds";
import { firstPublishLines } from "@/lib/publish/firstPublishCopy";
import {
	BRING_IN_CHANGES_ACTION,
	CHECK_AGAIN_ACTION,
	HQ_CHANGES_DIALOG_TITLE,
	HQ_CHANGES_HEADING,
	HQ_CHANGES_NO_EDIT_ACCESS_LINE,
	HQ_CHANGES_STAGE_LABELS,
	hqChangedFoundLine,
	SEE_WHAT_CHANGED_ACTION,
	sincePhrase,
} from "@/lib/publish/hqChangesCopy";
import {
	KEPT_LABELS,
	keptLead,
	keptRefreshSentence,
} from "@/lib/publish/keptValues";
import {
	encodeManualImportGuide,
	MANUAL_IMPORT_GUIDE_HEADER,
	manualImportGuide,
} from "@/lib/publish/manualImportGuide";
import {
	ACCEPT_PLACEMENT_MOVES_LABEL,
	movedToCaseManagementSentence,
	type PlacementMoveOfferView,
	SAVE_TO_CASE_OFFER_HEADING,
	saveToCaseOfferBody,
	saveToCaseWhereMissing,
} from "@/lib/publish/placementMoves";
import {
	COMMTRACK_OFF,
	CONNECT_FORWARDER,
	FLAT_LOCATION_FIXTURE,
	FORM_ENTRY_SYNC_OFF,
	formEntrySyncWhereMissing,
	LOGO_UPLOAD_STEP_TEXT,
	PLAN_FEATURES,
	webAppsWhereMissing,
} from "@/lib/publish/planFeatures";
import type { ProjectSpaceCompatibilityReport } from "@/lib/publish/projectSpaceCompatibility";
import {
	PROJECT_SPACE_CAPABILITIES,
	PROJECT_SPACE_COMPATIBILITY_DOCS_URL,
	PROJECT_SPACE_COMPATIBILITY_SUPPORT_EMAIL,
} from "@/lib/publish/projectSpaceCompatibility";
import {
	ENDED_HQ_APP_LINK,
	ENDED_WORKERS_LINE,
	endedLine,
	PUBLISH_PLAN_CREATES_BESIDE,
	STOP_PUBLISHING_ACTION,
	STOP_PUBLISHING_CONFIRM,
	STOP_PUBLISHING_HELPER,
	stopPublishingConfirmTitle,
} from "@/lib/publish/stopPublishing";
import {
	WEB_APPS_CHANGE_HEADING,
	webAppsChangeMessage,
} from "@/lib/publish/webApps";
import { componentPeer } from "../../lib/componentPeer";
import { expect, test } from "../../lib/fixtures";

/* What a person can do where the project space syncs cases on form entry, for an app nothing keeps off Web Apps alone. */
const SYNC_WHERE_MISSING = formEntrySyncWhereMissing({
	open: true,
	features: [],
});
/* What a person can do where the plan lacks Web Apps, for an app nothing keeps off Android. */
const WEB_APPS_WHERE_MISSING = webAppsWhereMissing({
	open: true,
	features: [],
});

let peer: Awaited<ReturnType<typeof componentPeer>>;
test.use({ actionTimeout: 10_000 });
test.beforeAll(async () => {
	peer = await componentPeer("e2e/lib/publishing-client.tsx", [], {
		"@/lib/deployment/actions": resolve("e2e/lib/publishing-boundary.ts"),
		"@/lib/lookup/actions": resolve("e2e/lib/publishing-boundary.ts"),
	});
});
test.afterAll(async () => {
	await peer?.close();
});
function report(
	domain = "alpha",
	blocked = false,
): ProjectSpaceCompatibilityReport {
	const capability = {
		...PROJECT_SPACE_CAPABILITIES["case-search"],
		reasons: ["Patients searches cases."],
		state: blocked ? ("missing" as const) : ("available" as const),
	};
	return {
		status: blocked ? "blocked" : "ready",
		target_domain: domain,
		required_capabilities: [capability],
		blockers: blocked ? [capability] : [],
		advisories: [],
		support_email: PROJECT_SPACE_COMPATIBILITY_SUPPORT_EMAIL,
		docs_url: PROJECT_SPACE_COMPATIBILITY_DOCS_URL,
		message: blocked
			? "This project space does not support Case search."
			: "This project space supports everything this app uses.",
	};
}
async function open(page: Page, query = "", review = true) {
	await page.route("**/api/apps/native-publishing/stream?*", (route) =>
		route.fulfill({
			status: 200,
			contentType: "text/event-stream",
			body: "retry: 3600000\n\n",
		}),
	);
	await page.route("**/api/apps/native-publishing/presence", (route) =>
		route.fulfill({ json: [] }),
	);
	await page.route("**/publishing/lookup", (route) =>
		route.fulfill({
			json: {
				success: true,
				data: { projectId: "native-project", revision: "0", tables: [] },
			},
		}),
	);
	await page.route("**/publishing/read", (route) =>
		route.fulfill({ json: { success: true, data: [] } }),
	);
	await page.route("**/publishing/download-targets", (route) =>
		route.fulfill({
			json: {
				success: true,
				data: {
					targets: [{ server: "india", domain: "alpha" }],
					heldFromHq: [],
					webAppsOnly: false,
				},
			},
		}),
	);
	await page.route("**/publishing/compatibility?*", (route) =>
		route.fulfill({
			json: {
				ok: true,
				report: report(
					new URL(route.request().url()).searchParams.get("domain") ||
						undefined,
				),
			},
		}),
	);
	await page.goto(`${peer.origin}/?${query}`);
	if (!query.includes("links=true"))
		await page
			.getByRole("button", { name: "Open publish", exact: true })
			.click();
	if (
		review &&
		!query.includes("links=true") &&
		(await page
			.getByRole("button", { name: "Continue", exact: true })
			.isEnabled())
	)
		await reviewDestination(page);
}
async function reviewDestination(page: Page) {
	await page.getByRole("button", { name: "Continue", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Review and publish", exact: true }),
	).toBeVisible();
}
async function choose(page: Page, label: string, name: string, review = true) {
	const back = page.getByRole("button", { name: "Back", exact: true });
	const another = page.getByRole("button", {
		name: "Another destination",
		exact: true,
	});
	if (await back.isVisible()) await back.click();
	else if (await another.isVisible()) await another.click();
	await page.getByRole("combobox", { name: label, exact: true }).click();
	await page.getByRole("option", { name, exact: true }).click();
	if (
		review &&
		(await page
			.getByRole("button", { name: "Continue", exact: true })
			.isVisible()) &&
		(await page
			.getByRole("button", { name: "Continue", exact: true })
			.isEnabled())
	)
		await reviewDestination(page);
}
const refusal = {
	success: false,
	refusal: {
		phase: "resources",
		failure: {
			code: "hq_resource_conflict",
			message: "An existing table needs your choice.",
			details: [],
		},
		resourceConflicts: [
			{
				kind: "lookup-table",
				novaResourceId: "table-one",
				name: "Clinics",
				identity: "clinics",
				remoteId: "remote-clinics",
			},
		],
		remoteChanges: [],
		confirmationsNeeded: [],
		webAppsChange: null,
		placementMoves: null,
	},
	preview_project_space: null,
} satisfies PublishResponseBody;
test("native publish consent expires when the dialog closes or its destination changes", async ({
	page,
}) => {
	const sent: unknown[] = [];
	await page.route("**/api/commcare/upload", (route) => {
		sent.push(route.request().postDataJSON());
		return route.fulfill({ json: refusal });
	});
	await open(page);
	if (
		await page
			.getByRole("button", { name: "Continue", exact: true })
			.isVisible()
	)
		await reviewDestination(page);
	await page.getByRole("button", { name: "Upload", exact: true }).click();
	await page.getByRole("checkbox", { name: "Clinics (clinics)" }).check();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await page.getByRole("button", { name: "Open publish", exact: true }).click();
	await reviewDestination(page);
	if (
		await page
			.getByRole("button", { name: "Continue", exact: true })
			.isVisible()
	)
		await reviewDestination(page);
	await page.getByRole("button", { name: "Upload", exact: true }).click();
	expect(sent).toHaveLength(2);
	expect(sent[1]).toMatchObject({ adopt_resources: [] });
	await page.getByRole("checkbox", { name: "Clinics (clinics)" }).check();
	await choose(page, "Publish option", "CommCare HQ app file");
	await choose(page, "Publish option", "CommCare HQ");
	if (
		await page
			.getByRole("button", { name: "Continue", exact: true })
			.isVisible()
	)
		await reviewDestination(page);
	await page.getByRole("button", { name: "Upload", exact: true }).click();
	expect(sent[2]).toMatchObject({ adopt_resources: [] });
});
test("native publish lists what changed in CommCare HQ, publishes over each ticked change as it was shown, and lands with the App Preview line", async ({
	page,
}) => {
	const sent: Record<string, unknown>[] = [];
	const remoteChanges = [
		{
			kind: "app",
			novaResourceId: "native-publishing",
			name: "Clinic visits",
			identity: "hq-app",
			parts: ["The form Visit in the menu Patients", "The app's name"],
			note: null,
			observedDigest: "digest-app",
			baselineKnown: true,
			since: { kind: "published" },
			canBringIn: false,
		},
		{
			kind: "location",
			novaResourceId: "place-north",
			name: "North",
			identity: "north",
			parts: [],
			note: null,
			observedDigest: "digest-north",
			baselineKnown: false,
			since: { kind: "published" },
			canBringIn: false,
		},
	] as const;
	const changed = {
		success: false,
		refusal: {
			phase: "preflight",
			failure: {
				code: "hq_changed",
				message: HQ_CHANGED_MESSAGE,
				details: ["Clinic visits", "North"],
			},
			resourceConflicts: [],
			remoteChanges: [...remoteChanges],
			confirmationsNeeded: [],
			webAppsChange: null,
			placementMoves: null,
		},
		preview_project_space: null,
	} satisfies PublishResponseBody;
	const landed = {
		success: true,
		hq_app_action: "updated",
		app_preview_note: APP_PREVIEW_NOTE,
		url: "https://www.commcarehq.org/a/alpha/apps/view/hq-app/",
		warnings: [],
		deployment: null,
		preview_project_space: "alpha",
	} satisfies PublishResponseBody;
	await page.route("**/api/commcare/upload", (route) => {
		sent.push(route.request().postDataJSON());
		return route.fulfill({ json: sent.length === 1 ? changed : landed });
	});
	await open(page);
	if (
		await page
			.getByRole("button", { name: "Continue", exact: true })
			.isVisible()
	)
		await reviewDestination(page);
	await page.getByRole("button", { name: "Upload", exact: true }).click();
	await expect(
		page.getByText("The form Visit in the menu Patients", { exact: true }),
	).toBeVisible();
	await expect(page.getByText("The app's name", { exact: true })).toBeVisible();
	await expect(
		page.getByText(BASELINE_UNKNOWN_SENTENCE, { exact: true }),
	).toBeVisible();
	const publishOver = page.getByRole("button", {
		name: "Publish over these changes",
		exact: true,
	});
	await expect(publishOver).toBeDisabled();
	await page
		.getByRole("checkbox", { name: "Publish over this Clinic visits" })
		.check();
	await expect(publishOver).toBeDisabled();
	await page.getByRole("checkbox", { name: "Publish over this North" }).check();
	await publishOver.click();
	await expect(page.getByText(APP_PREVIEW_NOTE, { exact: true })).toBeVisible();
	expect(sent).toHaveLength(2);
	expect(sent[0]).toMatchObject({ discard_remote_changes: [] });
	expect(sent[1].discard_remote_changes).toEqual([
		{
			kind: "app",
			novaResourceId: "native-publishing",
			observedDigest: "digest-app",
		},
		{
			kind: "location",
			novaResourceId: "place-north",
			observedDigest: "digest-north",
		},
	]);
});
test("native released links preserve external selection order and recheck before copying", async ({
	page,
	context,
}) => {
	const calls: unknown[] = [];
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.route("**/publishing/link", (route) => {
		calls.push(route.request().postDataJSON());
		return route.fulfill({
			json:
				calls.length === 1
					? {
							success: true,
							data: {
								url: "https://india.commcarehq.org/link/first",
								checkedAt: "2026-09-06T00:00:00Z",
							},
						}
					: {
							success: false,
							message:
								"The released build changed. Check it again after publishing.",
						},
		});
	});
	await open(page, "links=true");
	await page
		.getByRole("button", { name: "Patients · Visit", exact: true })
		.click();
	await page
		.getByRole("textbox", { name: "patient case IDs", exact: true })
		.fill(" hq-second \n\nhq-first");
	await page
		.getByRole("button", { name: "Generate HQ link", exact: true })
		.click();
	await expect(
		page.getByRole("textbox", { name: "CommCare HQ deep link", exact: true }),
	).toHaveValue("https://india.commcarehq.org/link/first");
	expect(calls[0]).toMatchObject({
		appId: "native-publishing",
		server: "india",
		domain: "alpha",
		selections: [{ caseIds: ["hq-second", "hq-first"] }],
	});
	await page.evaluate(() => navigator.clipboard.writeText("keep clipboard"));
	await page.getByRole("button", { name: "Copy HQ link", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText("released build changed");
	await expect(
		page.getByRole("textbox", { name: "CommCare HQ deep link", exact: true }),
	).toHaveCount(0);
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
		"keep clipboard",
	);
	await expect(
		page.getByRole("textbox", { name: "patient case IDs", exact: true }),
	).toHaveValue(" hq-second \n\nhq-first");
});

test("native publish checks each selected Project and holds a server refusal until a fresh check", async ({
	page,
}) => {
	const checked: string[] = [];
	page.on("request", (request) => {
		if (request.url().includes("/publishing/compatibility?"))
			checked.push(new URL(request.url()).searchParams.get("domain") ?? "");
	});
	await open(page, "multi=true");
	await expect(
		page.getByRole("button", { name: "Continue", exact: true }),
	).toBeDisabled();
	expect(checked).toEqual([]);
	await choose(page, "Project space", "Alpha");
	await expect(
		page.getByRole("button", { name: "Upload", exact: true }),
	).toBeEnabled();
	expect(checked).toEqual(["alpha"]);
	await page.route("**/api/commcare/upload", (route) =>
		route.fulfill({
			json: { ...refusal, project_space_compatibility: report("alpha", true) },
		}),
	);
	if (
		await page
			.getByRole("button", { name: "Continue", exact: true })
			.isVisible()
	)
		await reviewDestination(page);
	await page.getByRole("button", { name: "Upload", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Upload", exact: true }),
	).toBeDisabled();
	await expect(
		page.getByText("“Alpha” needs more support to run the app", {
			exact: true,
		}),
	).toBeVisible();
	await page.getByRole("button", { name: "Check again", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Upload", exact: true }),
	).toBeEnabled();
	await choose(page, "Project space", "Beta");
	await expect(
		page.getByRole("button", { name: "Upload", exact: true }),
	).toBeEnabled();
	expect(checked).toEqual(["alpha", "alpha", "beta"]);
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "Open publish", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Continue", exact: true }),
	).toBeDisabled();
});

test("native file downloads remain available to viewers and ignore a completion from an older dialog", async ({
	page,
}) => {
	let held: import("@playwright/test").Route | undefined;
	await page.route("**/api/compile/json", (route) => {
		held = route;
	});
	await page.route("**/publishing/download/ccz?*", (route) =>
		route.fulfill({ json: { ok: true } }),
	);
	try {
		await open(page, "viewer=true", false);
		await page
			.getByRole("combobox", { name: "Publish option", exact: true })
			.click();
		await expect(
			page.getByRole("option", { name: "CommCare HQ", exact: true }),
		).toHaveCount(0);
		await page
			.getByRole("option", { name: "CommCare HQ app file", exact: true })
			.click();
		await reviewDestination(page);
		await page
			.getByRole("button", { name: "Download ZIP", exact: true })
			.click();
		await expect.poll(() => Boolean(held)).toBe(true);
		await expect(
			page.getByRole("button", { name: "Preparing", exact: true }),
		).toBeDisabled();
		await page.keyboard.press("Escape");
		await page
			.getByRole("button", { name: "Open publish", exact: true })
			.click();
		const old = held;
		held = undefined;
		await old?.fulfill({ body: "zip", contentType: "application/zip" });
		await reviewDestination(page);
		await expect(
			page.getByRole("button", { name: "Download ZIP", exact: true }),
		).toBeEnabled();
		await expect(
			page.getByText("CommCare HQ app file downloaded", { exact: true }),
		).toHaveCount(0);
		await choose(page, "Publish option", "CommCare mobile app file");
		await page
			.getByRole("button", { name: "Download CCZ", exact: true })
			.click();
		await expect(
			page.getByText("Mobile app file downloaded", { exact: true }),
		).toBeVisible();
		await page.getByRole("button", { name: "Done", exact: true }).click();
		await expect(
			page.getByRole("button", { name: "Open publish", exact: true }),
		).toBeFocused();
	} finally {
		await held?.abort();
		await page.goto("about:blank");
	}
});

test("native compatibility transport failure preserves downloads and an explicit retry restores upload", async ({
	page,
}) => {
	await open(page);
	await page.route("**/publishing/compatibility?*", (route) =>
		route.fulfill({
			json: { ok: false, message: "Nova could not check this project space." },
		}),
	);
	await page.getByRole("button", { name: "Check again", exact: true }).click();
	await expect(
		page.getByText("Nova could not check this project space.", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Upload", exact: true }),
	).toBeDisabled();
	await choose(page, "Publish option", "CommCare HQ app file");
	await expect(
		page.getByRole("button", { name: "Download ZIP", exact: true }),
	).toBeEnabled();
	await choose(page, "Publish option", "CommCare HQ");
	await page.route("**/publishing/compatibility?*", (route) =>
		route.fulfill({ json: { ok: true, report: report() } }),
	);
	await page.getByRole("button", { name: "Try again", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Upload", exact: true }),
	).toBeEnabled();
});

test("native released links wait for actual human save authority and discard a response after destination change", async ({
	page,
}) => {
	let put: import("@playwright/test").Route | undefined;
	let link: import("@playwright/test").Route | undefined;
	await page.route("**/api/apps/native-publishing", (route) => {
		put = route;
	});
	await page.route("**/publishing/link", (route) => {
		link = route;
	});
	try {
		await open(page, "links=true");
		await page
			.getByRole("button", { name: "Patients · Visit", exact: true })
			.click();
		await page
			.getByRole("textbox", { name: "patient case IDs", exact: true })
			.fill("hq-one");
		await page
			.getByRole("button", { name: "Edit document", exact: true })
			.click();
		await page
			.getByRole("button", { name: "Generate HQ link", exact: true })
			.click();
		await expect.poll(() => Boolean(put)).toBe(true);
		expect(link).toBeUndefined();
		await expect(
			page.getByRole("button", {
				name: "Checking released build",
				exact: true,
			}),
		).toBeDisabled();
		const save = put;
		put = undefined;
		await save?.fulfill({ json: { seq: 1 } });
		await expect.poll(() => Boolean(link)).toBe(true);
		await page
			.getByRole("button", { name: "Change deployment target", exact: true })
			.click();
		const old = link;
		link = undefined;
		await old?.fulfill({
			json: {
				success: true,
				data: {
					url: "https://india.commcarehq.org/old",
					checkedAt: "2026-09-06T00:00:00Z",
				},
			},
		});
		await expect(
			page.getByRole("textbox", { name: "CommCare HQ deep link", exact: true }),
		).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: "Generate HQ link", exact: true }),
		).toBeEnabled();
	} finally {
		await put?.abort();
		await link?.abort();
		await page.goto("about:blank");
	}
});

test("native released link viewers retain the destination without verification writes", async ({
	page,
}) => {
	const calls: string[] = [];
	page.on("request", (request) => {
		if (request.url().includes("/publishing/link")) calls.push(request.url());
	});
	await open(page, "links=true&viewer=true");
	await page
		.getByRole("button", { name: "Patients · Visit", exact: true })
		.click();
	await expect(
		page.getByRole("textbox", { name: "patient case IDs", exact: true }),
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Generate HQ link", exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByText(
			"A Project editor can check the released build and generate a link",
			{ exact: true },
		),
	).toBeVisible();
	expect(calls).toEqual([]);
});

test("native released links discard old document responses and old destination refusals", async ({
	page,
}) => {
	const held: { route: import("@playwright/test").Route | undefined } = {
		route: undefined,
	};
	const takeHeld = () => {
		const route = held.route;
		held.route = undefined;
		return route;
	};
	await page.route("**/publishing/link", (route) => {
		held.route = route;
	});
	try {
		await open(page, "links=true");
		await page
			.getByRole("button", { name: "Patients · Visit", exact: true })
			.click();
		await page
			.getByRole("textbox", { name: "patient case IDs", exact: true })
			.fill("hq-one");
		await page
			.getByRole("button", { name: "Generate HQ link", exact: true })
			.click();
		await expect.poll(() => Boolean(held.route)).toBe(true);
		await page
			.getByRole("button", { name: "Edit document", exact: true })
			.click();
		const old = takeHeld();
		await old?.fulfill({
			json: {
				success: true,
				data: {
					url: "https://india.commcarehq.org/stale",
					checkedAt: "2026-09-06T00:00:00Z",
				},
			},
		});
		await expect(
			page.getByRole("textbox", { name: "CommCare HQ deep link", exact: true }),
		).toHaveCount(0);
		// The next request waits for the actual mutation PUT before it reaches HQ.
		await page.route("**/api/apps/native-publishing", (route) =>
			route.fulfill({ json: { seq: 1 } }),
		);
		await page
			.getByRole("button", { name: "Generate HQ link", exact: true })
			.click();
		await expect.poll(() => Boolean(held.route)).toBe(true);
		const fresh = takeHeld();
		await fresh?.fulfill({
			json: { success: false, message: "Alpha has no released build." },
		});
		await expect(page.getByRole("alert")).toHaveText(
			"Alpha has no released build.",
		);
		await page
			.getByRole("button", { name: "Change deployment target", exact: true })
			.click();
		await expect(page.getByRole("alert")).toHaveCount(0);
	} finally {
		await held.route?.abort();
		await page.goto("about:blank");
	}
});

test("native publish to the empty app an earlier try made says it fills it in, and lands as a new app", async ({
	page,
}) => {
	const doc = endpointWireFixture("multiple");
	/* A first publish that stopped after HQ made the empty app: its mapping
	 * is live and carries no pushed revision. */
	const shell: DeploymentView = {
		deployment: {
			deployment: {
				id: "deployment",
				appId: "native-publishing",
				projectId: "native-project",
				server: "production",
				domain: "alpha",
				state: "incomplete",
				resumePhase: "resources",
				phases: NO_DEPLOYMENT_PHASE_OUTCOMES,
				createdBy: "native-user",
				createdAt: "2026-09-06T00:00:00Z",
				updatedAt: "2026-09-06T00:00:00Z",
				lastObservedAt: null,
				offeredLogoContentHash: null,
				targetEmptyCaseListText: null,
				endings: 0,
			},
			active: [
				{
					deploymentId: "deployment",
					kind: "app",
					novaResourceId: "native-publishing",
					remoteId: "hq-shell",
					ownership: "nova-created",
					pushedIdentity: null,
					adoptedAt: null,
					adoptedBy: null,
					pushedRevision: null,
					pushedAt: null,
					pushToken: "shell-token",
					remoteRevision: null,
					remoteObservedAt: null,
					supersededAt: null,
					remoteMissingAt: null,
					adoptedByName: null,
					releasedAt: null,
					endedReason: null,
					endedByName: null,
					heldByAnotherApp: false,
				},
			],
			superseded: [],
			confirmations: [],
		},
		artifact: buildSetupArtifact({
			doc,
			server: "production",
			domain: "alpha",
			hqAppId: null,
			locations: [],
		}),
		leftBehind: [],
		kept: null,
		firstPublish: null,
	};
	await page.route("**/api/commcare/upload", (route) =>
		route.fulfill({
			json: {
				success: true,
				hq_app_action: "created",
				url: "https://www.commcarehq.org/a/alpha/apps/view/hq-shell/",
				warnings: [],
				deployment: null,
				preview_project_space: "alpha",
			} satisfies PublishResponseBody,
		}),
	);
	await open(page);
	/* The dialog reads where the app stands each time it opens; this answer
	 * is registered after open's, so it is the one the second opening reads. */
	await page.route("**/publishing/read", (route) =>
		route.fulfill({ json: { success: true, data: [shell] } }),
	);
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "Open publish", exact: true }).click();
	await expect(
		page.getByText(
			"Nova made an empty app here on an earlier try. Uploading fills it in.",
			{ exact: true },
		),
	).toBeVisible();
	if (
		await page
			.getByRole("button", { name: "Continue", exact: true })
			.isVisible()
	)
		await reviewDestination(page);
	await page.getByRole("button", { name: "Upload", exact: true }).click();
	await expect(
		page.getByText("Your app is on CommCare HQ", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByText("Your app is updated on CommCare HQ", { exact: true }),
	).toHaveCount(0);
});

test("native CCZ download is made for a project space the app is published to", async ({
	page,
}) => {
	const asked: { server: string | null; domain: string | null }[] = [];
	await page.route("**/publishing/download/ccz?*", (route) => {
		const url = new URL(route.request().url());
		asked.push({
			server: url.searchParams.get("server"),
			domain: url.searchParams.get("domain"),
		});
		return route.fulfill({ json: { ok: true } });
	});
	async function targets(
		data: { targets: unknown[]; heldFromHq: string[]; webAppsOnly?: boolean },
		query = "",
	) {
		await open(page, query);
		await page.route("**/publishing/download-targets", (route) =>
			route.fulfill({
				json: { success: true, data: { webAppsOnly: false, ...data } },
			}),
		);
		await page.keyboard.press("Escape");
		await page
			.getByRole("button", { name: "Open publish", exact: true })
			.click();
		await choose(page, "Publish option", "CommCare mobile app file", false);
	}

	await targets({ targets: [], heldFromHq: [] });
	await expect(
		page.getByText(
			"A CCZ signs workers in to one project space and sends their forms there, so it is made for a project space this app is published to. Once the app is published, you can download the CCZ for that space.",
			{ exact: true },
		),
	).toBeVisible();
	await expect(
		page.getByRole("combobox", { name: "Project space", exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Download CCZ", exact: true }),
	).toHaveCount(0);
	await page
		.getByRole("button", { name: "Publish to CommCare HQ", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Continue", exact: true }),
	).toBeVisible();

	const held = [
		'CommCare HQ can\'t yet find the cases for "Child care" from several cases selected in "Parents".',
	];
	await targets({ targets: [], heldFromHq: held });
	await expect(
		page.getByText(
			"A CCZ signs workers in to one project space and sends their forms there, so it is made for a project space this app is published to. This app can't be published to CommCare HQ as it is, so it has no CCZ yet.",
			{ exact: true },
		),
	).toBeVisible();
	await expect(page.getByText(held[0], { exact: true })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Download CCZ", exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Publish to CommCare HQ", exact: true }),
	).toHaveCount(0);

	await targets({
		targets: [{ server: "india", domain: "alpha" }],
		heldFromHq: [],
	});
	await expect(
		page.getByRole("combobox", { name: "Project space", exact: true }),
	).toHaveText("alpha on India");
	if (
		await page
			.getByRole("button", { name: "Continue", exact: true })
			.isVisible()
	)
		await reviewDestination(page);
	await page.getByRole("button", { name: "Download CCZ", exact: true }).click();
	await expect(
		page.getByText("Mobile app file downloaded", { exact: true }),
	).toBeVisible();
	expect(asked.at(-1)).toEqual({ server: "india", domain: "alpha" });

	await targets({
		targets: [
			{ server: "india", domain: "alpha" },
			{ server: "production", domain: "alpha" },
		],
		heldFromHq: [],
	});
	await expect(
		page.getByRole("button", { name: "Continue", exact: true }),
	).toBeDisabled();
	await choose(page, "Project space", "alpha on US");
	if (
		await page
			.getByRole("button", { name: "Continue", exact: true })
			.isVisible()
	)
		await reviewDestination(page);
	await page.getByRole("button", { name: "Download CCZ", exact: true }).click();
	await expect(
		page.getByText("Mobile app file downloaded", { exact: true }),
	).toBeVisible();
	expect(asked.at(-1)).toEqual({ server: "production", domain: "alpha" });
});

test("native CCZ offers the project space a publish just reached, without reopening", async ({
	page,
}) => {
	await open(page);
	await page.route("**/publishing/download-targets", (route) =>
		route.fulfill({
			json: {
				success: true,
				data: { targets: [], heldFromHq: [], webAppsOnly: false },
			},
		}),
	);
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "Open publish", exact: true }).click();
	await page.route("**/api/commcare/upload", (route) =>
		route.fulfill({
			json: {
				success: true,
				hq_app_action: "created",
				url: "https://india.commcarehq.org/a/alpha/apps/view/hq-app/",
				warnings: [],
				deployment: null,
				preview_project_space: "alpha",
			} satisfies PublishResponseBody,
		}),
	);
	/* The publish lands on the space; the ledger now names it. */
	await page.route("**/publishing/download-targets", (route) =>
		route.fulfill({
			json: {
				success: true,
				data: {
					targets: [{ server: "india", domain: "alpha" }],
					heldFromHq: [],
					webAppsOnly: false,
				},
			},
		}),
	);
	if (
		await page
			.getByRole("button", { name: "Continue", exact: true })
			.isVisible()
	)
		await reviewDestination(page);
	await page.getByRole("button", { name: "Upload", exact: true }).click();
	await expect(
		page.getByText("Your app is on CommCare HQ", { exact: true }),
	).toBeVisible();
	await choose(page, "Publish option", "CommCare mobile app file", false);
	await expect(
		page.getByRole("combobox", { name: "Project space", exact: true }),
	).toHaveText("alpha on India");
	await expect(
		page.getByRole("button", { name: "Continue", exact: true }),
	).toBeEnabled();
});

test("native import file download lists the guide's steps once the file arrives", async ({
	page,
}) => {
	const steps = manualImportGuide({
		appFileName: "Endpoint app",
		lookupTags: ["districts"],
		managedLookupFiles: [],
		hasMedia: false,
		versionFloor: "2.57",
		capabilities: [],
		planFeatures: [],
		logo: null,
		runsInWebApps: true,
		readsLocations: false,
		sendsToConnect: false,
		formEntrySync: false,
		commtrack: false,
		sameTypeChildLinks: [],
		distanceSearches: [],
	});
	await page.route("**/api/compile/json", (route) =>
		route.fulfill({
			body: "zip",
			contentType: "application/zip",
			headers: {
				[MANUAL_IMPORT_GUIDE_HEADER]: encodeManualImportGuide(steps),
			},
		}),
	);
	await open(page, "viewer=true", false);
	await choose(page, "Publish option", "CommCare HQ app file", false);
	/* The field's description below the chosen option, not the option's own. */
	await expect(page.locator("#publish-target-description")).toHaveText(
		"Download a ZIP to import into CommCare HQ",
	);
	await reviewDestination(page);
	await page.getByRole("button", { name: "Download ZIP", exact: true }).click();
	await expect(
		page.getByText("CommCare HQ app file downloaded", { exact: true }),
	).toBeVisible();
	const listed = page.getByRole("listitem").filter({
		has: page.getByText(steps[0].title, { exact: true }),
	});
	await expect(listed).toHaveCount(1);
	const titles = await page
		.locator("ol > li > p:first-child")
		.allTextContents();
	expect(titles).toEqual(steps.map((step) => step.title));
	await expect(
		page.getByText("This app needs CommCare 2.57 or later.", { exact: false }),
	).toBeVisible();
});

test("native import file download without a guide header still lands", async ({
	page,
}) => {
	await page.route("**/api/compile/json", (route) =>
		route.fulfill({ body: "zip", contentType: "application/zip" }),
	);
	await open(page, "viewer=true", false);
	await choose(page, "Publish option", "CommCare HQ app file");
	await page.getByRole("button", { name: "Download ZIP", exact: true }).click();
	await expect(
		page.getByText("CommCare HQ app file downloaded", { exact: true }),
	).toBeVisible();
	await expect(page.locator("ol > li")).toHaveCount(0);
});

/** A deployment on alpha, as a landed publish answers with it. */
function landedView(
	confirmations: DeploymentView["deployment"]["confirmations"],
): DeploymentView {
	return {
		deployment: {
			deployment: {
				id: "deployment",
				appId: "native-publishing",
				projectId: "native-project",
				server: "production",
				domain: "alpha",
				state: "uploaded",
				resumePhase: null,
				phases: NO_DEPLOYMENT_PHASE_OUTCOMES,
				createdBy: "native-user",
				createdAt: "2026-10-01T00:00:00Z",
				updatedAt: "2026-10-01T00:00:00Z",
				lastObservedAt: null,
				offeredLogoContentHash: null,
				targetEmptyCaseListText: null,
				endings: 0,
			},
			active: [],
			superseded: [],
			confirmations,
		},
		artifact: buildSetupArtifact({
			doc: endpointWireFixture("multiple"),
			server: "production",
			domain: "alpha",
			hqAppId: null,
			locations: [],
		}),
		leftBehind: [],
		kept: null,
		firstPublish: null,
	};
}

test("native Refresh from CommCare HQ reads the kept list again, keeps it through a read that did not happen, and shows what changed", async ({
	page,
}) => {
	const shownKept = {
		labels: ["fuzzy-search"],
		valuesDigest: "kept-before",
		observedAt: "2026-10-01T12:00:00Z",
	} as const;
	const readKept = {
		labels: ["fuzzy-search", "required-question-asterisk"],
		valuesDigest: "kept-after",
		observedAt: "2026-10-02T12:00:00Z",
	} as const;
	const asked: unknown[] = [];
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/commcare/upload", (route) =>
		route.fulfill({
			json: {
				success: true,
				hq_app_action: "updated",
				url: "https://www.commcarehq.org/a/alpha/apps/view/hq-app/",
				warnings: [],
				deployment: landedView([]).deployment,
				setup_artifact: landedView([]).artifact,
				kept: shownKept,
				preview_project_space: "alpha",
				logo_step: null,
			} satisfies PublishResponseBody,
		}),
	);
	await page.route("**/publishing/refresh-kept", async (route) => {
		asked.push(route.request().postDataJSON());
		if (asked.length === 1) {
			/* Held until the card has shown the read in flight. */
			await held;
			return route.fulfill({
				json: {
					success: true,
					data: { kind: "key-not-accepted" },
				} satisfies DeploymentActionResult<KeptRefreshView>,
			});
		}
		return route.fulfill({
			json: {
				success: true,
				data: {
					kind: "refreshed",
					deployment: {
						...landedView([]),
						kept: readKept,
						preview: { projectSpace: "alpha", targetFacts: null },
					},
				},
			} satisfies DeploymentActionResult<KeptRefreshView>,
		});
	});
	try {
		await open(page);
		await page.getByRole("button", { name: "Upload", exact: true }).click();
		await expect(
			page.getByText("Your app is updated on CommCare HQ", { exact: true }),
		).toBeVisible();
		const lead = page.getByText(
			/^These stay as they are in CommCare HQ, as it held them on .+:$/,
		);
		const kept = page.locator("[data-kept-values]").getByRole("listitem");
		await expect(lead).toBeVisible();
		await expect(kept).toHaveText([KEPT_LABELS["fuzzy-search"]]);
		/* The date the card shows, as the reader's browser words it. */
		const shownDate = (await lead.textContent())
			?.replace(
				/^These stay as they are in CommCare HQ, as it held them on /,
				"",
			)
			.replace(/:$/, "");
		expect(shownDate).toBeTruthy();

		await page
			.getByRole("button", { name: KEPT_REFRESH_BUTTON, exact: true })
			.click();
		await expect(
			page.getByRole("button", {
				name: KEPT_REFRESH_BUTTON_PENDING,
				exact: true,
			}),
		).toBeDisabled();
		release();
		/* A read that did not happen is an alert under the list, and the list
		 * and its date stay as they were. */
		await expect(page.getByRole("alert")).toHaveText(
			keptRefreshSentence(
				{ kind: "key-not-accepted", changed: false },
				{ date: shownDate ?? "", space: "alpha" },
			),
		);
		await expect(lead).toHaveText(keptLead(shownDate ?? "", true));
		await expect(kept).toHaveText([KEPT_LABELS["fuzzy-search"]]);

		await page
			.getByRole("button", { name: KEPT_REFRESH_BUTTON, exact: true })
			.click();
		/* A read that found a change says so and shows the new list. */
		await expect(
			page.getByRole("status").filter({
				hasText: keptRefreshSentence(
					{ kind: "refreshed", changed: true },
					{ date: shownDate ?? "", space: "alpha" },
				),
			}),
		).toBeVisible();
		await expect(kept).toHaveText([
			KEPT_LABELS["fuzzy-search"],
			KEPT_LABELS["required-question-asterisk"],
		]);
		await expect(page.getByRole("alert")).toHaveCount(0);
		expect(asked).toEqual([
			{ appId: "native-publishing", server: "production", domain: "alpha" },
			{ appId: "native-publishing", server: "production", domain: "alpha" },
		]);
	} finally {
		release();
	}
});

test("native publish asks for each plan feature and project-space setting before the first press, holds Upload until each is ticked, and lands with the logo step", async ({
	page,
}) => {
	const sent: Record<string, unknown>[] = [];
	await open(page);
	/* Registered after open's, so it is the answer the next check reads. */
	await page.route("**/publishing/compatibility?*", (route) =>
		route.fulfill({
			json: {
				ok: true,
				report: report("alpha"),
				confirmations: {
					plan_features: [
						{
							...PLAN_FEATURES["web-apps"],
							reasons: ["This app runs in Web Apps."],
							where_missing: WEB_APPS_WHERE_MISSING,
							state: "needs_confirmation",
						},
						{
							...PLAN_FEATURES["worker-records"],
							reasons: ["Visit reads worker information."],
							where_missing: null,
							state: "needs_confirmation",
						},
					],
					flat_location_fixture: {
						label: FLAT_LOCATION_FIXTURE.label,
						consequence: FLAT_LOCATION_FIXTURE.consequence,
						reasons: [
							"Visit sets a case's owner from a place in your organization.",
						],
						where_missing: FLAT_LOCATION_FIXTURE.whereMissing,
						state: "needs_confirmation",
					},
					connect_forwarder: {
						label: CONNECT_FORWARDER.label,
						consequence: CONNECT_FORWARDER.consequence,
						reasons: ["Visit sends a deliver unit to CommCare Connect."],
						where_missing: CONNECT_FORWARDER.whereMissing,
						state: "needs_confirmation",
					},
					form_entry_sync_off: {
						label: FORM_ENTRY_SYNC_OFF.label,
						consequence: FORM_ENTRY_SYNC_OFF.consequence,
						reasons: [
							"Visit works on a case chosen in Patients, a menu with Search.",
						],
						where_missing: SYNC_WHERE_MISSING,
						state: "needs_confirmation",
					},
				},
			},
		}),
	);
	await page.route("**/api/commcare/upload", (route) => {
		sent.push(route.request().postDataJSON());
		return route.fulfill({
			json: {
				success: true,
				hq_app_action: "created",
				url: "https://www.commcarehq.org/a/alpha/apps/view/hq-app/",
				warnings: [],
				deployment: null,
				preview_project_space: "alpha",
				logo_step: {
					assetId: "asset-logo",
					fileName: "logo.png",
					changed: true,
				},
			} satisfies PublishResponseBody,
		});
	});
	await page.route("**/api/media/asset-logo", (route) =>
		route.fulfill({
			status: 200,
			contentType: "image/png",
			body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
		}),
	);
	await page.getByRole("button", { name: "Check again", exact: true }).click();
	const upload = page.getByRole("button", { name: "Upload", exact: true });
	await page
		.getByRole("button", {
			name: "Details about Worker records (user cases)",
			exact: true,
		})
		.click();
	await expect(
		page.getByText("Visit reads worker information.", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByText(FLAT_LOCATION_FIXTURE.question("alpha"), { exact: true }),
	).toBeVisible();
	await page
		.getByRole("button", {
			name: "Details about Web-Based Apps (CloudCare)",
			exact: true,
		})
		.click();
	await expect(
		page.getByText(WEB_APPS_WHERE_MISSING, { exact: true }),
	).toBeVisible();
	await expect(upload).toBeDisabled();
	await page
		.getByRole("checkbox", {
			name: "This project space has it Web-Based Apps (CloudCare)",
		})
		.check();
	await page
		.getByRole("checkbox", {
			name: "This project space has it Worker records (user cases)",
		})
		.check();
	await page
		.getByRole("checkbox", { name: "It still does The flat location list" })
		.check();
	await expect(upload).toBeDisabled();
	await page
		.getByRole("checkbox", { name: "It does A Connect forwarder" })
		.check();
	await expect(upload).toBeDisabled();
	await expect(
		page.getByText(FORM_ENTRY_SYNC_OFF.question("alpha"), { exact: true }),
	).toBeVisible();
	await page
		.getByRole("button", {
			name: `Details about ${FORM_ENTRY_SYNC_OFF.label}`,
			exact: true,
		})
		.click();
	await expect(
		page.getByText(SYNC_WHERE_MISSING, { exact: true }),
	).toBeVisible();
	await page
		.getByRole("checkbox", {
			name: `${FORM_ENTRY_SYNC_OFF.confirmLabel} ${FORM_ENTRY_SYNC_OFF.label}`,
		})
		.check();
	await expect(upload).toBeEnabled();
	await upload.click();
	await expect(
		page.getByText(LOGO_UPLOAD_STEP_TEXT, { exact: true }),
	).toBeVisible();
	expect(sent).toHaveLength(1);
	expect(sent[0].confirm).toEqual([
		{ kind: "plan-feature", subject: "web-apps" },
		{ kind: "plan-feature", subject: "worker-records" },
		{ kind: "flat-location-fixture" },
		{ kind: "connect-forwarder" },
		{ kind: "form-entry-sync-off" },
	]);
	const download = page.waitForEvent("download");
	await page
		.getByRole("link", { name: "Download logo.png", exact: true })
		.click();
	expect((await download).suggestedFilename()).toBe("logo.png");
});

test("native publish answers a confirmation refusal with the same rows, and Withdraw on the record makes the next publish ask again", async ({
	page,
}) => {
	const sent: Record<string, unknown>[] = [];
	const withdrawn: Record<string, unknown>[] = [];
	const lookupTables: DeploymentConfirmationNeeded = {
		kind: "plan-feature",
		subject: "lookup-tables",
		label: PLAN_FEATURES["lookup-tables"].label,
		plans: PLAN_FEATURES["lookup-tables"].plans,
		consequence: PLAN_FEATURES["lookup-tables"].consequence,
		reasons: ["The app reads data from a lookup table."],
		whereMissing: null,
	};
	await page.route("**/api/commcare/upload", (route) => {
		sent.push(route.request().postDataJSON());
		return route.fulfill({
			json:
				sent.length === 1
					? ({
							success: false,
							refusal: {
								phase: "preflight",
								failure: {
									code: "hq_confirmation_needed",
									message:
										"“alpha” needs a few things Nova can't check from here. Once you confirm that the project space has each one below, publishing can continue.",
									details: [],
								},
								resourceConflicts: [],
								remoteChanges: [],
								confirmationsNeeded: [lookupTables],
								webAppsChange: null,
								placementMoves: null,
							},
							preview_project_space: null,
						} satisfies PublishResponseBody)
					: ({
							success: true,
							hq_app_action: "created",
							url: "https://www.commcarehq.org/a/alpha/apps/view/hq-app/",
							warnings: [],
							deployment: landedView([
								{
									kind: "plan-feature",
									subject: "lookup-tables",
									confirmedByName: "Ada",
									confirmedAt: "2026-10-01T12:00:00Z",
								},
							]).deployment,
							setup_artifact: landedView([]).artifact,
							preview_project_space: "alpha",
							logo_step: null,
						} satisfies PublishResponseBody),
		});
	});
	await page.route("**/publishing/withdraw", (route) => {
		withdrawn.push(route.request().postDataJSON());
		return route.fulfill({
			json: { success: true, data: landedView([]) },
		});
	});
	await open(page);
	const upload = page.getByRole("button", { name: "Upload", exact: true });
	await upload.click();
	const confirm = page.getByRole("checkbox", {
		name: "This project space has it Lookup Tables",
	});
	await expect(confirm).toBeVisible();
	await expect(upload).toBeDisabled();
	await confirm.check();
	await upload.click();
	expect(sent[0]).toMatchObject({ confirm: [] });
	expect(sent[1]).toMatchObject({
		confirm: [{ kind: "plan-feature", subject: "lookup-tables" }],
	});
	await page
		.getByRole("button", { name: "Withdraw Lookup Tables", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Withdraw Lookup Tables", exact: true }),
	).toHaveCount(0);
	expect(withdrawn).toEqual([
		{
			appId: "native-publishing",
			server: "production",
			domain: "alpha",
			confirmation: { kind: "plan-feature", subject: "lookup-tables" },
		},
	]);
	/* With the confirmation withdrawn, the check lists the feature again. */
	await page.route("**/publishing/compatibility?*", (route) =>
		route.fulfill({
			json: {
				ok: true,
				report: report("alpha"),
				confirmations: {
					plan_features: [
						{
							...lookupTables,
							id: "lookup-tables",
							where_missing: null,
							state: "needs_confirmation",
						},
					],
					flat_location_fixture: null,
					connect_forwarder: null,
				},
			},
		}),
	);
	await page.getByRole("button", { name: "Done", exact: true }).click();
	await page.getByRole("button", { name: "Open publish", exact: true }).click();
	await reviewDestination(page);
	await expect(
		page.getByRole("checkbox", {
			name: "This project space has it Lookup Tables",
		}),
	).not.toBeChecked();
	await expect(upload).toBeDisabled();
});

/*
 * What the check reports, word for word as `commtrackReasons` names it
 * (lib/commcare/__tests__/planPrivileges.test.ts): a form of an app on
 * Android alone, Restock, whose source holds the session's supply point text
 * (the reason the planner reads off the emitted source, which no label or
 * string writes whole), and an advanced menu, Households, whose case list is its own
 * menu item beside its forms, whose entry CommCare HQ's build gives a
 * product step under CommCare Supply. The check reads server-only modules,
 * so the route answers with its report here.
 */
for (const { subject, reason } of [
	{
		subject: "a form whose source names the session's supply point",
		reason:
			"Restock holds the text instance('commcaresession')/session/data/supply_point_id, which CommCare HQ reads as the session's supply point.",
	},
	{
		subject: "an advanced menu whose case list is its own menu item",
		reason:
			"Households shows its case list as its own menu item, in a menu CommCare HQ builds as advanced.",
	},
]) {
	test(`asks whether CommCare Supply is off for ${subject}`, async ({
		page,
	}) => {
		const checks = {
			plan_features: [],
			flat_location_fixture: null,
			connect_forwarder: null,
			form_entry_sync_off: null,
			commtrack_off: {
				label: COMMTRACK_OFF.label,
				consequence: COMMTRACK_OFF.consequence,
				reasons: [reason],
				where_missing: COMMTRACK_OFF.whereMissing,
				state: "needs_confirmation" as const,
			},
			placement_moves: null,
		};
		const sent: Record<string, unknown>[] = [];
		await open(page);
		/* Registered after open's, so it is the answer the next check reads. */
		await page.route("**/publishing/compatibility?*", (route) =>
			route.fulfill({
				json: { ok: true, report: report("alpha"), confirmations: checks },
			}),
		);
		await page.route("**/api/commcare/upload", (route) => {
			sent.push(route.request().postDataJSON());
			return route.fulfill({
				json: {
					success: true,
					hq_app_action: "created",
					url: "https://www.commcarehq.org/a/alpha/apps/view/hq-app/",
					warnings: [],
					deployment: landedView([
						{
							kind: "commtrack-off",
							subject: "commtrack-off",
							confirmedByName: "Ada",
							confirmedAt: "2026-10-01T12:00:00Z",
						},
					]).deployment,
					setup_artifact: landedView([]).artifact,
					preview_project_space: "alpha",
					logo_step: null,
				} satisfies PublishResponseBody,
			});
		});
		await page
			.getByRole("button", { name: "Check again", exact: true })
			.click();
		const upload = page.getByRole("button", { name: "Upload", exact: true });
		await expect(
			page.getByText(COMMTRACK_OFF.question("alpha"), { exact: true }),
		).toBeVisible();
		await page
			.getByRole("button", {
				name: `Details about ${COMMTRACK_OFF.label}`,
				exact: true,
			})
			.click();
		await expect(page.getByText(reason, { exact: true })).toBeVisible();
		await expect(upload).toBeDisabled();
		await page
			.getByRole("checkbox", {
				name: `${COMMTRACK_OFF.confirmLabel} ${COMMTRACK_OFF.label}`,
			})
			.check();
		await expect(upload).toBeEnabled();
		await upload.click();
		/* The record the publish landed with holds the answer, and offers it back. */
		await expect(
			page.getByRole("button", {
				name: `Withdraw ${COMMTRACK_OFF.label}`,
				exact: true,
			}),
		).toBeVisible();
		expect(sent).toHaveLength(1);
		expect(sent[0].confirm).toEqual([{ kind: "commtrack-off" }]);
	});
}

test("native publish below the CommCare version floor links to the app whose settings raise it", async ({
	page,
}) => {
	const message =
		"The app on “alpha” is set to CommCare 2.53.0, and Nova's apps need 2.57 or later. You can raise the CommCare version in that app's settings in CommCare HQ, then publish again. Phones on an older CommCare can no longer install or update the app after that. Saving that page can also set the app's other settings there, so Nova may show you what changed before it publishes.";
	await page.route("**/api/commcare/upload", (route) =>
		route.fulfill({
			json: {
				success: false,
				refusal: {
					phase: "preflight",
					failure: {
						code: "hq_app_version_below_floor",
						message,
						details: [],
					},
					resourceConflicts: [],
					remoteChanges: [],
					confirmationsNeeded: [],
					webAppsChange: null,
					placementMoves: null,
				},
				url: "https://www.commcarehq.org/a/alpha/apps/view/hq-app/",
				preview_project_space: null,
			} satisfies PublishResponseBody,
		}),
	);
	await open(page);
	if (
		await page
			.getByRole("button", { name: "Continue", exact: true })
			.isVisible()
	)
		await reviewDestination(page);
	await page.getByRole("button", { name: "Upload", exact: true }).click();
	await expect(page.getByText(message, { exact: true })).toBeVisible();
	await expect(
		page.getByRole("link", { name: "Open the app in CommCare HQ" }),
	).toHaveAttribute(
		"href",
		"https://www.commcarehq.org/a/alpha/apps/view/hq-app/",
	);
});
test("native publish over an application profile naming a removed language shows a line per profile and links to the app", async ({
	page,
}) => {
	const message =
		"Application profiles of the app on “alpha” include languages this app no longer has, so Nova stopped before sending anything. Nova can't change application profiles in CommCare HQ. You can take those languages out of each profile listed below, or remove the profile, on the Application Profiles tab of the app's Releases page there, then publish again. That tab shows only where the project space's plan includes application profiles. Left as they are, CommCare HQ would build those profiles with languages that have no text of their own, or couldn't build them at all.";
	const lines = [
		"“Field team”: French (fra), Hausa (hau)",
		"A profile with no name: French (fra), the only language it has",
	];
	await page.route("**/api/commcare/upload", (route) =>
		route.fulfill({
			json: {
				success: false,
				refusal: {
					phase: "preflight",
					failure: {
						code: "hq_build_profile_language_missing",
						message,
						details: lines,
					},
					resourceConflicts: [],
					remoteChanges: [],
					confirmationsNeeded: [],
					webAppsChange: null,
					placementMoves: null,
				},
				url: "https://www.commcarehq.org/a/alpha/apps/view/hq-app/",
				preview_project_space: null,
			} satisfies PublishResponseBody,
		}),
	);
	await open(page);
	if (
		await page
			.getByRole("button", { name: "Continue", exact: true })
			.isVisible()
	)
		await reviewDestination(page);
	await page.getByRole("button", { name: "Upload", exact: true }).click();
	await expect(page.getByText(message, { exact: true })).toBeVisible();
	for (const line of lines) {
		await expect(page.getByText(line, { exact: true })).toBeVisible();
	}
	await expect(
		page.getByRole("link", { name: "Open the app in CommCare HQ" }),
	).toHaveAttribute(
		"href",
		"https://www.commcarehq.org/a/alpha/apps/view/hq-app/",
	);
});
test("native publish says what taking a table over does, and shows a table HQ holds content in as a stop with nothing to tick", async ({
	page,
}) => {
	const message =
		"Nova can't keep everything CommCare HQ holds in this app's lookup tables yet, so it stopped before sending anything: publishing over them would remove it. You can give a table a new export tag in Project data, and Nova then publishes its own table and leaves CommCare HQ's as it is.";
	const line =
		"The table Clinics holds field properties and rows limited to certain users in CommCare HQ.";
	const answers: PublishResponseBody[] = [
		refusal,
		{
			success: false,
			refusal: {
				phase: "preflight",
				failure: {
					code: "hq_table_content_unsupported",
					message,
					details: [line],
				},
				resourceConflicts: [],
				remoteChanges: [],
				confirmationsNeeded: [],
				webAppsChange: null,
				placementMoves: null,
			},
			preview_project_space: null,
		},
	];
	await page.route("**/api/commcare/upload", (route) =>
		route.fulfill({ json: answers.shift() }),
	);
	await open(page);
	if (
		await page
			.getByRole("button", { name: "Continue", exact: true })
			.isVisible()
	)
		await reviewDestination(page);
	await page.getByRole("button", { name: "Upload", exact: true }).click();
	await expect(
		page.getByText(LOOKUP_ADOPTION_NOTE, { exact: true }),
	).toBeVisible();
	await page.getByRole("checkbox", { name: "Clinics (clinics)" }).check();
	if (
		await page
			.getByRole("button", { name: "Continue", exact: true })
			.isVisible()
	)
		await reviewDestination(page);
	await page.getByRole("button", { name: "Upload", exact: true }).click();
	await expect(page.getByText(message, { exact: true })).toBeVisible();
	await expect(page.getByText(line, { exact: true })).toBeVisible();
	// Neither an adoption nor a discard keeps the content, so nothing is offered.
	await expect(page.getByRole("checkbox")).toHaveCount(0);
});

test("native publish asks before turning Web Apps on for the app, holds Upload until it is ticked, and sends the answer with the next upload", async ({
	page,
}) => {
	const sent: Record<string, unknown>[] = [];
	const change = {
		from: false,
		to: true,
		changedInHq: true,
		since: { kind: "published" as const },
	};
	const message = webAppsChangeMessage("alpha", change);
	await page.route("**/api/commcare/upload", (route) => {
		sent.push(route.request().postDataJSON());
		return route.fulfill({
			json:
				sent.length === 1
					? ({
							success: false,
							refusal: {
								phase: "preflight",
								failure: {
									code: "hq_web_apps_change",
									message,
									details: [],
								},
								resourceConflicts: [],
								remoteChanges: [],
								confirmationsNeeded: [],
								webAppsChange: change,
								placementMoves: null,
							},
							preview_project_space: null,
						} satisfies PublishResponseBody)
					: ({
							success: true,
							hq_app_action: "updated",
							url: "https://www.commcarehq.org/a/alpha/apps/view/hq-app/",
							warnings: [],
							deployment: null,
							preview_project_space: "alpha",
						} satisfies PublishResponseBody),
		});
	});
	await open(page);
	const upload = page.getByRole("button", { name: "Upload", exact: true });
	await upload.click();
	await expect(
		page.getByRole("heading", { name: WEB_APPS_CHANGE_HEADING, exact: true }),
	).toBeVisible();
	const answer = page.getByRole("checkbox", {
		name: "Turn Web Apps on for this app",
		exact: true,
	});
	await expect(answer).not.toBeChecked();
	await expect(upload).toBeDisabled();
	await answer.check();
	await expect(upload).toBeEnabled();
	await upload.click();
	await expect(
		page.getByText("Your app is updated on CommCare HQ", { exact: true }),
	).toBeVisible();
	expect(sent).toHaveLength(2);
	expect(sent[0]).not.toHaveProperty("confirmWebApps");
	expect(sent[1]).toMatchObject({ confirmWebApps: true });
});

test("offers to move Save to Case changes and publishes once the person ticks Move them and publish", async ({
	page,
}) => {
	/* The refusal a publish answers for an app whose held Save to Case
	 * operation a basic slot can express, where the plan's Save to Case is not
	 * confirmed: the need, and the offer `placementMoveOffer` derives
	 * (`lib/deployment/__tests__/placementMoves.test.ts` holds the
	 * derivation). */
	const sent: Record<string, unknown>[] = [];
	const saveToCase: DeploymentConfirmationNeeded = {
		kind: "plan-feature",
		subject: "advanced-case-actions",
		label: PLAN_FEATURES["advanced-case-actions"].label,
		plans: PLAN_FEATURES["advanced-case-actions"].plans,
		consequence: PLAN_FEATURES["advanced-case-actions"].consequence,
		reasons: [
			"Register household saves a case change in a Save to Case block.",
		],
		whereMissing: saveToCaseWhereMissing(true, ["Register household"]),
	};
	const moveSentence = movedToCaseManagementSentence(
		"Register household",
		"makes a new household case",
	);
	const offer: PlacementMoveOfferView = {
		reason: "save-to-case",
		digest: "a".repeat(64),
		moves: [
			{
				form: "Register household",
				change: "makes a new household case",
				sentence: moveSentence,
			},
		],
		asksChildCases: false,
	};
	await page.route("**/api/commcare/upload", (route) => {
		sent.push(route.request().postDataJSON());
		return route.fulfill({
			json:
				sent.length === 1
					? ({
							success: false,
							refusal: {
								phase: "preflight",
								failure: {
									code: "hq_confirmation_needed",
									message:
										"“alpha” needs a few things Nova can't check from here. Once you confirm that the project space has each one below, publishing can continue.",
									details: [],
								},
								resourceConflicts: [],
								remoteChanges: [],
								confirmationsNeeded: [saveToCase],
								webAppsChange: null,
								placementMoves: offer,
							},
							placements: { recorded: 1, moved: 0 },
							preview_project_space: null,
						} satisfies PublishResponseBody)
					: ({
							success: true,
							hq_app_action: "created",
							url: "https://www.commcarehq.org/a/alpha/apps/view/hq-app/",
							warnings: [],
							deployment: null,
							placements: { recorded: 1, moved: 1 },
							preview_project_space: "alpha",
						} satisfies PublishResponseBody),
		});
	});
	await open(page);
	const upload = page.getByRole("button", { name: "Upload", exact: true });
	await upload.click();
	await expect(
		page.getByRole("heading", {
			name: SAVE_TO_CASE_OFFER_HEADING,
			exact: true,
		}),
	).toBeVisible();
	await expect(
		page.getByText(saveToCaseOfferBody(false), { exact: true }),
	).toBeVisible();
	await expect(page.getByText(moveSentence, { exact: true })).toBeVisible();
	const hasIt = page.getByRole("checkbox", {
		name: "This project space has it Save to Case",
	});
	const move = page.getByRole("checkbox", {
		name: ACCEPT_PLACEMENT_MOVES_LABEL,
		exact: true,
	});
	await expect(move).not.toBeChecked();
	await expect(upload).toBeDisabled();
	/* The two boxes answer one question, so ticking one unticks the other. */
	await hasIt.check();
	await expect(upload).toBeEnabled();
	await move.check();
	await expect(hasIt).not.toBeChecked();
	await expect(upload).toBeEnabled();
	await upload.click();
	await expect(
		page.getByText("Your app is on CommCare HQ", { exact: true }),
	).toBeVisible();
	expect(sent).toHaveLength(2);
	expect(sent[0]).not.toHaveProperty("acceptPlacementMoves");
	expect(sent[1]).toMatchObject({
		confirm: [],
		acceptPlacementMoves: { reason: "save-to-case", digest: offer.digest },
	});
});

test("native CCZ of an app that runs in Web Apps only says why there is none", async ({
	page,
}) => {
	await open(page);
	await page.route("**/publishing/download-targets", (route) =>
		route.fulfill({
			json: {
				success: true,
				data: { targets: [], heldFromHq: [], webAppsOnly: true },
			},
		}),
	);
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "Open publish", exact: true }).click();
	/* The option stays offered and selectable: choosing it says why. */
	await choose(page, "Publish option", "CommCare mobile app file");
	await expect(
		page.getByText(WEB_APPS_ONLY_HAS_NO_CCZ, { exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("combobox", { name: "Project space", exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Download CCZ", exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Publish to CommCare HQ", exact: true }),
	).toHaveCount(0);
	/* The footer offers Close in place of the actions; the header's X shares
	 * that name, so the assertion reads the footer. */
	await expect(
		page
			.getByRole("dialog")
			.locator('[data-slot="dialog-footer"]')
			.getByRole("button", { name: "Close", exact: true }),
	).toBeVisible();
});

test("publish keeps a stable frame and explicit review while delayed checks arrive", async ({
	page,
}) => {
	await open(page, "", false);
	const dialog = page.getByRole("dialog", { name: "Publish app", exact: true });
	await expect(
		dialog.getByRole("heading", { name: "Publish app", exact: true }),
	).toBeFocused();
	await expect(
		page.getByRole("button", { name: "Upload", exact: true }),
	).toHaveCount(0);
	await test.info().attach("destination", {
		body: await dialog.screenshot({
			path: test.info().outputPath("destination.png"),
		}),
		contentType: "image/png",
	});
	const before = await dialog.boundingBox();
	await reviewDestination(page);
	await expect(
		page.getByRole("heading", { name: "Review and publish", exact: true }),
	).toBeFocused();
	let held: import("@playwright/test").Route | undefined;
	await page.route("**/publishing/compatibility?*", (route) => {
		held = route;
	});
	try {
		await page
			.getByRole("button", { name: "Check again", exact: true })
			.click();
		await expect.poll(() => Boolean(held)).toBe(true);
		await expect(
			page.getByRole("button", { name: "Upload", exact: true }),
		).toBeDisabled();
		expect(await dialog.boundingBox()).toEqual(before);
		const request = held;
		held = undefined;
		await request?.fulfill({
			json: {
				ok: true,
				report: report(),
				confirmations: {
					plan_features: Object.values(PLAN_FEATURES).map((feature) => ({
						...feature,
						reasons: ["A form uses this feature."],
						where_missing: "A project administrator can help.",
						state: "needs_confirmation",
					})),
					flat_location_fixture: null,
					connect_forwarder: null,
					form_entry_sync_off: null,
					commtrack_off: null,
					placement_moves: null,
				},
			},
		});
		await expect(
			page.getByRole("heading", {
				name: "Confirm for this project space",
				exact: true,
			}),
		).toBeVisible();
		expect(await dialog.boundingBox()).toEqual(before);
		await expect(
			page.getByRole("button", { name: "Upload", exact: true }),
		).toBeDisabled();
		await expect(page.getByText("A form uses this feature.")).toHaveCount(0);
		await test.info().attach("review-desktop", {
			body: await dialog.screenshot({
				path: test.info().outputPath("review-desktop.png"),
			}),
			contentType: "image/png",
		});
		await page.setViewportSize({ width: 390, height: 700 });
		await expect
			.poll(() =>
				dialog.evaluate((node) => node.scrollWidth - node.clientWidth),
			)
			.toBe(0);
		const footer = dialog.locator('[data-slot="dialog-footer"]');
		await expect(footer).toBeInViewport();
		await test.info().attach("review-mobile", {
			body: await dialog.screenshot({
				path: test.info().outputPath("review-mobile.png"),
			}),
			contentType: "image/png",
		});
		await page.getByRole("button", { name: "Back", exact: true }).click();
		await expect(
			page.getByRole("textbox", { name: "App name", exact: true }),
		).toHaveValue("Entry points");
		await expect(
			page.getByRole("heading", { name: "Choose a destination", exact: true }),
		).toBeFocused();
	} finally {
		await held?.abort();
		await page.goto("about:blank");
	}
});

test("changing HQ servers retires a same-named space's pending check and consent", async ({
	page,
}) => {
	await open(page);
	await page.route("**/api/commcare/upload", (route) =>
		route.fulfill({ json: refusal }),
	);
	await page.getByRole("button", { name: "Upload", exact: true }).click();
	await page
		.getByRole("checkbox", { name: "Clinics (clinics)", exact: true })
		.check();
	let held: import("@playwright/test").Route | undefined;
	await page.route("**/publishing/compatibility?*", (route) => {
		held = route;
	});
	try {
		await page.evaluate(() =>
			window.dispatchEvent(
				new CustomEvent("publishing-connection", {
					detail: {
						server: "india",
						domains: [{ name: "alpha", displayName: "Alpha India" }],
					},
				}),
			),
		);
		await expect(
			page.getByRole("heading", { name: "Choose a destination", exact: true }),
		).toBeVisible();
		await reviewDestination(page);
		await expect.poll(() => Boolean(held)).toBe(true);
		await expect(
			page.getByRole("checkbox", { name: "Clinics (clinics)", exact: true }),
		).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: "Upload", exact: true }),
		).toBeDisabled();
		const request = held;
		held = undefined;
		await request?.fulfill({ json: { ok: true, report: report() } });
		await expect(
			page.getByRole("button", { name: "Upload", exact: true }),
		).toBeEnabled();
		await page.getByRole("button", { name: "Upload", exact: true }).click();
		await expect(
			page.getByRole("checkbox", { name: "Clinics (clinics)", exact: true }),
		).not.toBeChecked();
	} finally {
		await held?.abort();
		await page.goto("about:blank");
	}
});

for (const cancel of [false, true]) {
	test(`upload waits for a pending edit${cancel ? " and stays canceled after dismissal" : " before sending"}`, async ({
		page,
	}) => {
		let save: import("@playwright/test").Route | undefined;
		let uploads = 0;
		await page.route("**/api/apps/native-publishing", (route) => {
			save = route;
		});
		await page.route("**/api/commcare/upload", (route) => {
			uploads++;
			return route.fulfill({ json: refusal });
		});
		try {
			await open(page);
			await page.keyboard.press("Escape");
			await page
				.getByRole("button", { name: "Edit document", exact: true })
				.click();
			await page
				.getByRole("button", { name: "Open publish", exact: true })
				.click();
			await reviewDestination(page);
			await page.getByRole("button", { name: "Upload", exact: true }).click();
			await expect(
				page.getByRole("button", { name: "Uploading", exact: true }),
			).toBeDisabled();
			await expect.poll(() => Boolean(save)).toBe(true);
			expect(uploads).toBe(0);
			if (cancel) await page.keyboard.press("Escape");
			const pending = save;
			save = undefined;
			await pending?.fulfill({ json: { seq: 1 } });
			if (cancel) {
				await page
					.getByRole("button", { name: "Open publish", exact: true })
					.click();
				await reviewDestination(page);
				await expect(
					page.getByRole("button", { name: "Upload", exact: true }),
				).toBeEnabled();
				expect(uploads).toBe(0);
			} else {
				await expect(
					page.getByRole("checkbox", {
						name: "Clinics (clinics)",
						exact: true,
					}),
				).toBeVisible();
				expect(uploads).toBe(1);
			}
		} finally {
			await save?.abort();
			await page.goto("about:blank");
		}
	});
}

test("a fresh review exposes compatibility failures while preserving refusal choices", async ({
	page,
}) => {
	await page.route("**/api/commcare/upload", (route) =>
		route.fulfill({ json: refusal }),
	);
	await open(page);
	await page.getByRole("button", { name: "Upload", exact: true }).click();
	const consent = page.getByRole("checkbox", {
		name: "Clinics (clinics)",
		exact: true,
	});
	await consent.check();
	await page.getByRole("button", { name: "Back", exact: true }).click();
	let check = 0;
	await page.route("**/publishing/compatibility?*", (route) => {
		check++;
		return route.fulfill({
			json:
				check === 1
					? { ok: false, message: "The fresh compatibility check failed" }
					: { ok: true, report: report("alpha", check === 2) },
		});
	});
	await reviewDestination(page);
	await expect(
		page.getByText("The fresh compatibility check failed", { exact: true }),
	).toBeVisible();
	await expect(consent).toBeChecked();
	await expect(
		page.getByRole("button", { name: "Upload", exact: true }),
	).toBeDisabled();
	await page.getByRole("button", { name: "Try again", exact: true }).click();
	await expect(
		page.getByText("“Alpha” needs more support to run the app", {
			exact: true,
		}),
	).toBeVisible();
	await expect(consent).toBeChecked();
	await expect(
		page.getByRole("button", { name: "Upload", exact: true }),
	).toBeDisabled();
	await page.getByRole("button", { name: "Check again", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Upload", exact: true }),
	).toBeEnabled();
	await expect(consent).toBeChecked();
});

// ── After an app is brought in ───────────────────────────────────────────

const BROUGHT_IN_AT = "2026-10-03T09:30:00Z";
const STOPPED_AT = "2026-10-20T15:00:00Z";
const FIRST_PUBLISH: FirstPublishView = {
	ids: ["forms-and-settings-rewritten", "case-names-checked"],
	touchesWorkers: true,
	of: "first-publish",
};

/** The live app mapping a bring-in records: `adopted`, with who and when. */
function broughtInMapping(): DeploymentResource {
	return {
		deploymentId: "deployment",
		kind: "app",
		novaResourceId: "native-publishing",
		remoteId: "hq-app",
		ownership: "adopted",
		pushedIdentity: null,
		adoptedAt: BROUGHT_IN_AT,
		adoptedBy: "native-user",
		pushedRevision: 1,
		pushedAt: BROUGHT_IN_AT,
		pushToken: "01992000-0000-7000-8000-000000000001",
		remoteRevision: null,
		remoteObservedAt: null,
		supersededAt: null,
		remoteMissingAt: null,
		adoptedByName: "Ada Lovelace",
		releasedAt: null,
		endedReason: null,
		endedByName: null,
		heldByAnotherApp: false,
	};
}

test("a card whose project space the check when the builder opened found changed says so and offers See what changed without a Refresh", async ({
	page,
}) => {
	await page.route("**/api/auth/get-session", (route) =>
		route.fulfill({ json: null }),
	);
	const reviews: unknown[] = [];
	await page.route("**/api/commcare/changes/review", async (route) => {
		reviews.push(route.request().postDataJSON());
		await route.fulfill({ status: 404, json: { error: "App not found" } });
	});
	await openSection(
		page,
		"editor",
		() => [landedView([])],
		"changed=production:alpha",
	);
	const found = page.getByText(
		hqChangedFoundLine(sincePhrase({ kind: "published" }, "alpha")),
		{ exact: true },
	);
	await expect(found).toBeVisible();
	await page
		.getByRole("button", { name: SEE_WHAT_CHANGED_ACTION, exact: true })
		.click();
	const dialog = page.getByRole("dialog", { name: HQ_CHANGES_DIALOG_TITLE });
	await expect(dialog).toBeVisible();
	/* A route that refuses the member says why, with nothing to check again. */
	await expect(
		dialog.getByText(HQ_CHANGES_NO_EDIT_ACCESS_LINE, { exact: true }),
	).toBeVisible();
	await expect(
		dialog.getByRole("button", { name: CHECK_AGAIN_ACTION, exact: true }),
	).toHaveCount(0);
	expect(reviews).toEqual([
		{ appId: "native-publishing", server: "production", domain: "alpha" },
	]);
});

test("a card whose project space the check did not name says nothing of it", async ({
	page,
}) => {
	await openSection(
		page,
		"editor",
		() => [landedView([])],
		"changed=production:beta",
	);
	/* The card is drawn, and says nothing of a change the check didn't find. */
	await expect(
		page.getByText("On CommCare HQ", { exact: true }).first(),
	).toBeVisible();
	await expect(
		page.getByText(
			hqChangedFoundLine(sincePhrase({ kind: "published" }, "alpha")),
			{ exact: true },
		),
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: SEE_WHAT_CHANGED_ACTION, exact: true }),
	).toHaveCount(0);
});

/** A deployment of the app brought in from `alpha`, not yet published to. */
function broughtInView(): DeploymentView {
	const landed = landedView([]);
	return {
		...landed,
		deployment: {
			...landed.deployment,
			active: [broughtInMapping()],
		},
		firstPublish: FIRST_PUBLISH,
	};
}

/** The same deployment once publishing there stopped. */
function stoppedView(): DeploymentView {
	const landed = landedView([]);
	return {
		...landed,
		deployment: {
			...landed.deployment,
			deployment: {
				...landed.deployment.deployment,
				state: "ended",
				endings: 1,
			},
			active: [],
			superseded: [
				{
					...broughtInMapping(),
					supersededAt: STOPPED_AT,
					endedReason: "stopped",
					endedByName: "Ada Lovelace",
				},
			],
		},
		firstPublish: null,
	};
}

/** A day as the card writes it, in the browser's own locale. */
function cardDate(page: Page, iso: string): Promise<string> {
	return page.evaluate(
		(at) =>
			new Date(at).toLocaleDateString(undefined, {
				day: "numeric",
				month: "long",
				year: "numeric",
			}),
		iso,
	);
}

/** The App setup Publishing section, its records answered from `read`. */
async function openSection(
	page: Page,
	role: "admin" | "editor",
	read: () => DeploymentView[],
	query = "",
) {
	await page.route("**/api/apps/native-publishing/stream?*", (route) =>
		route.fulfill({
			status: 200,
			contentType: "text/event-stream",
			body: "retry: 3600000\n\n",
		}),
	);
	await page.route("**/api/apps/native-publishing/presence", (route) =>
		route.fulfill({ json: [] }),
	);
	await page.route("**/publishing/lookup", (route) =>
		route.fulfill({
			json: {
				success: true,
				data: { projectId: "native-project", revision: "0", tables: [] },
			},
		}),
	);
	await page.route("**/publishing/read", (route) =>
		route.fulfill({ json: { success: true, data: read() } }),
	);
	await page.goto(`${peer.origin}/?section=true&role=${role}&${query}`);
}

test("a brought-in record says where it came from and that Nova hasn't published to it, and Stop publishing here ends it into the ended card", async ({
	page,
}) => {
	const stops: unknown[] = [];
	await page.route("**/publishing/stop", (route) => {
		stops.push(route.request().postDataJSON());
		return route.fulfill({
			json: {
				success: true,
				data: { view: stoppedView(), preview: null },
			},
		});
	});
	await openSection(page, "admin", () =>
		stops.length === 0 ? [broughtInView()] : [stoppedView()],
	);
	const broughtIn = await cardDate(page, BROUGHT_IN_AT);
	await expect(
		page.getByText(broughtInFromLine("alpha", broughtIn, "Ada Lovelace"), {
			exact: true,
		}),
	).toBeVisible();
	await expect(
		page.getByText(notPublishedYetLine(broughtIn), { exact: true }),
	).toBeVisible();
	await expect(
		page.getByText(STOP_PUBLISHING_HELPER, { exact: true }),
	).toBeVisible();

	await page
		.getByRole("button", { name: STOP_PUBLISHING_ACTION, exact: true })
		.click();
	const confirm = page.getByRole("alertdialog");
	await expect(
		confirm.getByRole("heading", {
			name: stopPublishingConfirmTitle("alpha"),
			exact: true,
		}),
	).toBeVisible();
	await confirm
		.getByRole("button", { name: STOP_PUBLISHING_CONFIRM, exact: true })
		.click();
	await expect(page.getByRole("alertdialog")).toHaveCount(0);

	const stopped = await cardDate(page, STOPPED_AT);
	await expect(
		page.getByText(
			endedLine(
				{
					byName: "Ada Lovelace",
					reason: "stopped",
					heldByAnotherApp: false,
				},
				stopped,
			),
			{ exact: true },
		),
	).toBeVisible();
	await expect(
		page.getByRole("link", { name: new RegExp(`^${ENDED_HQ_APP_LINK}`) }),
	).toHaveAttribute(
		"href",
		hqPlaceUrl(
			{ server: "production", domain: "alpha", remoteAppId: "hq-app" },
			{ kind: "app" },
		) ?? "",
	);
	/* The ended card draws no ladder, no Check status and no stop. */
	await expect(page.getByText("On CommCare HQ", { exact: true })).toHaveCount(
		0,
	);
	await expect(
		page.getByRole("button", { name: "Check status", exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: STOP_PUBLISHING_ACTION, exact: true }),
	).toHaveCount(0);
	expect(stops).toEqual([
		{ appId: "native-publishing", server: "production", domain: "alpha" },
	]);
});

/* After a stop, a teammate brought that HQ app in as another Nova app: the
 * ended card says so and offers no way to an app that is another's now. */
test("an ended card whose HQ app another Nova app publishes to now names no way back to it", async ({
	page,
}) => {
	const ended = stoppedView();
	const held: DeploymentView = {
		...ended,
		deployment: {
			...ended.deployment,
			superseded: ended.deployment.superseded.map((mapping) => ({
				...mapping,
				heldByAnotherApp: true,
			})),
		},
	};
	await openSection(page, "admin", () => [held]);
	const stopped = await cardDate(page, STOPPED_AT);
	await expect(
		page.getByText(
			endedLine(
				{ byName: "Ada Lovelace", reason: "stopped", heldByAnotherApp: true },
				stopped,
			),
			{ exact: true },
		),
	).toBeVisible();
	await expect(
		page.getByText(
			endedLine(
				{ byName: "Ada Lovelace", reason: "stopped", heldByAnotherApp: false },
				stopped,
			),
			{ exact: true },
		),
	).toHaveCount(0);
	await expect(
		page.getByRole("link", { name: new RegExp(`^${ENDED_HQ_APP_LINK}`) }),
	).toHaveCount(0);
});

/* A restore found another Nova app publishing to the HQ app, and ended this
 * deployment. While that app still publishes there the card names no way
 * back to it; once it has stopped there or been deleted, the card says what
 * happened on that day and links to the HQ app again. */
for (const heldByAnotherApp of [true, false]) {
	test(`an ended card taken over by another Nova app ${heldByAnotherApp ? "that still publishes there names no way back to it" : "that no longer publishes there links to the HQ app again"}`, async ({
		page,
	}) => {
		const ended = stoppedView();
		const taken: DeploymentView = {
			...ended,
			deployment: {
				...ended.deployment,
				superseded: ended.deployment.superseded.map((mapping) => ({
					...mapping,
					endedReason: "claimed-elsewhere",
					heldByAnotherApp,
				})),
			},
		};
		await openSection(page, "admin", () => [taken]);
		const stopped = await cardDate(page, STOPPED_AT);
		const line = (held: boolean) =>
			endedLine(
				{
					byName: "Ada Lovelace",
					reason: "claimed-elsewhere",
					heldByAnotherApp: held,
				},
				stopped,
			);
		await expect(
			page.getByText(line(heldByAnotherApp), { exact: true }),
		).toBeVisible();
		await expect(
			page.getByText(line(!heldByAnotherApp), { exact: true }),
		).toHaveCount(0);
		const link = page.getByRole("link", {
			name: new RegExp(`^${ENDED_HQ_APP_LINK}`),
		});
		if (heldByAnotherApp) {
			await expect(link).toHaveCount(0);
		} else {
			await expect(link).toHaveAttribute(
				"href",
				hqPlaceUrl(
					{ server: "production", domain: "alpha", remoteAppId: "hq-app" },
					{ kind: "app" },
				) ?? "",
			);
		}
		/* An ending a restore made offers no stop either. */
		await expect(
			page.getByRole("button", { name: STOP_PUBLISHING_ACTION, exact: true }),
		).toHaveCount(0);
	});
}

/* The answer to a stop can be lost after the stop landed. The confirmation
 * then cannot say nothing changed, and the section reads where the app stands
 * again, so a stop that landed shows as the ended card without a reload. */
test("a stop whose answer is lost says Nova is checking, and the section reads the records again", async ({
	page,
}) => {
	let landed = false;
	await page.route("**/publishing/stop", (route) => route.abort("failed"));
	let reads = 0;
	await openSection(page, "admin", () => {
		reads++;
		return [landed ? stoppedView() : broughtInView()];
	});
	const broughtIn = await cardDate(page, BROUGHT_IN_AT);
	await expect(
		page.getByText(broughtInFromLine("alpha", broughtIn, "Ada Lovelace"), {
			exact: true,
		}),
	).toBeVisible();
	const confirm = page.getByRole("alertdialog");

	/* The stop did not land: the dialog says Nova is checking, and the
	 * record read again is still live. */
	const before = reads;
	await page
		.getByRole("button", { name: STOP_PUBLISHING_ACTION, exact: true })
		.click();
	await confirm
		.getByRole("button", { name: STOP_PUBLISHING_CONFIRM, exact: true })
		.click();
	await expect(confirm.getByRole("alert")).toHaveText(
		STOP_PUBLISHING_UNANSWERED,
	);
	await expect.poll(() => reads).toBeGreaterThan(before);
	await expect(
		confirm.getByText(STOP_PUBLISHING_FAILED, { exact: true }),
	).toHaveCount(0);

	/* The stop landed and its answer was lost: the records read again show
	 * the ended card. */
	landed = true;
	await confirm
		.getByRole("button", { name: STOP_PUBLISHING_CONFIRM, exact: true })
		.click();
	const stopped = await cardDate(page, STOPPED_AT);
	await expect(
		page.getByText(
			endedLine(
				{ byName: "Ada Lovelace", reason: "stopped", heldByAnotherApp: false },
				stopped,
			),
			{ exact: true },
		),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: STOP_PUBLISHING_ACTION, exact: true }),
	).toHaveCount(0);
});

/* A password is shown once, and the docs promise it stays until the person
 * leaves the page. Stopping publishing there keeps that promise: the ended
 * card shows the passwords this page holds, and makes no more workers. */
test("the passwords this page holds stay on the card after publishing there stops", async ({
	page,
}) => {
	let stopped = false;
	await page.route("**/publishing/provision", (route) =>
		route.fulfill({
			json: {
				success: true,
				data: {
					refusal: null,
					workers: [
						{
							personaUuid: "0199a000-0000-7000-8000-00000000a001",
							personaName: "Nurse",
							username: "nurse@alpha.commcarehq.org",
							userId: "hq-user-1",
							created: true,
							adopted: false,
							password: "pw-kept-after-stop",
						},
					],
					unconfirmed: [],
					view: null,
				},
			},
		}),
	);
	await page.route("**/publishing/stop", (route) => {
		stopped = true;
		return route.fulfill({
			json: { success: true, data: { view: stoppedView(), preview: null } },
		});
	});
	await openSection(
		page,
		"admin",
		() => [stopped ? stoppedView() : broughtInView()],
		"persona=true",
	);
	await page.getByRole("checkbox", { name: "Nurse", exact: true }).check();
	await page
		.getByRole("button", { name: "Make 1 worker", exact: true })
		.click();
	const password = page.getByText(/pw-kept-after-stop/);
	await expect(password).toBeVisible();

	await page
		.getByRole("button", { name: STOP_PUBLISHING_ACTION, exact: true })
		.click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: STOP_PUBLISHING_CONFIRM, exact: true })
		.click();
	const stoppedOn = await cardDate(page, STOPPED_AT);
	await expect(
		page.getByText(
			endedLine(
				{ byName: "Ada Lovelace", reason: "stopped", heldByAnotherApp: false },
				stoppedOn,
			),
			{ exact: true },
		),
	).toBeVisible();
	/* The card's setup notes keep their own "Make a version" step, so the
	 * panel's controls are looked for within the panel. */
	const workers = page.getByRole("region", { name: "Workers", exact: true });
	await expect(workers.getByText(/pw-kept-after-stop/)).toBeVisible();
	await expect(
		workers.getByText(ENDED_WORKERS_LINE, { exact: true }),
	).toBeVisible();
	await expect(workers.getByRole("checkbox")).toHaveCount(0);
	await expect(workers.getByRole("button", { name: /^Make/ })).toHaveCount(0);
});

test("Stop publishing here is offered to an admin and not to an editor", async ({
	page,
}) => {
	await openSection(page, "editor", () => [broughtInView()]);
	const broughtIn = await cardDate(page, BROUGHT_IN_AT);
	await expect(
		page.getByText(broughtInFromLine("alpha", broughtIn, "Ada Lovelace"), {
			exact: true,
		}),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: STOP_PUBLISHING_ACTION, exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByText(STOP_PUBLISHING_HELPER, { exact: true }),
	).toHaveCount(0);
});

test("the review step says what the first publish over a brought-in app changes, workers' lines first, and nothing for an app Nova made", async ({
	page,
}) => {
	await open(page, "role=admin", false);
	await page.route("**/publishing/read", (route) =>
		route.fulfill({ json: { success: true, data: [broughtInView()] } }),
	);
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "Open publish", exact: true }).click();
	await reviewDestination(page);
	const lines = firstPublishLines(FIRST_PUBLISH, "publish");
	const section = page.getByRole("region", { name: lines.heading });
	await expect(section).toBeVisible();
	await expect(section.getByText(lines.lead, { exact: true })).toBeVisible();
	await expect(section.getByRole("heading", { level: 3 })).toHaveText([
		lines.workers.label,
		lines.hqOnly.label,
	]);
	await expect(section.getByRole("listitem")).toHaveText([
		...lines.workers.lines.map((line) => line.sentence),
		...lines.hqOnly.lines.map((line) => line.sentence),
	]);
	await expect(section.getByText(lines.note, { exact: true })).toBeVisible();

	await page.route("**/publishing/read", (route) =>
		route.fulfill({ json: { success: true, data: [landedView([])] } }),
	);
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "Open publish", exact: true }).click();
	await reviewDestination(page);
	await expect(
		page.getByRole("heading", { name: lines.heading, exact: true }),
	).toHaveCount(0);
});

/** A refusal over a change made in CommCare HQ to the app itself, which cannot be brought in. */
const appChanged = {
	success: false,
	refusal: {
		phase: "preflight",
		failure: {
			code: "hq_changed",
			message: HQ_CHANGED_MESSAGE,
			details: ["Clinic visits"],
		},
		resourceConflicts: [],
		remoteChanges: [
			{
				kind: "app",
				novaResourceId: "native-publishing",
				name: "Clinic visits",
				identity: "hq-app",
				parts: ["The app's name"],
				note: null,
				observedDigest: "digest-app",
				baselineKnown: true,
				since: { kind: "published" },
				canBringIn: false,
			},
		],
		confirmationsNeeded: [],
		webAppsChange: null,
		placementMoves: null,
	},
	preview_project_space: null,
} satisfies PublishResponseBody;

test("a change made in CommCare HQ to the app offers an admin Stop publishing here, which drops the refusal and plans a new app beside it", async ({
	page,
}) => {
	const stops: unknown[] = [];
	await page.route("**/api/commcare/upload", (route) =>
		route.fulfill({ json: appChanged }),
	);
	await page.route("**/publishing/stop", (route) => {
		stops.push(route.request().postDataJSON());
		return route.fulfill({
			json: {
				success: true,
				data: { view: stoppedView(), preview: null },
			},
		});
	});
	await open(page, "role=admin", false);
	await page.route("**/publishing/read", (route) =>
		route.fulfill({ json: { success: true, data: [broughtInView()] } }),
	);
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "Open publish", exact: true }).click();
	await reviewDestination(page);
	await page.getByRole("button", { name: "Upload", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: DRIFT_STOP_LEAVE_HEADING, exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("checkbox", { name: "Publish over this Clinic visits" }),
	).not.toBeChecked();
	await expect(
		page.getByText(DRIFT_STOP_EDITOR_LINE, { exact: true }),
	).toHaveCount(0);

	await page
		.getByRole("button", { name: STOP_PUBLISHING_ACTION, exact: true })
		.click();
	/* The stopped space is no longer one a CCZ can be made for, so the
	 * dialog reads the CCZ's project spaces again and offers none. */
	let targetReads = 0;
	await page.route("**/publishing/download-targets", (route) => {
		targetReads++;
		return route.fulfill({
			json: {
				success: true,
				data: { targets: [], heldFromHq: [], webAppsOnly: false },
			},
		});
	});
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: STOP_PUBLISHING_CONFIRM, exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "Choose a destination", exact: true }),
	).toBeVisible();
	await expect.poll(() => targetReads).toBe(1);
	await expect(
		page
			.getByRole("status")
			.filter({ hasText: stoppedPublishingLine("alpha") }),
	).toHaveText(stoppedPublishingLine("alpha"));
	await expect(
		page.getByText(PUBLISH_PLAN_CREATES_BESIDE, { exact: true }).first(),
	).toBeVisible();
	await expect(
		page.getByRole("checkbox", { name: "Publish over this Clinic visits" }),
	).toHaveCount(0);
	expect(stops).toEqual([
		{ appId: "native-publishing", server: "production", domain: "alpha" },
	]);
});

test("a change made in CommCare HQ to the app tells an editor who can stop publishing here", async ({
	page,
}) => {
	await page.route("**/api/commcare/upload", (route) =>
		route.fulfill({ json: appChanged }),
	);
	await open(page, "role=editor");
	await page.getByRole("button", { name: "Upload", exact: true }).click();
	await expect(
		page.getByText(DRIFT_STOP_EDITOR_LINE, { exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: STOP_PUBLISHING_ACTION, exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByRole("heading", { name: DRIFT_STOP_LEAVE_HEADING, exact: true }),
	).toHaveCount(0);
});

test("a change made in CommCare HQ to the app that Nova can bring in shows the changes panel in place of the item, with no tick while it reads or after", async ({
	page,
}) => {
	const canBringIn = {
		...appChanged,
		refusal: {
			...appChanged.refusal,
			remoteChanges: appChanged.refusal.remoteChanges.map((change) => ({
				...change,
				canBringIn: true,
			})),
		},
	} satisfies PublishResponseBody;
	const reviews: unknown[] = [];
	const answer = Promise.withResolvers<void>();
	await page.route("**/api/commcare/upload", (route) =>
		route.fulfill({ json: canBringIn }),
	);
	/* The panel names who sends a bring-in from the member's session. */
	await page.route("**/api/auth/get-session", (route) =>
		route.fulfill({ json: null }),
	);
	await page.route("**/api/commcare/changes/review", async (route) => {
		reviews.push(route.request().postDataJSON());
		await answer.promise;
		await route.fulfill({
			status: 200,
			contentType: "application/x-ndjson",
			body: [
				{ type: "stage", stage: "reading-app" },
				{
					type: "done",
					answer: {
						kind: "changes",
						since: { kind: "published" },
						hqChanges: ["The question Weight in the form Visit"],
						novaChanges: [],
						madeBy: [],
						caseData: [],
						publishChanges: [],
						observedDigest: "digest-app",
						renamedInNova: [],
						tables: [],
						readingId: "01928c3e-5b7a-7cde-8f01-23456789abcd",
						reviewDigest: "review-digest",
					},
				},
			]
				.map((line) => `${JSON.stringify(line)}\n`)
				.join(""),
		});
	});
	try {
		await open(page, "role=admin");
		await page.getByRole("button", { name: "Upload", exact: true }).click();
		const stage = page.locator("[data-hq-changes-stage]");
		await expect(stage).toBeVisible();
		await expect(stage).toContainText(HQ_CHANGES_STAGE_LABELS["reading-app"]);
		/* While it reads, the panel is the item's controls: no parts, no
		 * tick and no stop block. */
		await expect(page.getByText("The app's name", { exact: true })).toHaveCount(
			0,
		);
		await expect(page.getByRole("checkbox")).toHaveCount(0);
		await expect(
			page.getByRole("heading", {
				name: DRIFT_STOP_LEAVE_HEADING,
				exact: true,
			}),
		).toHaveCount(0);
		answer.resolve();
		await expect(
			page.getByRole("heading", { name: HQ_CHANGES_HEADING, exact: true }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: BRING_IN_CHANGES_ACTION, exact: true }),
		).toBeVisible();
		await expect(page.getByRole("checkbox")).toHaveCount(0);
		await expect(
			page.getByRole("heading", {
				name: DRIFT_STOP_LEAVE_HEADING,
				exact: true,
			}),
		).toHaveCount(0);
		expect(reviews).toEqual([
			{ appId: "native-publishing", server: "production", domain: "alpha" },
		]);
	} finally {
		answer.resolve();
	}
});

test("publishing a brought-in app to a second project space says it makes a new app there", async ({
	page,
}) => {
	await open(page, "multi=true", false);
	await page.route("**/publishing/read", (route) =>
		route.fulfill({ json: { success: true, data: [broughtInView()] } }),
	);
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "Open publish", exact: true }).click();
	await page
		.getByRole("combobox", { name: "Project space", exact: true })
		.click();
	await page.getByRole("option", { name: "Beta", exact: true }).click();
	await expect(
		page.getByText(ANOTHER_SPACE_NEW_APP_LINE, { exact: true }),
	).toBeVisible();
	await page
		.getByRole("combobox", { name: "Project space", exact: true })
		.click();
	await page.getByRole("option", { name: "Alpha", exact: true }).click();
	await expect(
		page.getByText("This updates the app already in this project space.", {
			exact: true,
		}),
	).toBeVisible();
});

test("Check connection reads the connection route alone, says so when it can't, and shows the upload form once it answers a connection", async ({
	page,
}) => {
	let answers = 0;
	await page.route("**/api/commcare/connection", (route) => {
		answers++;
		/* The first check never arrives: the connection dropped. */
		return answers === 1
			? route.abort("failed")
			: route.fulfill({
					json: {
						connection: {
							configured: true,
							username: "native-user@dimagi.com",
							server: "production",
							availableDomains: [{ name: "alpha", displayName: "Alpha" }],
						},
					},
				});
	});
	await open(page, "disconnected=true", false);
	await expect(
		page.getByRole("heading", {
			name: "Connect CommCare HQ to upload",
			exact: true,
		}),
	).toBeVisible();
	/* The peer mounts the dialog with the context's `refresh` itself, and no
	 * Next router: this holds the dialog and the context. That `PublishPanel`
	 * hands the button the context's `refresh` and not a router refresh is
	 * held by the app journey in `e2e/tests/app/publish-flow.spec.ts`. */
	const navigations: string[] = [];
	page.on("request", (request) => {
		if (
			request.resourceType() === "document" ||
			request.headers().rsc !== undefined ||
			new URL(request.url()).searchParams.has("_rsc")
		)
			navigations.push(request.url());
	});
	const check = page.getByRole("button", {
		name: "Check connection",
		exact: true,
	});
	await check.click();
	await expect(page.getByRole("alert")).toHaveText(CONNECTION_CHECK_FAILED);
	await expect(check).toBeEnabled();
	await check.click();
	await expect(
		page.getByRole("textbox", { name: "App name", exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("heading", {
			name: "Connect CommCare HQ to upload",
			exact: true,
		}),
	).toHaveCount(0);
	expect(answers).toBe(2);
	expect(navigations).toEqual([]);
});
