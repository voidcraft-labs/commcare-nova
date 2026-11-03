/**
 * The content-free report (step 5's part 09, section 10.3), pure, over a
 * plan the production transform builds from every pre-step fixture.
 *
 * Contract: no line holds an authored string, and every run ends in an
 * `outcome` line, one that throws included. The plausible failures are a
 * line that prints what a plan carries beside its counts (a notice entry's
 * name, a schema change's case type, a deployment's domain, a blocker's
 * message) and a run whose error escapes before its outcome is printed.
 * Each fixture's names, labels and hints, the deployments' domains, the
 * case types and a blocker's places are given a sentinel here; the test
 * first shows the sentinel reached the plan, then searches every line for
 * it.
 */

import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildCaseTypeMap } from "@/lib/case-store/store";
import { normalizeHqAppSource } from "@/lib/deployment/hqSourceBaseline";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { CASE_CLAIM_CASE_TYPE } from "@/lib/domain";
import { caseTypeToJsonSchema } from "@/lib/domain/expression/jsonSchema";
import { asUuid } from "@/lib/domain/uuid";
import {
	canonicalJsonDigest,
	canonicalJsonText,
} from "@/lib/utils/canonicalJson";
import { CutoverLedgerError } from "../ledger";
import { rawDocumentDigest, readRawDocument } from "../oldShape";
import {
	type PlacementCounts,
	readBaseline,
	UNHELD_CLASSES,
} from "../placements";
import {
	CutoverReport,
	errorClassOf,
	fleetLine,
	outcomeLine,
	planSections,
	type ReportFleet,
	type ReportLine,
	reported,
	writerLine,
} from "../report";
import { writesIntoOperations } from "../steps/writesIntoOperations";
import { parseHead, structurePhase } from "../structure";
import { transformApp } from "../transform";
import {
	type AppPlan,
	type LiveDeployment,
	PLAN_FORMAT,
	type PublishedDeployment,
	REPORT_SECTIONS,
	type StepContext,
} from "../types";
import {
	carriersOfPersistedDoc,
	PRE_STEP_FIXTURE_IDS,
	readPreStepJson,
} from "./rawFixture";

/** Every authored string the test plants carries this. */
const SENTINEL = "Zqxsentinel";
const SENTINEL_DOMAIN = "zqxsentinel-space";

type JsonObject = Record<string, unknown>;

function mark(value: unknown): unknown {
	return typeof value === "string" ? `${SENTINEL} ${value}` : value;
}

/**
 * The stored document of fixture `id` with its app name, every module's and
 * form's name, and every field's label and hint and every option's label
 * carrying the sentinel. Ids, case types and properties are left as they
 * are, so the transform reads the fixture's own structure.
 */
function sentinelled(id: string): JsonObject {
	const doc = structuredClone(readPreStepJson(`${id}.json`)) as JsonObject;
	doc.appName = mark(doc.appName);
	for (const slot of ["modules", "forms"] as const)
		for (const record of Object.values((doc[slot] ?? {}) as JsonObject))
			(record as JsonObject).name = mark((record as JsonObject).name);
	for (const record of Object.values((doc.fields ?? {}) as JsonObject)) {
		const field = record as JsonObject;
		for (const key of ["label", "hint"] as const)
			if (field[key] !== undefined) field[key] = mark(field[key]);
		if (Array.isArray(field.options))
			for (const option of field.options as JsonObject[])
				option.label = mark(option.label);
	}
	return doc;
}

/** CommCare HQ's read of a witness, as the body it answered. */
function hqRead(id: string): unknown {
	const response = JSON.parse(
		readFileSync(
			new URL(
				`../../../../proof/hq-reads/${id}/app-source.json`,
				import.meta.url,
			),
			"utf8",
		),
	) as { body: string };
	return JSON.parse(response.body);
}

const PUBLISHED_FIXTURE = "targeted-migration-case-writes";

/** A published deployment of `id`'s witness: a readable baseline holding
 *  HQ's read of it, on the sentinel's domain. */
function publishedDeployment(id: string): PublishedDeployment {
	const normalized = normalizeHqAppSource(hqRead(id));
	if ("malformed" in normalized)
		throw new Error(`The read is not an application: ${normalized.malformed}`);
	return {
		deploymentId: "0b6c6a5e-1111-4a5e-9c1e-000000000001",
		server: "production",
		domain: SENTINEL_DOMAIN,
		baseline: readBaseline({
			origin: "push",
			source_gzip: gzipSync(Buffer.from(normalized.text, "utf8")),
			source_digest: normalized.digest,
			observed_at: new Date("2026-10-01T00:00:00.000Z"),
		}),
		overrides: [],
		pushedRevision: 1,
	};
}

/** The stored schemas a pre-step deploy left: the derivation of the
 *  document the field writes become, the claim type not yet stored. */
function storedSchemas(
	appId: string,
	raw: ReturnType<typeof readRawDocument>,
): Map<string, string> {
	const structure = structurePhase(raw);
	const head = parseHead(appId, structure.persisted);
	const schemas = new Map<string, string>();
	if (!head.ok) return schemas;
	const doc = writesIntoOperations(head.doc, structure.facts).doc;
	for (const caseType of buildCaseTypeMap(toPersistableDoc(doc)).values()) {
		if (caseType.name === CASE_CLAIM_CASE_TYPE) continue;
		schemas.set(
			caseType.name,
			canonicalJsonText(caseTypeToJsonSchema(caseType)),
		);
	}
	return schemas;
}

/** One fixture's plan entry, through the production transform. */
function planOf(id: string, index: number): AppPlan {
	const doc = sentinelled(id);
	const appId = `app-${String(index).padStart(2, "0")}`;
	const raw = readRawDocument(appId, carriersOfPersistedDoc(doc));
	const published = id === PUBLISHED_FIXTURE ? [publishedDeployment(id)] : [];
	const live: LiveDeployment[] = published.map((deployment) => ({
		deploymentId: deployment.deploymentId,
		server: deployment.server,
		domain: deployment.domain,
	}));
	const ctx: StepContext = {
		appId,
		projectId: "project-a",
		lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
		mediaRecords: new Map(),
		deployments: published,
		storedSchemas: storedSchemas(appId, raw),
		liveDeployments: live,
		mutationSeq: 1,
		discardsPrivateWork: index % 2 === 0,
	};
	const result = transformApp(raw, ctx);
	return {
		appId,
		projectId: ctx.projectId,
		deleted: false,
		baseSeq: 1,
		baseDigest: rawDocumentDigest(raw),
		targetDigest:
			result.target === null
				? null
				: canonicalJsonDigest(toPersistableDoc(result.target)),
		deployments: published.map((deployment) => ({
			deploymentId: deployment.deploymentId,
			baseline:
				deployment.baseline.kind === "unknown"
					? deployment.baseline.why
					: deployment.baseline.kind,
			sourceDigest:
				deployment.baseline.kind === "readable"
					? deployment.baseline.sourceDigest
					: null,
			observedAt:
				deployment.baseline.kind === "readable"
					? deployment.baseline.observedAt
					: null,
		})),
		changes: result.changes,
		held: result.held,
		pathMoves: result.pathMoves,
		notice: result.notice,
		// The plan drops a blocker's places; this one keeps them, so the test
		// shows the report never reads them either.
		blockers: result.blockers,
		schemaChanges: result.schemaChanges,
		discardsPrivateWork: result.discardsPrivateWork,
	};
}

/** An app whose every carrier the report could misread holds the sentinel:
 *  a planted schema change's case type, a blocker's places, a deployment
 *  line's domain. */
const PLANTED: AppPlan = {
	appId: "app-zz-planted",
	projectId: "project-a",
	deleted: true,
	baseSeq: 3,
	baseDigest: "0".repeat(64),
	targetDigest: null,
	deployments: [
		{
			deploymentId: "0b6c6a5e-1111-4a5e-9c1e-000000000002",
			baseline: "unread",
			sourceDigest: null,
			observedAt: null,
		},
	],
	changes: [
		{
			step: "renamed-concepts",
			kind: "dead-case-list-media",
			entityUuid: null,
			detail: { icon: 1, audioLabel: 1 },
		},
		{
			step: "renamed-concepts",
			kind: "case-list-registration-form",
			entityUuid: null,
			detail: { translations: 2 },
		},
		{
			step: "extension-children",
			kind: "non-extension-carried-create",
			entityUuid: null,
			detail: {},
		},
	],
	held: [],
	pathMoves: [
		{
			deploymentId: "0b6c6a5e-1111-4a5e-9c1e-000000000002",
			forms: 2,
			causes: ["subcase-renumbered", "placement-simplified"],
		},
	],
	notice: [
		{
			kind: "deployment",
			reason: "placements-kept-unread",
			deployment: {
				deploymentId: asUuid("0b6c6a5e-1111-4a5e-9c1e-000000000002"),
				server: "production",
				domain: SENTINEL_DOMAIN,
			},
		},
	],
	blockers: [
		{
			code: "target-gate",
			count: 1,
			findingCodes: ["CASE_PROPERTY_UNKNOWN"],
			places: [
				{
					entity: {
						kind: "form",
						uuid: asUuid("0b6c6a5e-1111-4a5e-9c1e-0000000000f1"),
						name: `${SENTINEL} form`,
					},
					findingCode: "CASE_PROPERTY_UNKNOWN",
					message: `${SENTINEL} reads a property no case holds.`,
				},
			],
		},
	],
	schemaChanges: [
		{ caseType: `${SENTINEL}_type`, cause: "claim-type-row", properties: 0 },
		{
			caseType: `${SENTINEL}_type`,
			cause: "capture-link-property",
			properties: 2,
		},
	],
	discardsPrivateWork: true,
};

function zeroCounts(): PlacementCounts {
	return {
		byTarget: { "case-operation": 0, "own-close": 0, "query-repeat": 0 },
		bySource: { carried: 0, "unknown-baseline": 0 },
		unheld: Object.fromEntries(
			UNHELD_CLASSES.map((unheldClass) => [unheldClass, 0]),
		) as PlacementCounts["unheld"],
		frozenChecked: 0,
		frozenDisagrees: 0,
	};
}

function fleetOf(): ReportFleet {
	const apps = [
		...PRE_STEP_FIXTURE_IDS.map((id, index) => planOf(id, index)),
		PLANTED,
	];
	return {
		plan: { apps, digest: canonicalJsonDigest({ format: PLAN_FORMAT, apps }) },
		appsInFleet: apps.length,
		deletedApps: 1,
		fleetSeqDigest: "f".repeat(64),
		databaseBytes: 1024,
		placementCounts: new Map([
			[
				PLANTED.appId,
				{
					...zeroCounts(),
					unheld: { ...zeroCounts().unheld, "subcase-renumbered": 1 },
					frozenChecked: 1,
				},
			],
		]),
		holders: {
			liveApps: ["app-00"],
			liveSessions: ["9d1e0000-0000-4000-8000-000000000001"],
			settleableApps: [],
			settleableSessions: [],
			unsettledApps: [],
			unsettledSessions: [],
		},
		privateWork: {
			openWorkspaces: 1,
			openChangeSets: 1,
			activeCandidates: 1,
			endingSessions: ["9d1e0000-0000-4000-8000-000000000002"],
			mutationEvents: 2,
			apps: ["app-00"],
		},
	};
}

const LEDGER = {
	horizonApplied: false,
	pendingMigrations: [
		"20261110000000_hq_round_trip_case_writes_publish_placement",
	],
};

function linesOf(
	fleet: ReportFleet,
	mode: CutoverReport["mode"] = "dry-run",
): ReportLine[] {
	const report = new CutoverReport(mode);
	fleetLine(report, fleet, { ledger: LEDGER, planMilliseconds: 12 });
	planSections(report, fleet);
	writerLine(report, {
		stepMilliseconds: { lock: 1, apps: 4 },
		walBytes: 10,
		databaseGrowthBytes: 20,
		migrationsApplied: [...LEDGER.pendingMigrations],
	});
	outcomeLine(report, { outcome: "ok" });
	return [...report.all()];
}

describe("the report's content", () => {
	const fleet = fleetOf();
	const all = linesOf(fleet);

	it("holds no authored string from any fixture, though the plan it reads does", () => {
		const plan = JSON.stringify(fleet.plan.apps);
		// The sentinel reached the plan: the notice carries names, and the
		// planted app carries a case type, a domain and a blocker's places.
		expect(plan).toContain(SENTINEL);
		expect(plan).toContain(SENTINEL_DOMAIN);
		expect(
			fleet.plan.apps.some((app) =>
				app.notice.some(
					(entry) =>
						entry.kind === "document" &&
						entry.entity.nameAtMigration.includes(SENTINEL),
				),
			),
		).toBe(true);
		for (const line of all) {
			const text = JSON.stringify(line).toLowerCase();
			expect(text, `the ${line.section} line`).not.toContain(
				SENTINEL.toLowerCase(),
			);
		}
	});

	it("prints its sections in section 10.3's order, outcome last", () => {
		const order = all.map((line) =>
			REPORT_SECTIONS.indexOf(line.section as never),
		);
		expect(order.every((at) => at >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		expect(all.at(-1)?.section).toBe("outcome");
		for (const line of all) {
			expect(line.report).toBe("hq-round-trip-case-writes");
			expect(line.mode).toBe("dry-run");
		}
	});

	it("counts what the plan holds by cause, kind and code", () => {
		const section = (name: string) => all.find((line) => line.section === name);
		expect(section("structure")).toMatchObject({
			deadCaseListMedia: expect.any(Number),
			overlayEntriesMoved: expect.any(Number),
		});
		expect(
			(section("structure")?.deadCaseListMedia as number) >= 2 &&
				(section("structure")?.overlayEntriesMoved as number) >= 2,
		).toBe(true);
		expect(section("steps")).toMatchObject({
			nonExtensionCarriedCreates: {
				apps: expect.arrayContaining([PLANTED.appId]),
			},
		});
		expect(section("placements")).toMatchObject({
			publishedApps: 2,
			deployments: { readable: 1, unread: 1 },
			unheld: { "subcase-renumbered": 1 },
			frozenChecked: 1,
		});
		const pathMoves = section("path-moves")?.causes as {
			cause: string;
			deployments: number;
			forms: number;
		}[];
		expect(
			pathMoves.find((entry) => entry.cause === "subcase-renumbered"),
		).toMatchObject({
			deployments: expect.any(Number),
			forms: expect.any(Number),
		});
		expect(section("schema")).toMatchObject({
			causes: expect.arrayContaining([
				{
					cause: "capture-link-property",
					apps: expect.any(Number),
					caseTypes: expect.any(Number),
					properties: expect.any(Number),
				},
			]),
		});
		expect(section("holders")).toMatchObject({
			live: 2,
			liveApps: ["app-00"],
			liveSessions: 1,
		});
		expect(section("private-work")).toMatchObject({
			openWorkspaces: 1,
			preAppSessions: 1,
			mutationEvents: 2,
		});
		expect(
			all.find(
				(line) => line.section === "blocker" && line.code === "target-gate",
			),
		).toMatchObject({
			count: expect.any(Number),
			apps: expect.arrayContaining([PLANTED.appId]),
			findingCodes: expect.arrayContaining(["CASE_PROPERTY_UNKNOWN"]),
		});
	});

	it("prints no plan digest in the scan, and the plan's digest otherwise", () => {
		const scan = linesOf(fleet, "scan").find(
			(line) => line.section === "fleet",
		);
		expect(scan?.planDigest).toBeNull();
		expect(all.find((line) => line.section === "fleet")?.planDigest).toBe(
			fleet.plan.digest,
		);
	});
});

describe("the outcome line", () => {
	it("is printed, with the error's class and no text, when the run throws", async () => {
		const printed: ReportLine[] = [];
		const report = new CutoverReport("execute", (line) => printed.push(line));
		const fleet = fleetOf();
		await expect(
			reported(report, async () => {
				fleetLine(report, fleet, { ledger: LEDGER, planMilliseconds: 1 });
				throw new Error(`${SENTINEL} quoted from a stored row`);
			}),
		).rejects.toThrow(SENTINEL);
		expect(printed.map((line) => line.section)).toEqual(["fleet", "outcome"]);
		expect(printed.at(-1)).toEqual({
			report: "hq-round-trip-case-writes",
			mode: "execute",
			section: "outcome",
			outcome: "stopped",
			stoppedBy: ["error"],
			errorClass: "internal",
		});
		expect(JSON.stringify(printed)).not.toContain(SENTINEL);
	});

	it("names the cutover's own stop, a catalog miss and a database error's SQLSTATE", async () => {
		const databaseError = Object.assign(new Error(`${SENTINEL} row text`), {
			code: "40001",
		});
		const wrapped = new Error("the fleet transaction failed", {
			cause: databaseError,
		});
		const catalogMiss = new Error("missing");
		catalogMiss.name = "CatalogObjectMissingError";
		expect(errorClassOf(new CutoverLedgerError("other ledger"))).toBe("ledger");
		expect(errorClassOf(catalogMiss)).toBe("catalog");
		expect(errorClassOf(databaseError)).toBe("database-40001");
		expect(errorClassOf(wrapped)).toBe("database-40001");
		expect(errorClassOf("thrown text")).toBe("internal");
		for (const error of [databaseError, wrapped]) {
			const report = new CutoverReport("rehearse");
			await expect(reported(report, () => Promise.reject(error))).rejects.toBe(
				error,
			);
			expect(report.all().at(-1)).toMatchObject({
				section: "outcome",
				errorClass: "database-40001",
			});
			expect(report.text()).not.toContain(SENTINEL);
		}
	});

	it("is the body's own when the run returns", async () => {
		const report = new CutoverReport("dry-run");
		await reported(report, async () => {
			outcomeLine(report, { outcome: "already-applied" });
		});
		expect(report.all()).toEqual([
			{
				report: "hq-round-trip-case-writes",
				mode: "dry-run",
				section: "outcome",
				outcome: "already-applied",
			},
		]);
	});
});
