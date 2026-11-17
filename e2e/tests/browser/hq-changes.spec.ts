import { createServer, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { Page, Route } from "@playwright/test";
import type { PublishResponseBody } from "@/components/builder/publishOutcome";
import { endpointWireFixture } from "@/lib/commcare/__tests__/endpointWireFixture";
import type { DeploymentView } from "@/lib/deployment/actions";
import { hqChangesBatchId } from "@/lib/deployment/hqChanges/batchId";
import type {
	HqChangesOutcome,
	HqChangesReview,
	HqChangesStage,
} from "@/lib/deployment/hqChanges/types";
import { APP_PREVIEW_NOTE } from "@/lib/deployment/remoteChanges";
import { buildSetupArtifact } from "@/lib/deployment/setupArtifact";
import {
	type DeploymentRemoteChange,
	type DeploymentResource,
	NO_DEPLOYMENT_PHASE_OUTCOMES,
} from "@/lib/deployment/types";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	DRIFT_STOP_EDITOR_LINE,
	DRIFT_STOP_LEAVE_HEADING,
} from "@/lib/publish/bringInCopy";
import { madeByLine } from "@/lib/publish/documentChangeCopy";
import type { FirstPublishView } from "@/lib/publish/firstPublishChangeIds";
import { firstPublishLines } from "@/lib/publish/firstPublishCopy";
import {
	BRING_IN_CHANGES_ACTION,
	broughtInLine,
	CANNOT_BRING_IN_HEADING,
	CANNOT_BRING_IN_OTHER_WAYS,
	CHECK_AGAIN_ACTION,
	cannotBringInLead,
	HQ_CHANGES_DIALOG_TITLE,
	HQ_CHANGES_GATE_NEXT,
	HQ_CHANGES_HEADING,
	hqChangesBroughtInToast,
	hqChangesLead,
	NOVA_CHANGES_HEADING,
	NOVA_CHANGES_LEAD,
	nextPublishChangesLine,
	nothingNewToPublishLine,
	nothingToBringInLine,
	PUBLISH_OVER_CHOSEN_LINE,
	PUBLISH_OVER_HQ_ACTION,
	PUBLISH_OVER_HQ_HELPER,
	PUBLISH_OVER_INSTEAD_LINE,
	renamedInNovaLine,
	SEE_WHAT_CHANGED_IN_HQ_ACTION,
	showAllAction,
	sincePhrase,
	USE_HQ_VERSION_ACTION,
	USE_HQ_VERSION_HELPER,
} from "@/lib/publish/hqChangesCopy";
import type { Finding, HqPlace } from "@/lib/publish/hqFindings";
import {
	PROJECT_SPACE_COMPATIBILITY_DOCS_URL,
	PROJECT_SPACE_COMPATIBILITY_SUPPORT_EMAIL,
} from "@/lib/publish/projectSpaceCompatibility";
import {
	STOP_PUBLISHING_ACTION,
	STOP_PUBLISHING_HELPER,
} from "@/lib/publish/stopPublishing";
import { componentPeer } from "../../lib/componentPeer";
import { attachErrorGuard, closePageWithUnload } from "../../lib/errorGuard";
import { expect, test } from "../../lib/fixtures";
import { type RemovableRoutes, removableRoutes } from "../../lib/routes";

/**
 * The changes made in CommCare HQ panel in the publish dialog, as a person
 * meets it when a publish stops on a change to the app that Nova can bring
 * in. The production dialog and panel are mounted in the production
 * providers under the production `BuilderHeader` and access gate
 * (`e2e/lib/hq-changes-client.tsx`); Nova's own routes, the review's and the
 * bring-in's stage streams among them, are answered here.
 */

const APP_ID = "native-hq-changes";
const PROJECT_ID = "native-project";
const MEMBER_ID = "native-user";
const DOMAIN = "alpha";
const OBSERVED_DIGEST = "digest-app";
const READING_ID = "01928c3e-5b7a-7cde-8f01-23456789abcd";
const REVIEW_DIGEST = "review-digest";
const PUBLISHED = { kind: "published" } as const;
const SINCE = sincePhrase(PUBLISHED, DOMAIN);

let peer: Awaited<ReturnType<typeof componentPeer>>;
test.use({ actionTimeout: 10_000 });
test.beforeAll(async () => {
	peer = await componentPeer("e2e/lib/hq-changes-client.tsx", [], {
		"@/lib/deployment/actions": resolve("e2e/lib/publishing-boundary.ts"),
		"@/lib/lookup/actions": resolve("e2e/lib/publishing-boundary.ts"),
		"@/lib/notices/actions": resolve("e2e/lib/builder-header-boundary.ts"),
		"@/lib/preview/app-tests/actions": resolve(
			"e2e/lib/builder-header-boundary.ts",
		),
		"@/lib/preview/engine/caseDataBinding": resolve(
			"e2e/lib/builder-header-boundary.ts",
		),
	});
});
test.afterAll(async () => {
	await peer?.close();
});

/** The live app mapping of the record: the HQ app this app publishes to. */
function appMapping(): DeploymentResource {
	return {
		deploymentId: "deployment",
		kind: "app",
		novaResourceId: APP_ID,
		remoteId: "hq-app",
		ownership: "nova-created",
		pushedIdentity: null,
		adoptedAt: null,
		adoptedBy: null,
		pushedRevision: 1,
		pushedAt: "2026-10-01T00:00:00Z",
		pushToken: "01992000-0000-7000-8000-000000000001",
		remoteRevision: null,
		remoteObservedAt: null,
		supersededAt: null,
		remoteMissingAt: null,
		adoptedByName: null,
		releasedAt: null,
		endedReason: null,
		endedByName: null,
		heldByAnotherApp: false,
	};
}

/** The record of the app on `alpha`, with what the next publish there changes. */
function recordView(
	firstPublish: FirstPublishView | null = null,
): DeploymentView {
	return {
		deployment: {
			deployment: {
				id: "deployment",
				appId: APP_ID,
				projectId: PROJECT_ID,
				server: "production",
				domain: DOMAIN,
				state: "uploaded",
				resumePhase: null,
				phases: NO_DEPLOYMENT_PHASE_OUTCOMES,
				createdBy: MEMBER_ID,
				createdAt: "2026-10-01T00:00:00Z",
				updatedAt: "2026-10-01T00:00:00Z",
				lastObservedAt: null,
				offeredLogoContentHash: null,
				targetEmptyCaseListText: null,
				endings: 0,
			},
			active: [appMapping()],
			superseded: [],
			confirmations: [],
		},
		artifact: buildSetupArtifact({
			doc: endpointWireFixture("multiple"),
			server: "production",
			domain: DOMAIN,
			hqAppId: "hq-app",
			locations: [],
		}),
		leftBehind: [],
		kept: null,
		firstPublish,
	};
}

/** The app's change as the refusal names it: one Nova can bring in. */
const APP_CHANGE: DeploymentRemoteChange = {
	kind: "app",
	novaResourceId: APP_ID,
	name: "Clinic visits",
	identity: "hq-app",
	parts: ["The form Visit in the menu Patients"],
	note: null,
	observedDigest: OBSERVED_DIGEST,
	baselineKnown: true,
	since: PUBLISHED,
	canBringIn: true,
};

/** A publish that stopped on a change made in CommCare HQ to the app. */
const CHANGED_IN_HQ = {
	success: false,
	refusal: {
		phase: "preflight",
		failure: {
			code: "hq_changed",
			message:
				"Something in this app changed in CommCare HQ since Nova last published it, so Nova stopped before sending anything. Here's what changed.",
			details: ["Clinic visits"],
		},
		resourceConflicts: [],
		remoteChanges: [APP_CHANGE],
		confirmationsNeeded: [],
		webAppsChange: null,
		placementMoves: null,
	},
	preview_project_space: null,
} satisfies PublishResponseBody;

/** A publish that landed. */
const LANDED = {
	success: true,
	hq_app_action: "updated",
	app_preview_note: APP_PREVIEW_NOTE,
	url: "https://www.commcarehq.org/a/alpha/apps/view/hq-app/",
	warnings: [],
	deployment: null,
	preview_project_space: DOMAIN,
} satisfies PublishResponseBody;

/** A review that found changes; S1 where `novaChanges` is empty. */
function changes(
	overrides: Partial<Extract<HqChangesReview, { kind: "changes" }>> = {},
): HqChangesReview {
	return {
		kind: "changes",
		since: PUBLISHED,
		hqChanges: ["The question Weight in the form Visit"],
		novaChanges: [],
		madeBy: [],
		caseData: [],
		publishChanges: [],
		observedDigest: OBSERVED_DIGEST,
		renamedInNova: [],
		tables: [],
		projectName: "Field team",
		readingId: READING_ID,
		reviewDigest: REVIEW_DIGEST,
		...overrides,
	};
}

/** A stage stream: the review's four stages, then its last line. */
function stream(
	answer: HqChangesReview | HqChangesOutcome,
	stages: readonly HqChangesStage[] = [
		"reading-app",
		"reading-project-data",
		"checking",
	],
): string {
	return [
		...stages.map((stage) => ({ type: "stage", stage })),
		{ type: "done", answer },
	]
		.map((line) => `${JSON.stringify(line)}\n`)
		.join("");
}

async function fulfillStream(route: Route, body: string): Promise<void> {
	await route.fulfill({
		status: 200,
		contentType: "application/x-ndjson",
		body,
	});
}

/** A route that records each JSON body it is posted and answers it. */
async function recorded(
	routes: RemovableRoutes,
	path: string,
	answer: (route: Route, index: number) => Promise<void>,
): Promise<unknown[]> {
	const bodies: unknown[] = [];
	await routes.route(`**${path}`, async (route) => {
		const index = bodies.length;
		bodies.push(route.request().postDataJSON());
		await answer(route, index);
	});
	return bodies;
}

/**
 * Nova's routes every journey needs answered: the app stream (or the
 * journey's own `stream`), presence, the Project's tables, the records, the
 * download targets, the compatibility check, and the member's session,
 * which names who sends a bring-in.
 */
async function answerNova(
	page: Page,
	records: () => DeploymentView[],
	stream?: (route: Route) => Promise<void>,
): Promise<void> {
	await page.route(
		`**/api/apps/${APP_ID}/stream?*`,
		stream ??
			((route) =>
				route.fulfill({
					status: 200,
					contentType: "text/event-stream",
					body: "retry: 3600000\n\n",
				})),
	);
	await page.route(`**/api/apps/${APP_ID}/presence`, (route) =>
		route.fulfill({ json: [] }),
	);
	await page.route("**/api/auth/get-session", (route) =>
		route.fulfill({
			json: {
				session: {
					id: "native-session",
					userId: MEMBER_ID,
					token: "native-session-token",
					expiresAt: "2027-01-01T00:00:00.000Z",
					createdAt: "2026-10-01T00:00:00.000Z",
					updatedAt: "2026-10-01T00:00:00.000Z",
				},
				user: {
					id: MEMBER_ID,
					name: "Ada Lovelace",
					email: "native-user@dimagi.com",
					emailVerified: true,
					image: null,
					createdAt: "2026-10-01T00:00:00.000Z",
					updatedAt: "2026-10-01T00:00:00.000Z",
				},
			},
		}),
	);
	await page.route("**/publishing/lookup", (route) =>
		route.fulfill({
			json: {
				success: true,
				data: { projectId: PROJECT_ID, revision: "0", tables: [] },
			},
		}),
	);
	await page.route("**/publishing/read", (route) =>
		route.fulfill({ json: { success: true, data: records() } }),
	);
	await page.route("**/publishing/download-targets", (route) =>
		route.fulfill({
			json: {
				success: true,
				data: {
					targets: [{ server: "production", domain: DOMAIN }],
					heldFromHq: [],
					webAppsOnly: false,
				},
			},
		}),
	);
	await page.route("**/api/commcare/project-space-compatibility", (route) =>
		route.fulfill({
			json: {
				project_space_compatibility: {
					status: "ready",
					target_domain: DOMAIN,
					required_capabilities: [],
					blockers: [],
					advisories: [],
					support_email: PROJECT_SPACE_COMPATIBILITY_SUPPORT_EMAIL,
					docs_url: PROJECT_SPACE_COMPATIBILITY_DOCS_URL,
					message: "This project space supports everything this app uses.",
				},
			},
		}),
	);
}

/** The header's Publish button. */
function publishButton(page: Page) {
	return page.getByRole("button", { name: "Publish", exact: true });
}

/** Opens the publish dialog on its review step and presses Upload. */
async function publish(page: Page, query = "role=admin"): Promise<void> {
	await page.goto(`${peer.origin}/?${query}`);
	await uploadFromPublish(page);
}

/** On the open page, opens the publish dialog on its review step and presses Upload. */
async function uploadFromPublish(page: Page): Promise<void> {
	await publishButton(page).click();
	const next = page.getByRole("button", { name: "Continue", exact: true });
	if ((await next.isVisible()) && (await next.isEnabled())) await next.click();
	await expect(
		page.getByRole("heading", { name: "Review and publish", exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "Upload", exact: true }).click();
}

/** The panel, apart from the dialog's own controls around it. */
function panel(page: Page) {
	return page.locator("[data-hq-changes-panel]");
}

function hqList(page: Page) {
	return page.getByRole("list", { name: HQ_CHANGES_HEADING, exact: true });
}

test("a change Nova can bring in with nothing removed asks no question, and one press brings it in", async ({
	page,
}) => {
	const routes = removableRoutes(page);
	try {
		await answerNova(page, () => [recordView()]);
		const uploads = await recorded(routes, "/api/commcare/upload", (route) =>
			route.fulfill({ json: CHANGED_IN_HQ }),
		);
		const reviews = await recorded(
			routes,
			"/api/commcare/changes/review",
			(route) => fulfillStream(route, stream(changes())),
		);
		const bringIns = await recorded(
			routes,
			"/api/commcare/changes/bring-in",
			(route) =>
				fulfillStream(
					route,
					stream(
						{
							kind: "brought-in",
							seq: 7,
							discarded: false,
							deployment: recordView(),
						},
						["reading-app", "reading-project-data", "checking", "bringing-in"],
					),
				),
		);
		await publish(page);

		await expect(
			page.getByRole("heading", { name: HQ_CHANGES_HEADING, exact: true }),
		).toBeVisible();
		await expect(
			page.getByText(hqChangesLead(SINCE, false), { exact: true }),
		).toBeVisible();
		await expect(hqList(page).getByRole("listitem")).toHaveText([
			"The question Weight in the form Visit",
		]);
		await expect(
			page.getByText(PUBLISH_OVER_INSTEAD_LINE, { exact: true }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: PUBLISH_OVER_HQ_ACTION, exact: true }),
		).toBeVisible();
		/* No warning: no Nova list, no Use CommCare HQ's version, no stop,
		 * and no tick beside the panel's choices. */
		await expect(
			page.getByRole("heading", { name: NOVA_CHANGES_HEADING, exact: true }),
		).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: USE_HQ_VERSION_ACTION, exact: true }),
		).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: STOP_PUBLISHING_ACTION, exact: true }),
		).toHaveCount(0);
		await expect(page.getByRole("checkbox")).toHaveCount(0);
		await expect(
			page.getByText("The form Visit in the menu Patients", { exact: true }),
		).toHaveCount(0);

		await page
			.getByRole("button", { name: BRING_IN_CHANGES_ACTION, exact: true })
			.click();
		await expect(page.getByRole("alertdialog")).toHaveCount(0);
		await expect(
			page.getByRole("status").filter({
				hasText: nothingNewToPublishLine(DOMAIN),
			}),
		).toContainText(broughtInLine(false));
		await expect(
			page.getByRole("button", { name: BRING_IN_CHANGES_ACTION, exact: true }),
		).toHaveCount(0);
		expect(reviews).toEqual([
			{ appId: APP_ID, server: "production", domain: DOMAIN },
		]);
		expect(bringIns).toEqual([
			{
				appId: APP_ID,
				server: "production",
				domain: DOMAIN,
				readingId: READING_ID,
				reviewDigest: REVIEW_DIGEST,
				tableChoices: {},
			},
		]);
		expect(uploads).toHaveLength(1);
	} finally {
		await routes.removeAll();
	}
});

test("changes made in both places list both, open in full on Show all, and offer three choices with no tick beside them", async ({
	page,
}) => {
	const hqChanges = Array.from(
		{ length: 12 },
		(_, index) => `The question Q${index + 1} in the form Visit`,
	);
	const novaChanges = [
		"The form Follow-up in the menu Patients: the questions Weight and Height",
		"The app's name",
	];
	const routes = removableRoutes(page);
	try {
		await answerNova(page, () => [recordView()]);
		const uploads = await recorded(
			routes,
			"/api/commcare/upload",
			(route, index) =>
				route.fulfill({ json: index === 0 ? CHANGED_IN_HQ : LANDED }),
		);
		await recorded(routes, "/api/commcare/changes/review", (route) =>
			fulfillStream(
				route,
				stream(changes({ hqChanges, novaChanges, madeBy: ["Grace Hopper"] })),
			),
		);
		const bringIns = await recorded(
			routes,
			"/api/commcare/changes/bring-in",
			(route) => route.fulfill({ status: 404 }),
		);
		await publish(page);

		await expect(
			page.getByText(hqChangesLead(SINCE, true), { exact: true }),
		).toBeVisible();
		await expect(
			page.getByRole("heading", { name: NOVA_CHANGES_HEADING, exact: true }),
		).toBeVisible();
		await expect(
			page.getByText(NOVA_CHANGES_LEAD, { exact: true }),
		).toBeVisible();
		await expect(
			page.getByText(madeByLine(["Grace Hopper"]), { exact: true }),
		).toBeVisible();
		await expect(
			page
				.getByRole("list", { name: NOVA_CHANGES_HEADING, exact: true })
				.getByRole("listitem"),
		).toHaveText(novaChanges);
		await expect(hqList(page).getByRole("listitem")).toHaveText(
			hqChanges.slice(0, 10),
		);
		await page
			.getByRole("button", { name: showAllAction(12), exact: true })
			.click();
		await expect(hqList(page).getByRole("listitem")).toHaveText(hqChanges);
		await expect(
			page.getByRole("button", { name: showAllAction(12), exact: true }),
		).toHaveCount(0);

		/* The three choices, each with its sentence, and nothing to tick. */
		await expect(
			page.getByRole("button", { name: USE_HQ_VERSION_ACTION, exact: true }),
		).toHaveAccessibleDescription(USE_HQ_VERSION_HELPER);
		await expect(
			page.getByRole("button", { name: PUBLISH_OVER_HQ_ACTION, exact: true }),
		).toHaveAccessibleDescription(PUBLISH_OVER_HQ_HELPER);
		await expect(
			page.getByRole("button", { name: STOP_PUBLISHING_ACTION, exact: true }),
		).toHaveAccessibleDescription(STOP_PUBLISHING_HELPER);
		await expect(page.getByRole("checkbox")).toHaveCount(0);
		await expect(
			page.getByRole("heading", {
				name: DRIFT_STOP_LEAVE_HEADING,
				exact: true,
			}),
		).toHaveCount(0);

		/* Publish over sets the item's choice and hands the footer button
		 * focus; that button sends the discard the review read. */
		await page
			.getByRole("button", { name: PUBLISH_OVER_HQ_ACTION, exact: true })
			.click();
		const publishOver = page.getByRole("button", {
			name: "Publish over these changes",
			exact: true,
		});
		await expect(publishOver).toBeFocused();
		await expect(publishOver).toBeEnabled();
		await publishOver.click();
		await expect(
			page.getByText(APP_PREVIEW_NOTE, { exact: true }),
		).toBeVisible();
		expect(uploads).toHaveLength(2);
		expect(
			(uploads[1] as { discard_remote_changes: unknown })
				.discard_remote_changes,
		).toEqual([
			{ kind: "app", novaResourceId: APP_ID, observedDigest: OBSERVED_DIGEST },
		]);
		expect(bringIns).toEqual([]);
	} finally {
		await routes.removeAll();
	}
});

test("a case property renamed in Nova since then takes the place of Use CommCare HQ's version, with Check again", async ({
	page,
}) => {
	const renamed = [{ caseType: "patient", from: "phone", to: "mobile" }];
	const routes = removableRoutes(page);
	try {
		await answerNova(page, () => [recordView()]);
		await recorded(routes, "/api/commcare/upload", (route) =>
			route.fulfill({ json: CHANGED_IN_HQ }),
		);
		const reviews = await recorded(
			routes,
			"/api/commcare/changes/review",
			(route) =>
				fulfillStream(
					route,
					stream(
						changes({
							novaChanges: ["The case property mobile of patient"],
							renamedInNova: renamed,
						}),
					),
				),
		);
		await publish(page);

		await expect(
			page.getByText(renamedInNovaLine(renamed), { exact: true }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: USE_HQ_VERSION_ACTION, exact: true }),
		).toHaveCount(0);
		await expect(
			page.getByText(USE_HQ_VERSION_HELPER, { exact: true }),
		).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: PUBLISH_OVER_HQ_ACTION, exact: true }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: STOP_PUBLISHING_ACTION, exact: true }),
		).toBeVisible();
		await expect(page.getByRole("checkbox")).toHaveCount(0);

		await panel(page)
			.getByRole("button", { name: CHECK_AGAIN_ACTION, exact: true })
			.click();
		await expect.poll(() => reviews.length).toBe(2);
		await expect(
			page.getByText(renamedInNovaLine(renamed), { exact: true }),
		).toBeVisible();
	} finally {
		await routes.removeAll();
	}
});

test("a save in CommCare HQ that changed nothing is recorded and the publish goes ahead by itself", async ({
	page,
}) => {
	const routes = removableRoutes(page);
	try {
		await answerNova(page, () => [recordView()]);
		const uploads = await recorded(
			routes,
			"/api/commcare/upload",
			(route, index) =>
				route.fulfill({ json: index === 0 ? CHANGED_IN_HQ : LANDED }),
		);
		await recorded(routes, "/api/commcare/changes/review", (route) =>
			fulfillStream(
				route,
				stream({
					kind: "nothing",
					reason: "reads-the-same",
					since: PUBLISHED,
					publishChanges: [],
					readingId: READING_ID,
					reviewDigest: REVIEW_DIGEST,
				}),
			),
		);
		const bringIns = await recorded(
			routes,
			"/api/commcare/changes/bring-in",
			(route) =>
				fulfillStream(
					route,
					stream({ kind: "recorded", deployment: recordView() }),
				),
		);
		await publish(page);

		await expect(
			page.getByText(APP_PREVIEW_NOTE, { exact: true }),
		).toBeVisible();
		expect(bringIns).toEqual([
			{
				appId: APP_ID,
				server: "production",
				domain: DOMAIN,
				readingId: READING_ID,
				reviewDigest: REVIEW_DIGEST,
				tableChoices: {},
			},
		]);
		expect(uploads).toHaveLength(2);
		expect(uploads[1]).toMatchObject({ discard_remote_changes: [] });
	} finally {
		await routes.removeAll();
	}
});

test("a save in CommCare HQ that changed nothing, where the next publish changes something there, waits for the person's press", async ({
	page,
}) => {
	const nextPublish: FirstPublishView = {
		ids: ["forms-and-settings-rewritten"],
		touchesWorkers: false,
		of: "next-publish",
	};
	const lines = firstPublishLines(nextPublish, "publish");
	const sentences = lines.hqOnly.lines.map((line) => line.sentence);
	let recordedRead = false;
	const routes = removableRoutes(page);
	try {
		await answerNova(page, () => [
			recordView(recordedRead ? nextPublish : null),
		]);
		const uploads = await recorded(
			routes,
			"/api/commcare/upload",
			(route, index) =>
				route.fulfill({ json: index === 0 ? CHANGED_IN_HQ : LANDED }),
		);
		await recorded(routes, "/api/commcare/changes/review", (route) =>
			fulfillStream(
				route,
				stream({
					kind: "nothing",
					reason: "already-here",
					since: PUBLISHED,
					publishChanges: sentences,
					readingId: READING_ID,
					reviewDigest: REVIEW_DIGEST,
				}),
			),
		);
		const bringIns = await recorded(
			routes,
			"/api/commcare/changes/bring-in",
			async (route) => {
				recordedRead = true;
				await fulfillStream(
					route,
					stream({ kind: "recorded", deployment: recordView(nextPublish) }),
				);
			},
		);
		await publish(page);

		const section = page.getByRole("region", { name: lines.heading });
		await expect(section).toBeVisible();
		await expect(section.getByText(lines.lead, { exact: true })).toBeVisible();
		await expect(section.getByRole("listitem")).toHaveText(sentences);
		expect(bringIns).toHaveLength(1);
		expect(uploads).toHaveLength(1);
		await expect(
			page.getByText(nothingToBringInLine("already-here", SINCE), {
				exact: true,
			}),
		).toHaveCount(0);

		await page.getByRole("button", { name: "Upload", exact: true }).click();
		await expect(
			page.getByText(APP_PREVIEW_NOTE, { exact: true }),
		).toBeVisible();
		expect(uploads).toHaveLength(2);
		expect(uploads[1]).toMatchObject({ discard_remote_changes: [] });
		expect(bringIns).toHaveLength(1);
	} finally {
		await routes.removeAll();
	}
});

const MENU_PLACE: HqPlace = { kind: "case-list", menu: 0, name: "Patients" };
const ACCOUNT_FINDING: Finding = {
	code: "case-list-columns.format",
	standing: "never",
	place: MENU_PLACE,
	subject: "case-list-columns",
	detail: { name: "interval" },
};

test("a change Nova can't hold shows its account and keeps the item's own two choices", async ({
	page,
}) => {
	const routes = removableRoutes(page);
	try {
		await answerNova(page, () => [recordView()]);
		await recorded(routes, "/api/commcare/upload", (route) =>
			route.fulfill({ json: CHANGED_IN_HQ }),
		);
		const reviews = await recorded(
			routes,
			"/api/commcare/changes/review",
			(route) =>
				fulfillStream(
					route,
					stream({
						kind: "account",
						findings: [ACCOUNT_FINDING],
						more: 0,
						counts: { notYet: 0, never: 1, fixInHq: 0 },
					}),
				),
		);
		await publish(page);

		await expect(
			page.getByRole("heading", { name: CANNOT_BRING_IN_HEADING, exact: true }),
		).toBeVisible();
		await expect(
			page.getByText(cannotBringInLead(1), { exact: true }),
		).toBeVisible();
		await expect(
			page.getByText(CANNOT_BRING_IN_OTHER_WAYS, { exact: true }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: BRING_IN_CHANGES_ACTION, exact: true }),
		).toHaveCount(0);
		/* The item as it is without the panel: its parts, its tick and the stop. */
		await expect(
			page.getByText("The form Visit in the menu Patients", { exact: true }),
		).toBeVisible();
		const tick = page.getByRole("checkbox", {
			name: "Publish over this Clinic visits",
		});
		await expect(tick).not.toBeChecked();
		await expect(
			page.getByRole("heading", {
				name: DRIFT_STOP_LEAVE_HEADING,
				exact: true,
			}),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: STOP_PUBLISHING_ACTION, exact: true }),
		).toBeVisible();
		const publishOver = page.getByRole("button", {
			name: "Publish over these changes",
			exact: true,
		});
		await expect(publishOver).toBeDisabled();
		await tick.check();
		await expect(publishOver).toBeEnabled();

		await panel(page)
			.getByRole("button", { name: CHECK_AGAIN_ACTION, exact: true })
			.click();
		await expect.poll(() => reviews.length).toBe(2);
	} finally {
		await routes.removeAll();
	}
});

/** The CommCare HQ stream peer: holds each tab's app stream open and writes frames to them. */
async function appStreams() {
	const open: { readonly tab: string; readonly response: ServerResponse }[] =
		[];
	const opened: string[] = [];
	const server = createServer((request, response) => {
		const tab =
			new URL(request.url ?? "/", "http://localhost").searchParams.get("tab") ??
			"";
		response.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-store",
		});
		response.write("retry: 3600000\n\n");
		const held = { tab, response };
		open.push(held);
		opened.push(tab);
		response.on("close", () => {
			const index = open.indexOf(held);
			if (index !== -1) open.splice(index, 1);
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Missing app stream peer port");
	const origin = `http://127.0.0.1:${address.port}`;
	return {
		/** Answers a tab's app stream from this peer. */
		route(tab: string) {
			return (route: Route) =>
				route.continue({ url: `${origin}/stream?tab=${tab}` });
		},
		/** How many streams each tab has opened. */
		openedBy(tab: string): number {
			return opened.filter((entry) => entry === tab).length;
		},
		/** Writes one event to every stream open now. */
		async send(event: string, data: unknown): Promise<void> {
			await Promise.all(
				open.map(
					({ response }) =>
						new Promise<void>((resolve, reject) =>
							response.write(
								`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
								(error) => (error ? reject(error) : resolve()),
							),
						),
				),
			);
		},
		async close(): Promise<void> {
			for (const { response } of open.splice(0)) response.destroy();
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		},
	};
}

/** The Publish dialog, open again after the reload, saying the changes are in. */
async function expectBroughtInAfterReload(
	page: Page,
	nextLine: string,
	discarded = false,
): Promise<void> {
	const dialog = page.getByRole("dialog", { name: "Publish app" });
	await expect(dialog).toBeVisible();
	await expect(
		dialog.getByRole("status").filter({ hasText: nextLine }),
	).toContainText(broughtInLine(discarded));
	await expect(
		dialog.getByRole("button", { name: "Continue", exact: true }),
	).toBeEnabled();
	await expect(page.getByRole("dialog")).toHaveCount(1);
}

/** What `GET /api/apps/{id}` answers a reload: the app as it now stands. */
function snapshotRoute(page: Page, reloads: { count: number }) {
	return page.route(`**/api/apps/${APP_ID}`, (route) => {
		reloads.count += 1;
		return route.fulfill({
			json: {
				projectId: PROJECT_ID,
				role: "admin",
				canEdit: true,
				blueprint: toPersistableDoc({
					...endpointWireFixture("multiple"),
					appId: APP_ID,
				}),
				baseSeq: 7,
				recordedHolds: [],
			},
		});
	});
}

test("a bring-in says nothing in the tab that sent it, and every other open tab says who brought the changes in", async ({
	page,
	context,
}) => {
	const streams = await appStreams();
	const other = await context.newPage();
	const otherGuard = await attachErrorGuard(other, undefined);
	const routes = removableRoutes(page);
	try {
		const ownReloads = { count: 0 };
		const otherReloads = { count: 0 };
		await answerNova(page, () => [recordView()], streams.route("own"));
		await answerNova(other, () => [recordView()], streams.route("other"));
		await snapshotRoute(page, ownReloads);
		await snapshotRoute(other, otherReloads);
		await recorded(routes, "/api/commcare/upload", (route) =>
			route.fulfill({ json: CHANGED_IN_HQ }),
		);
		await recorded(routes, "/api/commcare/changes/review", (route) =>
			fulfillStream(route, stream(changes())),
		);
		await recorded(routes, "/api/commcare/changes/bring-in", (route) =>
			fulfillStream(
				route,
				stream(
					{
						kind: "brought-in",
						seq: 7,
						discarded: false,
						deployment: recordView(),
					},
					["reading-app", "reading-project-data", "checking", "bringing-in"],
				),
			),
		);
		await other.goto(`${peer.origin}/?role=editor`);
		await publish(page);
		await page
			.getByRole("button", { name: BRING_IN_CHANGES_ACTION, exact: true })
			.click();
		await expect(
			page.getByRole("status").filter({
				hasText: nothingNewToPublishLine(DOMAIN),
			}),
		).toContainText(broughtInLine(false));
		await expect.poll(() => streams.openedBy("own")).toBe(1);
		await expect.poll(() => streams.openedBy("other")).toBe(1);

		/* The stream tells every tab who is here, then that the bring-in's
		 * commit forced a reload. */
		await streams.send("presence", [
			{
				userId: "grace",
				sessionId: "grace-session",
				name: "Grace Hopper",
				image: null,
				email: "grace@dimagi.com",
				color: "#a78bfa",
				location: { kind: "home" },
				updatedAt: 1,
			},
		]);
		await streams.send("reload", {
			reason: "hq-changes",
			batchId: hqChangesBatchId({
				deploymentId: "deployment",
				reviewDigest: REVIEW_DIGEST,
				memberId: MEMBER_ID,
			}),
			actorId: "grace",
		});

		const toast = hqChangesBroughtInToast("Grace Hopper");
		await expect(other.getByText(toast, { exact: true })).toBeVisible();
		expect(otherReloads.count).toBe(1);
		/* The own tab reloaded and opened its stream again, which is where a
		 * reload's notice is said, and it said nothing. */
		await expect.poll(() => streams.openedBy("own")).toBe(2);
		expect(ownReloads.count).toBe(1);
		await expect(page.getByText(toast, { exact: true })).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: "Dismiss", exact: true }),
		).toHaveCount(0);
		/* The reload closed the dialog with every other floating layer; once
		 * it landed, the dialog opened again on its destination step, saying
		 * the changes are in, and publishing from it stays live. */
		await expectBroughtInAfterReload(page, nothingNewToPublishLine(DOMAIN));
	} finally {
		/* Both tabs close before their streams do, so no tab sees its stream
		 * drop; the fixture still asserts the first tab's errors after this. */
		await routes.removeAll();
		await closePageWithUnload(other);
		await closePageWithUnload(page);
		await streams.close();
		await otherGuard.assertNoErrors();
	}
});

/** The reload frame a bring-in's commit sends every tab, this one's own batch named. */
function ownReload() {
	return {
		reason: "hq-changes",
		batchId: hqChangesBatchId({
			deploymentId: "deployment",
			reviewDigest: REVIEW_DIGEST,
			memberId: MEMBER_ID,
		}),
		actorId: MEMBER_ID,
	};
}

test("a bring-in that answers after the reload its commit forced is shown when the dialog opens again, with what the next publish changes", async ({
	page,
}) => {
	const nextPublish: FirstPublishView = {
		ids: ["forms-and-settings-rewritten"],
		touchesWorkers: false,
		of: "next-publish",
	};
	const streams = await appStreams();
	const routes = removableRoutes(page);
	const sent = Promise.withResolvers<Route>();
	try {
		const reloads = { count: 0 };
		await answerNova(page, () => [recordView()], streams.route("own"));
		await snapshotRoute(page, reloads);
		await recorded(routes, "/api/commcare/upload", (route) =>
			route.fulfill({ json: CHANGED_IN_HQ }),
		);
		await recorded(routes, "/api/commcare/changes/review", (route) =>
			fulfillStream(
				route,
				stream(changes({ novaChanges: ["The app's name"] })),
			),
		);
		await routes.route("**/api/commcare/changes/bring-in", async (route) => {
			sent.resolve(route);
		});
		await publish(page);
		await page
			.getByRole("button", { name: USE_HQ_VERSION_ACTION, exact: true })
			.click();
		const bringIn = await sent.promise;
		await expect.poll(() => streams.openedBy("own")).toBe(1);

		/* The commit's reload lands before the bring-in's answer does. */
		await streams.send("reload", ownReload());
		await expect.poll(() => streams.openedBy("own")).toBe(2);
		expect(reloads.count).toBe(1);
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await fulfillStream(
			bringIn,
			stream({
				kind: "brought-in",
				seq: 7,
				discarded: true,
				deployment: recordView(nextPublish),
			}),
		);

		await expectBroughtInAfterReload(
			page,
			nextPublishChangesLine(DOMAIN),
			true,
		);
		await expect(
			page.getByText(nothingNewToPublishLine(DOMAIN), { exact: true }),
		).toHaveCount(0);
	} finally {
		await routes.removeAll();
		await closePageWithUnload(page);
		await streams.close();
	}
});

/** The Publishing card's dialog. */
function cardDialog(page: Page) {
	return page.getByRole("dialog", { name: HQ_CHANGES_DIALOG_TITLE });
}

test("the card's dialog that brought the changes in opens again on its answer once the reload its commit forced has landed", async ({
	page,
}) => {
	const streams = await appStreams();
	const routes = removableRoutes(page);
	try {
		const reloads = { count: 0 };
		await answerNova(page, () => [recordView()], streams.route("own"));
		await snapshotRoute(page, reloads);
		await recorded(routes, "/api/commcare/changes/review", (route) =>
			fulfillStream(route, stream(changes())),
		);
		const bringIns = await recorded(
			routes,
			"/api/commcare/changes/bring-in",
			(route) =>
				fulfillStream(
					route,
					stream({
						kind: "brought-in",
						seq: 7,
						discarded: false,
						deployment: recordView(),
					}),
				),
		);
		await page.goto(`${peer.origin}/?role=admin`);
		await page
			.getByRole("button", { name: "See what changed", exact: true })
			.click();
		await cardDialog(page)
			.getByRole("button", { name: BRING_IN_CHANGES_ACTION, exact: true })
			.click();
		await expect(
			cardDialog(page)
				.getByRole("status")
				.filter({
					hasText: broughtInLine(false),
				}),
		).toBeVisible();
		expect(bringIns).toHaveLength(1);
		await expect.poll(() => streams.openedBy("own")).toBe(1);

		await streams.send("reload", ownReload());
		await expect.poll(() => streams.openedBy("own")).toBe(2);
		expect(reloads.count).toBe(1);
		await expect(
			cardDialog(page)
				.getByRole("status")
				.filter({
					hasText: broughtInLine(false),
				}),
		).toBeVisible();
		await expect(page.getByRole("dialog")).toHaveCount(1);
		await expect(
			page.getByText(hqChangesBroughtInToast(null), { exact: true }),
		).toHaveCount(0);
		/* The dialog says it once: closed, it stays closed. */
		await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog")).toHaveCount(0);
	} finally {
		await routes.removeAll();
		await closePageWithUnload(page);
		await streams.close();
	}
});

test("the card's publish over opens the Publish dialog with that choice made, where the key reaches one project space", async ({
	page,
}) => {
	const routes = removableRoutes(page);
	try {
		await answerNova(page, () => [recordView()]);
		const uploads = await recorded(routes, "/api/commcare/upload", (route) =>
			route.fulfill({ json: LANDED }),
		);
		await recorded(routes, "/api/commcare/changes/review", (route) =>
			fulfillStream(
				route,
				stream(changes({ novaChanges: ["The app's name"] })),
			),
		);
		await page.goto(`${peer.origin}/?role=admin`);
		await page
			.getByRole("button", { name: "See what changed", exact: true })
			.click();
		await cardDialog(page)
			.getByRole("button", { name: PUBLISH_OVER_HQ_ACTION, exact: true })
			.click();

		const dialog = page.getByRole("dialog", { name: "Publish app" });
		await expect(
			dialog.getByText(PUBLISH_OVER_CHOSEN_LINE, { exact: true }),
		).toBeVisible();
		await dialog.getByRole("button", { name: "Continue", exact: true }).click();
		await dialog
			.getByRole("button", { name: "Publish over these changes", exact: true })
			.click();
		await expect(
			page.getByText(APP_PREVIEW_NOTE, { exact: true }),
		).toBeVisible();
		expect(uploads).toHaveLength(1);
		expect(
			(uploads[0] as { discard_remote_changes: unknown })
				.discard_remote_changes,
		).toEqual([
			{ kind: "app", novaResourceId: APP_ID, observedDigest: OBSERVED_DIGEST },
		]);
	} finally {
		await routes.removeAll();
	}
});

test("publishing over from the panel works where CommCare HQ was saved again between the refused publish and the review", async ({
	page,
}) => {
	const reread = "digest-app-saved-again";
	const routes = removableRoutes(page);
	try {
		await answerNova(page, () => [recordView()]);
		const uploads = await recorded(
			routes,
			"/api/commcare/upload",
			(route, index) =>
				route.fulfill({ json: index === 0 ? CHANGED_IN_HQ : LANDED }),
		);
		await recorded(routes, "/api/commcare/changes/review", (route) =>
			fulfillStream(
				route,
				stream(
					changes({
						novaChanges: ["The app's name"],
						observedDigest: reread,
					}),
				),
			),
		);
		await publish(page);
		await page
			.getByRole("button", { name: PUBLISH_OVER_HQ_ACTION, exact: true })
			.click();
		const publishOver = page.getByRole("button", {
			name: "Publish over these changes",
			exact: true,
		});
		await expect(publishOver).toBeFocused();
		await expect(publishOver).toBeEnabled();
		await publishOver.click();
		await expect(
			page.getByText(APP_PREVIEW_NOTE, { exact: true }),
		).toBeVisible();
		expect(
			(uploads[1] as { discard_remote_changes: unknown })
				.discard_remote_changes,
		).toEqual([
			{ kind: "app", novaResourceId: APP_ID, observedDigest: reread },
		]);
	} finally {
		await routes.removeAll();
	}
});

test("on the card, a change Nova can't hold draws the two ways on its sentence names", async ({
	page,
}) => {
	const routes = removableRoutes(page);
	try {
		await answerNova(page, () => [recordView()]);
		await recorded(routes, "/api/commcare/changes/review", (route) =>
			fulfillStream(
				route,
				stream({
					kind: "account",
					findings: [ACCOUNT_FINDING],
					more: 0,
					counts: { notYet: 0, never: 1, fixInHq: 0 },
				}),
			),
		);
		for (const role of ["admin", "editor"] as const) {
			await page.goto(`${peer.origin}/?role=${role}`);
			await page
				.getByRole("button", { name: "See what changed", exact: true })
				.click();
			const card = cardDialog(page);
			await expect(
				card.getByText(CANNOT_BRING_IN_OTHER_WAYS, { exact: true }),
			).toBeVisible();
			await expect(
				card.getByRole("button", { name: PUBLISH_OVER_HQ_ACTION, exact: true }),
			).toBeVisible();
			if (role === "admin") {
				await expect(
					card.getByRole("button", {
						name: STOP_PUBLISHING_ACTION,
						exact: true,
					}),
				).toHaveAccessibleDescription(STOP_PUBLISHING_HELPER);
			} else {
				await expect(
					card.getByText(DRIFT_STOP_EDITOR_LINE, { exact: true }),
				).toBeVisible();
			}
		}
		/* Publish over opens the Publish dialog on the project space, where the
		 * publish stops on the change with its own Publish over this. */
		await cardDialog(page)
			.getByRole("button", { name: PUBLISH_OVER_HQ_ACTION, exact: true })
			.click();
		await expect(cardDialog(page)).toHaveCount(0);
		await expect(
			page.getByRole("dialog", { name: "Publish app" }),
		).toBeVisible();
	} finally {
		await routes.removeAll();
	}
});

test("the card's bring-in that answers after its dialog closed, and before its own reload, is said again once that reload lands", async ({
	page,
}) => {
	const streams = await appStreams();
	const routes = removableRoutes(page);
	const sent = Promise.withResolvers<Route>();
	try {
		const reloads = { count: 0 };
		await answerNova(page, () => [recordView()], streams.route("own"));
		await snapshotRoute(page, reloads);
		await recorded(routes, "/api/commcare/changes/review", (route) =>
			fulfillStream(route, stream(changes())),
		);
		await routes.route("**/api/commcare/changes/bring-in", async (route) => {
			sent.resolve(route);
		});
		await page.goto(`${peer.origin}/?role=admin`);
		await page
			.getByRole("button", { name: "See what changed", exact: true })
			.click();
		await cardDialog(page)
			.getByRole("button", { name: BRING_IN_CHANGES_ACTION, exact: true })
			.click();
		const bringIn = await sent.promise;
		await expect.poll(() => streams.openedBy("own")).toBe(1);

		/* The person closes the card's dialog while the bring-in runs. */
		await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog")).toHaveCount(0);

		/* Its answer comes before its own reload: the header opens the card's
		 * dialog on it at once. */
		await fulfillStream(
			bringIn,
			stream({
				kind: "brought-in",
				seq: 7,
				discarded: false,
				deployment: recordView(),
			}),
		);
		const line = cardDialog(page)
			.getByRole("status")
			.filter({ hasText: broughtInLine(false) });
		await expect(line).toBeVisible();

		/* The reload closes it with the header's controls, and opens it
		 * again once it has landed. */
		await streams.send("reload", ownReload());
		await expect.poll(() => streams.openedBy("own")).toBe(2);
		expect(reloads.count).toBe(1);
		await expect(line).toBeVisible();
		await expect(page.getByRole("dialog")).toHaveCount(1);
		await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog")).toHaveCount(0);
	} finally {
		await routes.removeAll();
		await closePageWithUnload(page);
		await streams.close();
	}
});

test("a publish that lands with no record to read back still takes the project space out of the header's See what changed in CommCare HQ", async ({
	page,
}) => {
	const routes = removableRoutes(page);
	try {
		await answerNova(page, () => [recordView()]);
		const uploads = await recorded(routes, "/api/commcare/upload", (route) =>
			route.fulfill({ json: LANDED }),
		);
		const headerChanges = page.getByRole("button", {
			name: SEE_WHAT_CHANGED_IN_HQ_ACTION,
			exact: true,
		});
		await page.goto(`${peer.origin}/?role=admin&changed=production:${DOMAIN}`);
		await expect(headerChanges).toBeVisible();
		await uploadFromPublish(page);
		await expect(
			page.getByText(APP_PREVIEW_NOTE, { exact: true }),
		).toBeVisible();
		expect(uploads).toHaveLength(1);
		expect(LANDED.deployment).toBeNull();
		/* The open dialog hides the header from the accessibility tree, so
		 * the header is read once it has closed. */
		await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await expect(publishButton(page)).toBeVisible();
		await expect(headerChanges).toHaveCount(0);
	} finally {
		await routes.removeAll();
	}
});

test("on the card, a bring-in the gate refuses draws the publish over its sentence names, which opens the Publish dialog with that choice made", async ({
	page,
}) => {
	const routes = removableRoutes(page);
	try {
		await answerNova(page, () => [recordView()]);
		await recorded(routes, "/api/commcare/changes/review", (route) =>
			fulfillStream(route, stream(changes())),
		);
		await recorded(routes, "/api/commcare/changes/bring-in", (route) =>
			fulfillStream(
				route,
				stream({
					kind: "gate",
					findings: ["The automation Follow up reads the property age."],
					details: ["The automation Follow up reads the property `age`."],
				}),
			),
		);
		await page.goto(`${peer.origin}/?role=admin`);
		await page
			.getByRole("button", { name: "See what changed", exact: true })
			.click();
		const card = cardDialog(page);
		/* S1 on the card offers no publish over until G1 names it. */
		await expect(
			card.getByRole("button", { name: PUBLISH_OVER_HQ_ACTION, exact: true }),
		).toHaveCount(0);
		await card
			.getByRole("button", { name: BRING_IN_CHANGES_ACTION, exact: true })
			.click();
		await expect(
			card.getByText(HQ_CHANGES_GATE_NEXT, { exact: false }),
		).toBeVisible();
		const publishOver = card.getByRole("button", {
			name: PUBLISH_OVER_HQ_ACTION,
			exact: true,
		});
		await expect(publishOver).toHaveAccessibleDescription(
			PUBLISH_OVER_HQ_HELPER,
		);
		await publishOver.click();
		await expect(cardDialog(page)).toHaveCount(0);
		const dialog = page.getByRole("dialog", { name: "Publish app" });
		await expect(
			dialog.getByText(PUBLISH_OVER_CHOSEN_LINE, { exact: true }),
		).toBeVisible();
	} finally {
		await routes.removeAll();
	}
});
