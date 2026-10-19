/**
 * Helper to build an `XPathLintContext` from the normalized doc store.
 *
 * The lint/autocomplete plugin takes a pre-collected snapshot of:
 *   - valid `/data/...` paths in the current form,
 *   - the case types readable from this form (own + ancestors) with their
 *     property metadata, and
 *   - value-producing form fields (for `#form/x` completions).
 *
 * Both the field inspector's XPath editors and the form-settings
 * connect panel need the same walk, so it's extracted here. Reads
 * exclusively from the normalized `BlueprintDocState` (Uuid-indexed
 * maps + adjacency list).
 *
 * The actual expression slot determines form or after-submit scope;
 * after-submit slots expose case data without form-answer completions.
 */

import {
	entryDatumIds,
	type FormLinkProjectionContext,
	formLinkProjectionContext,
} from "@/lib/commcare/formLinkProjection";
import { lookupTypeIndex } from "@/lib/doc/commitVerdicts";
import { parseFormExpressionForSlot } from "@/lib/doc/expressionText";
import { lookupExpressionDefinitions } from "@/lib/doc/lookupExpressionContext";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import {
	asUuid,
	type Field,
	type FieldKind,
	type Form,
	isContainer,
	orderedLocationProperties,
	orderedOrganizationLevels,
	type ProseTemplate,
	projectProseTemplate,
	type ReachableCaseTypeIndex,
	reachableCaseTypes,
	toReachableIndex,
	type Uuid,
} from "@/lib/domain";
import {
	type ExpressionContext,
	type LookupDefinitionIndex,
	slotContext,
} from "@/lib/domain/expression/context";
import type { FormStructure } from "@/lib/domain/expression/formStructure";
import type {
	DatumRef,
	ExpressionSlotRef,
} from "@/lib/domain/expression/types";
import { VALUE_PRODUCING_TYPES } from "@/lib/references/provider";
import type {
	XPathInstanceReads,
	XPathLintContext,
	XPathReferenceContext,
} from "./xpath-lint";

/**
 * The case types a form can READ — its owning module's case type plus that
 * type's ancestor chain (walked through `parent_type`) — or `undefined`
 * when the module has no case type. The case-type record on `doc.caseTypes`
 * is the authoritative property list; it's populated by the SA and we never
 * synthesize entries from field write destinations (by design). Child types
 * are deliberately NOT included — a child case is created fresh and never
 * loaded, so reading its properties is unresolvable at runtime.
 *
 * One derivation for both lint contexts, so a form's field slots and its
 * after-submit slots can never disagree about which case types exist.
 */
export function formReachableCaseTypes(
	state: BlueprintDoc,
	formUuid: Uuid,
): ReachableCaseTypeIndex | undefined {
	// Find the module that owns this form so we can resolve its caseType.
	let moduleUuid: Uuid | undefined;
	for (const [mUuid, formUuids] of Object.entries(state.formOrder)) {
		if (formUuids.includes(formUuid)) {
			moduleUuid = asUuid(mUuid);
			break;
		}
	}
	const mod = moduleUuid ? state.modules[moduleUuid] : undefined;
	const moduleCaseType = mod?.caseType;
	return moduleCaseType
		? toReachableIndex(
				reachableCaseTypes(moduleCaseType, state.caseTypes ?? []),
				state,
			)
		: undefined;
}

/**
 * Walk the doc's field tree under `formUuid` and collect the three slices
 * the CodeMirror plugin reads. `undefined` if the form no longer exists
 * (caller decides what to render in that case).
 */
export function buildLintContext(
	state: BlueprintDoc,
	formUuid: Uuid,
): XPathReferenceContext | undefined {
	const form = state.forms[formUuid] as Form | undefined;
	if (!form) return undefined;

	// Walk fields under the form root to collect valid paths + form entries.
	const validPaths = new Set<string>();
	const formEntries: Array<{
		uuid: Uuid;
		path: string;
		label: string;
		kind: FieldKind;
	}> = [];
	function walk(parent: Uuid, prefix: string) {
		const order = state.fieldOrder[parent] ?? [];
		for (const childUuid of order) {
			const field = state.fields[childUuid] as Field | undefined;
			if (!field) continue;
			const path = `${prefix}/${field.id}`;
			validPaths.add(path);
			// Field variants differ in label presence — safe fallback to id so
			// the autocomplete always has something readable to display.
			const withLabel = field as Field & { label?: ProseTemplate };
			formEntries.push({
				uuid: field.uuid,
				path: path.slice("/data/".length),
				label: withLabel.label
					? projectProseTemplate(withLabel.label, state).text
					: field.id,
				kind: field.kind,
			});
			if (isContainer(field)) {
				walk(childUuid, path);
			}
		}
	}
	walk(formUuid, "/data");

	return {
		formUuid,
		validPaths,
		reachableCaseTypes: formReachableCaseTypes(state, formUuid),
		formEntries: formEntries.filter((e) => VALUE_PRODUCING_TYPES.has(e.kind)),
		userProperties: Object.values(state.userProperties ?? {}),
		formType: form.type,
	};
}

/** Derive editing semantics from the actual owner and slot, never a form default. */
export function buildExpressionLintContext(
	doc: BlueprintDoc,
	slot: ExpressionSlotRef,
	lookupContext: LookupValidationContext,
	options: { readonly form?: FormStructure } = {},
): XPathLintContext | undefined {
	const context = slotContext(
		doc,
		slot,
		lookupTypeIndex(lookupContext),
		options,
	);
	const form = context?.form;
	if (context === undefined || form === undefined) return undefined;
	const references = buildLintContext(doc, form.formUuid);
	if (references === undefined) return undefined;
	const lookup = lookupExpressionDefinitions(lookupContext);
	return {
		...references,
		...(context.profile.formAnswers
			? {}
			: { validPaths: new Set<string>(), formEntries: [] }),
		...(context.profile.caseData ? {} : { reachableCaseTypes: undefined }),
		scope: context.profile.scope === "session" ? "session" : "form",
		instanceReads: slotInstanceReads(doc, context, lookup),
		expressionContext: context,
		parse: (source) =>
			parseFormExpressionForSlot(doc, slot, source, lookup, options),
	};
}

/** What a session value holds, as the person knows it. */
function datumLabel(
	doc: BlueprintDoc,
	ref: DatumRef,
	ownCaseType: string | undefined,
): string {
	switch (ref.kind) {
		case "selected-case":
			return `The case chosen in ${doc.modules[ref.module]?.name ?? "a menu"}`;
		case "new-case":
			return ownCaseType === undefined
				? "This form's new case"
				: `This form's new ${ownCaseType} case`;
		case "new-child-case":
			return `This form's new ${ref.caseType} case`;
		case "worker-record":
			return "The worker's own record";
		case "tile-group-parents":
			return `The grouped cases' connections in ${doc.modules[ref.module]?.name ?? "a menu"}`;
	}
}

/** Each document snapshot's entry-datum projection. It is app-wide and a
 * lint context is built for every slot, so one snapshot builds it once (as
 * `validator/rules/form.ts::projectionContextFor` does); the context holds
 * each form's datums once computed. */
const entryProjections = new WeakMap<BlueprintDoc, FormLinkProjectionContext>();

function entryProjectionFor(doc: BlueprintDoc): FormLinkProjectionContext {
	const held = entryProjections.get(doc);
	if (held !== undefined) return held;
	const built = formLinkProjectionContext(doc, { entryMetadataOnly: true });
	entryProjections.set(doc, built);
	return built;
}

/**
 * The secondary instances the slot reads, from the same facts the parser
 * binds against and the checker admits by: the Project's tables, places
 * when the app has levels, the chosen cases only in the questions of a
 * several-case form, the search's results only where the entry carries the
 * inline query, a no-matches form's search fields, and the session values
 * the entry supplies.
 */
function slotInstanceReads(
	doc: BlueprintDoc,
	context: ExpressionContext,
	lookup: LookupDefinitionIndex | "unavailable",
): XPathInstanceReads {
	const form = context.form;
	const rows =
		form === undefined
			? []
			: entryDatumIds(
					doc,
					entryProjectionFor(doc),
					form.moduleUuid,
					form.formUuid,
				);
	const ownCaseType =
		form === undefined
			? undefined
			: context.facts.moduleCaseTypes.get(form.moduleUuid);
	const levels = orderedOrganizationLevels(doc);
	const chosen =
		context.slot.entity === "field"
			? rows.find(
					(row) =>
						!row.scalar &&
						row.refs.some(
							(ref) =>
								ref.kind === "selected-case" &&
								context.supplies.refs.some(
									(supply) =>
										!supply.scalar &&
										supply.ref.kind === "selected-case" &&
										supply.ref.module === ref.module,
								),
						),
				)
			: undefined;
	const searched = context.supplies.searchResults;
	const searchedType =
		searched === undefined
			? undefined
			: context.facts.caseTypes.find(
					(type) =>
						type.name === context.facts.moduleCaseTypes.get(searched.module),
				);
	return {
		tables:
			lookup === "unavailable"
				? []
				: [...lookup.values()].map((table) => ({
						tag: table.tag,
						name: table.name,
						columns: table.columns.map((column) => ({
							wireName: column.wireName,
							label: column.label,
						})),
					})),
		...(levels.length === 0
			? {}
			: {
					places: {
						levels: levels.map((level) => ({
							code: level.code,
							name: level.name,
						})),
						properties: orderedLocationProperties(doc).map((property) => ({
							slug: property.slug,
							label: property.label,
						})),
					},
				}),
		...(chosen === undefined ? {} : { selectedCases: chosen.id }),
		...(searchedType === undefined || form?.noMatchesForm
			? {}
			: {
					searchResults: {
						properties: searchedType.properties.map((property) => ({
							name: property.name,
							label: projectProseTemplate(property.label, doc).text,
						})),
					},
				}),
		...(form?.noMatchesForm
			? { searchInputs: form.searchInputs.map((input) => input.name) }
			: {}),
		sessionData: rows.flatMap((row) => {
			const ref = row.refs[0];
			return row.scalar && ref !== undefined
				? [{ id: row.id, label: datumLabel(doc, ref, ownCaseType) }]
				: [];
		}),
	};
}
