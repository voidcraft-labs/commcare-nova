import { createServer, get as httpGet, type ServerResponse } from "node:http";
import type { Page, Route } from "@playwright/test";
import {
	declarationRows,
	recordedFeaturesLine,
	STOP_ACTIONS,
	stopActionLabel,
	tableChoiceView,
} from "@/components/bring-in/bringInModel";
import { keptDateText } from "@/components/builder/keptListModel";
import type { AdoptedAppReceipt } from "@/lib/db/appGenesis";
import type { CommCareSettingsPublic } from "@/lib/db/settings";
import type {
	AccountAnswer,
	BringInInput,
	CreateAnswer,
	HqAppPicker,
	ReadingAnswer,
	ReadingEvent,
	ReadingKey,
	ReadingReview,
	ReviewTable,
} from "@/lib/deployment";
import { hqPlaceUrl } from "@/lib/deployment/hqPlaceUrl";
import { deploymentServerLabel } from "@/lib/deployment/types";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import { lookupTableIdSchema } from "@/lib/domain/lookupIds";
import { PLATFORM_FEATURES } from "@/lib/domain/platforms";
import {
	accountHeadingLine,
	accountLead,
	BRING_IN_ACTIONS,
	BRING_IN_NOT_CONNECTED_TITLE,
	CONNECTION_CHECK_FAILED,
	CREATING_LOST_LINE,
	CREATING_STATUS,
	NAMED_IN_HQ_LEAD,
	PICKER_APP_FILTER_PLACEHOLDER,
	PICKER_HEADING,
	PICKER_READ_WAITS_LINE,
	PICKER_SPACE_LABEL,
	PICKER_SPACE_NO_MATCH,
	pickerOneSpaceLine,
	pickerProjectLine,
	READING_LOST_AFTER_CREATE_LINE,
	READING_LOST_LINE,
	READING_SLOW_LINE,
	REVIEW_CHOICE_MISSING,
	REVIEW_NAME_NONE_IN_HQ,
	REVIEW_NO_CHOICE_OPEN,
	REVIEW_WEB_APPS_ASKS_OFF,
	readFailedAfterCreateBody,
	readingStatusLine,
	readingWaitsForCreateLine,
	reviewHeading,
	SIGNED_OUT_LINE,
	SIGNED_OUT_TITLE,
	stopNothingChangedLine,
	TRYING_AGAIN,
} from "@/lib/publish/bringInCopy";
import {
	FIRST_PUBLISH_FORM_BUILDER_NOTE,
	FIRST_PUBLISH_NO_WORKER_CHANGE,
	firstPublishLines,
} from "@/lib/publish/firstPublishCopy";
import {
	HQ_APP_CLAIM_ELSEWHERE_LABEL,
	HQ_APP_CLAIM_OPEN_ACTION,
} from "@/lib/publish/hqAppClaims";
import {
	ACCOUNT_CHECK_AGAIN_LINE,
	alreadyInNovaNext,
	type CircumstanceContext,
	circumstanceBlock,
	FINDING_LABELS,
	findingLine,
} from "@/lib/publish/hqFindingCopy";
import {
	type CircumstanceFinding,
	circumstanceFinding,
	type Finding,
	type HqPlace,
	type StopCircumstance,
} from "@/lib/publish/hqFindings";
import {
	CREATE_ANSWER_LEADS,
	READING_FAILED_COPY,
	READING_REFUSAL_COPY,
	READING_STAGE_LABELS,
	UNVERIFIED_LANDING_TITLE,
} from "@/lib/publish/hqReadingCopy";
import { CHOICE_OTHER_PROJECT } from "@/lib/publish/managedData";
import { bringInHref } from "@/lib/routing/bringInLocation";
import type {
	BringInPeerConfig,
	BringInPeerLanding,
} from "../../lib/bring-in-client";
import { componentPeer } from "../../lib/componentPeer";
import { expect, test } from "../../lib/fixtures";
import { openPage, reloadPage } from "../../lib/pageLoads";
import { type RemovableRoutes, removableRoutes } from "../../lib/routes";

/**
 * Bringing an app in from CommCare HQ, as a person sees it, on the
 * production flow mounted in the production connection context. Every Nova
 * route the flow calls is answered here with bodies typed by the production
 * types: the picker's list and the connection as JSON, a read and a create
 * as NDJSON, one `ReadingEvent` a line. A body whose lines a journey writes
 * one at a time, or holds open, is answered by a local stream the route
 * continues to, so the page reads it as it arrives.
 */

/** The key the page keeps a create in, to send it again after a reload. */
const CREATE_KEY = "nova:bring-in-create";

const TEAM = { id: "project-team", name: "Clinic team", personal: false };
const PERSONAL = {
	id: "project-personal",
	name: "Ada Lovelace",
	personal: true,
};
const CONNECTED: CommCareSettingsPublic = {
	configured: true,
	username: "ada@clinic.example",
	server: "india",
	availableDomains: [{ name: "clinic", displayName: "Clinic" }],
};
const TWO_SPACES: CommCareSettingsPublic = {
	...CONNECTED,
	availableDomains: [
		{ name: "clinic", displayName: "Clinic" },
		{ name: "district", displayName: "District" },
	],
};
const SERVER_LABEL = deploymentServerLabel("india");
const KEY: ReadingKey = {
	projectId: TEAM.id,
	server: "india",
	domain: "clinic",
	remoteAppId: "2b9a6c1d4e5f40718293a4b5c6d7e8f9",
};
const APP_ADDRESS = bringInHref({ kind: "app", key: KEY });
const CHOOSE_ADDRESS = bringInHref({ kind: "choose" });
/** A day the journeys' claims and reads are dated by, spelled in the page's locale. */
const CLAIMED_AT = "2026-10-02T09:30:00.000Z";
const formatDate = (iso: string) => keptDateText(iso, new Date(), "en-US");

test.use({ actionTimeout: 10_000, locale: "en-US" });

let peer: Awaited<ReturnType<typeof componentPeer>>;
test.beforeAll(async () => {
	peer = await componentPeer("e2e/lib/bring-in-client.tsx");
});
test.afterAll(async () => {
	await peer?.close();
});

// ---------------------------------------------------------------------------
// Bodies, built from the production types
// ---------------------------------------------------------------------------

function ndjson(events: readonly ReadingEvent[]): string {
	return events.map((event) => `${JSON.stringify(event)}\n`).join("");
}

/** A read's or a create's whole answer: two stages, then its last line. */
function answered(answer: ReadingAnswer | CreateAnswer): string {
	return ndjson([
		{ type: "stage", stage: "connecting" },
		{ type: "stage", stage: "reading-app" },
		{ type: "done", answer },
	]);
}

async function fulfillNdjson(route: Route, body: string): Promise<void> {
	await route.fulfill({
		status: 200,
		contentType: "application/x-ndjson",
		body,
	});
}

const READING_ID = "01928c3e-5b7a-7cde-8f01-23456789abcd";
const TABLE_ID = lookupTableIdSchema.parse(
	"01928c3e-5b7a-7cde-8f01-0000000000aa",
);

/** A table whose tag meets one the Project has, with both answers offered. */
const DISTRICT_TABLE: ReviewTable = {
	tag: "district",
	standing: "choice",
	hqDigest: "a".repeat(64),
	projectTable: {
		tableId: TABLE_ID,
		definitionRevision: "3",
		rowsRevision: "7",
	},
	choice: {
		differs: ["rows"],
		apps: [],
		options: {
			"use-commcare-hq": { offered: true, goneColumns: [], retypedColumns: [] },
			"use-project": { offered: true, goneColumns: [], retypedColumns: [] },
		},
	},
};

/** The same table where neither answer is open to the person. */
const CLOSED_TABLE: ReviewTable = {
	...DISTRICT_TABLE,
	choice: {
		differs: ["rows"],
		apps: [],
		options: {
			"use-commcare-hq": { offered: false, why: "needs-admin", name: null },
			"use-project": { offered: false, why: "needs-admin", name: null },
		},
	},
};

/**
 * The review of an app that runs on both platforms, preselected, or on
 * Android alone, with CommCare HQ's Web Apps on and one table to answer.
 */
function reviewOf(overrides: Partial<ReadingReview> = {}): ReadingReview {
	return {
		appName: "Household visits",
		readAt: CLAIMED_AT,
		creates: {
			menus: 2,
			forms: 3,
			questions: 14,
			caseTypes: ["household"],
			languages: ["en"],
			mediaFiles: 0,
		},
		runsOn: [
			{
				runsOnlyOn: null,
				splitDatetime: false,
				preselected: true,
				recordedFeatures: [{ kind: "plan-feature", subject: "lookup-tables" }],
				firstPublish: {
					ids: ["forms-and-settings-rewritten"],
					touchesWorkers: false,
					of: "first-publish",
				},
			},
			{
				runsOnlyOn: "android",
				splitDatetime: false,
				preselected: false,
				recordedFeatures: [
					{ kind: "plan-feature", subject: "lookup-tables" },
					{ kind: "plan-feature", subject: "child-cases" },
				],
				firstPublish: {
					ids: ["forms-and-settings-rewritten", "web-apps-turned-off"],
					touchesWorkers: true,
					of: "first-publish",
				},
			},
		],
		runsOnWhy: "content",
		webAppsOnInHq: true,
		datetimeQuestions: 0,
		platformsOut: [],
		kept: [],
		tables: [DISTRICT_TABLE],
		ownerRules: [],
		places: null,
		mediaLeftOut: 0,
		firstPublish: {
			ids: ["forms-and-settings-rewritten"],
			touchesWorkers: false,
			of: "first-publish",
		},
		...overrides,
	};
}

function reviewAnswer(
	review: ReadingReview = reviewOf(),
	digest = "d".repeat(64),
): Extract<ReadingAnswer, { kind: "review" }> {
	return {
		kind: "review",
		readingId: READING_ID,
		reviewDigest: digest,
		review,
	};
}

/** What the review sends with its defaults and `district` answered `use-project`. */
const ANSWERED_INPUT: BringInInput = {
	...KEY,
	readingId: READING_ID,
	reviewDigest: "d".repeat(64),
	appName: "Household visits",
	runsOnlyOn: null,
	splitDatetime: false,
	tableChoices: { district: "use-project" },
};

function receiptOf(input: BringInInput): AdoptedAppReceipt {
	const appId = "0192a000-0000-7000-8000-000000000001";
	const doc = emptyBlueprintDoc(appId);
	return {
		eventVersion: 1,
		designSessionId: null,
		appId,
		projectId: input.projectId,
		role: "editor",
		canEdit: true,
		seq: 1,
		batchId: "0192a000-0000-7000-8000-000000000002",
		changeSetId: null,
		snapshotDigest: "e".repeat(64),
		blueprint: toPersistableDoc({ ...doc, appName: input.appName }),
		starter: null,
		adoption: {
			server: input.server,
			domain: input.domain,
			remoteAppId: input.remoteAppId,
		},
	};
}

function pickerOf(
	domain: string,
	apps: Extract<HqAppPicker, { kind: "apps" }>["apps"],
): HqAppPicker {
	return { kind: "apps", server: "india", domain, apps };
}

const CLINIC_APPS = pickerOf("clinic", [
	{ remoteAppId: "aaaa0001", name: "Household visits", claim: null },
	{
		remoteAppId: "aaaa0002",
		name: "Growth monitoring",
		claim: {
			kind: "open",
			appId: "0192b000-0000-7000-8000-00000000000a",
			appName: "Growth",
		},
	},
	{
		remoteAppId: "aaaa0003",
		name: "Referrals",
		claim: {
			kind: "elsewhere",
			at: CLAIMED_AT,
			contact: { role: "person", names: ["Grace Hopper"] },
		},
	},
	{ remoteAppId: "aaaa0004", name: "Antenatal care", claim: null },
]);

const DISTRICT_APPS = pickerOf(
	"district",
	[
		"Water points",
		"School health",
		"Bed nets",
		"Malaria screening",
		"Nutrition",
		"Vaccination",
		"Births",
		"Deaths",
		"Outreach",
		"Supervision",
	].map((name, index) => ({
		remoteAppId: `dddd00${String(index).padStart(2, "0")}`,
		name,
		claim: null,
	})),
);

// ---------------------------------------------------------------------------
// The page, its routes and a stream a journey writes line by line
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: BringInPeerConfig = {
	settings: CONNECTED,
	projects: [TEAM, PERSONAL],
	tabProjectId: TEAM.id,
	landing: "landed",
};

/**
 * Opens the peer at `address`, a `/build/new` address as the flow writes
 * one. The peer's page is served at that address too, so a reload of the
 * page the flow pushed loads the flow again.
 */
async function open(
	page: Page,
	routes: RemovableRoutes,
	address: string,
	config: Partial<BringInPeerConfig> = {},
	origin: string = peer.origin,
): Promise<void> {
	await page.addInitScript(
		(peerConfig: BringInPeerConfig) => {
			window.__bringInPeer = peerConfig;
		},
		{ ...DEFAULT_CONFIG, ...config },
	);
	await routes.route(
		(url) => url.origin === origin && url.pathname === "/build/new",
		async (route) => {
			const response = await route.fetch({ url: `${peer.origin}/` });
			await route.fulfill({ response });
		},
	);
	await openPage(page, `${origin}${address}`);
}

/** A route that records each JSON body it is posted. */
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

async function answerApps(
	routes: RemovableRoutes,
	pickers: Readonly<Record<string, HqAppPicker>>,
): Promise<string[]> {
	const asked: string[] = [];
	await routes.route("**/api/commcare/hq-apps?*", async (route) => {
		const domain = new URL(route.request().url()).searchParams.get("domain");
		asked.push(domain ?? "");
		const picker = domain === null ? undefined : pickers[domain];
		if (picker === undefined) {
			await route.fulfill({ status: 404, json: { error: "No such list" } });
			return;
		}
		await route.fulfill({ json: { picker } });
	});
	return asked;
}

interface HeldStream {
	/** The body the page posted. */
	readonly body: unknown;
	write(event: ReadingEvent): Promise<void>;
	/** Ends the response; a body that ends with no `done` or `failed` line is a lost request. */
	end(): Promise<void>;
}

/**
 * A local server the page is opened from when a journey writes a read or a
 * create one line at a time, or holds one open: it answers each POST with an
 * NDJSON stream the journey writes, and every other request from the
 * component peer. `route.fulfill` sends a whole body at once, so a route of
 * a stream continues the request here, on the page's own origin.
 */
async function streamPeer() {
	const arrived: HeldStream[] = [];
	const open = new Set<ServerResponse>();
	const server = createServer((request, response) => {
		if (request.method !== "POST") {
			const asset = httpGet(`${peer.origin}${request.url ?? "/"}`, (served) => {
				response.writeHead(served.statusCode ?? 502, {
					"content-type":
						served.headers["content-type"] ?? "application/octet-stream",
				});
				served.pipe(response);
			});
			asset.on("error", () => {
				response.writeHead(502);
				response.end();
			});
			return;
		}
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			response.writeHead(200, {
				"content-type": "application/x-ndjson",
				"cache-control": "no-store",
			});
			response.flushHeaders();
			open.add(response);
			response.on("close", () => open.delete(response));
			arrived.push({
				body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
				write: (event) =>
					new Promise<void>((resolve, reject) =>
						response.write(`${JSON.stringify(event)}\n`, (error) =>
							error ? reject(error) : resolve(),
						),
					),
				end: () => new Promise<void>((resolve) => response.end(resolve)),
			});
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Missing stream peer port");
	return {
		/** Where `open` serves the page from. */
		origin: `http://127.0.0.1:${address.port}`,
		/** Answers a route by letting its request through to this server. */
		async continue(route: Route): Promise<void> {
			await route.continue();
		},
		/** The `index`th request this server was sent, once it has arrived. */
		async request(index: number): Promise<HeldStream> {
			await expect.poll(() => arrived.length).toBeGreaterThan(index);
			const held = arrived[index];
			if (held === undefined) throw new Error("Missing held stream");
			return held;
		},
		async close(): Promise<void> {
			for (const response of open) response.destroy();
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		},
	};
}

/** What the recording landing was called with. */
async function landings(page: Page): Promise<BringInPeerLanding[]> {
	return await page.evaluate(() => window.__bringInLandings ?? []);
}

function heading(page: Page, name: string) {
	return page.getByRole("heading", { level: 1, name, exact: true });
}

/**
 * The stage line as it is drawn. A screen reader's copy of it stands beside
 * it with the count it last announced, so the drawn one comes first.
 */
function stageLine(page: Page, label: string) {
	return page.getByText(label, { exact: true }).first();
}

function button(page: Page, name: string) {
	return page.getByRole("button", { name, exact: true });
}

/** The context the page fills a circumstance from, at an app's address opened afresh. */
const ADDRESS_CONTEXT: CircumstanceContext = {
	server: SERVER_LABEL,
	space: KEY.domain,
	app: null,
	formatDate,
};

/** Fixed instants for a controlled clock: a page loads at the first, and the journey pauses at the second. */
const CLOCK_START = new Date("2026-01-01T00:00:00Z");
const CLOCK_PAUSE = new Date("2026-01-01T01:00:00Z");

// ---------------------------------------------------------------------------
// Choosing
// ---------------------------------------------------------------------------

test.describe("choosing", () => {
	test("with no connection the aside invites one, and Check connection brings the fields back on the same address", async ({
		page,
	}) => {
		const routes = removableRoutes(page);
		try {
			let checks = 0;
			await routes.route("**/api/commcare/connection", async (route) => {
				checks++;
				if (checks === 1) {
					await route.abort("failed");
					return;
				}
				await route.fulfill({ json: { connection: CONNECTED } });
			});
			const asked = await answerApps(routes, { clinic: CLINIC_APPS });
			await open(page, routes, CHOOSE_ADDRESS, {
				settings: { configured: false },
			});
			await expect(heading(page, PICKER_HEADING)).toBeVisible();
			await expect(
				page.getByRole("heading", { name: BRING_IN_NOT_CONNECTED_TITLE }),
			).toBeVisible();
			await expect(
				page.getByText(PICKER_SPACE_LABEL, { exact: true }),
			).toHaveCount(0);

			await button(page, "Check connection").click();
			await expect(
				page.getByRole("alert").filter({ hasText: CONNECTION_CHECK_FAILED }),
			).toBeVisible();
			await expect(button(page, "Check connection")).toBeEnabled();
			expect(checks).toBe(1);

			await button(page, "Check connection").click();
			const space = page.getByText(pickerOneSpaceLine("clinic", SERVER_LABEL), {
				exact: true,
			});
			await expect(space).toBeFocused();
			await expect(
				page.getByRole("heading", { name: BRING_IN_NOT_CONNECTED_TITLE }),
			).toHaveCount(0);
			expect(checks).toBe(2);
			expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(
				CHOOSE_ADDRESS,
			);
			// One project space lists its apps with no choice asked.
			await expect(
				page.getByRole("radio", { name: "Household visits", exact: true }),
			).toBeVisible();
			expect(asked).toEqual(["clinic"]);
			await expect(
				page.getByRole("combobox", { name: PICKER_SPACE_LABEL }),
			).toHaveCount(0);
		} finally {
			await routes.removeAll();
		}
	});

	test("a chosen project space lists its apps, a held row says why it can't be chosen, and the filter narrows", async ({
		page,
	}) => {
		const routes = removableRoutes(page);
		try {
			const asked = await answerApps(routes, {
				clinic: CLINIC_APPS,
				district: DISTRICT_APPS,
			});
			await open(page, routes, CHOOSE_ADDRESS, { settings: TWO_SPACES });
			await expect(heading(page, PICKER_HEADING)).toBeVisible();
			expect(asked).toEqual([]);
			await page.getByRole("combobox", { name: PICKER_SPACE_LABEL }).click();
			await page.getByRole("option", { name: "Clinic", exact: true }).click();
			const growth = page.getByRole("radio", {
				name: "Growth monitoring",
				exact: true,
			});
			await expect(growth).toBeVisible();
			expect(asked).toEqual(["clinic"]);

			// A row Nova already holds, in a Project the person is part of.
			await expect(growth).toHaveAttribute("aria-disabled", "true");
			/* Its reason makes it taller, and the mark keeps to the label's first
			 * line rather than the row's middle. */
			const growthMark = await growth
				.locator('span[aria-hidden="true"]')
				.first()
				.boundingBox();
			const growthLabel = await growth.locator('[id$="-label"]').boundingBox();
			const growthRow = await growth.boundingBox();
			if (growthMark === null || growthLabel === null || growthRow === null)
				throw new Error("Missing the claimed row");
			expect(Math.round(growthRow.height)).toBeGreaterThan(44);
			expect(Math.round(growthMark.y)).toBe(Math.round(growthLabel.y));
			await expect(
				page.getByRole("button", {
					name: `${HQ_APP_CLAIM_OPEN_ACTION} Growth monitoring`,
				}),
			).toHaveAttribute("href", "/build/0192b000-0000-7000-8000-00000000000a");
			/* A row that cannot be chosen still takes the press, which changes
			 * nothing; Playwright's own check would refuse to send it. */
			await growth.click({ force: true });
			await expect(growth).not.toBeChecked();

			// A row held in a Project the person is not part of.
			const referrals = page.getByRole("radio", {
				name: "Referrals",
				exact: true,
			});
			await expect(referrals).toHaveAttribute("aria-disabled", "true");
			await expect(
				page.getByText(HQ_APP_CLAIM_ELSEWHERE_LABEL, { exact: true }),
			).toBeVisible();
			await expect(
				page.getByText(
					alreadyInNovaNext(
						{
							kind: "elsewhere",
							at: CLAIMED_AT,
							contact: { role: "person", names: ["Grace Hopper"] },
						},
						formatDate,
					),
					{ exact: true },
				),
			).toBeVisible();
			await referrals.click({ force: true });
			await expect(referrals).not.toBeChecked();

			// More than eight apps stand under a filter.
			await page.getByRole("combobox", { name: PICKER_SPACE_LABEL }).click();
			await page.getByRole("option", { name: "District", exact: true }).click();
			const filter = page.getByRole("searchbox", {
				name: PICKER_APP_FILTER_PLACEHOLDER,
			});
			await expect(filter).toBeVisible();
			expect(asked).toEqual(["clinic", "district"]);
			await expect(page.getByRole("radio")).toHaveCount(10);
			await filter.fill("health");
			await expect(page.getByRole("radio")).toHaveCount(1);
			await expect(
				page.getByRole("radio", { name: "School health", exact: true }),
			).toBeVisible();
		} finally {
			await routes.removeAll();
		}
	});

	test("the arrow keys move through every row, the held ones included, and a held row takes no Space", async ({
		page,
	}) => {
		const routes = removableRoutes(page);
		try {
			await answerApps(routes, { clinic: CLINIC_APPS });
			await open(page, routes, CHOOSE_ADDRESS);
			const growth = page.getByRole("radio", {
				name: "Growth monitoring",
				exact: true,
			});
			const referrals = page.getByRole("radio", {
				name: "Referrals",
				exact: true,
			});
			const household = page.getByRole("radio", {
				name: "Household visits",
				exact: true,
			});
			await household.click();
			await expect(household).toBeChecked();
			await page.keyboard.press("ArrowDown");
			await expect(growth).toBeFocused();
			await page.keyboard.press("Space");
			await expect(growth).not.toBeChecked();
			await expect(household).toBeChecked();
			await page.keyboard.press("ArrowDown");
			await expect(referrals).toBeFocused();
			await page.keyboard.press("ArrowDown");
			const antenatal = page.getByRole("radio", {
				name: "Antenatal care",
				exact: true,
			});
			await expect(antenatal).toBeFocused();
			await expect(antenatal).toBeChecked();
		} finally {
			await routes.removeAll();
		}
	});

	test("Read this app puts the app's address in place and posts exactly its key, and Back returns to the list", async ({
		page,
	}) => {
		const routes = removableRoutes(page);
		try {
			await answerApps(routes, { clinic: CLINIC_APPS });
			const reads = await recorded(
				routes,
				"/api/commcare/bring-in/read",
				(route) => fulfillNdjson(route, answered(reviewAnswer())),
			);
			await open(page, routes, CHOOSE_ADDRESS);
			await expect(
				page.getByText(pickerProjectLine(TEAM), { exact: true }),
			).toBeVisible();
			await page.getByRole("combobox", { name: "Add it to" }).click();
			await page
				.getByRole("option", { name: PERSONAL.name, exact: true })
				.click();
			await expect(
				page.getByText(pickerProjectLine(PERSONAL), { exact: true }),
			).toBeVisible();
			await page
				.getByRole("radio", { name: "Antenatal care", exact: true })
				.click();
			await button(page, BRING_IN_ACTIONS.readThisApp).click();
			const key: ReadingKey = {
				projectId: PERSONAL.id,
				server: "india",
				domain: "clinic",
				remoteAppId: "aaaa0004",
			};
			await expect(page).toHaveURL(
				`${peer.origin}${bringInHref({ kind: "app", key })}`,
			);
			await expect(
				heading(page, reviewHeading("Household visits")),
			).toBeVisible();
			expect(reads).toEqual([key]);

			await page.goBack();
			await expect(page).toHaveURL(`${peer.origin}${CHOOSE_ADDRESS}`);
			await expect(heading(page, PICKER_HEADING)).toBeVisible();
			await expect(
				page.getByRole("radio", { name: "Antenatal care", exact: true }),
			).toBeChecked();
			await expect(page.getByRole("radio")).toHaveCount(4);
		} finally {
			await routes.removeAll();
		}
	});

	test("a person who may add an app to no Project reads why, with no fields", async ({
		page,
	}) => {
		const routes = removableRoutes(page);
		try {
			const asked = await answerApps(routes, { clinic: CLINIC_APPS });
			await open(page, routes, CHOOSE_ADDRESS, { projects: [] });
			await expect(
				page.getByText(READING_REFUSAL_COPY.no_project_access, { exact: true }),
			).toBeVisible();
			await expect(page.getByRole("combobox")).toHaveCount(0);
			await expect(page.getByRole("radio")).toHaveCount(0);
			await expect(button(page, BRING_IN_ACTIONS.readThisApp)).toHaveCount(0);
			expect(asked).toEqual([]);
		} finally {
			await routes.removeAll();
		}
	});

	test("a list that found no key is read again once Check connection finds one", async ({
		page,
	}) => {
		const routes = removableRoutes(page);
		try {
			/* The page loaded with a connection, and the key was removed
			 * elsewhere before the list was read: the list answers that there is
			 * no connection, and the connection route finds the key again. */
			const asked: string[] = [];
			await routes.route("**/api/commcare/hq-apps?*", async (route) => {
				asked.push(
					new URL(route.request().url()).searchParams.get("domain") ?? "",
				);
				const picker: HqAppPicker =
					asked.length === 1 ? { kind: "not-connected" } : CLINIC_APPS;
				await route.fulfill({ json: { picker } });
			});
			let checks = 0;
			await routes.route("**/api/commcare/connection", async (route) => {
				checks++;
				await route.fulfill({ json: { connection: CONNECTED } });
			});
			await open(page, routes, CHOOSE_ADDRESS);
			await expect(
				page.getByRole("heading", { name: BRING_IN_NOT_CONNECTED_TITLE }),
			).toBeVisible();
			await expect(page.getByRole("radio")).toHaveCount(0);

			await button(page, "Check connection").click();
			await expect(
				page.getByRole("radio", { name: "Household visits", exact: true }),
			).toBeVisible();
			await expect(
				page.getByText(pickerOneSpaceLine("clinic", SERVER_LABEL), {
					exact: true,
				}),
			).toBeFocused();
			await expect(
				page.getByRole("heading", { name: BRING_IN_NOT_CONNECTED_TITLE }),
			).toHaveCount(0);
			expect(checks).toBe(1);
			expect(asked).toEqual(["clinic", "clinic"]);
		} finally {
			await routes.removeAll();
		}
	});

	test("a stop met while choosing is announced, says nothing was created, and Check again keeps focus in the card", async ({
		page,
	}) => {
		const routes = removableRoutes(page);
		try {
			const stop = circumstanceFinding("rate-limited", { kind: "app" }, {});
			const asked: string[] = [];
			await routes.route("**/api/commcare/hq-apps?*", async (route) => {
				asked.push(
					new URL(route.request().url()).searchParams.get("domain") ?? "",
				);
				const picker: HqAppPicker =
					asked.length === 1 ? { kind: "stop", finding: stop } : CLINIC_APPS;
				await route.fulfill({ json: { picker } });
			});
			await open(page, routes, CHOOSE_ADDRESS);
			const block = circumstanceBlock(stop, ADDRESS_CONTEXT);
			await expect(
				page.getByRole("heading", { level: 2, name: block.title }),
			).toBeVisible();
			/* The screen's heading never changes, so the region says the stop. */
			await expect(page.locator("[data-bring-in-status]")).toContainText(
				block.title,
			);
			await expect(
				page.getByText(stopNothingChangedLine("read"), { exact: true }),
			).toBeVisible();

			await button(page, BRING_IN_ACTIONS.checkAgain).click();
			const appTitle = page.getByText("App", { exact: true });
			await expect(appTitle).toBeFocused();
			await expect(
				page.getByRole("radio", { name: "Household visits", exact: true }),
			).toBeVisible();
			await expect(appTitle).toBeFocused();
			expect(asked).toEqual(["clinic", "clinic"]);
		} finally {
			await routes.removeAll();
		}
	});

	test("Read this app waits while the filter hides the chosen app, and a one-line row sits centred", async ({
		page,
	}) => {
		const routes = removableRoutes(page);
		try {
			await answerApps(routes, { district: DISTRICT_APPS });
			await open(page, routes, CHOOSE_ADDRESS, {
				settings: {
					...CONNECTED,
					availableDomains: [{ name: "district", displayName: "District" }],
				},
			});
			const water = page.getByRole("radio", {
				name: "Water points",
				exact: true,
			});
			await water.click();
			await expect(water).toBeChecked();

			/* The 44px row keeps its content centred: the mark sits as far from
			 * the top as from the bottom. */
			const row = await water.boundingBox();
			const mark = await water
				.locator('span[aria-hidden="true"]')
				.first()
				.boundingBox();
			if (row === null || mark === null) throw new Error("Missing the row");
			expect(
				Math.round(mark.y - row.y) -
					Math.round(row.y + row.height - (mark.y + mark.height)),
			).toBe(0);

			const read = button(page, BRING_IN_ACTIONS.readThisApp);
			await expect(read).not.toHaveAttribute("aria-disabled", "true");
			await page
				.getByRole("searchbox", { name: PICKER_APP_FILTER_PLACEHOLDER })
				.fill("health");
			await expect(page.getByRole("radio")).toHaveCount(1);
			await expect(page.getByRole("radio", { checked: true })).toHaveCount(0);
			await expect(read).toHaveAttribute("aria-disabled", "true");
			await expect(read).toHaveAccessibleDescription(PICKER_READ_WAITS_LINE);
			// A press on a button that waits is still a press, and changes nothing.
			await read.click({ force: true });
			await expect(page).toHaveURL(`${peer.origin}${CHOOSE_ADDRESS}`);

			/* The filter never cleared the choice. */
			await page
				.getByRole("searchbox", { name: PICKER_APP_FILTER_PLACEHOLDER })
				.fill("");
			await expect(water).toBeChecked();
			await expect(read).not.toHaveAttribute("aria-disabled", "true");
		} finally {
			await routes.removeAll();
		}
	});

	test("more than eight project spaces are searched, and a search that matches none says so", async ({
		page,
	}) => {
		const routes = removableRoutes(page);
		try {
			await answerApps(routes, { clinic: CLINIC_APPS });
			await open(page, routes, CHOOSE_ADDRESS, {
				settings: {
					...CONNECTED,
					availableDomains: Array.from({ length: 9 }, (_, index) => ({
						name: `space-${index + 1}`,
						displayName: `Space ${index + 1}`,
					})),
				},
			});
			const search = page.getByRole("combobox", { name: PICKER_SPACE_LABEL });
			await search.click();
			await search.fill("clinic");
			await expect(
				page.getByText(PICKER_SPACE_NO_MATCH, { exact: true }),
			).toBeVisible();
			await expect(page.getByRole("option")).toHaveCount(0);
			await search.fill("Space 9");
			await expect(
				page.getByRole("option", { name: "Space 9", exact: true }),
			).toBeVisible();
			await expect(
				page.getByText(PICKER_SPACE_NO_MATCH, { exact: true }),
			).toHaveCount(0);
		} finally {
			await routes.removeAll();
		}
	});
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

test.describe("reading", () => {
	test("the stage follows the stream's lines and the count moves", async ({
		page,
	}) => {
		const routes = removableRoutes(page);
		const stream = await streamPeer();
		try {
			await routes.route("**/api/commcare/bring-in/read", (route) =>
				stream.continue(route),
			);
			await open(page, routes, APP_ADDRESS, {}, stream.origin);
			await expect(heading(page, readingStatusLine(null))).toBeVisible();
			const held = await stream.request(0);
			expect(held.body).toEqual(KEY);
			await held.write({ type: "stage", stage: "connecting" });
			await expect(
				stageLine(page, READING_STAGE_LABELS.connecting),
			).toBeVisible();
			await held.write({ type: "stage", stage: "reading-app" });
			await expect(
				stageLine(page, READING_STAGE_LABELS["reading-app"]),
			).toBeVisible();
			await held.write({ type: "stage", stage: "checking-media" });
			await held.write({ type: "files", done: 3, total: 40 });
			await expect(
				stageLine(
					page,
					READING_STAGE_LABELS["checking-media"]({ done: 3, total: 40 }),
				),
			).toBeVisible();
			await held.write({ type: "files", done: 27, total: 40 });
			await expect(
				stageLine(
					page,
					READING_STAGE_LABELS["checking-media"]({ done: 27, total: 40 }),
				),
			).toBeVisible();
			await held.write({ type: "done", answer: reviewAnswer() });
			await held.end();
			await expect(
				heading(page, reviewHeading("Household visits")),
			).toBeVisible();
		} finally {
			await routes.removeAll();
			await stream.close();
		}
	});

	test("the wait keeps company after twenty seconds", async ({ page }) => {
		const routes = removableRoutes(page);
		const stream = await streamPeer();
		await page.clock.install({ time: CLOCK_START });
		try {
			await answerApps(routes, { clinic: CLINIC_APPS });
			await routes.route("**/api/commcare/bring-in/read", (route) =>
				stream.continue(route),
			);
			await open(page, routes, CHOOSE_ADDRESS, {}, stream.origin);
			const household = page.getByRole("radio", {
				name: "Household visits",
				exact: true,
			});
			await household.click();
			await expect(household).toBeChecked();
			await page.clock.pauseAt(CLOCK_PAUSE);
			await button(page, BRING_IN_ACTIONS.readThisApp).click();
			await expect(
				heading(page, readingStatusLine("Household visits")),
			).toBeVisible();
			await stream.request(0);
			await page.clock.runFor(19_000);
			await expect(page.getByText(READING_SLOW_LINE)).toHaveCount(0);
			await page.clock.runFor(1_000);
			await expect(page.getByText(READING_SLOW_LINE)).toBeVisible();
		} finally {
			await page.clock.resume();
			await routes.removeAll();
			await stream.close();
		}
	});

	test("a lost response is read again once after three seconds, and a second offers Try again", async ({
		page,
	}) => {
		const routes = removableRoutes(page);
		await page.clock.install({ time: CLOCK_START });
		try {
			const reads = await recorded(
				routes,
				"/api/commcare/bring-in/read",
				(route, index) =>
					fulfillNdjson(
						route,
						index < 2
							? ndjson([{ type: "stage", stage: "connecting" }])
							: answered(reviewAnswer()),
					),
			);
			await answerApps(routes, { clinic: CLINIC_APPS });
			await open(page, routes, CHOOSE_ADDRESS);
			const household = page.getByRole("radio", {
				name: "Household visits",
				exact: true,
			});
			await household.click();
			await expect(household).toBeChecked();
			await page.clock.pauseAt(CLOCK_PAUSE);
			await button(page, BRING_IN_ACTIONS.readThisApp).click();
			await expect(page.getByText(TRYING_AGAIN, { exact: true })).toBeVisible();
			expect(reads).toHaveLength(1);
			await page.clock.runFor(2_999);
			expect(reads).toHaveLength(1);
			await page.clock.runFor(1);
			await expect(
				page.getByText(READING_LOST_LINE, { exact: true }),
			).toBeVisible();
			expect(reads).toHaveLength(2);
			await page.clock.runFor(10_000);
			expect(reads).toHaveLength(2);
			await button(page, BRING_IN_ACTIONS.tryAgain).click();
			await expect(
				heading(page, reviewHeading("Household visits")),
			).toBeVisible();
			expect(reads).toHaveLength(3);
			expect(new Set(reads.map((body) => JSON.stringify(body))).size).toBe(1);
		} finally {
			await page.clock.resume();
			await routes.removeAll();
		}
	});

	test("a failed line shows Nova's own failure and posts nothing more until Try again", async ({
		page,
	}) => {
		const routes = removableRoutes(page);
		await page.clock.install({ time: CLOCK_START });
		try {
			const reads = await recorded(
				routes,
				"/api/commcare/bring-in/read",
				(route, index) =>
					fulfillNdjson(
						route,
						index === 0
							? ndjson([
									{ type: "stage", stage: "connecting" },
									{ type: "failed" },
								])
							: answered(reviewAnswer()),
					),
			);
			await open(page, routes, APP_ADDRESS);
			await expect(heading(page, READING_FAILED_COPY.read.title)).toBeVisible();
			await page.clock.pauseAt(CLOCK_PAUSE);
			await page.clock.runFor(10_000);
			expect(reads).toHaveLength(1);
			await button(page, BRING_IN_ACTIONS.tryAgain).click();
			await expect(
				heading(page, reviewHeading("Household visits")),
			).toBeVisible();
			expect(reads).toEqual([KEY, KEY]);
		} finally {
			await page.clock.resume();
			await routes.removeAll();
		}
	});

	test("a refusal for the Project says why and offers another Project", async ({
		page,
	}) => {
		const routes = removableRoutes(page);
		try {
			await routes.route("**/api/commcare/bring-in/read", (route) =>
				route.fulfill({
					status: 403,
					json: {
						error: READING_REFUSAL_COPY.no_project_access,
						code: "no_project_access",
					},
				}),
			);
			await open(page, routes, APP_ADDRESS);
			await expect(
				page.getByText(READING_REFUSAL_COPY.no_project_access, { exact: true }),
			).toBeVisible();
			await expect(
				button(page, BRING_IN_ACTIONS.chooseAnotherProject),
			).toBeVisible();
		} finally {
			await routes.removeAll();
		}
	});
});

// ---------------------------------------------------------------------------
// A stop
// ---------------------------------------------------------------------------

test("every stop offers its row's actions, with focus on its title, and Check again reads the app afresh", async ({
	page,
}) => {
	test.setTimeout(120_000);
	const openClaim = {
		kind: "open",
		appId: "0192b000-0000-7000-8000-00000000000a",
		appName: "Growth",
	} as const;
	const elsewhere = {
		kind: "elsewhere",
		at: CLAIMED_AT,
		contact: { role: "owners", names: ["Grace Hopper", "Alan Turing"] },
	} as const;
	const stops: CircumstanceFinding[] = [
		...(Object.keys(STOP_ACTIONS) as StopCircumstance[])
			.filter((code) => code !== "already-in-nova")
			.map((code) =>
				circumstanceFinding(code as "app-gone", { kind: "app" }, {}),
			),
		circumstanceFinding(
			"already-in-nova",
			{ kind: "app" },
			{ claim: openClaim },
		),
		circumstanceFinding(
			"already-in-nova",
			{ kind: "app" },
			{ claim: elsewhere },
		),
	];
	const routes = removableRoutes(page);
	try {
		let current = 0;
		const reads = await recorded(
			routes,
			"/api/commcare/bring-in/read",
			(route) => {
				const finding = stops[current];
				if (finding === undefined) throw new Error("No stop to answer");
				return fulfillNdjson(route, answered({ kind: "stop", finding }));
			},
		);
		await open(page, routes, CHOOSE_ADDRESS, {
			settings: { configured: false },
		});
		for (const [index, finding] of stops.entries()) {
			current = index;
			await page.evaluate((address) => {
				window.history.pushState(null, "", address);
				window.dispatchEvent(new PopStateEvent("popstate"));
			}, APP_ADDRESS);
			const block = circumstanceBlock(finding, ADDRESS_CONTEXT);
			const title = heading(page, block.title);
			await expect(title, finding.code).toBeFocused();
			const actions = STOP_ACTIONS[finding.code as StopCircumstance](finding);
			/* The shared Button draws every action, the ones that open a page
			 * included, so each is a button to assistive technology. */
			await expect(page.getByRole("link"), finding.code).toHaveCount(0);
			await expect(page.getByRole("button"), finding.code).toHaveCount(
				actions.length,
			);
			for (const action of actions)
				await expect(
					page.getByRole("button", { name: stopActionLabel(action) }),
					finding.code,
				).toBeVisible();
			const nothingChanged = page.getByText(stopNothingChangedLine("read"), {
				exact: true,
			});
			await expect(nothingChanged, finding.code).toHaveCount(
				finding.code === "already-in-nova" ? 0 : 1,
			);
			if (actions.some((action) => action.kind === "check-again")) {
				const before = reads.length;
				await button(page, BRING_IN_ACTIONS.checkAgain).click();
				await expect.poll(() => reads.length, finding.code).toBe(before + 1);
				await expect(title, finding.code).toBeVisible();
			}
			await page.evaluate((address) => {
				window.history.pushState(null, "", address);
				window.dispatchEvent(new PopStateEvent("popstate"));
			}, CHOOSE_ADDRESS);
			await expect(heading(page, PICKER_HEADING)).toBeVisible();
		}
	} finally {
		await routes.removeAll();
	}
});

// ---------------------------------------------------------------------------
// The account
// ---------------------------------------------------------------------------

const MENU_PLACE: HqPlace = { kind: "case-list", menu: 0, name: "Patients" };
const FORM_PLACE = {
	kind: "form",
	menu: 0,
	form: 1,
	menuName: "Patients",
	name: "Follow-up",
} as const;

function questionAt(path: string): HqPlace {
	return {
		kind: "question",
		menu: 0,
		form: 1,
		menuName: "Patients",
		formName: "Follow-up",
		path,
	};
}

/** Twenty-two findings of one sentence about one form's questions: a run that folds. */
const FOLDED: Finding[] = Array.from({ length: 22 }, (_, index) => ({
	code: "question-appearance.style",
	standing: "not-yet",
	place: questionAt(`/data/visit/q${index + 1}`),
	subject: "question-appearance",
	detail: { name: "minimal" },
}));

const ACCOUNT_FINDINGS: Finding[] = [
	{
		code: "case-list-columns.format",
		standing: "never",
		place: MENU_PLACE,
		subject: "case-list-columns",
		detail: { name: "interval" },
	},
	...FOLDED,
	circumstanceFinding("shadow-disagrees", questionAt("/data/visit/weight"), {
		name: "if(/data/visit/weight > 0, 1, 0)",
	}),
	circumstanceFinding(
		"no-platform-runs-everything",
		questionAt("/data/visit/seen_at"),
		{
			name: "a date and time question that reads its own answer",
			reason: "split-refused",
		},
	),
];

const ACCOUNT: AccountAnswer = {
	kind: "account",
	appName: "Household visits",
	findings: ACCOUNT_FINDINGS,
	more: 0,
	counts: { notYet: 22, never: 1, fixInHq: 2 },
	mediaChecked: true,
};

test("the account groups what keeps the app out by where it lives, and its list can be copied whole", async ({
	page,
	context,
}) => {
	const routes = removableRoutes(page);
	try {
		await context.grantPermissions(["clipboard-read", "clipboard-write"], {
			origin: peer.origin,
		});
		const reads = await recorded(
			routes,
			"/api/commcare/bring-in/read",
			(route) => fulfillNdjson(route, answered(ACCOUNT)),
		);
		await open(page, routes, APP_ADDRESS);
		await expect(
			heading(page, accountHeadingLine("yet", "Household visits")),
		).toBeVisible();
		await expect(page.getByText(accountLead("yet", "read"))).toBeVisible();
		const accountContext: CircumstanceContext = {
			...ADDRESS_CONTEXT,
			app: "Household visits",
		};

		// Each group's heading once, in the app's order.
		const groupHeadings = page.locator("[data-account-findings] section h2");
		await expect(groupHeadings).toHaveText([
			"The case list of Patients",
			"Follow-up, in the menu Patients",
		]);
		const formGroup = page.locator("[data-account-findings] section").filter({
			has: page.getByRole("heading", {
				name: "Follow-up, in the menu Patients",
			}),
		});
		await expect(
			formGroup.getByRole("link", { name: /Open in CommCare HQ/ }),
		).toHaveAttribute("href", hqPlaceUrl(KEY, FORM_PLACE) ?? "");
		expect(hqPlaceUrl(KEY, FORM_PLACE)).toMatch(/modules-0\/forms-1\/$/);

		// Each label once as text, beside its next step.
		for (const label of [
			FINDING_LABELS["not-yet"],
			FINDING_LABELS.never,
			FINDING_LABELS["fix-in-hq"],
		])
			await expect(
				page.locator("dt").getByText(label, { exact: true }),
			).toBeVisible();

		// The folded run opens to its questions.
		const fold = findingLine(FOLDED[0] as Finding).sentence;
		await expect(formGroup.getByText(fold, { exact: true })).toHaveCount(1);
		await expect(
			formGroup.getByText("/data/visit/q22", { exact: true }),
		).toBeHidden();
		await formGroup
			.getByRole("button", { name: BRING_IN_ACTIONS.showTheQuestions })
			.click();
		await expect(
			formGroup.getByText("/data/visit/q22", { exact: true }),
		).toBeVisible();

		// A circumstance with a name of its own shows it on its own line.
		const shadow = ACCOUNT_FINDINGS.at(-2) as CircumstanceFinding;
		await expect(
			formGroup.getByText(`${NAMED_IN_HQ_LEAD} ${shadow.detail.name}`, {
				exact: true,
			}),
		).toBeVisible();
		// A refused split reads the next step about its date and time question.
		const split = ACCOUNT_FINDINGS.at(-1) as CircumstanceFinding;
		const splitNext = circumstanceBlock(split, accountContext).next;
		expect(splitNext).toContain("seen_at");
		await expect(formGroup.getByText(splitNext, { exact: true })).toBeVisible();
		await expect(
			page.getByText(ACCOUNT_CHECK_AGAIN_LINE, { exact: true }),
		).toBeVisible();

		// Copy the list puts every finding on the clipboard, the line included.
		await button(page, BRING_IN_ACTIONS.copyTheList).click();
		await expect(button(page, BRING_IN_ACTIONS.copied)).toBeVisible();
		const copied = await page.evaluate(() => navigator.clipboard.readText());
		expect(copied.endsWith(ACCOUNT_CHECK_AGAIN_LINE)).toBe(true);
		for (const finding of ACCOUNT_FINDINGS) {
			const sentence =
				finding.subject === null
					? circumstanceBlock(finding, accountContext).title
					: findingLine(finding).sentence;
			expect(copied).toContain(sentence);
		}
		for (const finding of FOLDED)
			expect(copied).toContain(
				`(${(finding.place as Extract<HqPlace, { kind: "question" }>).path})`,
			);

		// Check again reads the app afresh.
		await button(page, BRING_IN_ACTIONS.checkAgain).click();
		await expect.poll(() => reads.length).toBe(2);
		await expect(
			heading(page, accountHeadingLine("yet", "Household visits")),
		).toBeVisible();

		// With the clipboard refused, the same text stands on screen to select.
		await page.evaluate(() => {
			navigator.clipboard.writeText = () =>
				Promise.reject(
					new DOMException("Write permission denied.", "NotAllowedError"),
				);
		});
		await button(page, BRING_IN_ACTIONS.copyTheList).click();
		const refused = page.getByRole("textbox");
		await expect(refused).toBeFocused();
		await expect(refused).toHaveValue(copied);
	} finally {
		await routes.removeAll();
	}
});

// ---------------------------------------------------------------------------
// The review
// ---------------------------------------------------------------------------

test.describe("the review", () => {
	test("Where workers use this app is chosen for the person, and choosing another changes what the first publish changes", async ({
		page,
	}) => {
		const routes = removableRoutes(page);
		try {
			const review = reviewOf();
			await recorded(routes, "/api/commcare/bring-in/read", (route) =>
				fulfillNdjson(route, answered(reviewAnswer(review))),
			);
			await open(page, routes, APP_ADDRESS);
			await expect(
				heading(page, reviewHeading("Household visits")),
			).toBeVisible();
			await expect(page.getByRole("checkbox")).toHaveCount(0);
			const [both, android] = declarationRows(review);
			if (both === undefined || android === undefined)
				throw new Error("The review offers two rows");
			const bothRow = page.getByRole("radio", {
				name: both.label,
				exact: true,
			});
			const androidRow = page.getByRole("radio", {
				name: android.label,
				exact: true,
			});
			await expect(bothRow).toBeChecked();
			await expect(androidRow).not.toBeChecked();

			const lines = page.locator("[data-first-publish-lines]");
			const preselected = firstPublishLines(both.choice.firstPublish, "review");
			await expect(
				lines.getByText(FIRST_PUBLISH_NO_WORKER_CHANGE, { exact: true }),
			).toBeVisible();
			await expect(
				page.getByText(REVIEW_WEB_APPS_ASKS_OFF, { exact: true }),
			).toHaveCount(0);
			await expect(
				page.getByText(recordedFeaturesLine(both.choice, KEY.domain) ?? "", {
					exact: true,
				}),
			).toBeVisible();
			expect(preselected.workers.lines).toHaveLength(0);

			await androidRow.click();
			await expect(androidRow).toBeChecked();
			const chosen = firstPublishLines(android.choice.firstPublish, "review");
			const turnedOff = chosen.workers.lines.find(
				(line) => line.id === "web-apps-turned-off",
			);
			if (turnedOff === undefined)
				throw new Error("Android only turns Web Apps off");
			await expect(
				lines.getByText(turnedOff.sentence, { exact: true }),
			).toBeVisible();
			await expect(
				lines.getByText(FIRST_PUBLISH_NO_WORKER_CHANGE, { exact: true }),
			).toHaveCount(0);
			await expect(lines.locator(":scope > :last-child")).toHaveText(
				FIRST_PUBLISH_FORM_BUILDER_NOTE,
			);
			await expect(
				page.getByText(REVIEW_WEB_APPS_ASKS_OFF, { exact: true }),
			).toBeVisible();
			await expect(
				page.getByText(recordedFeaturesLine(android.choice, KEY.domain) ?? "", {
					exact: true,
				}),
			).toBeVisible();
		} finally {
			await routes.removeAll();
		}
	});

	test("a platform the app can't run on lists what keeps it off", async ({
		page,
	}) => {
		const routes = removableRoutes(page);
		try {
			const [, android] = reviewOf().runsOn;
			if (android === undefined)
				throw new Error("The review offers Android only");
			const review = reviewOf({
				runsOn: [{ ...android, preselected: true }],
				platformsOut: [
					{
						platform: "web-apps",
						features: ["datetime-question", "forms-read-search"],
						media: false,
					},
				],
			});
			await recorded(routes, "/api/commcare/bring-in/read", (route) =>
				fulfillNdjson(route, answered(reviewAnswer(review))),
			);
			await open(page, routes, APP_ADDRESS);
			const runsOn = page.locator("[data-review-runs-on]");
			await expect(runsOn).toBeVisible();
			for (const feature of ["datetime-question", "forms-read-search"] as const)
				await expect(
					runsOn
						.getByRole("listitem")
						.filter({ hasText: PLATFORM_FEATURES[feature].label }),
				).toHaveText(PLATFORM_FEATURES[feature].label);
		} finally {
			await routes.removeAll();
		}
	});

	test("Bring it in asks for every answer before it sends one exactly", async ({
		page,
	}) => {
		const routes = removableRoutes(page);
		try {
			await recorded(routes, "/api/commcare/bring-in/read", (route) =>
				fulfillNdjson(route, answered(reviewAnswer())),
			);
			const creates = await recorded(
				routes,
				"/api/commcare/bring-in/create",
				(route) =>
					fulfillNdjson(
						route,
						answered({ kind: "created", receipt: receiptOf(ANSWERED_INPUT) }),
					),
			);
			await open(page, routes, APP_ADDRESS);
			await expect(
				heading(page, reviewHeading("Household visits")),
			).toBeVisible();
			const view = tableChoiceView(
				DISTRICT_TABLE,
				TEAM.name,
				KEY.domain,
				false,
			);
			const group = page.locator('[data-review-table-choice="district"]');

			// An empty name stops it at the field.
			const name = page.getByRole("textbox", { name: "App name", exact: true });
			await name.fill("   ");
			await button(page, BRING_IN_ACTIONS.bringItIn).click();
			await expect(name).toBeFocused();
			await expect(
				page.getByText(READING_REFUSAL_COPY.name_missing, { exact: true }),
			).toBeVisible();
			await name.fill("Household visits");

			// An unanswered table stops it at the table.
			await button(page, BRING_IN_ACTIONS.bringItIn).click();
			await expect(group.getByRole("alert")).toHaveText(REVIEW_CHOICE_MISSING);
			await expect(group.locator(":focus")).toHaveCount(1);
			expect(creates).toEqual([]);

			const own = view.rows.find((row) => row.choice === "use-project");
			if (own === undefined) throw new Error("The table offers the Project's");
			await group.getByRole("radio", { name: own.label, exact: true }).click();
			await button(page, BRING_IN_ACTIONS.bringItIn).click();
			await expect.poll(() => creates.length).toBe(1);
			expect(creates).toEqual([ANSWERED_INPUT]);
		} finally {
			await routes.removeAll();
		}
	});

	test("a table neither of whose answers is open says so, and not the other Project line", async ({
		page,
	}) => {
		const routes = removableRoutes(page);
		try {
			await recorded(routes, "/api/commcare/bring-in/read", (route) =>
				fulfillNdjson(
					route,
					answered(reviewAnswer(reviewOf({ tables: [CLOSED_TABLE] }))),
				),
			);
			await open(page, routes, APP_ADDRESS);
			const group = page.locator('[data-review-table-choice="district"]');
			await expect(
				group.getByText(REVIEW_NO_CHOICE_OPEN, { exact: true }),
			).toBeVisible();
			await expect(
				group.getByText(CHOICE_OTHER_PROJECT, { exact: true }),
			).toHaveCount(0);
		} finally {
			await routes.removeAll();
		}
	});
});

// ---------------------------------------------------------------------------
// A create's answers
// ---------------------------------------------------------------------------

test.describe("a create's answers", () => {
	/** The review answered, the name changed, `district` answered and Android only chosen. */
	async function answerTheReview(page: Page): Promise<void> {
		await expect(
			heading(page, reviewHeading("Household visits")),
		).toBeVisible();
		await page
			.getByRole("textbox", { name: "App name", exact: true })
			.fill("Visits for the clinic");
		await page
			.locator('[data-review-table-choice="district"]')
			.getByRole("radio", {
				name:
					tableChoiceView(DISTRICT_TABLE, TEAM.name, KEY.domain, false).rows[1]
						?.label ?? "",
				exact: true,
			})
			.click();
		await page
			.getByRole("radio", { name: "Android only", exact: true })
			.click();
		await button(page, BRING_IN_ACTIONS.bringItIn).click();
	}

	test("held keeps the review and every answer under a block", async ({
		page,
	}) => {
		const routes = removableRoutes(page);
		try {
			const held = circumstanceFinding("rate-limited", { kind: "app" }, {});
			await recorded(routes, "/api/commcare/bring-in/read", (route) =>
				fulfillNdjson(route, answered(reviewAnswer())),
			);
			await recorded(routes, "/api/commcare/bring-in/create", (route) =>
				fulfillNdjson(route, answered({ kind: "held", finding: held })),
			);
			await open(page, routes, APP_ADDRESS);
			await answerTheReview(page);
			await expect(
				page.getByText(CREATE_ANSWER_LEADS.held, { exact: true }),
			).toBeVisible();
			await expect(
				page.getByText(
					circumstanceBlock(held, {
						...ADDRESS_CONTEXT,
						app: "Household visits",
					}).title,
					{ exact: true },
				),
			).toBeVisible();
			await expect(
				page.getByRole("textbox", { name: "App name", exact: true }),
			).toHaveValue("Visits for the clinic");
			await expect(
				page.getByRole("radio", { name: "Android only", exact: true }),
			).toBeChecked();
			await expect(
				page
					.locator('[data-review-table-choice="district"]')
					.getByRole("radio", { checked: true }),
			).toHaveCount(1);
		} finally {
			await routes.removeAll();
		}
	});

	test("a publish still finishing at CommCare HQ keeps the review and every answer, says so above the footer, and the same create can be sent again", async ({
		page,
	}) => {
		const routes = removableRoutes(page);
		try {
			await recorded(routes, "/api/commcare/bring-in/read", (route) =>
				fulfillNdjson(route, answered(reviewAnswer())),
			);
			const creates = await recorded(
				routes,
				"/api/commcare/bring-in/create",
				(route) =>
					fulfillNdjson(
						route,
						answered({ kind: "refused", refusal: "publish_in_flight" }),
					),
			);
			await open(page, routes, APP_ADDRESS);
			await answerTheReview(page);
			await expect(
				page.getByRole("alert").filter({
					hasText: READING_REFUSAL_COPY.publish_in_flight,
				}),
			).toHaveText(READING_REFUSAL_COPY.publish_in_flight);
			await expect(
				heading(page, reviewHeading("Household visits")),
			).toBeVisible();
			await expect(
				page.getByRole("textbox", { name: "App name", exact: true }),
			).toHaveValue("Visits for the clinic");
			await expect(
				page.getByRole("radio", { name: "Android only", exact: true }),
			).toBeChecked();
			await expect(
				page
					.locator('[data-review-table-choice="district"]')
					.getByRole("radio", { checked: true }),
			).toHaveCount(1);
			expect(creates).toHaveLength(1);

			/* A few minutes later, the same answers go again as they were. */
			await button(page, BRING_IN_ACTIONS.bringItIn).click();
			await expect.poll(() => creates.length).toBe(2);
			expect(creates[1]).toEqual(creates[0]);
		} finally {
			await routes.removeAll();
		}
	});

	test("changed with a review keeps what still applies, and says where a choice was dropped", async ({
		page,
	}) => {
		const routes = removableRoutes(page);
		try {
			const [both] = reviewOf().runsOn;
			if (both === undefined) throw new Error("The review offers both");
			const now = reviewAnswer(
				reviewOf({ appName: "Household visits 2", runsOn: [both] }),
				"f".repeat(64),
			);
			await recorded(routes, "/api/commcare/bring-in/read", (route) =>
				fulfillNdjson(route, answered(reviewAnswer())),
			);
			await recorded(routes, "/api/commcare/bring-in/create", (route) =>
				fulfillNdjson(route, answered({ kind: "changed", now })),
			);
			await open(page, routes, APP_ADDRESS);
			/* The status region a lead is said in stood before the screen
			 * changed: a region mounted already holding its text says nothing. */
			await expect(
				heading(page, reviewHeading("Household visits")),
			).toBeVisible();
			await page
				.locator("[data-bring-in-status]")
				.evaluate((region) => region.setAttribute("data-before-create", ""));
			await answerTheReview(page);
			const lead = `${CREATE_ANSWER_LEADS.changed.review} ${CREATE_ANSWER_LEADS.choicesDropped}`;
			await expect(page.getByText(lead, { exact: true })).toBeVisible();
			await expect(
				page.locator("[data-bring-in-status][data-before-create]"),
			).toContainText(lead);
			await expect(
				page.getByRole("textbox", { name: "App name", exact: true }),
			).toHaveValue("Visits for the clinic");
			await expect(
				page.getByRole("radio", { name: "Web Apps and Android", exact: true }),
			).toBeChecked();
			await expect(
				page.getByRole("radio", { name: "Android only", exact: true }),
			).toHaveCount(0);
			await expect(
				page
					.locator('[data-review-table-choice="district"]')
					.getByRole("radio", { checked: true }),
			).toHaveCount(1);
		} finally {
			await routes.removeAll();
		}
	});

	test("changed with an app already in Nova shows its own lead and Open, and no line that nothing changed", async ({
		page,
	}) => {
		const routes = removableRoutes(page);
		try {
			const claim = {
				kind: "open",
				appId: "0192b000-0000-7000-8000-00000000000b",
				appName: "Visits",
			} as const;
			const finding = circumstanceFinding(
				"already-in-nova",
				{ kind: "app" },
				{ claim },
			);
			await recorded(routes, "/api/commcare/bring-in/read", (route) =>
				fulfillNdjson(route, answered(reviewAnswer())),
			);
			await recorded(routes, "/api/commcare/bring-in/create", (route) =>
				fulfillNdjson(
					route,
					answered({ kind: "changed", now: { kind: "stop", finding } }),
				),
			);
			await open(page, routes, APP_ADDRESS);
			await answerTheReview(page);
			await expect(
				page.getByText(CREATE_ANSWER_LEADS.changed["already-in-nova"], {
					exact: true,
				}),
			).toBeVisible();
			await expect(
				page.getByRole("button", {
					name: `Open ${claim.appName}`,
					exact: true,
				}),
			).toHaveAttribute("href", `/build/${claim.appId}`);
			await expect(
				page.getByText(stopNothingChangedLine("create"), { exact: true }),
			).toHaveCount(0);
			await expect(
				page.getByText(stopNothingChangedLine("read"), { exact: true }),
			).toHaveCount(0);
		} finally {
			await routes.removeAll();
		}
	});

	test("read-again reads the app under its lead and keeps the answers for the review that follows", async ({
		page,
	}) => {
		const routes = removableRoutes(page);
		const stream = await streamPeer();
		try {
			let reads = 0;
			await routes.route("**/api/commcare/bring-in/read", async (route) => {
				reads++;
				if (reads === 1) await fulfillNdjson(route, answered(reviewAnswer()));
				else await stream.continue(route);
			});
			await recorded(routes, "/api/commcare/bring-in/create", (route) =>
				fulfillNdjson(route, answered({ kind: "read-again" })),
			);
			await open(page, routes, APP_ADDRESS, {}, stream.origin);
			await answerTheReview(page);
			const again = await stream.request(0);
			await expect(
				heading(page, readingStatusLine("Household visits")),
			).toBeVisible();
			await expect(
				page.getByText(CREATE_ANSWER_LEADS["read-again"], { exact: true }),
			).toBeVisible();
			await again.write({
				type: "done",
				answer: reviewAnswer(reviewOf(), "c".repeat(64)),
			});
			await again.end();
			await expect(
				heading(page, reviewHeading("Household visits")),
			).toBeVisible();
			await expect(
				page.getByText(CREATE_ANSWER_LEADS["read-again"], { exact: true }),
			).toBeVisible();
			await expect(
				page.getByRole("textbox", { name: "App name", exact: true }),
			).toHaveValue("Visits for the clinic");
			await expect(
				page.getByRole("radio", { name: "Android only", exact: true }),
			).toBeChecked();
		} finally {
			await routes.removeAll();
			await stream.close();
		}
	});

	test("a read after read-again that fails or is lost twice keeps the lead and says no app was created", async ({
		page,
	}) => {
		const routes = removableRoutes(page);
		await page.clock.install({ time: CLOCK_START });
		try {
			let failNext = true;
			const reads = await recorded(
				routes,
				"/api/commcare/bring-in/read",
				(route, index) => {
					if (index === 0)
						return fulfillNdjson(route, answered(reviewAnswer()));
					if (failNext) {
						failNext = false;
						return fulfillNdjson(
							route,
							ndjson([
								{ type: "stage", stage: "connecting" },
								{ type: "failed" },
							]),
						);
					}
					// A response with no last line: a lost request.
					return fulfillNdjson(
						route,
						ndjson([{ type: "stage", stage: "connecting" }]),
					);
				},
			);
			await recorded(routes, "/api/commcare/bring-in/create", (route) =>
				fulfillNdjson(route, answered({ kind: "read-again" })),
			);
			await open(page, routes, APP_ADDRESS);
			await answerTheReview(page);
			const leadLine = page.getByText(CREATE_ANSWER_LEADS["read-again"], {
				exact: true,
			});

			// Nova's own failure in that read.
			await expect(heading(page, READING_FAILED_COPY.read.title)).toBeVisible();
			await expect(leadLine).toBeVisible();
			await expect(
				page.getByText(readFailedAfterCreateBody("Household visits"), {
					exact: true,
				}),
			).toBeVisible();
			await expect(
				page.getByText(READING_FAILED_COPY.read.body("Household visits"), {
					exact: true,
				}),
			).toHaveCount(0);
			expect(reads).toHaveLength(2);

			// Try again, lost twice.
			await page.clock.pauseAt(CLOCK_PAUSE);
			await button(page, BRING_IN_ACTIONS.tryAgain).click();
			await expect(page.getByText(TRYING_AGAIN, { exact: true })).toBeVisible();
			await page.clock.runFor(3_000);
			await expect(
				page.getByText(READING_LOST_AFTER_CREATE_LINE, { exact: true }),
			).toBeVisible();
			await expect(leadLine).toBeVisible();
			await expect(
				page.getByText(READING_LOST_LINE, { exact: true }),
			).toHaveCount(0);
			expect(reads).toHaveLength(4);
		} finally {
			await page.clock.resume();
			await routes.removeAll();
		}
	});

	test("check-failed shows the account of its one finding under Nova's own heading", async ({
		page,
	}) => {
		const routes = removableRoutes(page);
		try {
			const finding = circumstanceFinding(
				"read-back-differs",
				{ kind: "app" },
				{ name: "birth-gate" },
			);
			await recorded(routes, "/api/commcare/bring-in/read", (route) =>
				fulfillNdjson(route, answered(reviewAnswer())),
			);
			await recorded(routes, "/api/commcare/bring-in/create", (route) =>
				fulfillNdjson(route, answered({ kind: "check-failed", finding })),
			);
			await open(page, routes, APP_ADDRESS);
			await answerTheReview(page);
			await expect(
				heading(page, accountHeadingLine("this-time", "Household visits")),
			).toBeVisible();
			await expect(
				page.getByText(accountLead("this-time", "create"), { exact: true }),
			).toBeVisible();
			await expect(
				page.getByText(CREATE_ANSWER_LEADS["check-failed"], { exact: true }),
			).toBeVisible();
		} finally {
			await routes.removeAll();
		}
	});
});

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

test.describe("creating", () => {
	/** The review answered as the journeys answer it, pressed: the create's body is `ANSWERED_INPUT`. */
	async function bringItIn(page: Page): Promise<void> {
		await expect(
			heading(page, reviewHeading("Household visits")),
		).toBeVisible();
		await page
			.locator('[data-review-table-choice="district"]')
			.getByRole("radio", {
				name:
					tableChoiceView(DISTRICT_TABLE, TEAM.name, KEY.domain, false).rows[1]
						?.label ?? "",
				exact: true,
			})
			.click();
		await button(page, BRING_IN_ACTIONS.bringItIn).click();
	}

	test("the files' count moves through both media stages, and created lands the receipt once", async ({
		page,
	}) => {
		const routes = removableRoutes(page);
		const stream = await streamPeer();
		try {
			await recorded(routes, "/api/commcare/bring-in/read", (route) =>
				fulfillNdjson(route, answered(reviewAnswer())),
			);
			await routes.route("**/api/commcare/bring-in/create", (route) =>
				stream.continue(route),
			);
			await open(page, routes, APP_ADDRESS, {}, stream.origin);
			await bringItIn(page);
			await expect(heading(page, CREATING_STATUS)).toBeVisible();
			await expect(page.getByRole("radio")).toHaveCount(0);
			const held = await stream.request(0);
			expect(held.body).toEqual(ANSWERED_INPUT);
			await held.write({ type: "stage", stage: "checking-media" });
			await expect(
				stageLine(page, READING_STAGE_LABELS["checking-media"](null)),
			).toBeVisible();
			await held.write({ type: "files", done: 1, total: 4 });
			await expect(
				stageLine(
					page,
					READING_STAGE_LABELS["checking-media"]({ done: 1, total: 4 }),
				),
			).toBeVisible();
			await held.write({ type: "stage", stage: "bringing-in-media" });
			await expect(
				stageLine(page, READING_STAGE_LABELS["bringing-in-media"](null)),
			).toBeVisible();
			await held.write({ type: "files", done: 3, total: 4 });
			await expect(
				stageLine(
					page,
					READING_STAGE_LABELS["bringing-in-media"]({ done: 3, total: 4 }),
				),
			).toBeVisible();
			await held.write({ type: "stage", stage: "creating" });
			await expect(
				stageLine(
					page,
					READING_STAGE_LABELS["bringing-in-media"]({ done: 3, total: 4 }),
				),
			).toHaveCount(0);
			await expect(
				page.getByText(CREATING_STATUS, { exact: true }),
			).toHaveCount(1);
			await expect(page.getByRole("radio")).toHaveCount(0);
			const receipt = receiptOf(ANSWERED_INPUT);
			await held.write({ type: "done", answer: { kind: "created", receipt } });
			await held.end();
			await expect.poll(async () => (await landings(page)).length).toBe(1);
			expect(await landings(page)).toEqual([
				{ raw: receipt, origin: "brought-in" },
			]);
		} finally {
			await routes.removeAll();
			await stream.close();
		}
	});

	test("a lost create is sent again once after three seconds with the same body, then waits for Try again", async ({
		page,
	}) => {
		const routes = removableRoutes(page);
		await page.clock.install({ time: CLOCK_START });
		try {
			await recorded(routes, "/api/commcare/bring-in/read", (route) =>
				fulfillNdjson(route, answered(reviewAnswer())),
			);
			const creates = await recorded(
				routes,
				"/api/commcare/bring-in/create",
				(route, index) =>
					fulfillNdjson(
						route,
						index < 2
							? ndjson([{ type: "stage", stage: "reading-app" }])
							: answered({
									kind: "created",
									receipt: receiptOf(ANSWERED_INPUT),
								}),
					),
			);
			await open(page, routes, APP_ADDRESS);
			await expect(
				heading(page, reviewHeading("Household visits")),
			).toBeVisible();
			await page.clock.pauseAt(CLOCK_PAUSE);
			await bringItIn(page);
			await expect(page.getByText(TRYING_AGAIN, { exact: true })).toBeVisible();
			expect(creates).toHaveLength(1);
			await page.clock.runFor(3_000);
			await expect(
				page.getByText(CREATING_LOST_LINE, { exact: true }),
			).toBeVisible();
			expect(creates).toEqual([ANSWERED_INPUT, ANSWERED_INPUT]);
			await page.clock.runFor(10_000);
			expect(creates).toHaveLength(2);
			await button(page, BRING_IN_ACTIONS.tryAgain).click();
			await expect.poll(async () => (await landings(page)).length).toBe(1);
			expect(creates).toEqual([ANSWERED_INPUT, ANSWERED_INPUT, ANSWERED_INPUT]);
		} finally {
			await page.clock.resume();
			await routes.removeAll();
		}
	});

	test("a failed line shows the create's failure, and Try again sends the same body", async ({
		page,
	}) => {
		const routes = removableRoutes(page);
		try {
			await recorded(routes, "/api/commcare/bring-in/read", (route) =>
				fulfillNdjson(route, answered(reviewAnswer())),
			);
			const creates = await recorded(
				routes,
				"/api/commcare/bring-in/create",
				(route, index) =>
					fulfillNdjson(
						route,
						index === 0
							? ndjson([
									{ type: "stage", stage: "connecting" },
									{ type: "failed" },
								])
							: answered({
									kind: "created",
									receipt: receiptOf(ANSWERED_INPUT),
								}),
					),
			);
			await open(page, routes, APP_ADDRESS);
			await bringItIn(page);
			await expect(
				heading(page, READING_FAILED_COPY.create.title),
			).toBeVisible();
			expect(creates).toHaveLength(1);
			await button(page, BRING_IN_ACTIONS.tryAgain).click();
			await expect.poll(async () => (await landings(page)).length).toBe(1);
			expect(creates).toEqual([ANSWERED_INPUT, ANSWERED_INPUT]);
		} finally {
			await routes.removeAll();
		}
	});

	test("a landing this tab could not open says the app is in, with Open your app and no Bring it in", async ({
		page,
	}) => {
		const routes = removableRoutes(page);
		try {
			await recorded(routes, "/api/commcare/bring-in/read", (route) =>
				fulfillNdjson(route, answered(reviewAnswer())),
			);
			const receipt = receiptOf(ANSWERED_INPUT);
			await recorded(routes, "/api/commcare/bring-in/create", (route) =>
				fulfillNdjson(route, answered({ kind: "created", receipt })),
			);
			await open(page, routes, APP_ADDRESS, { landing: "unverified" });
			await bringItIn(page);
			await expect(heading(page, UNVERIFIED_LANDING_TITLE)).toBeVisible();
			await expect(
				page.getByRole("button", {
					name: BRING_IN_ACTIONS.openYourApp,
					exact: true,
				}),
			).toHaveAttribute("href", `/build/${receipt.appId}`);
			await expect(button(page, BRING_IN_ACTIONS.bringItIn)).toHaveCount(0);
		} finally {
			await routes.removeAll();
		}
	});
});

// ---------------------------------------------------------------------------
// A reload during a create
// ---------------------------------------------------------------------------

test.describe("a reload during a create", () => {
	test("sends the same create again, with no read between, and keeps the key until the answer", async ({
		page,
	}) => {
		const routes = removableRoutes(page);
		const stream = await streamPeer();
		try {
			const reads = await recorded(
				routes,
				"/api/commcare/bring-in/read",
				(route) => fulfillNdjson(route, answered(reviewAnswer())),
			);
			await routes.route("**/api/commcare/bring-in/create", (route) =>
				stream.continue(route),
			);
			await open(page, routes, APP_ADDRESS, {}, stream.origin);
			await expect(
				heading(page, reviewHeading("Household visits")),
			).toBeVisible();
			await page
				.locator('[data-review-table-choice="district"]')
				.getByRole("radio", {
					name:
						tableChoiceView(DISTRICT_TABLE, TEAM.name, KEY.domain, false)
							.rows[1]?.label ?? "",
					exact: true,
				})
				.click();
			await button(page, BRING_IN_ACTIONS.bringItIn).click();
			expect((await stream.request(0)).body).toEqual(ANSWERED_INPUT);
			const stored = async () =>
				await page.evaluate(
					(key) => window.sessionStorage.getItem(key),
					CREATE_KEY,
				);
			expect(JSON.parse((await stored()) ?? "null")).toMatchObject({
				input: ANSWERED_INPUT,
			});

			await reloadPage(page);
			await expect(heading(page, CREATING_STATUS)).toBeVisible();
			const again = await stream.request(1);
			expect(again.body).toEqual(ANSWERED_INPUT);
			expect(reads).toHaveLength(1);
			expect(await stored()).not.toBeNull();
			await again.write({
				type: "done",
				answer: { kind: "created", receipt: receiptOf(ANSWERED_INPUT) },
			});
			await again.end();
			await expect.poll(async () => (await landings(page)).length).toBe(1);
			expect(await stored()).toBeNull();
		} finally {
			await routes.removeAll();
			await stream.close();
		}
	});

	for (const end of ["read-again", "created"] as const) {
		test(`a create left and come Back to holds the read of another app chosen meanwhile, which names it, until it answers ${end}`, async ({
			page,
		}) => {
			const routes = removableRoutes(page);
			const stream = await streamPeer();
			const second: ReadingKey = { ...KEY, remoteAppId: "aaaa0004" };
			try {
				await answerApps(routes, { clinic: CLINIC_APPS });
				const reads = await recorded(
					routes,
					"/api/commcare/bring-in/read",
					(route) => {
						const key = route.request().postDataJSON() as ReadingKey;
						return fulfillNdjson(
							route,
							answered(
								key.remoteAppId === second.remoteAppId
									? reviewAnswer(
											reviewOf({ appName: "Antenatal care" }),
											"c".repeat(64),
										)
									: reviewAnswer(),
							),
						);
					},
				);
				await routes.route("**/api/commcare/bring-in/create", (route) =>
					stream.continue(route),
				);
				await open(page, routes, APP_ADDRESS, {}, stream.origin);
				await expect(
					heading(page, reviewHeading("Household visits")),
				).toBeVisible();
				await page
					.locator('[data-review-table-choice="district"]')
					.getByRole("radio", {
						name:
							tableChoiceView(DISTRICT_TABLE, TEAM.name, KEY.domain, false)
								.rows[1]?.label ?? "",
						exact: true,
					})
					.click();
				await button(page, BRING_IN_ACTIONS.bringItIn).click();
				expect((await stream.request(0)).body).toEqual(ANSWERED_INPUT);

				/* The person leaves the page while the create runs, and comes Back. */
				await openPage(page, `${stream.origin}/`);
				await page.goBack();
				await expect(heading(page, CREATING_STATUS)).toBeVisible();
				const again = await stream.request(1);
				expect(again.body).toEqual(ANSWERED_INPUT);

				/* Then chooses another app while that create is still running. */
				await page.evaluate((address) => {
					window.history.pushState(null, "", address);
					window.dispatchEvent(new PopStateEvent("popstate"));
				}, CHOOSE_ADDRESS);
				await page
					.getByRole("radio", { name: "Antenatal care", exact: true })
					.click();
				await button(page, BRING_IN_ACTIONS.readThisApp).click();
				await expect(
					page.getByText(readingStatusLine("Antenatal care"), { exact: true }),
				).toBeVisible();
				await expect(
					page.getByText(readingWaitsForCreateLine("Household visits"), {
						exact: true,
					}),
				).toBeVisible();
				expect(reads).toEqual([KEY]);

				const receipt = receiptOf(ANSWERED_INPUT);
				await again.write({
					type: "done",
					answer:
						end === "created"
							? { kind: "created", receipt }
							: { kind: "read-again" },
				});
				await again.end();
				if (end === "created") {
					await expect.poll(async () => (await landings(page)).length).toBe(1);
					expect(await landings(page)).toEqual([
						{ raw: receipt, origin: "brought-in" },
					]);
					expect(reads).toEqual([KEY]);
				} else {
					await expect(
						heading(page, reviewHeading("Antenatal care")),
					).toBeVisible();
					expect(reads).toEqual([KEY, second]);
					expect(await landings(page)).toEqual([]);
				}
				await expect(
					page.getByText(readingWaitsForCreateLine("Household visits"), {
						exact: true,
					}),
				).toHaveCount(0);
				expect(
					await page.evaluate(
						(key) => window.sessionStorage.getItem(key),
						CREATE_KEY,
					),
				).toBeNull();
			} finally {
				await routes.removeAll();
				await stream.close();
			}
		});
	}

	for (const stale of ["another app's", "an hour old"] as const) {
		test(`removes a key that is ${stale} and reads the app`, async ({
			page,
		}) => {
			const routes = removableRoutes(page);
			await page.clock.install({ time: CLOCK_START });
			try {
				const reads = await recorded(
					routes,
					"/api/commcare/bring-in/read",
					(route) => fulfillNdjson(route, answered(reviewAnswer())),
				);
				const creates = await recorded(
					routes,
					"/api/commcare/bring-in/create",
					(route) =>
						fulfillNdjson(
							route,
							answered({ kind: "created", receipt: receiptOf(ANSWERED_INPUT) }),
						),
				);
				await open(page, routes, CHOOSE_ADDRESS, {
					settings: { configured: false },
				});
				await expect(heading(page, PICKER_HEADING)).toBeVisible();
				const value =
					stale === "another app's"
						? {
								at: CLOCK_START.getTime(),
								input: { ...ANSWERED_INPUT, remoteAppId: "ffff0001" },
							}
						: {
								at: CLOCK_START.getTime() - 60 * 60 * 1000 - 1,
								input: ANSWERED_INPUT,
							};
				await page.evaluate(
					([key, text]) => window.sessionStorage.setItem(key, text),
					[CREATE_KEY, JSON.stringify(value)] as const,
				);
				await page.evaluate((address) => {
					window.history.pushState(null, "", address);
					window.dispatchEvent(new PopStateEvent("popstate"));
				}, APP_ADDRESS);
				await expect(
					heading(page, reviewHeading("Household visits")),
				).toBeVisible();
				expect(reads).toEqual([KEY]);
				expect(creates).toEqual([]);
				expect(
					await page.evaluate(
						(key) => window.sessionStorage.getItem(key),
						CREATE_KEY,
					),
				).toBeNull();
			} finally {
				await routes.removeAll();
			}
		});
	}
});

// ---------------------------------------------------------------------------
// An app CommCare HQ holds no name for, and a session that ended
// ---------------------------------------------------------------------------

test("an app CommCare HQ holds no name for reads as this app, and its review asks for a name it can't keep", async ({
	page,
}) => {
	const routes = removableRoutes(page);
	try {
		let answer: ReadingAnswer = { ...ACCOUNT, appName: "" };
		await recorded(routes, "/api/commcare/bring-in/read", (route) =>
			fulfillNdjson(route, answered(answer)),
		);
		const creates = await recorded(
			routes,
			"/api/commcare/bring-in/create",
			(route) => route.abort("failed"),
		);
		await open(page, routes, APP_ADDRESS);
		await expect(heading(page, accountHeadingLine("yet", null))).toBeVisible();

		answer = reviewAnswer(reviewOf({ appName: "" }));
		await button(page, BRING_IN_ACTIONS.checkAgain).click();
		await expect(heading(page, reviewHeading(null))).toBeVisible();
		const name = page.getByRole("textbox", { name: "App name", exact: true });
		await expect(name).toHaveValue("");
		await button(page, BRING_IN_ACTIONS.bringItIn).click();
		await expect(name).toBeFocused();
		await expect(
			page.getByText(REVIEW_NAME_NONE_IN_HQ, { exact: true }),
		).toBeVisible();
		await expect(
			page.getByText(READING_REFUSAL_COPY.name_missing, { exact: true }),
		).toHaveCount(0);
		expect(creates).toEqual([]);
	} finally {
		await routes.removeAll();
	}
});

test("a request that finds the session ended offers a reload and asks for nothing more", async ({
	page,
}) => {
	const routes = removableRoutes(page);
	try {
		const reads = await recorded(
			routes,
			"/api/commcare/bring-in/read",
			(route) =>
				route.fulfill({ status: 401, json: { error: "Not signed in" } }),
		);
		await open(page, routes, APP_ADDRESS);
		await expect(heading(page, SIGNED_OUT_TITLE)).toBeFocused();
		await expect(
			page.getByText(SIGNED_OUT_LINE, { exact: true }),
		).toBeVisible();
		await expect(button(page, BRING_IN_ACTIONS.reload)).toBeVisible();
		expect(reads).toHaveLength(1);
	} finally {
		await routes.removeAll();
	}
});

// ---------------------------------------------------------------------------
// Narrow
// ---------------------------------------------------------------------------

test("at 360px the footer's buttons stack at 44px, the middle scrolls, and the page never scrolls sideways", async ({
	page,
}) => {
	const routes = removableRoutes(page);
	try {
		await page.setViewportSize({ width: 360, height: 640 });
		await recorded(routes, "/api/commcare/bring-in/read", (route) =>
			fulfillNdjson(route, answered(reviewAnswer())),
		);
		await open(page, routes, APP_ADDRESS);
		await expect(
			heading(page, reviewHeading("Household visits")),
		).toBeVisible();
		const bring = await button(page, BRING_IN_ACTIONS.bringItIn).boundingBox();
		const other = await button(
			page,
			BRING_IN_ACTIONS.chooseAnotherApp,
		).boundingBox();
		if (bring === null || other === null)
			throw new Error("Missing footer buttons");
		expect(Math.round(bring.height)).toBe(44);
		expect(Math.round(other.height)).toBe(44);
		expect(Math.round(bring.x)).toBe(Math.round(other.x));
		expect(bring.y).toBeLessThan(other.y);
		const middle = page
			.locator('[data-bring-in-screen="review"]')
			.locator("..");
		const scrolls = await middle.evaluate((node) => ({
			overflow: getComputedStyle(node).overflowY,
			scrollable: node.scrollHeight > node.clientHeight,
		}));
		expect(scrolls).toEqual({ overflow: "auto", scrollable: true });
		const sideways = await page.evaluate(
			() =>
				document.documentElement.scrollWidth -
				document.documentElement.clientWidth,
		);
		expect(sideways).toBe(0);
	} finally {
		await routes.removeAll();
	}
});
