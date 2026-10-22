/**
 * The notice lines for changes the cutover writes nothing for (part 09 §6):
 * what a worker, a search or the case store does differently with no stored
 * change. One exported selection per reason, each reading the lifted target
 * (or the plan's facts about the app's private work, schema changes and
 * deployments). None is a step and none changes the document.
 *
 * Each document selection reads the same trees the head emitter reads, in
 * the contexts it reads them in: a search's clauses through
 * `composeXPathQueryClauses`, the same composition the suite's
 * `_xpath_query` is printed from, and a device slot's comparisons through
 * `instantOperand.ts::comparisonPlan`, the one classification the on-device
 * emitter lowers by. A miss here leaves a file the census cannot explain,
 * which stops the cutover rather than passing silently.
 */

import { moduleExpressionContexts } from "@/lib/commcare/expressionContext";
import { moduleCaseTypeForActions } from "@/lib/commcare/formLinkProjection";
import {
	type LookupWireNaming,
	lookupTypeIndexFromNaming,
	lookupWireNaming,
} from "@/lib/commcare/lookup/naming";
import { composeXPathQueryClauses } from "@/lib/commcare/suite/case-search/xpathQuery";
import {
	type BlueprintDoc,
	effectiveCaseSearchConfig,
	type Uuid,
} from "@/lib/domain";
import { entryPointInventory } from "@/lib/domain/entryPoints";
import { term as termExpression } from "@/lib/domain/expression/builders";
import {
	type ExpressionContext,
	slotContext,
} from "@/lib/domain/expression/context";
import { isCsqlQueryAnchor } from "@/lib/domain/expression/csqlPositions";
import {
	comparisonOperands,
	comparisonPlan,
	type InstantComparisonKind,
	type InstantOperand,
	instantOperand,
} from "@/lib/domain/expression/instantOperand";
import {
	expressionContextAtPath,
	scalarDataType,
	typeOf,
} from "@/lib/domain/expression/typeChecker";
import type { Expression } from "@/lib/domain/expression/types";
import { walkExpressionNodes } from "@/lib/domain/expression/walk";
import { formOfField } from "@/lib/domain/fieldForm";
import { ownRecordValue } from "@/lib/domain/records";
import {
	type ExpressionCarrierRef,
	expressionSlotValues,
} from "@/lib/domain/referenceSlots";
import { SYSTEM_DATETIME_CASE_PROPERTIES } from "@/lib/domain/standardCaseProperties";
import type { LookupTableDefinition } from "@/lib/lookup/types";
import type {
	DEPLOYMENT_NOTICE_REASONS,
	DocumentNoticeReason,
} from "@/lib/notices/migrationNotice";
import type { DocumentChange, PlannedSchemaChange } from "./types";

/** The Project facts a document selection reads beside the target. */
export interface BehaviorContext {
	/** The Project's rows-free lookup definitions, as the emitter names them. */
	readonly lookupDefinitions: readonly LookupTableDefinition[];
}

function naming(context: BehaviorContext): LookupWireNaming {
	return lookupWireNaming(context.lookupDefinitions);
}

// ── Searches ────────────────────────────────────────────────────────

/**
 * Each module whose search HQ runs, with the clauses its `_xpath_query`
 * sends, each in its own slot's context: the gates `expandDoc` reads (an
 * effective Search on a module whose cases land) and the composition the
 * suite prints (`lib/commcare/distanceSearches.ts` reads the same).
 */
function searchClauses(
	target: BlueprintDoc,
	context: BehaviorContext,
): {
	readonly moduleUuid: Uuid;
	readonly clauses: readonly {
		readonly expression: Expression;
		readonly context: ExpressionContext;
	}[];
}[] {
	const lookupNaming = naming(context);
	return target.moduleOrder.flatMap((moduleUuid) => {
		const module = ownRecordValue(target.modules, moduleUuid);
		if (module?.caseListConfig === undefined) return [];
		if (effectiveCaseSearchConfig(module) === undefined) return [];
		if (moduleCaseTypeForActions(target, moduleUuid) === "") return [];
		const clauses =
			composeXPathQueryClauses(
				module.caseListConfig,
				module.caseType,
				moduleExpressionContexts(target, moduleUuid, lookupNaming),
			) ?? [];
		return clauses.length === 0 ? [] : [{ moduleUuid, clauses }];
	});
}

function moduleChange(
	target: BlueprintDoc,
	reason: DocumentNoticeReason,
	moduleUuid: Uuid,
): DocumentChange {
	return {
		reason,
		entity: {
			type: "module",
			uuid: moduleUuid,
			nameAtMigration: ownRecordValue(target.modules, moduleUuid)?.name ?? "",
		},
	};
}

/**
 * `search-today-is-workers-day` (part 06 §3.4): each module whose effective
 * `_xpath_query` reads `today`. Every `today` in a CSQL slot is a runtime
 * segment the device works out, so any `today` in the clauses is one.
 */
export function searchTodayIsWorkersDay(
	target: BlueprintDoc,
	context: BehaviorContext,
): DocumentChange[] {
	return searchClauses(target, context).flatMap(({ moduleUuid, clauses }) => {
		let reads = false;
		for (const clause of clauses)
			walkExpressionNodes(clause.expression, (node) => {
				if (node.kind === "today") reads = true;
			});
		return reads
			? [moduleChange(target, "search-today-is-workers-day", moduleUuid)]
			: [];
	});
}

/**
 * Whether an equality on `anchor` is HQ's closed instant range (part 06
 * §3.13): a custom date-and-time property in any CSQL slot, a system date
 * and time only where no device evaluates the slot. The rule
 * `lib/commcare/csql/emitter.ts::readsInstantByRange` emits by.
 */
function equalityReadsInstantRange(
	anchor: Expression,
	ctx: ExpressionContext,
): boolean {
	if (anchor.kind !== "term" || anchor.term.kind !== "prop") return false;
	if (scalarDataType(typeOf(anchor, ctx)?.data) !== "datetime") return false;
	if (!SYSTEM_DATETIME_CASE_PROPERTIES.has(anchor.term.property)) return true;
	return !ctx.profile.targets.has("SU") && !ctx.profile.targets.has("XF");
}

/**
 * `search-date-time-equality-matches` (part 06 §3.13): each module whose
 * effective `_xpath_query` holds `eq`, `neq` or `in` on a date-and-time
 * anchor, which the head emitter sends as a closed instant range.
 */
export function searchDateTimeEqualityMatches(
	target: BlueprintDoc,
	context: BehaviorContext,
): DocumentChange[] {
	return searchClauses(target, context).flatMap(({ moduleUuid, clauses }) => {
		let holds = false;
		for (const clause of clauses)
			walkExpressionNodes(clause.expression, (node, path) => {
				if (holds) return;
				const anchors =
					node.kind === "eq" || node.kind === "neq"
						? [node.left, node.right].filter(isCsqlQueryAnchor)
						: node.kind === "in"
							? [node.left].filter(isCsqlQueryAnchor)
							: [];
				if (anchors.length === 0) return;
				const at = expressionContextAtPath(
					clause.expression,
					clause.context,
					path,
				);
				if (anchors.some((anchor) => equalityReadsInstantRange(anchor, at)))
					holds = true;
			});
		return holds
			? [moduleChange(target, "search-date-time-equality-matches", moduleUuid)]
			: [];
	});
}

// ── Comparisons a device now makes by the moment ────────────────────

const ORDERINGS: ReadonlySet<string> = new Set(["lt", "lte", "gt", "gte"]);

/**
 * Whether an expression a device evaluates holds a comparison the on-device
 * emitter lowers to instants (`comparisonPlan` is `lowered`): an ordering,
 * `=` or `!=` with each side's literals typed as the form rule set types
 * them, and each `in` member, `between` bound and `switch` case against its
 * subject, as `lib/commcare/xpath/wire/fromExpression.ts` compares them.
 */
function holdsLoweredComparison(
	root: Expression,
	slot: ExpressionContext,
): boolean {
	let lowered = false;
	walkExpressionNodes(root, (node, path) => {
		if (lowered) return;
		const pairs: [InstantComparisonKind, InstantOperand, InstantOperand][] = [];
		const at = () => expressionContextAtPath(root, slot, path);
		if (node.kind === "eq" || node.kind === "neq" || ORDERINGS.has(node.kind)) {
			const comparison = node as Extract<
				Expression,
				{ kind: InstantComparisonKind }
			>;
			const { left, right } = comparisonOperands(comparison, at());
			pairs.push([comparison.kind, left, right]);
		} else if (node.kind === "in") {
			const ctx = at();
			const left = instantOperand(node.left, ctx);
			for (const value of node.values)
				pairs.push(["eq", left, instantOperand(termExpression(value), ctx)]);
		} else if (node.kind === "between") {
			const ctx = at();
			const left = instantOperand(node.left, ctx);
			if (node.lower !== undefined)
				pairs.push([
					node.lowerInclusive ? "gte" : "gt",
					left,
					instantOperand(node.lower, ctx),
				]);
			if (node.upper !== undefined)
				pairs.push([
					node.upperInclusive ? "lte" : "lt",
					left,
					instantOperand(node.upper, ctx),
				]);
		} else if (node.kind === "switch") {
			const ctx = at();
			const on = instantOperand(node.on, ctx);
			for (const entry of node.cases)
				pairs.push(["eq", on, instantOperand(termExpression(entry.when), ctx)]);
		}
		if (
			pairs.some(
				([kind, left, right]) =>
					comparisonPlan(kind, left, right) === "lowered",
			)
		)
			lowered = true;
	});
	return lowered;
}

/** Every owner of expression slots, in document order: modules, then each module's forms, each form's fields. */
function expressionOwners(target: BlueprintDoc): ExpressionCarrierRef[] {
	const owners: ExpressionCarrierRef[] = [];
	const fields = (parent: Uuid) => {
		for (const uuid of target.fieldOrder[parent] ?? []) {
			if (ownRecordValue(target.fields, uuid) === undefined) continue;
			owners.push({ entity: "field", uuid });
			fields(uuid);
		}
	};
	for (const moduleUuid of target.moduleOrder) {
		if (ownRecordValue(target.modules, moduleUuid) === undefined) continue;
		owners.push({ entity: "module", uuid: moduleUuid });
		for (const formUuid of target.formOrder[moduleUuid] ?? []) {
			if (ownRecordValue(target.forms, formUuid) === undefined) continue;
			owners.push({ entity: "form", uuid: formUuid });
			fields(formUuid);
		}
	}
	return owners;
}

/**
 * `date-time-comparison-compares-moments` (finding 56): each entity with a
 * slot a device evaluates (its targets hold `XF` or `SU`) that holds a
 * comparison of two dates and times the lowering rewrites. One line per
 * entity and target: a field's (with `detail.form`, its form's name) sits in
 * the form's XForm (`detail.target` `xform`); a form's or a module's sits in
 * the XForm where the slot is the form's own, or in the app's menus
 * (`suite`).
 */
export function dateTimeComparisonComparesMoments(
	target: BlueprintDoc,
	context: BehaviorContext,
): DocumentChange[] {
	const lookupTypes = lookupTypeIndexFromNaming(naming(context)) ?? new Map();
	const changes: DocumentChange[] = [];
	for (const owner of expressionOwners(target)) {
		const targets = new Set<"xform" | "suite">();
		for (const { ref, expression } of expressionSlotValues(target, owner)) {
			const ctx = slotContext(target, ref, lookupTypes);
			if (ctx === undefined) continue;
			const xform = ctx.profile.targets.has("XF");
			const suite = ctx.profile.targets.has("SU");
			if (!xform && !suite) continue;
			if (!holdsLoweredComparison(expression, ctx)) continue;
			targets.add(xform ? "xform" : "suite");
		}
		for (const where of ["xform", "suite"] as const) {
			if (!targets.has(where)) continue;
			changes.push(comparisonChange(target, owner, where));
		}
	}
	return changes;
}

function comparisonChange(
	target: BlueprintDoc,
	owner: ExpressionCarrierRef,
	where: "xform" | "suite",
): DocumentChange {
	const reason = "date-time-comparison-compares-moments";
	switch (owner.entity) {
		case "field": {
			const field = ownRecordValue(target.fields, owner.uuid);
			const formUuid = formOfField(target, owner.uuid);
			const form =
				formUuid === undefined
					? undefined
					: ownRecordValue(target.forms, formUuid);
			return {
				reason,
				entity: {
					type: "field",
					uuid: owner.uuid,
					nameAtMigration: field?.id ?? "",
				},
				detail: {
					...(form === undefined ? {} : { form: form.name }),
					target: where,
				},
			};
		}
		case "form":
			return {
				reason,
				entity: {
					type: "form",
					uuid: owner.uuid,
					nameAtMigration: ownRecordValue(target.forms, owner.uuid)?.name ?? "",
				},
				detail: { target: where },
			};
		case "module":
			return {
				reason,
				entity: {
					type: "module",
					uuid: owner.uuid,
					nameAtMigration:
						ownRecordValue(target.modules, owner.uuid)?.name ?? "",
				},
				detail: { target: where },
			};
	}
}

// ── Facts of the plan ───────────────────────────────────────────────

/** A planned schema change's key, as `parked` counts are keyed. */
export function schemaChangeKey(change: {
	readonly caseType: string;
	readonly property: string;
}): string {
	return JSON.stringify([change.caseType, change.property]);
}

/**
 * `case-property-type-now-known`: each planned schema change of source
 * `inferred` (§8), a property unknown today that step 3's Hidden Value
 * inference types. `detail.parked` counts the stored values that do not
 * cast to the new type (`SchemaCaseStore.conversionImpact`), only where
 * there are some.
 */
export function casePropertyTypeNowKnown(
	appName: string,
	schemaChanges: readonly PlannedSchemaChange[],
	parked: ReadonlyMap<string, number>,
): DocumentChange[] {
	return schemaChanges
		.filter((change) => change.source === "inferred")
		.map((change) => {
			const count = parked.get(schemaChangeKey(change)) ?? 0;
			return {
				reason: "case-property-type-now-known",
				entity: { type: "app", nameAtMigration: appName },
				detail: {
					caseType: change.caseType,
					property: change.property,
					dataType: change.to,
					...(count > 0 ? { parked: String(count) } : {}),
				},
			};
		});
}

/** `unsaved-assistant-work-discarded`: the app had open private work the cutover abandons. */
export function unsavedAssistantWorkDiscarded(
	appName: string,
	discardsPrivateWork: boolean,
): DocumentChange[] {
	return discardsPrivateWork
		? [
				{
					reason: "unsaved-assistant-work-discarded",
					entity: { type: "app", nameAtMigration: appName },
				},
			]
		: [];
}

/**
 * The lifted target's no-write document lines, in the order of
 * `DOCUMENT_NOTICE_REASONS`: the searches, the device comparisons, the
 * inferred types, the discarded work.
 */
export function behaviorChanges(input: {
	readonly appName: string;
	readonly target: BlueprintDoc;
	readonly context: BehaviorContext;
	readonly schemaChanges: readonly PlannedSchemaChange[];
	readonly parked: ReadonlyMap<string, number>;
	readonly discardsPrivateWork: boolean;
}): DocumentChange[] {
	return [
		...searchTodayIsWorkersDay(input.target, input.context),
		...searchDateTimeEqualityMatches(input.target, input.context),
		...dateTimeComparisonComparesMoments(input.target, input.context),
		...casePropertyTypeNowKnown(
			input.appName,
			input.schemaChanges,
			input.parked,
		),
		...unsavedAssistantWorkDiscarded(input.appName, input.discardsPrivateWork),
	];
}

// ── Deployment lines ────────────────────────────────────────────────

/** One deployment of an app: a live `app` mapping. */
export interface BehaviorDeployment {
	readonly deploymentId: string;
}

type DeploymentNoticeReason = (typeof DEPLOYMENT_NOTICE_REASONS)[number];

/** One deployment line the plan holds, content-free. */
export interface DeploymentChange {
	readonly deploymentId: string;
	readonly reason: DeploymentNoticeReason;
}

/** Whether the target has an entry point, so the horizon's `+1` makes every manifest stale. */
export function hasEntryPoints(target: BlueprintDoc): boolean {
	return entryPointInventory(target).length > 0;
}

/**
 * The document reasons whose change reaches the wire at the next publish
 * (part 09 §6): canonical spellings of authored expressions, the first-row
 * lift, the lowering, an inference typing's binds, and part 06's two.
 */
export const WIRE_REACHING_REASONS: ReadonlySet<DocumentNoticeReason> = new Set(
	[
		"expressions-respelled",
		"repeat-read-takes-first-row",
		"date-time-comparison-compares-moments",
		"case-property-type-now-known",
		"search-today-is-workers-day",
		"search-date-time-equality-matches",
	],
);

/**
 * `expressions-sent-at-next-publish` for every deployment of an app with a
 * wire-reaching entry, and `deep-links-need-republish` for every deployment
 * of an app with entry points, in `DEPLOYMENT_NOTICE_REASONS`' order.
 */
export function deploymentChanges(
	deployments: readonly BehaviorDeployment[],
	changes: readonly Pick<DocumentChange, "reason">[],
	entryPoints: boolean,
): DeploymentChange[] {
	const sends = changes.some((change) =>
		WIRE_REACHING_REASONS.has(change.reason),
	);
	return deployments.flatMap(({ deploymentId }) => [
		...(sends
			? [{ deploymentId, reason: "expressions-sent-at-next-publish" as const }]
			: []),
		...(entryPoints
			? [{ deploymentId, reason: "deep-links-need-republish" as const }]
			: []),
	]);
}
