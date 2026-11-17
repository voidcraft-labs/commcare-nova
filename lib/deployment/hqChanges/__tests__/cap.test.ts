/**
 * A review of changes made in CommCare HQ at the byte cap, and the bring-in
 * of what it lists, over `computeHqChanges` and `bringInHqChanges` with
 * CommCare HQ answering on a loopback socket and the deployment's store, the
 * Project's side, the member's key and the commit controlled at their
 * boundaries. The export boundary runs whole over the Project's data given,
 * and the commit runs the kernel's own preparation and gate over the head.
 *
 * A review runs pieces no bring-in's read runs: the baseline read as a
 * source, the second reader pass, the two diffs, the take check and the
 * replay. A stored baseline larger than a review reads, read as a source
 * anyway; a current
 * source past the bound, held or parsed; and a synchronous piece long enough
 * to fail another request's timer on the same instance are what these cases
 * catch. A failure of the last is fixed where the piece is long; the cap
 * stands.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withSocketHttpPeer } from "@/__tests__/helpers/httpPeer";
import {
	type RetainedHqAnswer,
	retainedBodyJson,
	retainedBodyText,
	retainedGroupRead,
	retainedReadingRead,
} from "@/__tests__/helpers/retainedHqReads";
import {
	HQ_BRING_IN_APP_MAX_BYTES,
	readHqAppForReading,
} from "@/lib/commcare/hq/appReading";
import { prepareGenesisCandidate } from "@/lib/db/appGenesis";
import { applyBlueprintChange } from "@/lib/db/applyBlueprintChange";
import { getHqCredentials } from "@/lib/db/settings";
import {
	evaluatePreparedMutationCandidate,
	prepareMutationCandidate,
} from "@/lib/doc/commitVerdicts";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import { log } from "@/lib/logger";
import type { LookupRevision } from "@/lib/lookup/types";
import { readOrganizationAuthoringSnapshot } from "@/lib/organization/service";
import { OWNERSHIP } from "../../__tests__/adoptedBirth";
import { adoptedIdentityRows } from "../../adoption";
import { normalizeHqAppSource } from "../../hqSourceBaseline";
import {
	APP_ID,
	readClean,
	readingInput,
} from "../../reading/__tests__/acceptanceInput";
import {
	postgresProjectSide,
	type ReadingProjectSide,
} from "../../reading/projectData/read";
import { activeRemoteApp, deploymentEnding } from "../../resources";
import {
	readAppBaseline,
	readDeployment,
	readDeploymentIdentityOverrides,
	readDeploymentMediaPaths,
	readMemberNames,
	recordHqChangesTaken,
} from "../../store";
import type {
	AppBaseline,
	DeploymentResource,
	DeploymentWithResources,
} from "../../types";
import { sourceFromBaseline } from "../baselineSource";
import { bringInHqChanges } from "../bringIn";
import { computeHqChanges } from "../review";

vi.mock("@/lib/agent/change-set/baseLoader", () => ({
	greatestFoldBaselineSeq: vi.fn(async () => 1),
}));
vi.mock("@/lib/db/pg", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/db/pg")>()),
	getAppDb: vi.fn(async () => ({})),
}));
vi.mock("@/lib/db/settings", () => ({ getHqCredentials: vi.fn() }));
vi.mock("@/lib/organization/service", () => ({
	readOrganizationAuthoringSnapshot: vi.fn(),
}));
vi.mock("@/lib/media/manifest", () => ({
	resolveMediaManifest: vi.fn(async () => new Map()),
}));
vi.mock("../../store", () => ({
	readDeployment: vi.fn(),
	readAppBaseline: vi.fn(),
	readDeploymentMediaPaths: vi.fn(async () => new Map()),
	readDeploymentIdentityOverrides: vi.fn(async () => []),
	readMemberNames: vi.fn(async () => new Map()),
	readProjectName: vi.fn(async () => "Cap project"),
	readFirstPublishStates: vi.fn(async () => new Map()),
	recordHqChangesTaken: vi.fn(async () => {}),
	recordRefreshedAppBaseline: vi.fn(),
	HqChangesBaselineMovedError: class extends Error {},
}));
vi.mock("../../resources", () => ({
	activeRemoteApp: vi.fn(),
	deploymentEnding: vi.fn(() => null),
	firstPublishOf: vi.fn(() => null),
	leftBehindResources: vi.fn(() => []),
}));
/* The card a landed bring-in answers with: display reads, not the bring-in's work. */
vi.mock("../../service", () => ({
	currentResourceIdentities: vi.fn(async () => null),
	deploymentKept: vi.fn(async () => null),
	setupArtifactFor: vi.fn(async () => null),
}));
/* A test that commits gives the commit its own work over its own head. */
vi.mock("@/lib/db/applyBlueprintChange", () => ({
	applyBlueprintChange: vi.fn(),
}));
/* The whole boundary, over a Project with no table and no file. */
vi.mock("@/lib/export/boundaryValidation", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/lib/export/boundaryValidation")>();
	return {
		...actual,
		prepareExportBoundary: vi.fn(
			(input: Parameters<typeof actual.prepareExportBoundary>[0]) =>
				actual.prepareExportBoundaryWithReads(input, {
					lookupFixtureData: async (scope) => ({
						projectId: scope.projectId,
						projectRevision: "0" as LookupRevision,
						definitions: [],
						rowsByTable: new Map(),
					}),
					mediaRows: async () => [],
					mediaManifest: async () => new Map(),
				}),
		),
	};
});
vi.mock("../../reading/projectData/read", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../reading/projectData/read")>()),
	postgresProjectSide: vi.fn(),
}));
vi.mock("../baselineSource", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../baselineSource")>();
	return { ...actual, sourceFromBaseline: vi.fn(actual.sourceFromBaseline) };
});

const HOSTNAME = "india.commcarehq.org";
const DOMAIN = "clinic";
const CREDS = { username: "account", apiKey: "key", server: "india" } as const;
const HQ_APP = retainedBodyJson(retainedReadingRead("application"))
	.id as string;
const PROJECT = "cap-project";
const SCOPE = {
	appId: APP_ID,
	projectId: PROJECT,
	role: "owner",
	actorUserId: "cap-member",
};
const TARGET = { server: "india", domain: DOMAIN } as const;
const READING_ID = "019a7f3c-2b1d-7e40-8a9b-0c1d2e3f4a5b";

const PATHS = {
	application: `/a/${DOMAIN}/api/application/v1/${HQ_APP}/`,
	source: `/a/${DOMAIN}/apps/source/${HQ_APP}/`,
	version: `/a/${DOMAIN}/apps/view/${HQ_APP}/current_version/`,
	tables: `/a/${DOMAIN}/api/lookup_table/v1/?limit=100`,
};

/** A Project that holds no table, as the proof lane's reading binds it. */
const NOTHING: ReadingProjectSide = {
	tables: async () => ({
		projectId: PROJECT,
		projectRevision: "0" as LookupRevision,
		definitions: [],
		rowsByTable: {},
		keptColumns: {},
	}),
	referencingApps: async () => ({}),
	siblings: async () => [],
	mayAdminister: async () => true,
	measureRows: async () => ({ dataBytes: 0, largestRowBytes: 0 }),
};

const MAPPING = {
	kind: "app",
	novaResourceId: APP_ID,
	remoteId: HQ_APP,
	ownership: "adopted",
	pushedRevision: 1,
	adoptedAt: "2026-11-10T09:30:00.000Z",
	releasedAt: null,
} as unknown as DeploymentResource;

const DEPLOYMENT = {
	deployment: { id: "cap-deployment", endings: 0 },
	active: [MAPPING],
} as unknown as DeploymentWithResources;

/** CommCare HQ's list of lookup tables, holding none. */
function noTables(): RetainedHqAnswer {
	const answer = retainedGroupRead("lookups/lookup-tables");
	const body = retainedBodyJson(answer);
	return {
		...answer,
		body: JSON.stringify({
			...body,
			meta: { ...(body.meta as object), total_count: 0 },
			objects: [],
		}),
	};
}

function send(response: ServerResponse, answer: RetainedHqAnswer): void {
	response.writeHead(answer.status, { ...answer.headers });
	response.end(retainedBodyText(answer));
}

/** A JSON body one byte over the cap, written and never ended. */
function overTheCap(response: ServerResponse): Promise<{ ended: boolean }> {
	const closed = Promise.withResolvers<{ ended: boolean }>();
	response.on("close", () =>
		closed.resolve({ ended: response.writableFinished }),
	);
	response.writeHead(200, { "content-type": "application/json" });
	const lead = '{"padding": "';
	response.write(
		lead + "x".repeat(HQ_BRING_IN_APP_MAX_BYTES + 1 - lead.length),
	);
	return closed.promise;
}

/** `ids` with the first eight hex digits of each replaced by `index`, in the id's own case. */
function freshened(text: string, ids: readonly string[], index: number) {
	let out = text;
	for (const id of ids) {
		const digits = index.toString(16).padStart(8, "0");
		const lead =
			id.slice(0, 8) === id.slice(0, 8).toUpperCase()
				? digits.toUpperCase()
				: digits;
		out = out.split(id).join(lead + id.slice(8));
	}
	return out;
}

/**
 * The application resource and the source of `navigation-base`, its one menu
 * repeated under fresh ids until the source is as near the cap as one more
 * menu allows, as a bring-in's own test at the cap builds them.
 */
function nearTheCap(): {
	readonly application: RetainedHqAnswer;
	readonly source: RetainedHqAnswer;
	readonly menus: number;
} {
	const retainedApplication = retainedReadingRead("application");
	const application = retainedBodyJson(retainedApplication);
	const retainedSource = retainedGroupRead("navigation-base/app-source");
	const source = retainedBodyJson(retainedSource);
	const [summary] = application.modules as Record<string, unknown>[];
	const [menu] = source.modules as Record<string, unknown>[];
	const attachments = source._attachments as Record<string, string>;
	const sourceForms = (menu.forms as { unique_id: string }[]).map(
		(form) => form.unique_id,
	);
	const summaryForms = (summary.forms as { unique_id: string }[]).map(
		(form) => form.unique_id,
	);
	const xmlnsIds = (summary.forms as { xmlns: string }[]).map((form) =>
		form.xmlns.slice(form.xmlns.lastIndexOf("/") + 1),
	);
	const ids = [
		menu.unique_id as string,
		...sourceForms,
		...summaryForms,
		...xmlnsIds,
	];
	const menuText = JSON.stringify(menu);
	const summaryText = JSON.stringify(summary);
	const attachmentTexts = sourceForms.map((id) => attachments[`${id}.xml`]);
	const perMenu =
		Buffer.byteLength(menuText) +
		attachmentTexts.reduce(
			(sum, text) => sum + Buffer.byteLength(JSON.stringify(text)) + 40,
			0,
		);
	const base = Buffer.byteLength(
		JSON.stringify({ ...source, modules: [], _attachments: {} }),
	);
	/* Room for the renamed app's longer name. */
	const menus = Math.floor(
		(HQ_BRING_IN_APP_MAX_BYTES - base - 8192) / (perMenu + 2),
	);
	const modules: unknown[] = [];
	const summaries: unknown[] = [];
	const held: Record<string, string> = {};
	for (let index = 0; index < menus; index += 1) {
		modules.push(JSON.parse(freshened(menuText, ids, index)));
		summaries.push(JSON.parse(freshened(summaryText, ids, index)));
		sourceForms.forEach((id, position) => {
			held[`${freshened(id, ids, index)}.xml`] = freshened(
				attachmentTexts[position] as string,
				ids,
				index,
			);
		});
	}
	const sourceBody = JSON.stringify({ ...source, modules, _attachments: held });
	if (Buffer.byteLength(sourceBody) > HQ_BRING_IN_APP_MAX_BYTES)
		throw new Error("The built source is over the cap.");
	return {
		application: {
			...retainedApplication,
			body: JSON.stringify({ ...application, modules: summaries }),
		},
		source: { ...retainedSource, body: sourceBody },
		menus,
	};
}

/** `source` with the app renamed in CommCare HQ. */
function renamed(source: RetainedHqAnswer): RetainedHqAnswer {
	return {
		...source,
		body: JSON.stringify({
			...retainedBodyJson(source),
			name: "Navigation, renamed in CommCare HQ",
		}),
	};
}

/** A stored baseline of `raw`, as `readAppBaseline` returns a verified one. */
function baselineOf(
	raw: unknown,
	sourceBytes?: number,
): Exclude<AppBaseline, { readonly origin: "unread" }> {
	const normalized = normalizeHqAppSource(raw);
	if ("malformed" in normalized)
		throw new Error("The built source does not normalize.");
	return {
		origin: "read",
		remoteAppId: HQ_APP,
		source: normalized.normalized,
		sourceDigest: normalized.digest,
		ownership: OWNERSHIP,
		observedAt: "2026-11-10T09:29:00.000Z",
		observedBy: SCOPE.actorUserId,
		novaRevision: 1,
		mediaFiles: {},
		sourceBytes: sourceBytes ?? normalized.bytes,
	};
}

function review() {
	return computeHqChanges(
		SCOPE,
		TARGET,
		{ readingId: READING_ID, keepMedia: false, onEvent: () => {} },
		"review",
	);
}

beforeEach(() => {
	vi.mocked(readDeployment).mockResolvedValue(DEPLOYMENT);
	vi.mocked(activeRemoteApp).mockReturnValue(MAPPING);
	vi.mocked(deploymentEnding).mockReturnValue(null);
	vi.mocked(readDeploymentIdentityOverrides).mockResolvedValue([]);
	vi.mocked(readDeploymentMediaPaths).mockResolvedValue(new Map());
	vi.mocked(readMemberNames).mockResolvedValue(new Map());
	vi.mocked(postgresProjectSide).mockReturnValue(NOTHING);
	vi.mocked(getHqCredentials).mockResolvedValue({
		ok: true,
		creds: CREDS,
		domain: { name: DOMAIN },
	} as Awaited<ReturnType<typeof getHqCredentials>>);
});
afterEach(() => {
	vi.mocked(sourceFromBaseline).mockClear();
	vi.mocked(readAppBaseline).mockReset();
	vi.mocked(readOrganizationAuthoringSnapshot).mockReset();
});

describe("a review of changes made in CommCare HQ at the byte cap", () => {
	it("answers base-too-large for a baseline one byte over the cap, reads it as no source and asks CommCare HQ nothing", async () => {
		vi.mocked(readAppBaseline).mockResolvedValue({
			...baselineOf(
				retainedBodyJson(retainedGroupRead("navigation-base/app-source")),
			),
			sourceBytes: HQ_BRING_IN_APP_MAX_BYTES + 1,
		});
		const requested: string[] = [];
		await withSocketHttpPeer(
			HOSTNAME,
			(request: IncomingMessage, response: ServerResponse) => {
				requested.push(request.url ?? "");
				response.writeHead(404);
				response.end();
			},
			async () => {
				const { review: answer } = await review();
				expect(answer).toEqual({
					kind: "unavailable",
					reason: "base-too-large",
					/* What a brought-in baseline measures against, as its sentence names it. */
					since: expect.objectContaining({ kind: "brought-in" }),
				});
			},
		);
		expect(sourceFromBaseline).not.toHaveBeenCalled();
		expect(requested).toEqual([]);
	}, 60_000);

	it("answers the one too-large account for a current source one byte over the cap", async () => {
		const built = nearTheCap();
		vi.mocked(readAppBaseline).mockResolvedValue(
			baselineOf(retainedBodyJson(built.source)),
		);
		vi.mocked(readOrganizationAuthoringSnapshot).mockResolvedValue({
			blueprint: prepareGenesisCandidate({
				appId: APP_ID,
				projectId: PROJECT,
				mutations: [],
			}).prepared.nextDoc,
			blueprintSeq: 1,
		} as Awaited<ReturnType<typeof readOrganizationAuthoringSnapshot>>);
		let stream: Promise<{ ended: boolean }> | undefined;
		await withSocketHttpPeer(
			HOSTNAME,
			(request: IncomingMessage, response: ServerResponse) => {
				if (request.url === PATHS.application)
					send(response, built.application);
				else if (request.url === PATHS.source) stream = overTheCap(response);
				else {
					response.writeHead(404);
					response.end();
				}
			},
			async () => {
				const { review: answer } = await review();
				expect(answer).toMatchObject({
					kind: "account",
					findings: [{ code: "too-large", place: { kind: "app" } }],
					more: 0,
				});
				expect(await stream).toEqual({ ended: false });
			},
		);
		expect(sourceFromBaseline).not.toHaveBeenCalled();
	}, 60_000);

	it("reviews a baseline and a changed source just under the cap and brings the change in, each synchronous piece under five seconds", async () => {
		const built = nearTheCap();
		expect(built.menus).toBeGreaterThan(100);
		const serve =
			(source: RetainedHqAnswer) =>
			(request: IncomingMessage, response: ServerResponse) => {
				if (request.url === PATHS.application)
					send(response, built.application);
				else if (request.url === PATHS.source) send(response, source);
				else if (request.url === PATHS.version)
					send(response, retainedReadingRead("current-version"));
				else if (request.url === PATHS.tables) send(response, noTables());
				else {
					response.writeHead(404);
					response.end();
				}
			};

		/* The app as Nova brought it in: the baseline is that read, the head its
		 * document, the identity rows its menus' and forms' ids. */
		const read = await withSocketHttpPeer(HOSTNAME, serve(built.source), () =>
			readHqAppForReading(CREDS, DOMAIN, HQ_APP, {}),
		);
		if (read.kind !== "read") throw new Error(read.kind);
		const outcome = readClean(readingInput(read.source, read.modules));
		const declaration = outcome.draft.declaration;
		if (declaration.kind !== "choices")
			throw new Error("The reading offers no declaration.");
		const choice = declaration.choices[declaration.proposed];
		const head = prepareGenesisCandidate({
			appId: APP_ID,
			projectId: PROJECT,
			mutations: [
				...diffDocsToMutations(emptyBlueprintDoc(APP_ID), outcome.draft.doc),
				...(choice?.mutations ?? []),
			],
		}).prepared.nextDoc;
		/* The commit's own synchronous work over the head at the cap: the kernel
		 * prepares the batch and evaluates the gate over the candidate, then runs
		 * the record in its transaction at the next sequence and answers the
		 * document it committed. */
		const commitAtCap: typeof applyBlueprintChange = async (args) => {
			const prepared = prepareMutationCandidate(head, args.guard.mutations);
			await nextTurn();
			const verdict = evaluatePreparedMutationCandidate(prepared, {
				kind: "available",
				projectId: PROJECT,
				projectRevision: "0" as LookupRevision,
				definitions: [],
			});
			expect(verdict.ok).toBe(true);
			await args.inTransaction?.({ tx: {} as never, seq: 2 });
			return { seq: 2, committedDoc: prepared.nextDoc };
		};
		vi.mocked(applyBlueprintChange).mockImplementationOnce(commitAtCap);
		const rows = adoptedIdentityRows(outcome.draft.identities, read.modules);
		if (!rows.ok) throw new Error(rows.at);
		vi.mocked(readDeploymentIdentityOverrides).mockResolvedValue(rows.rows);
		vi.mocked(readAppBaseline).mockResolvedValue(baselineOf(read.source.raw));
		vi.mocked(readOrganizationAuthoringSnapshot).mockResolvedValue({
			blueprint: head,
			blueprintSeq: 1,
			organization: { locations: {} },
		} as unknown as Awaited<
			ReturnType<typeof readOrganizationAuthoringSnapshot>
		>);

		/* The longest the event loop is held, over everything each request runs,
		 * its pieces and whatever runs between them. */
		const held = monitorEventLoopDelay({ resolution: 20 });
		const heldMs = async <T>(run: () => Promise<T>) => {
			held.reset();
			held.enable();
			try {
				return { result: await run(), heldMs: held.max / 1e6 };
			} finally {
				held.disable();
			}
		};

		/* One peer serves CommCare HQ's app as it is now to both requests, so the
		 * bring-in's reads go out on connections kept alive across the review. */
		await withSocketHttpPeer(
			HOSTNAME,
			serve(renamed(built.source)),
			async () => {
				const reviewed = await heldMs(review);
				const { review: answer, facts } = reviewed.result;
				if (answer.kind !== "changes") throw new Error(JSON.stringify(answer));
				expect(answer.hqChanges).toEqual(["The app's name"]);
				expect(facts.sourceBytes).toBeGreaterThan(
					HQ_BRING_IN_APP_MAX_BYTES * 0.9,
				);

				const brought = await heldMs(() =>
					bringInHqChanges(
						SCOPE,
						TARGET,
						{
							readingId: answer.readingId,
							reviewDigest: answer.reviewDigest,
							tableChoices: {},
						},
						{ onEvent: () => {} },
					),
				);
				expect(brought.result).toMatchObject({ kind: "brought-in", seq: 2 });
				expect(applyBlueprintChange).toHaveBeenCalledOnce();
				expect(recordHqChangesTaken).toHaveBeenCalledOnce();
				const bringInFacts = vi
					.mocked(log.info)
					.mock.calls.find(
						([line, context]) =>
							line === "[hq-changes] answered" &&
							(context as { operation?: string }).operation === "bring-in",
					)?.[1] as { readonly longestPieceMs: number } | undefined;

				expect(facts.longestPieceMs).toBeLessThan(5_000);
				expect(reviewed.heldMs).toBeLessThan(5_000);
				expect(bringInFacts?.longestPieceMs).toBeLessThan(5_000);
				expect(brought.heldMs).toBeLessThan(5_000);
			},
		);
		/* Seven whole readings of a source at the cap (the app as brought in, then
		 * each request's base, now and fixed-point readings), two acceptances and
		 * two plans: the bound this test holds is each piece's, not the whole. */
	}, 300_000);
});
