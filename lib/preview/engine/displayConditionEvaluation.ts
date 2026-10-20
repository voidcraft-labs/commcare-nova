// lib/preview/engine/displayConditionEvaluation.ts
//
// Client-side execution of module/form navigation display conditions
// at navigation render, the preview counterpart of the wire's
// `<menu relevant>` / `<command relevant>` attributes. The text is the
// suite's own: the SAME emitters `compiler.ts` writes those attributes with
// (`lib/commcare/suite/displayConditions.ts`), serialized at the Preview
// target and evaluated over the instances the device holds at that menu:
// the session (with the chosen case under its datum), the device's cases,
// and the lookup fixtures under their suite ids. A form condition's read of
// the chosen case is therefore the suite's casedb walk keyed on
// `session/data/<datum>`, never a value Preview substitutes.
//
// An item off the menu (`hiddenFromMenu`) is `hidden` before its condition is
// read: no menu lists it on either runtime, and the condition applies only
// once it is back on the menu. Every other condition is evaluated exactly as
// stored (`displayConditionForEmission`), with no clause absorbed.
//
// Three-valued visibility: `shown` / `hidden` are evaluated results;
// `pending` means the condition reads lookup data or device cases Preview is
// still loading, so the caller renders a placeholder, never a guess. With
// loaded data, unavailable lookup identities and any other checker-gated
// impossibility throw loudly (a bug surface, never a silently-shown item).

import {
	entryDatumIdResolver,
	entryDatumIds,
	formLinkProjectionContext,
	selectedCaseSessionDatum,
} from "@/lib/commcare/formLinkProjection";
import {
	type DisplayConditionCarrier,
	emitFormDisplayConditionForSuite,
	emitModuleDisplayCondition,
} from "@/lib/commcare/suite/displayConditions";
import { serializeWire } from "@/lib/commcare/xpath/wire/serialize";
import type { WireExpr } from "@/lib/commcare/xpath/wire/tree";
import type { BlueprintDoc, CaseType, Uuid } from "@/lib/domain";
import { displayConditionForEmission } from "@/lib/domain/expression";
import type { ExpressionContext } from "@/lib/domain/expression/context";
import type { DatumRef, Expression } from "@/lib/domain/expression/types";
import { toBoolean } from "../xpath/coerce";
import { evaluate } from "../xpath/evaluator";
import { invokeGeneratedJavaRosaFunction } from "../xpath/generatedJavaRosaFunctions";
import type { XPathInstance } from "../xpath/runtimeValues";
import type { EvalContext } from "../xpath/types";
import { expressionReadsCaseDatabase } from "./expressionCaseReads";
import type { PreviewSearchSessionValues } from "./identity";
import {
	type PreviewLookupData,
	predicateLookupsCovered,
} from "./lookupEvaluation";
import type { PreviewLookupStatus } from "./useLookupPreviewData";
import {
	type CaseDatabaseSnapshot,
	caseDatabaseXPathInstance,
	commcareSessionXPathInstance,
	lookupXPathInstances,
} from "./xpathInstances";

export type NavigationItemVisibility = "shown" | "hidden" | "pending";

/** The device's cases a navigation condition may read. */
export interface NavigationDeviceCases {
	/** The worker's device snapshot, or `null` while it loads. */
	readonly snapshot: CaseDatabaseSnapshot | null;
	/** The app's case types, which give the snapshot's stored values their
	 * device spelling (`caseDatabaseXPathInstance`). */
	readonly caseTypes: readonly CaseType[];
}

/** The case a case-first form menu was reached with, under the session datum
 * its form selects it as (`navigationSelectedCase`), and the session the
 * menu holds once it is chosen. */
export interface NavigationSelectedCase {
	readonly datumId: string;
	readonly caseId: string;
	/** The ids the form's entry prints its datums under. */
	readonly datumIds?: (ref: DatumRef) => string | undefined;
	/** `session/data` before the case was chosen: the cases chosen in
	 * earlier menus (`entrySessionData.ts::caseListStepSession`). */
	readonly sessionData?: Readonly<Record<string, string>>;
}

interface VisibilityArgs {
	readonly condition: Expression | undefined;
	readonly types: ExpressionContext;
	/** The item is off the menu: hidden whatever its condition says. */
	readonly hiddenFromMenu?: boolean;
	readonly session: PreviewSearchSessionValues;
	readonly lookup: PreviewLookupStatus;
	/** Absent where the caller holds no device cases; a condition that reads
	 * them is then `pending`, as it is while they load. */
	readonly deviceCases?: NavigationDeviceCases;
}

/**
 * Module conditions gate the home screen's module list. They run before any
 * case selection, so they read the session, the device's cases (a worker
 * property is the worker's own case) and the lookup fixtures.
 */
export function moduleDisplayVisibility(
	args: VisibilityArgs,
): NavigationItemVisibility {
	return conditionVisibility(args, (carrier, naming) =>
		emitModuleDisplayCondition(carrier, args.types, naming),
	);
}

/**
 * Form conditions gate the case-list screen's post-selection form menu
 * (including the single-form auto-continue) and the module screen's
 * forms-first list. A read of the chosen case walks the device's cases from
 * `session/data/<datum>`, which holds `selectedCase`, and a read of a case
 * chosen in an earlier menu walks them from that menu's datum, which the
 * menu's session holds beside it; the forms-first flow chooses none (the
 * validator already rejects property reads there).
 */
export function formDisplayVisibility(
	args: VisibilityArgs & {
		readonly selectedCase?: NavigationSelectedCase | undefined;
	},
): NavigationItemVisibility {
	return conditionVisibility(
		args,
		(carrier, naming) =>
			emitFormDisplayConditionForSuite(
				carrier,
				args.types,
				naming,
				args.selectedCase?.datumId,
				args.selectedCase?.datumIds,
			),
		args.selectedCase === undefined
			? {}
			: {
					...args.selectedCase.sessionData,
					[args.selectedCase.datumId]: args.selectedCase.caseId,
				},
	);
}

/**
 * The session datum a form selects its module's case under, which a
 * case-first form menu's condition reads the chosen case through. The suite
 * writes the form's `<command relevant>` with the same datum
 * (`compiler.ts`, `selectedCaseSessionDatum`).
 */
export function navigationSelectedCase(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	formUuid: Uuid,
	caseId: string,
	/** `session/data` at the module's case list step, which the menu keeps
	 * once its case is chosen. */
	sessionData?: Readonly<Record<string, string>>,
): NavigationSelectedCase | undefined {
	let context = projectionContexts.get(doc);
	if (context === undefined) {
		context = formLinkProjectionContext(doc, { entryMetadataOnly: true });
		projectionContexts.set(doc, context);
	}
	const datum = selectedCaseSessionDatum(doc, context, moduleUuid, formUuid);
	if (datum === undefined) return undefined;
	const ids = entryDatumIds(doc, context, moduleUuid, formUuid);
	return {
		datumId: datum.id,
		caseId,
		datumIds: entryDatumIdResolver(ids),
		...(sessionData === undefined ? {} : { sessionData }),
	};
}

/** One projection per document: a menu asks once per form it lists. */
const projectionContexts = new WeakMap<
	BlueprintDoc,
	ReturnType<typeof formLinkProjectionContext>
>();

function conditionVisibility(
	args: VisibilityArgs,
	emit: (
		carrier: DisplayConditionCarrier,
		naming: PreviewLookupData["naming"] | undefined,
	) => WireExpr | undefined,
	sessionData: Readonly<Record<string, string>> = {},
): NavigationItemVisibility {
	if (args.hiddenFromMenu === true) return "hidden";
	// The emitters' own decision: an absent condition, or one whose root is
	// always, is simply shown, matching the absent wire attribute. Every
	// other condition is evaluated as stored.
	const effective = displayConditionForEmission(args.condition);
	if (effective === undefined) return "shown";
	if (args.session.identityPending) return "pending";

	/* A carrier-bearing condition is decidable only over a snapshot that
	 * COVERS its identities: a bare "data exists" test is not enough,
	 * because the stale-while-revalidate snapshot predates a validly
	 * committed reference to a new table/column. Loading, a failed
	 * fetch, the first-render idle tick, and the stale-coverage window
	 * all render the placeholder, never a guess, never a crash for a
	 * transient; a COVERED snapshot with a broken identity still throws
	 * loudly below (a genuine validator bypass). */
	const data = args.lookup.kind === "data" ? args.lookup.data : undefined;
	if (!predicateLookupsCovered(effective, data)) return "pending";
	const snapshot = args.deviceCases?.snapshot ?? null;
	if (snapshot === null && expressionReadsCaseDatabase(effective))
		return "pending";

	const wire = emit({ displayCondition: effective }, data?.naming);
	if (wire === undefined) return "shown";
	const instances = new Map<string, XPathInstance>([
		[
			"commcaresession",
			commcareSessionXPathInstance(args.session, sessionData),
		],
		...lookupInstances(data),
	]);
	if (snapshot !== null && args.deviceCases !== undefined)
		instances.set(
			"casedb",
			caseDatabaseInstance(snapshot, args.deviceCases.caseTypes),
		);
	return toBoolean(
		evaluate(
			serializeWire(wire, { target: "preview" }).text,
			navigationEvalContext(instances),
		),
	)
		? "shown"
		: "hidden";
}

/* A menu evaluates every item's condition on each render over the same
 * snapshot and fixture capture, so their instances are built once each. */
const caseDatabaseInstances = new WeakMap<
	CaseDatabaseSnapshot,
	WeakMap<readonly CaseType[], XPathInstance>
>();

function caseDatabaseInstance(
	snapshot: CaseDatabaseSnapshot,
	caseTypes: readonly CaseType[],
): XPathInstance {
	let byTypes = caseDatabaseInstances.get(snapshot);
	if (byTypes === undefined) {
		byTypes = new WeakMap();
		caseDatabaseInstances.set(snapshot, byTypes);
	}
	let instance = byTypes.get(caseTypes);
	if (instance === undefined) {
		instance = caseDatabaseXPathInstance(snapshot, caseTypes);
		byTypes.set(caseTypes, instance);
	}
	return instance;
}

const fixtureInstances = new WeakMap<
	PreviewLookupData,
	ReadonlyMap<string, XPathInstance>
>();

function lookupInstances(
	data: PreviewLookupData | undefined,
): ReadonlyMap<string, XPathInstance> {
	if (data === undefined) return new Map();
	let instances = fixtureInstances.get(data);
	if (instances === undefined) {
		instances = lookupXPathInstances(data, { includeFixtureAliases: true });
		fixtureInstances.set(data, instances);
	}
	return instances;
}

/** A menu has no form instance and no context node: only the named
 * instances the device holds when it builds the menu. */
function navigationEvalContext(
	instances: ReadonlyMap<string, XPathInstance>,
): EvalContext {
	return {
		contextPath: "",
		position: 1,
		getValue: () => undefined,
		resolveXPathInstance: (instanceId) => instances.get(instanceId),
		invokeGeneratedFunction: invokeGeneratedJavaRosaFunction,
	};
}
