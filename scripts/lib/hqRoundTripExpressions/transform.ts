/**
 * The cutover's transform of one app (part 09 §4, §5): raw carriers in; the
 * target, the notice lines, the blockers and the planned case-schema
 * changes out. Pure: it reads only its arguments, all of them from Nova's
 * database.
 *
 * The steps run in the one fixed order of `EXPRESSIONS_STEP_IDS`, each over
 * the transform's private working document: structure first (the target
 * must hydrate before any parse), then records, then form logic, then what
 * needs the lifted trees. A second application to its own output changes
 * nothing: each step carries a value it has already lifted.
 *
 * After the last step the target is parsed by the head's
 * `blueprintDocSchema` and hydrated, judged by the commit gate and by export
 * readiness with the Project's lookup definitions and media manifest, and
 * its derived case schemas are compared with the app's active stored rows.
 */

import { buildCaseTypeMap } from "@/lib/case-store/store";
import type { ValidationError } from "@/lib/commcare/validator/errors";
import { parsePersistedJsonText } from "@/lib/db/persistedJson";
import {
	exportReadinessFindings,
	mutationCommitVerdict,
} from "@/lib/doc/commitVerdicts";
import { lookupExpressionDefinitions } from "@/lib/doc/lookupExpressionContext";
import type { BlueprintDoc, PersistableDoc } from "@/lib/domain/blueprint";
import {
	type CasePropertyDataType,
	casePropertyDataTypes,
} from "@/lib/domain/casePropertyTypes";
import { schemaForDataType } from "@/lib/domain/expression/jsonSchema";
import { CASE_SCALAR_PROPERTY_NAMES } from "@/lib/domain/standardCaseProperties";
import { USERCASE_CASE_TYPE } from "@/lib/domain/usercase";
import { canonicalJsonText } from "@/lib/utils/canonicalJson";
import { copyRawDocument, type RawCarriers, readRawDocument } from "./oldShape";
import { catalogRulesStep } from "./steps/catalogRules";
import { declareReadPropertiesStep } from "./steps/declareReadProperties";
import { formLinkDatumNamesStep } from "./steps/formLinkDatumNames";
import { formLogicLiftStep } from "./steps/formLogicLift";
import { liftRoundTripStep } from "./steps/liftRoundTrip";
import { recordExpressionsStep } from "./steps/recordExpressions";
import { repeatReadFirstRowStep } from "./steps/repeatReadFirstRow";
import { appEntity } from "./steps/shared";
import { WorkingDocument } from "./steps/working";
import {
	type BlockerPlace,
	CUTOVER_BLOCKER_CODES,
	type CutoverBlocker,
	type CutoverBlockerCode,
	type DocumentChange,
	EXPRESSIONS_STEP_IDS,
	type ExpressionsStep,
	type PlannedSchemaChange,
	type StepClassCount,
	type StepContext,
	type TransformContext,
	type TransformResult,
} from "./types";

/** Every step, in the one order they run in. */
export const EXPRESSIONS_STEPS: readonly ExpressionsStep[] = [
	catalogRulesStep,
	formLinkDatumNamesStep,
	recordExpressionsStep,
	formLogicLiftStep,
	declareReadPropertiesStep,
	repeatReadFirstRowStep,
	liftRoundTripStep(),
];

/** What a test may replace at its owning boundary; production passes none. */
export interface TransformOptions {
	readonly steps?: readonly ExpressionsStep[];
	readonly exportReadiness?: typeof exportReadinessFindings;
}

function distinctSorted(values: Iterable<string>): string[] {
	return [...new Set(values)].sort();
}

/** `CODE`, `CODE:reason` and `CODE:checkCode:checkReason` of a finding. */
function findingReason(finding: ValidationError): string[] {
	const details = finding.details ?? {};
	return [
		...(details.reason === undefined
			? []
			: [`${finding.code}:${details.reason}`]),
		...(details.checkCode === undefined
			? []
			: [
					`${finding.code}:${details.checkCode}${
						details.checkReason === undefined ? "" : `:${details.checkReason}`
					}`,
				]),
	];
}

function findingBlocker(
	code: "target-gate" | "target-export-readiness",
	findings: readonly ValidationError[],
): CutoverBlocker {
	return {
		code,
		count: findings.length,
		findingCodes: distinctSorted(findings.map((finding) => finding.code)),
		findingReasons: distinctSorted(findings.flatMap(findingReason)),
	};
}

function findingPlaces(
	code: "target-gate" | "target-export-readiness",
	findings: readonly ValidationError[],
): BlockerPlace[] {
	return findings.map((finding) => ({
		code,
		entity: {
			kind: finding.scope,
			...(finding.location.fieldUuid !== undefined
				? { uuid: finding.location.fieldUuid }
				: finding.location.formUuid !== undefined
					? { uuid: finding.location.formUuid }
					: finding.location.moduleUuid !== undefined
						? { uuid: finding.location.moduleUuid }
						: {}),
		},
		findingCode: finding.code,
		text: finding.message,
	}));
}

/** The data type a stored schema row's property subschema is the canonical schema of. */
function storedDataType(subschema: unknown): CasePropertyDataType | undefined {
	const text = canonicalJsonText(subschema);
	return casePropertyDataTypes.find(
		(type) => canonicalJsonText(schemaForDataType(type)) === text,
	);
}

/**
 * The case-schema plan (§8): the target's derived case types compared, per
 * property, with the app's active stored rows, the worker's own case left
 * out on both sides. A difference is planned when step 5 declared the
 * property, or when the catalog holds no type for it, so its type is the one
 * step 3's inference derives; any other difference is unplanned.
 */
export function plannedSchemaChanges(
	target: PersistableDoc,
	storedCaseSchemas: ReadonlyMap<string, string>,
	declared: ReadonlySet<string>,
): { changes: PlannedSchemaChange[]; unplanned: number } {
	const derived = new Map(buildCaseTypeMap(target));
	derived.delete(USERCASE_CASE_TYPE);
	const catalogTypes = new Map<string, CasePropertyDataType | undefined>();
	for (const caseType of target.caseTypes ?? [])
		for (const property of caseType.properties)
			catalogTypes.set(
				JSON.stringify([caseType.name, property.name]),
				property.data_type,
			);
	const changes: PlannedSchemaChange[] = [];
	let unplanned = 0;
	for (const [name, caseType] of derived) {
		const storedText = storedCaseSchemas.get(name);
		const storedProperties = new Map<
			string,
			CasePropertyDataType | undefined
		>();
		if (storedText !== undefined) {
			const stored = parsePersistedJsonText(
				storedText,
				`case_type_schemas.schema for ${name}`,
			) as { properties?: Record<string, unknown> };
			for (const [property, subschema] of Object.entries(
				stored.properties ?? {},
			))
				storedProperties.set(property, storedDataType(subschema));
		}
		const seen = new Set<string>();
		for (const property of caseType.properties) {
			if (CASE_SCALAR_PROPERTY_NAMES.has(property.name)) continue;
			seen.add(property.name);
			const to = property.data_type ?? "text";
			const from = storedProperties.has(property.name)
				? (storedProperties.get(property.name) ?? null)
				: null;
			if (from === to) continue;
			const key = JSON.stringify([name, property.name]);
			if (declared.has(key))
				changes.push({
					caseType: name,
					property: property.name,
					from,
					to,
					source: "declared",
				});
			else if (catalogTypes.get(key) === undefined && from !== null)
				changes.push({
					caseType: name,
					property: property.name,
					from,
					to,
					source: "inferred",
				});
			else unplanned += 1;
		}
		for (const property of storedProperties.keys())
			if (!seen.has(property)) unplanned += 1;
	}
	for (const name of storedCaseSchemas.keys())
		if (name !== USERCASE_CASE_TYPE && !derived.has(name)) unplanned += 1;
	changes.sort((a, b) =>
		a.caseType === b.caseType
			? a.property < b.property
				? -1
				: 1
			: a.caseType < b.caseType
				? -1
				: 1,
	);
	return { changes, unplanned };
}

/** Run every step over a private copy of the app's document and judge the target. */
export function transformApp(
	raw: RawCarriers,
	ctx: TransformContext,
	options: TransformOptions = {},
): TransformResult {
	const doc = new WorkingDocument(
		ctx.appId,
		copyRawDocument(readRawDocument(ctx.appId, raw)),
		ctx.lookupContext,
	);
	const definitions = lookupExpressionDefinitions(ctx.lookupContext);
	const stepContext: StepContext = {
		appId: ctx.appId,
		projectId: ctx.projectId,
		lookup: definitions === "unavailable" ? new Map() : definitions,
		storedCaseKeys: ctx.storedCaseKeys,
	};

	const changes: DocumentChange[] = [];
	const blockers: CutoverBlocker[] = [];
	const classes: StepClassCount[] = [];
	const places: BlockerPlace[] = [];
	const steps = options.steps ?? EXPRESSIONS_STEPS;
	if (steps.map((step) => step.id).join() !== EXPRESSIONS_STEP_IDS.join())
		throw new Error(
			"The cutover's steps must run in part 09's order, each once: catalog-rules, form-link-datum-names, record-expressions, form-logic-lift, declare-read-properties, repeat-read-first-row, lift-round-trip.",
		);
	for (const step of steps) {
		const result = step.apply(doc, stepContext);
		changes.push(...result.changes);
		blockers.push(...result.blockers);
		classes.push(...result.classes);
		places.push(...result.places);
	}

	// The classes of a lift belong to the slot's final lift, wherever a
	// later step parsed it again, so they are tallied from the slots.
	const slots = doc.slots();
	for (const step of ["record-expressions", "form-logic-lift"] as const) {
		const tally = new Map<string, number>();
		for (const slot of slots)
			for (const cls of slot.classes.get(step) ?? [])
				tally.set(cls, (tally.get(cls) ?? 0) + 1);
		const at = classes.findIndex(
			(entry) =>
				EXPRESSIONS_STEP_IDS.indexOf(entry.step) >
				EXPRESSIONS_STEP_IDS.indexOf(step),
		);
		const entries = [...tally].map(([cls, count]) => ({
			step,
			class: cls as StepClassCount["class"],
			count,
		}));
		classes.splice(at === -1 ? classes.length : at, 0, ...entries);
	}

	const refused = slots.filter((slot) => slot.refused !== undefined);
	if (refused.length > 0) {
		blockers.push({
			code: "expression-parse-refused",
			count: refused.length,
			findingCodes: distinctSorted(
				refused.flatMap((slot) => slot.refused?.codes ?? []),
			),
		});
		for (const slot of refused)
			if (slot.refused) places.push(slot.refused.place);
	}

	// A slot no step lifted and no step blocked holds a stored value the
	// head union does not admit (or sits in a structure the head schema
	// refuses): the target cannot hold it.
	const unaccounted = slots.filter(
		(slot) =>
			slot.lifted === false &&
			slot.refused === undefined &&
			slot.blocked === undefined,
	);
	if (unaccounted.length > 0) {
		blockers.push({
			code: "target-parse",
			count: unaccounted.length,
			findingCodes: [],
		});
		for (const slot of unaccounted)
			places.push({
				code: "target-parse",
				entity: { kind: slot.owner.entity, uuid: slot.owner.uuid },
				slot: slot.ref.slot,
			});
	}

	// The app-level lines: one for every expression that now names a choice
	// (step 3's and step 4's together) and one for every respelled one.
	const count = (step: "record-expressions" | "form-logic-lift", cls: string) =>
		slots.filter((slot) => slot.classes.get(step)?.has(cls as never)).length;
	const choices =
		count("record-expressions", "choice") + count("form-logic-lift", "choice");
	const respelled = count("form-logic-lift", "respelled");
	const firstLater = changes.findIndex(
		(change) => change.reason !== "case-property-rules-removed",
	);
	changes.splice(
		firstLater === -1 ? changes.length : firstLater,
		0,
		...(choices === 0
			? []
			: [
					{
						reason: "expressions-follow-choices" as const,
						entity: appEntity(doc.raw),
						detail: { count: String(choices) },
					},
				]),
		...(respelled === 0
			? []
			: [
					{
						reason: "expressions-respelled" as const,
						entity: appEntity(doc.raw),
						detail: { count: String(respelled) },
					},
				]),
	);

	// After the last step: the head schema, the gate, export readiness and
	// the case-schema plan, over the target, or over the target with each
	// slot that could not be lifted left out, so a blocked app still shows
	// every other blocker it holds.
	const allLifted = slots.every((slot) => slot.lifted !== false);
	const judged = allLifted ? doc.target() : doc.judged();
	let target: PersistableDoc | undefined;
	let schemaChanges: PlannedSchemaChange[] = [];
	if (!judged.ok) {
		blockers.push({
			code: "target-parse",
			count: judged.issues,
			findingCodes: [],
		});
		places.push({ code: "target-parse", entity: { kind: "app" } });
	} else {
		if (allLifted) target = judged.persisted;
		const verdict = mutationCommitVerdict(judged.doc, [], ctx.lookupContext);
		if (!verdict.ok && verdict.findings.length > 0) {
			blockers.push(findingBlocker("target-gate", verdict.findings));
			places.push(...findingPlaces("target-gate", verdict.findings));
		}
		const readiness = (options.exportReadiness ?? exportReadinessFindings)(
			judged.doc as BlueprintDoc,
			ctx.lookupContext,
			ctx.mediaAssets,
		);
		if (readiness.length > 0) {
			blockers.push(findingBlocker("target-export-readiness", readiness));
			places.push(...findingPlaces("target-export-readiness", readiness));
		}
		const declared = new Set(
			changes
				.filter((change) => change.reason === "case-property-declared")
				.map((change) =>
					JSON.stringify([change.detail?.caseType, change.detail?.property]),
				),
		);
		const plan = plannedSchemaChanges(
			judged.persisted,
			ctx.storedCaseSchemas,
			declared,
		);
		schemaChanges = plan.changes;
		if (plan.unplanned > 0) {
			blockers.push({
				code: "case-schema-unplanned",
				count: plan.unplanned,
				findingCodes: [],
			});
			places.push({ code: "case-schema-unplanned", entity: { kind: "app" } });
		}
	}

	const merged = new Map<CutoverBlockerCode, CutoverBlocker>();
	for (const blocker of blockers) {
		const prior = merged.get(blocker.code);
		merged.set(
			blocker.code,
			prior === undefined
				? blocker
				: {
						code: blocker.code,
						count: prior.count + blocker.count,
						findingCodes: distinctSorted([
							...prior.findingCodes,
							...blocker.findingCodes,
						]),
						...(prior.findingReasons === undefined &&
						blocker.findingReasons === undefined
							? {}
							: {
									findingReasons: distinctSorted([
										...(prior.findingReasons ?? []),
										...(blocker.findingReasons ?? []),
									]),
								}),
					},
		);
	}
	return {
		target,
		changes,
		blockers: CUTOVER_BLOCKER_CODES.flatMap((code) => {
			const blocker = merged.get(code);
			return blocker === undefined ? [] : [blocker];
		}),
		schemaChanges,
		classes: classes.filter((entry) => entry.count > 0),
		places,
	};
}

export { roundTripFailures } from "./steps/liftRoundTrip";
