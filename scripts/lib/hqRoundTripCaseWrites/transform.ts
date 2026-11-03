/**
 * The case-writes cutover's transform of one app (part 09 §7): pure, from
 * the app's carriers as read and what the fleet read gives beside them to
 * the target, its content-free changes, its holds, its path moves, its
 * notice entries, its blockers and its planned case-schema differences.
 *
 * The order is the table's: the structure phase over raw JSON (steps 1 to
 * 5), the head parse, the semantic steps 6 to 13 over the parsed document,
 * the placement step 14, the judgement 15, then the deployment lines 16,
 * which write nothing. A blocker stops the transform at its step: the plan
 * has no target for the app, and the app is still judged over the document
 * the steps before it left, so it is reported with every other blocker the
 * judgement can still find. The judgement's idempotence check runs only over
 * a target every step made, and its inner run judges nothing.
 */

import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import type {
	DeploymentNoticeEntry,
	DocumentNoticeEntry,
	MigrationNoticeEntry,
} from "@/lib/notices/migrationNotice";
import { deploymentLines } from "./deployments";
import { judge } from "./judge";
import { entriesForApp } from "./notice";
import type { RawDocument } from "./oldShape";
import { placements } from "./placements";
import type { StepResult } from "./steps/apply";
import { explicitPreloadsStep } from "./steps/explicitPreloads";
import { extensionChildren } from "./steps/extensionChildren";
import { fieldListFlagsStep } from "./steps/fieldListFlags";
import { formLinkSemantics } from "./steps/formLinkSemantics";
import { queryRepeatPlacementStep } from "./steps/queryRepeatPlacement";
import { repeatCountsStep } from "./steps/repeatCounts";
import { searchWorkflowStep } from "./steps/searchWorkflow";
import { writesIntoOperations } from "./steps/writesIntoOperations";
import { parseHead, structurePhase } from "./structure";
import {
	type AppTransform,
	BLOCKER_CODES,
	type CutoverBlocker,
	compareText,
	type HeldUnit,
	type LiftedFacts,
	type PlannedChange,
	type PlannedSchemaChange,
	type StepContext,
} from "./types";

export type { AppTransform, StepContext };

/** Blockers merged by code, in the registry's order. */
function inRegistryOrder(
	blockers: readonly CutoverBlocker[],
): readonly CutoverBlocker[] {
	const merged = new Map<CutoverBlocker["code"], CutoverBlocker>();
	for (const blocker of blockers) {
		const prior = merged.get(blocker.code);
		if (prior === undefined) {
			merged.set(blocker.code, blocker);
			continue;
		}
		const places = [...(prior.places ?? []), ...(blocker.places ?? [])];
		merged.set(blocker.code, {
			code: blocker.code,
			count: prior.count + blocker.count,
			findingCodes: [
				...new Set([...prior.findingCodes, ...blocker.findingCodes]),
			].sort(compareText),
			...(places.length > 0 && { places }),
		});
	}
	return BLOCKER_CODES.flatMap((code) => {
		const blocker = merged.get(code);
		return blocker === undefined ? [] : [blocker];
	});
}

/** The creates step 8 found a link carrying, by form, for step 14. */
function carriedCreatesByForm(
	doc: BlueprintDoc,
	carried: ReadonlySet<Uuid>,
): ReadonlyMap<Uuid, ReadonlySet<Uuid>> {
	const byForm = new Map<Uuid, ReadonlySet<Uuid>>();
	for (const [formUuid, form] of Object.entries(doc.forms) as [
		Uuid,
		BlueprintDoc["forms"][Uuid],
	][])
		byForm.set(
			formUuid,
			new Set(
				(form.caseOperations ?? []).flatMap((operation) =>
					carried.has(operation.uuid) ? [operation.uuid] : [],
				),
			),
		);
	return byForm;
}

/** What the transform keeps as it runs. */
interface Collected {
	readonly changes: PlannedChange[];
	readonly documents: DocumentNoticeEntry[];
	readonly blockers: CutoverBlocker[];
}

function collect(into: Collected, step: StepResult): void {
	into.changes.push(...step.changes);
	into.documents.push(...documentLines(step.notice));
	into.blockers.push(...step.blockers);
}

function documentLines(
	notice: readonly MigrationNoticeEntry[],
): DocumentNoticeEntry[] {
	return notice.filter(
		(entry): entry is DocumentNoticeEntry => entry.kind === "document",
	);
}

function deploymentEntries(
	notice: readonly MigrationNoticeEntry[],
): DeploymentNoticeEntry[] {
	return notice.filter(
		(entry): entry is DeploymentNoticeEntry => entry.kind === "deployment",
	);
}

/** Steps 6 to 13 in their order, each over the document the one before it
 *  left; the first that meets a blocker stops the run there. */
function semanticSteps(
	doc: BlueprintDoc,
	facts: LiftedFacts,
	ctx: StepContext,
	into: Collected,
): {
	readonly doc: BlueprintDoc;
	readonly stopped: boolean;
	readonly carriedCreates?: ReadonlySet<Uuid>;
} {
	const operations = writesIntoOperations(doc, facts);
	collect(into, operations);
	if (operations.blockers.length > 0)
		return { doc: operations.doc, stopped: true };
	const links = formLinkSemantics(operations.doc);
	collect(into, links);
	if (links.blockers.length > 0) return { doc: links.doc, stopped: true };
	const extension = extensionChildren(links.doc);
	collect(into, extension);
	if (extension.blockers.length > 0)
		return { doc: extension.doc, stopped: true };
	const later: ((doc: BlueprintDoc) => StepResult)[] = [
		(next) => explicitPreloadsStep(next, facts),
		(next) => searchWorkflowStep(next, facts),
		(next) => queryRepeatPlacementStep(next),
		(next) => repeatCountsStep(next, ctx),
		(next) => fieldListFlagsStep(next, facts),
	];
	let current = extension.doc;
	for (const step of later) {
		const result = step(current);
		collect(into, result);
		if (result.blockers.length > 0) return { doc: result.doc, stopped: true };
		current = result.doc;
	}
	return {
		doc: current,
		stopped: false,
		carriedCreates: extension.carriedCreates,
	};
}

/**
 * The run behind `transformApp`. `judged` false is the judgement's own
 * inner run, which asks only what the steps do to the target: it judges
 * nothing, since a document the steps leave unchanged is the one the outer
 * run already judged, and its structure phase can no longer lift what the
 * first run read (an attachment write's mode, for one).
 */
function run(
	raw: RawDocument,
	ctx: StepContext,
	judged: boolean,
): AppTransform {
	const into: Collected = { changes: [], documents: [], blockers: [] };
	const stopped = (
		schemaChanges: readonly PlannedSchemaChange[] = [],
	): AppTransform => ({
		target: null,
		changes: into.changes,
		held: [],
		pathMoves: [],
		notice: [],
		blockers: inRegistryOrder(into.blockers),
		schemaChanges,
		discardsPrivateWork: ctx.discardsPrivateWork,
	});
	/** The judgement over a document a blocker left: every blocker it can
	 *  still find, idempotence aside. */
	const judgedStop = (doc: BlueprintDoc, facts: LiftedFacts): AppTransform => {
		if (!judged) return stopped();
		const judgement = judge({ target: doc, ctx, facts });
		into.blockers.push(...judgement.blockers);
		return stopped(judgement.schemaChanges);
	};

	// Steps 1 to 5, then the head parse.
	const structure = structurePhase(raw);
	into.changes.push(...structure.changes);
	into.documents.push(...documentLines(structure.notice));
	into.blockers.push(...structure.blockers);
	const head = parseHead(ctx.appId, structure.persisted);
	if (!head.ok) {
		into.blockers.push(head.blocker);
		return stopped();
	}
	const facts = structure.facts;
	if (structure.blockers.length > 0) return judgedStop(head.doc, facts);

	// Steps 6 to 13.
	const semantic = semanticSteps(head.doc, facts, ctx, into);
	if (semantic.stopped) return judgedStop(semantic.doc, facts);

	// Step 14.
	const placed = placements({
		raw,
		target: semantic.doc,
		facts,
		deployments: ctx.deployments,
		mutationSeq: ctx.mutationSeq,
		...(semantic.carriedCreates !== undefined && {
			carriedCreates: carriedCreatesByForm(
				semantic.doc,
				semantic.carriedCreates,
			),
		}),
	});
	into.changes.push(...placed.changes);
	into.blockers.push(...placed.blockers);
	if (placed.blockers.length > 0) return judgedStop(placed.target, facts);
	const target = placed.target;

	// Step 15.
	const judgement = judged
		? judge({
				target,
				ctx,
				facts,
				rerun: (again: RawDocument) => run(again, ctx, false),
			})
		: { blockers: [], schemaChanges: [] };
	if (judgement.blockers.length > 0) {
		into.blockers.push(...judgement.blockers);
		return stopped(judgement.schemaChanges);
	}

	// Step 16, which the inner run has no use for.
	if (!judged)
		return {
			target,
			changes: into.changes,
			held: placed.held,
			pathMoves: [],
			notice: [],
			blockers: [],
			schemaChanges: [],
			discardsPrivateWork: ctx.discardsPrivateWork,
		};
	const lines = deploymentLines({
		raw,
		target,
		facts,
		units: placed.units,
		live: ctx.liveDeployments,
		published: ctx.deployments,
		documentNotice: into.documents,
		...(ctx.lookupContext.kind === "available" && {
			lookupNaming: lookupWireNaming(ctx.lookupContext.definitions),
		}),
	});
	const held: readonly HeldUnit[] = placed.held;
	return {
		target,
		changes: into.changes,
		held,
		pathMoves: lines.pathMoves,
		notice: entriesForApp({
			appName: target.appName,
			deployments: deploymentEntries(lines.notice),
			documents: into.documents,
			discardsPrivateWork: ctx.discardsPrivateWork,
		}),
		blockers: [],
		schemaChanges: judgement.schemaChanges,
		discardsPrivateWork: ctx.discardsPrivateWork,
	};
}

/** Every step of part 09 §7 over one app's carriers as read. */
export function transformApp(raw: RawDocument, ctx: StepContext): AppTransform {
	return run(raw, ctx, true);
}

/**
 * Step `judge-target` alone, over any target: the blockers it finds, empty
 * where the target is clean. `raw` gives the facts the structure phase
 * lifts from the app as read, which the case-schema comparison reads.
 */
export function judgeTarget(
	raw: RawDocument,
	target: BlueprintDoc,
	ctx: StepContext,
): readonly CutoverBlocker[] {
	const { facts } = structurePhase(raw);
	return inRegistryOrder(
		judge({
			target,
			ctx,
			facts,
			rerun: (again) => run(again, ctx, false),
		}).blockers,
	);
}
