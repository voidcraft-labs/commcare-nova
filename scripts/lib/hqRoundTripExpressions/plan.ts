/**
 * The expressions cutover's plan: what the fleet transaction will write,
 * decided from Nova's own database alone, and the digest that pins it
 * (part 09 §3, "The plan and its digest").
 *
 * Pure: `./fleet.ts` reads the fleet source from the database, then
 * `transformFleet` runs each app's transform over it and
 * `assemblePlannedFleet` selects the no-write lines (`./behavior.ts`) and
 * assembles the plan, its targets and its notice rows.
 *
 * The digest covers every field of the plan. Nothing in it comes from
 * outside the database, so over a quiescent database it cannot move: a
 * moved digest means a document, a holder or a deployment moved.
 */

import { createHash } from "node:crypto";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import type { LookupTableDefinition } from "@/lib/lookup/types";
import type { MigrationNoticeEntry } from "@/lib/notices/migrationNotice";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	behaviorChanges,
	type DeploymentChange,
	deploymentChanges,
	hasEntryPoints,
	schemaChangeKey,
} from "./behavior";
import type { HolderCensus } from "./holders";
import { appNoticeEntries } from "./notice";
import {
	type RawCarriers,
	type RawDocument,
	rawDocumentDigest,
} from "./oldShape";
import type { SchemaChangeImpact } from "./schemaPlan";
import type {
	BlockerPlace,
	CutoverBlocker,
	DocumentChange,
	PlannedSchemaChange,
	StepClassCount,
	TransformApp,
	TransformContext,
} from "./types";

export const CUTOVER = "hq-round-trip-expressions";
export const MARKER_BATCH_ID = "fold-baseline:hq-round-trip-expressions";
export const MARKER_ACTOR_ID = "system:hq-round-trip-expressions";
export const PLAN_FORMAT = "hq-round-trip-expressions-1";

// ── The plan ────────────────────────────────────────────────────────

/** One deployment of an app with a live `app` mapping. */
export interface PlannedDeployment {
	readonly deploymentId: string;
	readonly server: string;
	readonly domain: string;
	/** The target has an entry point, so the horizon's `+1` makes its manifest stale. */
	readonly hasEntryPoints: boolean;
}

export interface AppPlan {
	readonly appId: string;
	readonly projectId: string;
	/** `apps.mutation_seq` as read. */
	readonly baseSeq: number;
	/** `rawDocumentDigest` of the raw carriers as read. */
	readonly baseDigest: string;
	/**
	 * `canonicalJsonDigest` of the parsed and hydrated target, stripped to
	 * what persists (`toPersistableDoc`); empty where the target does not
	 * parse, which is a `target-parse` blocker.
	 */
	readonly targetDigest: string;
	/** The steps' entries in step order, then behavior.ts's. */
	readonly changes: readonly DocumentChange[];
	/** Content-free, one per code met, in `CUTOVER_BLOCKER_CODES` order. */
	readonly blockers: readonly CutoverBlocker[];
	readonly schemaChanges: readonly PlannedSchemaChange[];
	/** An open workspace or change set of this app is abandoned. */
	readonly discardsPrivateWork: boolean;
	/** Ordered by deployment id. */
	readonly deployments: readonly PlannedDeployment[];
}

export interface ExpressionsCutoverPlan {
	readonly format: typeof PLAN_FORMAT;
	/** Ordered by app id. */
	readonly apps: readonly AppPlan[];
	/** `canonicalJsonDigest` of every field above. */
	readonly digest: string;
}

/** The plan's digest: every field of every app, and the format. */
export function expressionsPlanDigest(
	plan: Omit<ExpressionsCutoverPlan, "digest">,
): string {
	return canonicalJsonDigest({
		format: plan.format,
		apps: plan.apps.map((app) => ({
			appId: app.appId,
			projectId: app.projectId,
			baseSeq: app.baseSeq,
			baseDigest: app.baseDigest,
			targetDigest: app.targetDigest,
			changes: app.changes,
			blockers: app.blockers,
			schemaChanges: app.schemaChanges,
			discardsPrivateWork: app.discardsPrivateWork,
			deployments: app.deployments.map((deployment) => ({
				deploymentId: deployment.deploymentId,
				server: deployment.server,
				domain: deployment.domain,
				hasEntryPoints: deployment.hasEntryPoints,
			})),
		})),
	});
}

/** Whether any app holds a blocker, which stops every writing mode. */
export function planHasBlockers(plan: ExpressionsCutoverPlan): boolean {
	return plan.apps.some((app) => app.blockers.length > 0);
}

/** One app's deployment lines, from its plan alone. */
export function appDeploymentChanges(app: AppPlan): DeploymentChange[] {
	return deploymentChanges(
		app.deployments,
		app.changes,
		app.deployments.some((deployment) => deployment.hasEntryPoints),
	);
}

// ── The fleet source ────────────────────────────────────────────────

/** One deployment that holds a live `app` mapping. */
export interface SourceDeployment {
	readonly deploymentId: string;
	readonly server: string;
	readonly domain: string;
}

export interface SourceApp {
	readonly appId: string;
	readonly projectId: string;
	readonly baseSeq: number;
	readonly deleted: boolean;
	readonly carriers: RawCarriers;
	readonly raw: RawDocument;
	readonly discardsPrivateWork: boolean;
	/** Each active `case_type_schemas` row: case type to schema as stored text. */
	readonly storedCaseSchemas: ReadonlyMap<string, string>;
	/** Per case type, per property key, the app's `cases` rows holding it. */
	readonly storedCaseKeys: ReadonlyMap<string, ReadonlyMap<string, number>>;
	/** Ordered by deployment id. */
	readonly deployments: readonly SourceDeployment[];
}

export interface SourceProject {
	readonly projectId: string;
	/** Every lookup table definition of the Project, rows-free. */
	readonly lookupContext: LookupValidationContext & { kind: "available" };
	/** The Project's media assets and every built-in icon, by id. */
	readonly mediaAssets: TransformContext["mediaAssets"];
}

/** The open private work the cutover abandons, fleet-wide. */
export interface PrivateWorkCensus {
	readonly openWorkspaces: number;
	readonly openChangeSets: number;
	readonly activeCandidates: number;
	/** Active pre-app build sessions that hold open work, which the cutover ends. */
	readonly endingSessions: readonly string[];
}

export interface FleetSource {
	/** Ordered by app id; one app under `--app`. */
	readonly apps: readonly SourceApp[];
	readonly projects: ReadonlyMap<string, SourceProject>;
	readonly privateWork: PrivateWorkCensus;
	readonly holders: HolderCensus;
	/** Every app, deleted ones included, whatever `--app` names. */
	readonly appsInFleet: number;
	readonly deletedApps: number;
	/** sha256 of every app's `[id, mutation_seq]`, as the base emitter digests it. */
	readonly fleetSeqDigest: string;
	readonly databaseBytes: number;
}

/**
 * The fleet's sequence digest, the base emitter's framing exactly: every
 * app's `[id, mutation_seq]` in code-point order of id, deleted apps
 * included, as JSON, through sha256.
 */
export function fleetSeqDigestOf(
	apps: readonly { readonly id: string; readonly seq: number }[],
): string {
	const sequences = [...apps]
		.sort((a, b) => compareText(a.id, b.id))
		.map((app) => [app.id, app.seq]);
	return createHash("sha256").update(JSON.stringify(sequences)).digest("hex");
}

// ── Planning ────────────────────────────────────────────────────────

/** Per-app facts the report prints and the digest does not cover. */
export interface AppPlanDetail {
	readonly appId: string;
	readonly deleted: boolean;
	/** Every class tally of the transform, zero counts left out. */
	readonly classes: readonly StepClassCount[];
	/** Each blocker's authored places, for `--debug-details` only. */
	readonly places: readonly BlockerPlace[];
	/** What each planned schema change meets in the stored cases. */
	readonly schemaImpacts: readonly SchemaChangeImpact[];
}

/** One app's transform, before the database tells what its schema changes meet. */
export interface TransformedApp {
	readonly source: SourceApp;
	readonly result: ReturnType<TransformApp>;
	/** The parsed and hydrated target; absent where it does not parse. */
	readonly target: BlueprintDoc | undefined;
}

/** The plan with everything the scripts, the report and the writer read beside it. */
export interface PlannedFleet {
	readonly plan: ExpressionsCutoverPlan;
	/** The hydrated target of every app whose target parses, by app id. */
	readonly targets: ReadonlyMap<string, BlueprintDoc>;
	/** The notice entries of every app that gets a notice row, by app id. */
	readonly noticeEntries: ReadonlyMap<string, readonly MigrationNoticeEntry[]>;
	readonly apps: readonly AppPlanDetail[];
	/** Each Project's lookup context, as the plan judged its targets. */
	readonly lookupContexts: ReadonlyMap<string, LookupValidationContext>;
	/** Each Project's media manifest, as the plan judged export readiness. */
	readonly mediaManifests: ReadonlyMap<string, TransformContext["mediaAssets"]>;
	/** Each Project's lookup definitions, for the census's head emission. */
	readonly lookupDefinitions: ReadonlyMap<
		string,
		readonly LookupTableDefinition[]
	>;
	readonly privateWork: PrivateWorkCensus;
	readonly holders: HolderCensus;
	readonly appsInFleet: number;
	readonly deletedApps: number;
	readonly fleetSeqDigest: string;
	readonly databaseBytes: number;
}

function projectOf(source: FleetSource, app: SourceApp): SourceProject {
	const project = source.projects.get(app.projectId);
	if (project === undefined)
		throw new Error(
			`App ${app.appId} belongs to Project ${app.projectId}, which the fleet read holds no lookup definitions or media for. Build the plan again from one read.`,
		);
	return project;
}

/** Run every app's transform over the fleet source. Pure. */
export function transformFleet(
	source: FleetSource,
	transform: TransformApp,
): TransformedApp[] {
	return source.apps.map((app) => {
		const project = projectOf(source, app);
		const result = transform(app.carriers, {
			appId: app.appId,
			projectId: app.projectId,
			lookupContext: project.lookupContext,
			mediaAssets: project.mediaAssets,
			storedCaseSchemas: app.storedCaseSchemas,
			storedCaseKeys: app.storedCaseKeys,
		});
		return {
			source: app,
			result,
			target:
				result.target === undefined
					? undefined
					: hydratePersistedBlueprint(result.target),
		};
	});
}

/**
 * Assemble the plan from the transforms and what each app's schema changes
 * meet in the stored cases. Pure: the behavior selections read the targets,
 * the notice rows read the plan.
 */
export function assemblePlannedFleet(
	source: FleetSource,
	transformed: readonly TransformedApp[],
	impacts: ReadonlyMap<string, readonly SchemaChangeImpact[]>,
): PlannedFleet {
	const targets = new Map<string, BlueprintDoc>();
	const noticeEntries = new Map<string, readonly MigrationNoticeEntry[]>();
	const details: AppPlanDetail[] = [];
	const apps = transformed.map(({ source: app, result, target }): AppPlan => {
		const project = projectOf(source, app);
		const appImpacts = impacts.get(app.appId) ?? [];
		const parked = new Map(
			appImpacts.map((impact) => [
				schemaChangeKey(impact.change),
				impact.uncastable,
			]),
		);
		const behavior =
			target === undefined
				? []
				: behaviorChanges({
						appName: app.raw.appName,
						target,
						context: {
							lookupDefinitions: project.lookupContext.definitions,
						},
						schemaChanges: result.schemaChanges,
						parked,
						discardsPrivateWork: app.discardsPrivateWork,
					});
		if (target !== undefined) targets.set(app.appId, target);
		const entryPoints = target !== undefined && hasEntryPoints(target);
		const plan: AppPlan = {
			appId: app.appId,
			projectId: app.projectId,
			baseSeq: app.baseSeq,
			baseDigest: rawDocumentDigest(app.raw),
			targetDigest:
				target === undefined
					? ""
					: canonicalJsonDigest(toPersistableDoc(target)),
			changes: [...result.changes, ...behavior],
			blockers: result.blockers,
			schemaChanges: result.schemaChanges,
			discardsPrivateWork: app.discardsPrivateWork,
			deployments: app.deployments.map((deployment) => ({
				deploymentId: deployment.deploymentId,
				server: deployment.server,
				domain: deployment.domain,
				hasEntryPoints: entryPoints,
			})),
		};
		const entries = appNoticeEntries(plan);
		if (entries.length > 0) noticeEntries.set(app.appId, entries);
		details.push({
			appId: app.appId,
			deleted: app.deleted,
			classes: result.classes,
			places: result.places,
			schemaImpacts: appImpacts,
		});
		return plan;
	});
	const withoutDigest = { format: PLAN_FORMAT, apps } as const;
	return {
		plan: { ...withoutDigest, digest: expressionsPlanDigest(withoutDigest) },
		targets,
		noticeEntries,
		apps: details,
		lookupContexts: new Map(
			[...source.projects].map(([id, project]) => [id, project.lookupContext]),
		),
		mediaManifests: new Map(
			[...source.projects].map(([id, project]) => [id, project.mediaAssets]),
		),
		lookupDefinitions: new Map(
			[...source.projects].map(([id, project]) => [
				id,
				project.lookupContext.definitions,
			]),
		),
		privateWork: source.privateWork,
		holders: source.holders,
		appsInFleet: source.appsInFleet,
		deletedApps: source.deletedApps,
		fleetSeqDigest: source.fleetSeqDigest,
		databaseBytes: source.databaseBytes,
	};
}

/** Code-point order, so nothing depends on the database's collation. */
function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
