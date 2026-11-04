/**
 * The case-writes cutover's plan (step 5's part 09, section 10.2): what the
 * fleet transaction will write, decided from Nova's database alone, and the
 * digest that pins it.
 *
 * Pure: `source.ts` reads the fleet, and `planFleet` runs each app's
 * transform over it (`transform.ts::transformApp`) and assembles the plan,
 * each app's target and what the report and the writer read beside it.
 *
 * The digest covers everything the writer writes and every input that
 * decides it, and nothing in it comes from outside the database: each app's
 * sequence, its raw digest, its target's digest, its changes, its holds,
 * its path moves, its notice entries, its blockers, its planned case-schema
 * differences and whether its private work is discarded; and each published
 * deployment's baseline as its kind, a readable one with its stored digest
 * and the time it was read, so a baseline that moved moves the digest. An
 * unreadable baseline's cause enters through its app's `baseline-unreadable`
 * blocker, whose finding codes name it. Holders are outside the digest: the
 * writer's blocking scan reads them again under its locks. Notice entries
 * carry authored names into the digest as hashed bytes only.
 */

import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import type { HolderCensus } from "./holders";
import type { PlacementCounts } from "./placements";
import type { FleetSource, PrivateWorkCensus, SourceApp } from "./source";
import { transformApp } from "./transform";
import {
	type AppPlan,
	type CaseWritesCutoverPlan,
	type CutoverBlocker,
	compareText,
	PLAN_FORMAT,
	type PublishedDeployment,
} from "./types";

/** What the writer writes for one app the plan does not block. */
export interface PlannedWrite {
	/** The hydrated target `AppPlan.targetDigest` digests. */
	readonly target: BlueprintDoc;
	/** The app as the fleet read gave it: its carriers, read raw, and the
	 *  context every step read, for the writer's placement postcondition. */
	readonly source: SourceApp;
	/** The creates a link carried when step 8 ran, by form, as step 15 read
	 *  them. */
	readonly carriedCreates?: ReadonlyMap<Uuid, ReadonlySet<Uuid>>;
}

/** The plan with everything the scripts, the report and the writer read
 *  beside it. Satisfies `report.ts::ReportFleet`. */
export interface PlannedFleet {
	readonly plan: CaseWritesCutoverPlan;
	/** Every app the plan does not block, by app id. */
	readonly writes: ReadonlyMap<string, PlannedWrite>;
	/** Each app's blockers with their `places`, for `--debug-details` on the
	 *  operator's terminal only; never in the plan, its digest or the report. */
	readonly blockerPlaces: ReadonlyMap<string, readonly CutoverBlocker[]>;
	/** Each app's placement counts, where step 15 ran without a blocker. */
	readonly placementCounts: ReadonlyMap<string, PlacementCounts>;
	readonly privateWork: PrivateWorkCensus;
	readonly holders: HolderCensus;
	readonly appsInFleet: number;
	readonly deletedApps: number;
	readonly fleetSeqDigest: string;
	readonly databaseBytes: number;
}

/** The plan's digest: its format and every app's plan. */
export function caseWritesPlanDigest(
	plan: Pick<CaseWritesCutoverPlan, "format" | "apps">,
): string {
	return canonicalJsonDigest({ format: plan.format, apps: plan.apps });
}

/** Whether any app holds a blocker, which stops every writing mode. */
export function planHasBlockers(plan: Pick<CaseWritesCutoverPlan, "apps">) {
	return plan.apps.some((app) => app.blockers.length > 0);
}

/**
 * Each published deployment's baseline as the plan records it (section
 * 8.1), in the order the fleet read gives them: a readable one with its
 * stored digest and the time it was read, every other one by its kind (an
 * unknown one by why it is unknown).
 */
export function plannedDeploymentsOf(
	deployments: readonly PublishedDeployment[],
): AppPlan["deployments"] {
	return deployments.map((deployment) => {
		const baseline = deployment.baseline;
		if (baseline.kind === "readable")
			return {
				deploymentId: deployment.deploymentId,
				baseline: "readable",
				sourceDigest: baseline.sourceDigest,
				observedAt: baseline.observedAt,
			};
		return {
			deploymentId: deployment.deploymentId,
			baseline: baseline.kind === "unknown" ? baseline.why : baseline.kind,
			sourceDigest: null,
			observedAt: null,
		};
	});
}

/** A blocker as the plan holds it: without its `places`. */
function contentFree(blocker: CutoverBlocker): CutoverBlocker {
	return {
		code: blocker.code,
		count: blocker.count,
		findingCodes: blocker.findingCodes,
	};
}

/**
 * Run every app's transform over the fleet source and assemble the plan,
 * every app in code-point order of id, deleted ones included. Pure.
 */
export function planFleet(source: FleetSource): PlannedFleet {
	const writes = new Map<string, PlannedWrite>();
	const blockerPlaces = new Map<string, readonly CutoverBlocker[]>();
	const placementCounts = new Map<string, PlacementCounts>();
	const ordered = [...source.apps].sort((a, b) =>
		compareText(a.appId, b.appId),
	);
	const apps = ordered.map((app): AppPlan => {
		const result = transformApp(app.raw, app.context);
		if (result.blockers.length > 0)
			blockerPlaces.set(app.appId, result.blockers);
		if (result.placement !== undefined)
			placementCounts.set(app.appId, result.placement.counts);
		const target = result.blockers.length === 0 ? result.target : null;
		if (target !== null)
			writes.set(app.appId, {
				target,
				source: app,
				...(result.placement?.carriedCreates !== undefined && {
					carriedCreates: result.placement.carriedCreates,
				}),
			});
		return {
			appId: app.appId,
			projectId: app.projectId,
			deleted: app.deleted,
			baseSeq: app.baseSeq,
			baseDigest: app.baseDigest,
			targetDigest:
				target === null ? null : canonicalJsonDigest(toPersistableDoc(target)),
			deployments: plannedDeploymentsOf(app.context.deployments),
			changes: result.changes,
			held: result.held,
			pathMoves: result.pathMoves,
			notice: result.notice,
			blockers: result.blockers.map(contentFree),
			schemaChanges: result.schemaChanges,
			discardsPrivateWork: result.discardsPrivateWork,
		};
	});
	const withoutDigest = { format: PLAN_FORMAT, apps } as const;
	return {
		plan: { ...withoutDigest, digest: caseWritesPlanDigest(withoutDigest) },
		writes,
		blockerPlaces,
		placementCounts,
		privateWork: source.privateWork,
		holders: source.holders,
		appsInFleet: source.appsInFleet,
		deletedApps: source.deletedApps,
		fleetSeqDigest: source.fleetSeqDigest,
		databaseBytes: source.databaseBytes,
	};
}
