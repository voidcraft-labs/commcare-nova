/**
 * The plan and its digest (step 5's part 09, section 10.2), pure, over a
 * fleet source built from the pre-step fixtures read raw.
 *
 * The digest is what makes `--execute --expect-plan-digest` write exactly
 * the plan the operator read in the dry run. The plausible failures: a
 * digest that moves between two builds of one fleet (key order, an
 * unordered collection, an identity drawn at random), so a quiescent window
 * refuses its own dry run; and a digest blind to a field the writer acts on
 * or decides from, so a plan that moved after the dry run is written
 * anyway. The observation is the digest of one fleet planned twice, and of
 * that plan with each field moved: a base sequence, a base digest, a
 * target, a hold, a baseline's stored digest or the time it was read, and a
 * blocker.
 */

import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildCaseTypeMap } from "@/lib/case-store/store";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import { normalizeHqAppSource } from "@/lib/deployment/hqSourceBaseline";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	CASE_CLAIM_CASE_TYPE,
	type MediaAssetId,
} from "@/lib/domain";
import { ALL_ICON_SLUGS } from "@/lib/domain/builtinIcons";
import { caseTypeToJsonSchema } from "@/lib/domain/expression/jsonSchema";
import { builtinAssetRows } from "@/lib/media/builtinIconAssets";
import { canonicalJsonText } from "@/lib/utils/canonicalJson";
import { rawDocumentDigest, readRawDocument } from "../oldShape";
import { readBaseline } from "../placements";
import { caseWritesPlanDigest, planFleet, planHasBlockers } from "../plan";
import type { FleetSource, SourceApp } from "../source";
import { writesIntoOperations } from "../steps/writesIntoOperations";
import { parseHead, structurePhase } from "../structure";
import {
	type AppPlan,
	type CaseWritesCutoverPlan,
	PLAN_FORMAT,
	type PublishedDeployment,
} from "../types";
import { carriersOfPersistedDoc, readPreStepJson } from "./rawFixture";

// ─── The fleet ────────────────────────────────────────────────────────────

const PUBLISHED = "targeted-migration-case-writes";
const ATTACHMENT = "targeted-migration-attachment";
/** The one fixture a blocker stops (part 09 §7.4's C9 arm under `forEach`). */
const BLOCKED = "pre-step-own-close-operation";
const DEPLOYMENT_ID = "0b6c6a5e-1111-4a5e-9c1e-000000000001";

const MEDIA: ReadonlyMap<MediaAssetId, MediaAssetRecord> = new Map(
	builtinAssetRows(ALL_ICON_SLUGS).map((record) => [
		record.id as MediaAssetId,
		record,
	]),
);

/** The fixture's writes made operations: the case schemas `main`'s deploy
 *  stored for it, but for the claim type's row, which no stored app holds. */
function storedSchemasOf(
	appId: string,
	raw: ReturnType<typeof readRawDocument>,
	id: string,
) {
	const structure = structurePhase(raw);
	const head = parseHead(appId, structure.persisted);
	if (!head.ok) throw new Error(`The fixture ${id} does not parse.`);
	const doc: BlueprintDoc = writesIntoOperations(head.doc, structure.facts).doc;
	const rows = new Map<string, string>();
	for (const caseType of buildCaseTypeMap(toPersistableDoc(doc)).values())
		if (caseType.name !== CASE_CLAIM_CASE_TYPE)
			rows.set(
				caseType.name,
				canonicalJsonText(caseTypeToJsonSchema(caseType)),
			);
	return rows;
}

/** A published deployment whose `push` baseline is HQ's read of the
 *  published fixture's witness, read at `observedAt`. */
function pushDeployment(
	observedAt = "2026-10-01T00:00:00.000Z",
): PublishedDeployment {
	const response = JSON.parse(
		readFileSync(
			new URL(
				`../../../../proof/hq-reads/${PUBLISHED}/app-source.json`,
				import.meta.url,
			),
			"utf8",
		),
	) as { body: string };
	const normalized = normalizeHqAppSource(JSON.parse(response.body));
	if ("malformed" in normalized)
		throw new Error(`The read is not an application: ${normalized.malformed}`);
	return {
		deploymentId: DEPLOYMENT_ID,
		server: "production",
		domain: "nova-space",
		baseline: readBaseline({
			origin: "push",
			source_gzip: gzipSync(Buffer.from(normalized.text, "utf8")),
			source_digest: normalized.digest,
			observed_at: new Date(observedAt),
		}),
		overrides: [],
		pushedRevision: null,
	};
}

interface SourceOptions {
	readonly deleted?: boolean;
	readonly baseSeq?: number;
	readonly deployments?: readonly PublishedDeployment[];
}

/** One fixture as the fleet read gives it, each read made afresh. */
function sourceApp(id: string, options: SourceOptions = {}): SourceApp {
	const doc = readPreStepJson(`${id}.json`) as Record<string, unknown>;
	const appId = doc.appId as string;
	const carriers = carriersOfPersistedDoc(doc);
	const raw = readRawDocument(appId, carriers);
	const baseSeq = options.baseSeq ?? 7;
	const deployments = options.deployments ?? [];
	return {
		appId,
		projectId: "c3a3e0f4-2b8e-4c39-9f7e-6d1b2c3d4e5f",
		deleted: options.deleted ?? false,
		baseSeq,
		carriers,
		raw,
		baseDigest: rawDocumentDigest(raw),
		context: {
			appId,
			projectId: "c3a3e0f4-2b8e-4c39-9f7e-6d1b2c3d4e5f",
			lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
			mediaRecords: MEDIA,
			deployments,
			storedSchemas: storedSchemasOf(appId, raw, id),
			liveDeployments: deployments.map((deployment) => ({
				deploymentId: deployment.deploymentId,
				server: deployment.server,
				domain: deployment.domain,
			})),
			mutationSeq: baseSeq,
			discardsPrivateWork: false,
		},
	};
}

/** The published app, an unpublished one marked deleted, and the blocked
 *  one, listed out of id order. */
function fleet(
	published: SourceOptions = { deployments: [pushDeployment()] },
): FleetSource {
	const apps = [
		sourceApp(BLOCKED),
		sourceApp(PUBLISHED, published),
		sourceApp(ATTACHMENT, { deleted: true }),
	];
	return {
		apps,
		projects: new Map(),
		privateWork: {
			openWorkspaces: 0,
			openChangeSets: 0,
			activeCandidates: 0,
			endingSessions: [],
			mutationEvents: 0,
			apps: [],
		},
		holders: {
			liveApps: [],
			liveSessions: [],
			settleableApps: [],
			settleableSessions: [],
			unsettledApps: [],
			unsettledSessions: [],
		},
		appsInFleet: apps.length,
		deletedApps: 1,
		fleetSeqDigest: "f".repeat(64),
		databaseBytes: 0,
	};
}

function appOf(plan: CaseWritesCutoverPlan, fixtureAppId: string): AppPlan {
	const app = plan.apps.find((candidate) => candidate.appId === fixtureAppId);
	if (app === undefined) throw new Error(`No app ${fixtureAppId} planned.`);
	return app;
}

const PUBLISHED_APP_ID = sourceApp(PUBLISHED).appId;
const BLOCKED_APP_ID = sourceApp(BLOCKED).appId;

/** Planned once: each transform runs every step and its judgement. */
const BASE = planFleet(fleet());

/** The base plan's digest with one app's plan replaced. */
function digestWith(edit: (app: AppPlan) => AppPlan): string {
	return caseWritesPlanDigest({
		format: PLAN_FORMAT,
		apps: BASE.plan.apps.map((app) =>
			app.appId === PUBLISHED_APP_ID ? edit(app) : app,
		),
	});
}

// ─── The digest ───────────────────────────────────────────────────────────

describe("the plan's digest", () => {
	it("is the same for one fleet planned twice from fresh reads", () => {
		expect(BASE.plan.digest).toMatch(/^[0-9a-f]{64}$/);
		expect(planFleet(fleet()).plan.digest).toBe(BASE.plan.digest);
		expect(caseWritesPlanDigest(BASE.plan)).toBe(BASE.plan.digest);
	});

	it("covers a hold and a baseline, which the published app holds", () => {
		const app = appOf(BASE.plan, PUBLISHED_APP_ID);
		expect(app.held.length).toBeGreaterThan(0);
		expect(app.deployments).toEqual([
			expect.objectContaining({
				deploymentId: DEPLOYMENT_ID,
				baseline: "readable",
				observedAt: "2026-10-01T00:00:00.000Z",
			}),
		]);
	});

	it.each<[string, (app: AppPlan) => AppPlan]>([
		["a base sequence", (app) => ({ ...app, baseSeq: app.baseSeq + 1 })],
		["a base digest", (app) => ({ ...app, baseDigest: "a".repeat(64) })],
		["a target", (app) => ({ ...app, targetDigest: "b".repeat(64) })],
		["a hold", (app) => ({ ...app, held: app.held.slice(1) })],
		[
			"a baseline's stored digest",
			(app) => ({
				...app,
				deployments: app.deployments.map((entry) => ({
					...entry,
					sourceDigest: "c".repeat(64),
				})),
			}),
		],
		[
			"the time a baseline was read",
			(app) => ({
				...app,
				deployments: app.deployments.map((entry) => ({
					...entry,
					observedAt: "2026-10-02T00:00:00.000Z",
				})),
			}),
		],
		[
			"a blocker",
			(app) => ({
				...app,
				blockers: [{ code: "target-gate", count: 1, findingCodes: ["CYCLE"] }],
			}),
		],
	])("moves with %s", (_name, edit) => {
		expect(digestWith(edit)).not.toBe(BASE.plan.digest);
	});

	it("moves when the fleet read gives a baseline read at another time", () => {
		const moved = planFleet(
			fleet({ deployments: [pushDeployment("2026-10-02T00:00:00.000Z")] }),
		);
		expect(appOf(moved.plan, PUBLISHED_APP_ID).deployments[0]?.observedAt).toBe(
			"2026-10-02T00:00:00.000Z",
		);
		expect(moved.plan.digest).not.toBe(BASE.plan.digest);
	});

	it("moves when the fleet read gives an app at another sequence", () => {
		const moved = planFleet(
			fleet({ baseSeq: 8, deployments: [pushDeployment()] }),
		);
		expect(appOf(moved.plan, PUBLISHED_APP_ID).baseSeq).toBe(8);
		expect(moved.plan.digest).not.toBe(BASE.plan.digest);
	});

	it("moves when a baseline no longer verifies, which blocks its app and names why", () => {
		const unreadable: PublishedDeployment = {
			...pushDeployment(),
			baseline: { kind: "unreadable", why: "digest" },
		};
		const blocked = planFleet(fleet({ deployments: [unreadable] }));
		const app = appOf(blocked.plan, PUBLISHED_APP_ID);
		expect(app.targetDigest).toBeNull();
		expect(app.deployments).toEqual([
			{
				deploymentId: DEPLOYMENT_ID,
				baseline: "unreadable",
				sourceDigest: null,
				observedAt: null,
			},
		]);
		expect(app.blockers).toEqual([
			{
				code: "baseline-unreadable",
				count: 1,
				findingCodes: ["baseline-unreadable:digest"],
			},
		]);
		expect(blocked.writes.has(PUBLISHED_APP_ID)).toBe(false);
		expect(blocked.plan.digest).not.toBe(BASE.plan.digest);
	});
});

// ─── The plan's apps ──────────────────────────────────────────────────────

describe("the plan's apps", () => {
	it("lists every app, deleted ones included, in code-point order of id", () => {
		const ids = BASE.plan.apps.map((app) => app.appId);
		expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
		expect(ids).toHaveLength(3);
		expect(BASE.plan.apps.filter((app) => app.deleted)).toHaveLength(1);
		expect(BASE.plan.format).toBe(PLAN_FORMAT);
	});

	it("has a target for every unblocked app and none for the blocked one", () => {
		expect(planHasBlockers(BASE.plan)).toBe(true);
		const blocked = appOf(BASE.plan, BLOCKED_APP_ID);
		expect(blocked.targetDigest).toBeNull();
		expect(blocked.blockers.length).toBeGreaterThan(0);
		expect(BASE.writes.has(BLOCKED_APP_ID)).toBe(false);
		for (const app of BASE.plan.apps.filter(
			(candidate) => candidate.blockers.length === 0,
		)) {
			expect(app.targetDigest).toMatch(/^[0-9a-f]{64}$/);
			expect(BASE.writes.get(app.appId)?.source.appId).toBe(app.appId);
		}
		expect(
			planHasBlockers({ apps: [appOf(BASE.plan, PUBLISHED_APP_ID)] }),
		).toBe(false);
	});

	it("keeps each blocker's places out of the plan and beside it", () => {
		const blocked = appOf(BASE.plan, BLOCKED_APP_ID);
		for (const blocker of blocked.blockers)
			expect(Object.keys(blocker).sort()).toEqual([
				"code",
				"count",
				"findingCodes",
			]);
		const places = BASE.blockerPlaces.get(BLOCKED_APP_ID) ?? [];
		expect(places.map((blocker) => blocker.code)).toEqual(
			blocked.blockers.map((blocker) => blocker.code),
		);
		expect(places.some((blocker) => (blocker.places ?? []).length > 0)).toBe(
			true,
		);
	});

	it("counts the published app's placements for the report", () => {
		const counts = BASE.placementCounts.get(PUBLISHED_APP_ID);
		expect(counts).toBeDefined();
		expect(counts?.bySource.carried).toBe(
			appOf(BASE.plan, PUBLISHED_APP_ID).held.filter(
				(held) => held.source === "carried",
			).length,
		);
	});
});
