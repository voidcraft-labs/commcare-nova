/**
 * One expression of one slot judged on its own: HQ's text is bound to a
 * candidate `Expression` through the form parser's reading hook, the
 * candidate is printed for that slot by the production emitter's own calls,
 * and the two texts' syntax trees are compared under the closed table of
 * `syntaxCompare.ts`. Nothing here matches text: the print proves every
 * recognition.
 */

import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { fieldCaseWriteViews } from "@/lib/domain/caseWriteViews";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import {
	activeRowScope,
	type ExpressionContext,
	type LookupTypeIndex,
	slotContext,
} from "@/lib/domain/expression/context";
import { formStructure } from "@/lib/domain/expression/formStructure";
import type { RuleSet } from "@/lib/domain/expression/profiles";
import { expressionContextAtPath } from "@/lib/domain/expression/typeChecker";
import {
	type Expression,
	type FormNodeRef,
	isProseSlotRef,
	type SlotContextRef,
} from "@/lib/domain/expression/types";
import { walkExpression } from "@/lib/domain/expression/walk";
import { formOfField } from "@/lib/domain/fieldForm";
import type { SelectOptionsSource } from "@/lib/domain/fields/selectOptionsSource";
import { CASE_LOADING_FORM_TYPES, operationCaseType } from "@/lib/domain/forms";
import { afterEmptySearchRegistrationFormOf } from "@/lib/domain/menuForms";
import { moduleFormsReadSearch } from "@/lib/domain/modules";
import { moduleUuidOfForm } from "@/lib/domain/postSubmit";
import { NO_ENTRIES } from "@/lib/domain/records";
import { userPropertySlugsByUuid } from "@/lib/domain/users";
import type { Uuid } from "@/lib/domain/uuid";
import type { LookupTableDefinition } from "@/lib/lookup/types";
import { entryValueWire } from "../../advancedEntryValues";
import { caseOptionsNodeset } from "../../caseOptions";
import { caseTypeHopMap } from "../../caseTypeDepths";
import { searchAnswersOf } from "../../emissionPlan";
import { type RewriteControl, rewriteWithheld } from "../../emissionRewrites";
import { moduleExpressionContexts } from "../../expressionContext";
import {
	caseListStepDatumId,
	entryDatumIdResolver,
	entryDatumIds,
	type FormLinkProjectionContext,
	formLinkProjectionContext,
	projectFormLinkSessionExpression,
	selectedCaseSessionDatum,
	sessionDataRef,
} from "../../formLinkProjection";
import {
	projectCaseListFilter,
	projectSearchButtonCondition,
} from "../../hqJson/caseList";
import {
	type HqInterpolation,
	type HqXPath,
	hqXPathText,
} from "../../hqJson/xpath";
import { type LookupWireNaming, lookupWireNaming } from "../../lookup/naming";
import { lookupOptionsNodeset } from "../../lookupOptions";
import { emitNormalizedExcludedOwnerIdsExpression } from "../../suite/case-list/nodesetFilter";
import { hqExpressionField } from "../../suite/case-list/orderPlanOptions";
import { searchPromptWire } from "../../suite/case-search/searchPrompts";
import { searchWireShape } from "../../suite/case-search/searchWireShape";
import { searchInputInstanceId } from "../../suite/case-search/types";
import {
	emitFormDisplayConditionForHq,
	emitModuleDisplayCondition,
} from "../../suite/displayConditions";
import { rethrowWorkStop } from "../../workMeter";
import { fieldBindType } from "../../xform/bindType";
import {
	bindLookupFilterFieldPaths,
	buildCaseOperations,
	type CaseOperationPlaces,
	caseOperationPlaceKey,
	collectFieldLocations,
} from "../../xform/caseOps";
import { planConstraintCollections } from "../../xform/constraintCollections";
import { datetimeCaseValue } from "../../xform/datetimeCaseValue";
import { formCasePropertyRead } from "../../xform/formCaseRead";
import {
	type FormExpressionEmission,
	formExpressionEmission,
} from "../../xform/formExpressions";
import { FormPath } from "../../xform/formPath";
import { planGeneratedNodes } from "../../xform/generatedNodes";
import { itextIdFor } from "../../xform/itextIds";
import { parseFormExpression } from "../../xpath/expressionAst";
import {
	type FormNodeProjection,
	formNodeProjection,
} from "../../xpath/formNodeProjection";
import {
	type FormParseIssue,
	FormParseRefusal,
} from "../../xpath/formParseIssues";
import type {
	FoldApi,
	FormParseScope,
	FormReadingHooks,
} from "../../xpath/formParseScope";
import { canonicalInstanceId } from "../../xpath/formPathBinding";
import { type FormSyntax, formSyntaxKey } from "../../xpath/formSyntax";
import { JAVAROSA_NATIVE_FUNCTIONS } from "../../xpath/functionCapabilities";
import { w } from "../../xpath/wire/builders";
import { toWire, type WireTermBindings } from "../../xpath/wire/fromExpression";
import { InstanceSink } from "../../xpath/wire/instances";
import { serializeWire } from "../../xpath/wire/serialize";
import type { WireExpr } from "../../xpath/wire/tree";
import {
	type HqInterpolationSlot,
	hqInterpolationSlot,
	interpolateHqXPath,
	syntaxOf,
} from "../hqInterpolation";
import type { PendingExpression, ReadMode } from "../pendingExpressions";
import {
	type CompareOptions,
	firstDifference,
	sameSyntax,
	sameXPathText,
} from "../syntaxCompare";
import { readFormSyntax } from "../syntaxRead";
import type { ReadSourceNames, SourceNodeRef } from "../xform";
import type { SlotPrint } from "./canonical";
import {
	core,
	EXPRESSION_FOLDS,
	type FoldEnv,
	type OperationPlaceReads,
	recordOnlyArm,
} from "./folds";
import type { ExpressionReadEnv } from "./index";
import {
	holdsUntypedTemporalLiteral,
	typedWhereRequired,
} from "./temporalLiterals";

// ── The mode a slot prints in ────────────────────────────────────────

/** The mode a slot's expression prints in: the XForm attribute it is, or the
 *  HQ JSON interpolation it carries. A search filter row is no slot's: it
 *  prints as CSQL, which `csqlRead.ts` compares. */
export type SlotPrintMode = Extract<
	ReadMode,
	{ readonly target: "xform" | "hq-json" }
>;

/** The mode the production emitter prints a slot in: the HQ JSON
 *  interpolation it carries, or the XForm attribute it is (a validation
 *  condition prints a predicate's own node as `.`). */
export function slotReadMode(
	doc: BlueprintDoc,
	ref: SlotContextRef,
): SlotPrintMode {
	if (ref.entity === "field")
		return { target: "xform", constraint: ref.slot === "validate" };
	if (ref.entity === "form") {
		switch (ref.slot) {
			case "form_display_condition": {
				const form = doc.forms[ref.uuid];
				return {
					target: "hq-json",
					interpolation:
						form !== undefined && CASE_LOADING_FORM_TYPES.has(form.type)
							? "case"
							: "no-case",
				};
			}
			case "form_entry_value":
			case "form_selection_source":
			case "form_link_condition":
			case "form_link_datum_xpath":
				return { target: "hq-json", interpolation: "none" };
			default:
				return { target: "xform", constraint: false };
		}
	}
	return { target: "hq-json", ...moduleSlotMode(ref.slot) };
}

/** Whether two stored texts of an HQ JSON slot are one expression to a
 *  runtime: each interpolated as HQ's build interpolates the slot
 *  (`hqInterpolation.ts::interpolateHqXPath`, which writes `#session/` as
 *  `instance('commcaresession')/session/`), then compared as one tree. Where
 *  either text has no interpolation for the slot (a case shorthand on a slot
 *  that opens no case), the two are compared as stored. */
export function sameSlotText(
	doc: BlueprintDoc,
	ref: SlotContextRef,
	a: string,
	b: string,
): boolean {
	const mode = slotReadMode(doc, ref);
	const slot =
		mode.target === "hq-json" &&
		mode.interpolation !== "none" &&
		mode.interpolation !== "enum-key"
			? hqInterpolationSlot(doc, ref, mode.interpolation)
			: undefined;
	if (slot !== undefined) {
		const left = syntaxOf(a, slot);
		const right = syntaxOf(b, slot);
		if (left.ok && right.ok) return sameSyntax(left.syntax, right.syntax);
	}
	return sameXPathText(a, b);
}

function moduleSlotMode(
	slot: Extract<SlotContextRef, { entity: "module" }>["slot"],
): { readonly interpolation: HqInterpolation } {
	switch (slot) {
		case "module_display_condition":
		case "search_input_required_when":
			return { interpolation: "no-case" };
		case "case_list_filter":
			return { interpolation: "case" };
		case "search_input_validation_rule":
			return { interpolation: "no-dots" };
		default:
			return { interpolation: "none" };
	}
}

// ── The scope ────────────────────────────────────────────────────────

/** The form whose answers a slot's context reads, if any. */
export function slotForm(
	doc: BlueprintDoc,
	ref: SlotContextRef,
): Uuid | undefined {
	if (ref.entity === "form") return ref.uuid;
	if (ref.entity === "field") return formOfField(doc, ref.uuid);
	return undefined;
}

/** Core's function names, with the handlers the parser admits: the only
 *  names an app's text may call. */
const READ_FUNCTIONS: ReadonlySet<string> = new Set([
	...JAVAROSA_NATIVE_FUNCTIONS,
	"jr:itext",
	"jr:choice-name",
	"here",
	"instance",
	"current",
]);

/** The source references a node of the graph may be named by, in the order
 *  a source is asked for them: a count placement's element, then model
 *  iteration's attribute. */
function sourceRefsOf(
	form: ReturnType<typeof formStructure>,
	node: FormNodeRef,
): readonly SourceNodeRef[] {
	switch (node.kind) {
		case "field": {
			const field = form?.fields.get(node.uuid);
			if (
				field?.kind === "repeat" &&
				field.repeatMode === "query_bound" &&
				node.role === undefined
			)
				return [{ kind: "query-row", repeat: node.uuid }];
			return [{ kind: "field", uuid: node.uuid }];
		}
		case "repeat-row":
			return [
				{
					kind: "generated",
					purpose: node.attribute === "id" ? "query-id" : "query-index",
					owner: node.repeat,
				},
				{
					kind: "repeat-attribute",
					repeat: node.repeat,
					attribute: node.attribute,
				},
			];
		case "repeat":
			if (node.role === "count-result")
				return [{ kind: "generated", purpose: "count", owner: node.repeat }];
			return [
				{ kind: "generated", purpose: node.role, owner: node.repeat },
				{
					kind: "repeat-attribute",
					repeat: node.repeat,
					attribute:
						node.role === "query-ids"
							? "ids"
							: node.role === "query-count"
								? "count"
								: "current_index",
				},
			];
		default:
			return [];
	}
}

/** The projection that names each node of `form` as the source named it
 *  (the form's own root, each field under its source name, and each
 *  generated node the form reader folded under the name the source gave
 *  it), and as the emitter names it where the source names it nothing. */
export function sourceNodeProjection(
	doc: BlueprintDoc,
	form: Uuid,
	names: ReadSourceNames,
): FormNodeProjection {
	const structure = formStructure(doc, form);
	if (structure === undefined)
		throw new Error(
			`The form ${form} has no complete structure to name. The reader builds a source projection only for a form the provisional document holds.`,
		);
	const wire = formNodeProjection(doc, structure, { surface: "wire" });
	const step: FormNodeProjection["step"] = (node) => {
		const own = wire.step(node);
		if (own === undefined) return undefined;
		if (node.kind === "form-root") return { name: names.root };
		for (const ref of sourceRefsOf(structure, node)) {
			const path = names.nodePath(ref);
			const name = path?.at(-1);
			// A source path spells an attribute's segment with its `@`.
			if (name !== undefined)
				return ref.kind === "repeat-attribute"
					? {
							name: name.startsWith("@") ? name.slice(1) : name,
							attribute: true,
						}
					: { name };
		}
		return own;
	};
	return {
		graph: wire.graph,
		step,
		path(node) {
			const coordinates = wire.graph.path(node);
			if (coordinates === undefined) return undefined;
			// A form path is rooted at `data`, the root every source Nova reads
			// holds; a source rooted elsewhere prints otherwise and reads as
			// unrecognized.
			let path = FormPath.root();
			for (const coordinate of coordinates.slice(1)) {
				const projected = step(coordinate);
				if (projected === undefined) return undefined;
				path = projected.attribute
					? path.attr(projected.name)
					: path.child(projected.name);
			}
			return path;
		},
	};
}

/** A fold site recorder for one bind, and the nodes a fold is binding
 *  plainly, which are offered no fold. */
interface FoldSites {
	readonly used: Set<string>;
	readonly spans: Map<string, { readonly from: number; readonly to: number }>;
	readonly plain: Set<FormSyntax>;
	/** Set where the bind read the listed case inside another query of cases. */
	listedCaseInQuery?: true;
}

/** The scope a registration's text binds in: the slot of the real
 *  document, the lookup catalog, the source's own names and the reading
 *  hook. `withdrawn` holds the fold sites withdrawn so far in this slot,
 *  as `foldId:from:to`. */
export function readingScope(
	doc: BlueprintDoc,
	pending: PendingExpression,
	env: ExpressionReadEnv,
	withdrawn: ReadonlySet<string>,
): FormParseScope {
	return scopeWith(doc, pending, env, withdrawn, {
		used: new Set(),
		spans: new Map(),
		plain: new Set(),
	});
}

function scopeWith(
	doc: BlueprintDoc,
	pending: PendingExpression,
	env: ExpressionReadEnv,
	withdrawn: ReadonlySet<string>,
	sites: FoldSites,
	root?: FormSyntax,
): FormParseScope {
	const form = slotForm(doc, pending.ref);
	const names = form === undefined ? undefined : env.sourceNames.get(form);
	const itextUnits = form === undefined ? undefined : env.itextUnits.get(form);
	const instanceSources =
		form === undefined ? undefined : env.instanceSources.get(form);
	const generated =
		form === undefined ? undefined : env.generatedValues.get(form);
	const operationIdPaths =
		(form === undefined ? undefined : env.operationIdPaths.get(form)) ??
		new Map<string, Uuid>();
	const sourceProjection =
		form !== undefined && names !== undefined
			? sourceNodeProjection(doc, form, names)
			: undefined;
	const place =
		form !== undefined && caseOperationSlot(pending.ref)
			? operationPlaceReads(doc, form, pending.ref, env)
			: undefined;
	const reading: FormReadingHooks = {
		functions: READ_FUNCTIONS,
		itextUnit: (id) => itextUnits?.get(id),
		instanceSource: (id) => instanceSources?.get(id),
		generatedValue: (path) => generated?.get(path)?.calculate,
		fold: (node, context, api) =>
			proposeFold(node, context, api, {
				doc,
				operationIdPaths,
				withdrawn,
				sites,
				...(place === undefined ? {} : { place }),
				...(root === undefined ? {} : { root }),
			}),
		// Core's casedb answers a `name` step with a blank node
		// (`CaseChildElement.getChildrenWithName`), so in an app's text it is
		// a read of the property called `name`, never the case's name.
		caseNameAlias: false,
		listedCaseInQuery: () => {
			sites.listedCaseInQuery = true;
		},
	};
	return {
		doc,
		slot: pending.ref,
		lookup: env.lookup,
		...(sourceProjection === undefined ? {} : { sourceProjection }),
		reading,
	};
}

/** The site key of one fold over one span of the source. */
export function foldSite(
	id: string,
	span: { readonly from: number; readonly to: number },
): string {
	return `${id}:${span.from}:${span.to}`;
}

/** The first proposal of the slot's rule set's folds, in table order, at a
 *  site not withdrawn. A proposal whose parts the binder refuses is no
 *  proposal: the node binds plainly. */
function proposeFold(
	node: FormSyntax,
	context: ExpressionContext,
	api: FoldApi,
	options: {
		readonly doc: BlueprintDoc;
		readonly operationIdPaths: ReadonlyMap<string, Uuid>;
		readonly withdrawn: ReadonlySet<string>;
		readonly sites: FoldSites;
		readonly place?: OperationPlaceReads;
		readonly root?: FormSyntax;
	},
): Expression | undefined {
	if (options.sites.plain.has(node)) return undefined;
	for (const fold of EXPRESSION_FOLDS) {
		if (!fold.ruleSets.includes(context.ruleSet)) continue;
		const own = foldSite(fold.id, node);
		if (options.withdrawn.has(own)) continue;
		const reported: string[] = [];
		let ownReading = false;
		const env: FoldEnv = {
			doc: options.doc,
			operationIdPaths: options.operationIdPaths,
			withdrawn: options.withdrawn,
			...(options.place === undefined ? {} : { place: options.place }),
			...(options.root === undefined ? {} : { root: options.root }),
			bindPlain(at, context) {
				options.sites.plain.add(at);
				try {
					return api.bind(at, context);
				} finally {
					options.sites.plain.delete(at);
				}
			},
			use(span) {
				const site = foldSite(fold.id, span);
				if (options.withdrawn.has(site)) return false;
				reported.push(site);
				options.sites.spans.set(site, span);
				return true;
			},
			ownReading() {
				ownReading = true;
			},
		};
		let proposal: Expression | undefined;
		try {
			proposal = fold.propose(node, context, api, env);
		} catch (error) {
			rethrowWorkStop(error);
			if (error instanceof FormParseRefusal) continue;
			throw error;
		}
		if (proposal === undefined) continue;
		if (context.ruleSet === "form" && recordOnlyArm(proposal))
			throw new Error(
				`The fold ${fold.id} proposed a tree in a ${context.ruleSet} slot it isn't offered to. Check \`EXPRESSION_FOLDS\`: a fold names the rule sets whose slots can hold its arm.`,
			);
		// The node's own reading claims no site, as a plain binding claims none.
		if (ownReading) return proposal;
		if (reported.length === 0) {
			options.sites.used.add(own);
			options.sites.spans.set(own, node);
		} else for (const site of reported) options.sites.used.add(site);
		return proposal;
	}
	return undefined;
}

// ── The print ────────────────────────────────────────────────────────

/** The lookup naming a reading prints under: the catalog's tags and column
 *  names. The naming reads each definition's id, tag and columns alone,
 *  which the catalog's index holds. */
const namings = new WeakMap<object, LookupWireNaming>();
function namingOf(env: ExpressionReadEnv): LookupWireNaming {
	let naming = namings.get(env.lookup);
	if (naming === undefined) {
		naming = lookupWireNaming([
			...env.lookup.values(),
		] as unknown as readonly LookupTableDefinition[]);
		namings.set(env.lookup, naming);
	}
	return naming;
}

/** The entry projection the emitter reads datum ids and links through. */
const linkContexts = new WeakMap<
	BlueprintDoc,
	Map<LookupWireNaming, FormLinkProjectionContext>
>();
function linkContextOf(
	doc: BlueprintDoc,
	naming: LookupWireNaming,
): FormLinkProjectionContext {
	let byNaming = linkContexts.get(doc);
	if (byNaming === undefined) {
		byNaming = new Map();
		linkContexts.set(doc, byNaming);
	}
	let context = byNaming.get(naming);
	if (context === undefined) {
		context = formLinkProjectionContext(doc, {
			entryMetadataOnly: true,
			attachmentTarget: null,
			lookupNaming: naming,
		});
		byNaming.set(naming, context);
	}
	return context;
}

/** A form's expression emission as the XForm builder builds it for the
 *  form's source: the form's case reads from its own case, the worker
 *  property slugs, the levels, the tables, the Search answers its forms
 *  read and the ids its entry prints datums under. */
function formEmission(
	doc: BlueprintDoc,
	formUuid: Uuid,
	naming: LookupWireNaming,
	print: {
		readonly projection?: FormNodeProjection;
		readonly rewrites?: RewriteControl;
	},
): {
	readonly emission: FormExpressionEmission;
	readonly bindings: WireTermBindings;
} {
	const form = doc.forms[formUuid];
	const moduleUuid = moduleUuidOfForm(doc, formUuid);
	if (form === undefined || moduleUuid === undefined)
		throw new Error(
			`The form ${formUuid} has no menu to print its expressions in. The reader prints a slot only of a form the provisional document holds.`,
		);
	const mod = doc.modules[moduleUuid];
	const links = linkContextOf(doc, naming);
	const own = selectedCaseSessionDatum(doc, links, moduleUuid, formUuid);
	const searchAnswers =
		moduleFormsReadSearch(mod) ||
		afterEmptySearchRegistrationFormOf(doc, moduleUuid) === formUuid
			? searchAnswersOf(doc, moduleUuid)
			: undefined;
	let datumId: WireTermBindings["datumId"];
	const bindings: WireTermBindings = {
		formCaseProperty: formCasePropertyRead({
			formType: form.type,
			caseTypeHops: caseTypeHopMap(doc, mod?.caseType),
			moduleCaseType: mod?.caseType,
			...(own !== undefined && own.maxSelectValue === undefined
				? { selectedCaseId: sessionDataRef(own.id) }
				: {}),
		}),
		userPropertySlugs: userPropertySlugsByUuid(doc),
		organizationLevels: doc.organizationLevels ?? NO_ENTRIES,
		lookup: { naming, instanceScope: "xform" },
		...(searchAnswers === undefined
			? {}
			: {
					searchInputInstanceId: searchAnswers.instanceId,
					searchInputNames: searchAnswers.names,
				}),
		datumId: (ref) => {
			datumId ??= entryDatumIdResolver(
				entryDatumIds(doc, links, moduleUuid, formUuid),
			);
			return datumId(ref);
		},
	};
	return {
		emission: formExpressionEmission(
			doc,
			formUuid,
			naming,
			bindings,
			doc,
			print,
		),
		bindings,
	};
}

/** The slots of a form the case operation emitter prints: a Save to Case
 *  block's expressions, and the form's own open and close conditions where
 *  a block of its own holds them. */
function caseOperationSlot(
	ref: SlotContextRef,
): ref is Extract<SlotContextRef, { entity: "form" }> {
	return (
		ref.entity === "form" &&
		(ref.slot.startsWith("case_operation_") ||
			ref.slot === "form_open_condition" ||
			ref.slot === "form_close_condition")
	);
}

/** Whether `expression`, a case write's whole value, is a literal the
 *  emitter writes as the text CommCare HQ stores for a moment: a write to a
 *  date-and-time property takes its value through `datetimeCaseValue`
 *  (`xform/caseOps.ts`), which folds a literal to that text and wraps every
 *  other value, a wrapper the case reader takes off before it registers the
 *  value, so only a literal is printed through it here. */
function writesStoredInstantLiteral(
	doc: BlueprintDoc,
	formUuid: Uuid,
	ref: Extract<SlotContextRef, { entity: "form" }>,
	expression: Expression,
): boolean {
	if (
		ref.slot !== "case_operation_write_value" ||
		expression.kind !== "term" ||
		expression.term.kind !== "literal"
	)
		return false;
	const member = ref.member as {
		readonly operationUuid?: Uuid;
		readonly property?: string;
	};
	const operation = doc.forms[formUuid]?.caseOperations?.find(
		(candidate) => candidate.uuid === member.operationUuid,
	);
	if (operation === undefined) return false;
	const caseType =
		(operation as { readonly retype?: string }).retype ??
		operationCaseType(doc, formUuid, operation);
	return (
		effectiveCaseTypes(doc)
			.find((type) => type.name === caseType)
			?.properties.find((property) => property.name === member.property)
			?.data_type === "datetime"
	);
}

/** Where the production emitter prints each case operation expression of a
 *  form (`xform/caseOps.ts::buildCaseOperations`), per document, naming and
 *  form: the bindings of the node the expression's text stands in. */
const placeCache = new WeakMap<
	BlueprintDoc,
	WeakMap<LookupWireNaming, Map<Uuid, CaseOperationPlaces | Error>>
>();
function caseOperationPlaces(
	doc: BlueprintDoc,
	formUuid: Uuid,
	naming: LookupWireNaming,
	emission: FormExpressionEmission,
): CaseOperationPlaces {
	let byNaming = placeCache.get(doc);
	if (byNaming === undefined) {
		byNaming = new WeakMap();
		placeCache.set(doc, byNaming);
	}
	let byForm = byNaming.get(naming);
	if (byForm === undefined) {
		byForm = new Map();
		byNaming.set(naming, byForm);
	}
	let places = byForm.get(formUuid);
	if (places === undefined) {
		try {
			const found: CaseOperationPlaces = new Map();
			const moduleUuid = moduleUuidOfForm(doc, formUuid);
			const mod =
				moduleUuid === undefined ? undefined : doc.modules[moduleUuid];
			const own =
				moduleUuid === undefined
					? undefined
					: selectedCaseSessionDatum(
							doc,
							linkContextOf(doc, naming),
							moduleUuid,
							formUuid,
						);
			const several = own?.maxSelectValue !== undefined;
			buildCaseOperations(
				doc,
				formUuid,
				planGeneratedNodes(doc, formUuid),
				mod?.caseType || undefined,
				new InstanceSink(),
				emission,
				naming,
				own !== undefined && !several ? sessionDataRef(own.id) : undefined,
				several ? own?.id : undefined,
				null,
				found,
			);
			places = found;
		} catch (error) {
			rethrowWorkStop(error);
			places = error instanceof Error ? error : new Error(String(error));
		}
		byForm.set(formUuid, places);
	}
	if (places instanceof Error) throw places;
	return places;
}

/** What the emitter prints through `current()` at the node a Save to Case
 *  block's expression stands in (its place, `caseOperationPlaces`), parsed
 *  and keyed by syntax; undefined where no block holds the slot. */
const placeReads = new WeakMap<WireTermBindings, OperationPlaceReads>();
function operationPlaceReads(
	doc: BlueprintDoc,
	formUuid: Uuid,
	ref: Extract<SlotContextRef, { entity: "form" }>,
	env: ExpressionReadEnv,
): OperationPlaceReads | undefined {
	const naming = namingOf(env);
	let bindings: WireTermBindings | undefined;
	try {
		bindings = caseOperationPlaces(
			doc,
			formUuid,
			naming,
			formEmission(doc, formUuid, naming, {}).emission,
		).get(caseOperationPlaceKey(ref));
	} catch (error) {
		rethrowWorkStop(error);
		// The emitter builds no block for this form, so nothing is printed
		// from a block's node.
		return undefined;
	}
	if (bindings === undefined) return undefined;
	let reads = placeReads.get(bindings);
	if (reads === undefined) {
		let keys = currentRootedKeys.get(doc);
		if (keys === undefined) {
			keys = new Map();
			currentRootedKeys.set(doc, keys);
		}
		reads = {
			operationIds: currentRootedReads(bindings.operationIds, keys),
			fields: currentRootedReads(bindings.formFields, keys),
		};
		placeReads.set(bindings, reads);
	}
	return reads;
}

/** What the emitter's print of a slot binds beside its context: where a
 *  Save to Case block's node holds the slot, the questions its place binds,
 *  each read of which prints as that binding whatever its spelling. */
export function slotPrint(
	doc: BlueprintDoc,
	ref: SlotContextRef,
	env: ExpressionReadEnv,
): SlotPrint {
	return slotPrintUnder(doc, ref, namingOf(env));
}

/** `slotPrint` under a lookup naming the caller holds: the questions a
 *  block's place binds are the same under every naming, which names only
 *  tables and columns. */
export function slotPrintUnder(
	doc: BlueprintDoc,
	ref: SlotContextRef,
	naming: LookupWireNaming,
): SlotPrint {
	// A select's choices from a table or from cases print every question of
	// the form through `bindLookupFilterFieldPaths` (the slot's print above),
	// so a read of any of them prints its binding whatever its spelling.
	if (ref.entity === "field" && ref.slot === "lookup_options_source") {
		const formUuid = slotForm(doc, ref);
		return formUuid === undefined
			? {}
			: {
					boundFields: new Set(collectFieldLocations(doc, formUuid).keys()),
				};
	}
	if (!caseOperationSlot(ref)) return {};
	let bindings: WireTermBindings | undefined;
	try {
		bindings = caseOperationPlaces(
			doc,
			ref.uuid,
			naming,
			formEmission(doc, ref.uuid, naming, {}).emission,
		).get(caseOperationPlaceKey(ref));
	} catch (error) {
		rethrowWorkStop(error);
		// The emitter builds no block for this form.
		return {};
	}
	return bindings?.formFields === undefined
		? {}
		: { boundFields: new Set(bindings.formFields.keys()) };
}

/** The syntax key of each text a block's place prints, or undefined where the
 *  text is not read from `current()`, per document: every place of a form
 *  prints its reads at its own depth, so places at one depth print the same
 *  texts, and each is read with the grammar once. */
const currentRootedKeys = new WeakMap<
	BlueprintDoc,
	Map<string, string | undefined>
>();

/** Each of `wires` the emitter prints from `current()`, by the key of its
 *  parsed syntax. A path from any other root (the form's, an instance's)
 *  prints no `current()`, so it is neither printed nor read. */
function currentRootedReads(
	wires: ReadonlyMap<Uuid, WireExpr> | undefined,
	keys: Map<string, string | undefined>,
): ReadonlyMap<string, Uuid> {
	const keyed = new Map<string, Uuid>();
	for (const [uuid, wire] of wires ?? []) {
		if (wire.k === "path" && wire.root.k !== "current") continue;
		const text = serializeWire(wire, {
			target: "xform",
			constraint: false,
		}).text;
		let key = keys.get(text);
		if (!keys.has(text)) {
			key = currentRootedKey(text);
			keys.set(text, key);
		}
		if (key !== undefined) keyed.set(key, uuid);
	}
	return keyed;
}

/** The key of `text`'s parsed syntax where it is read from `current()`. */
function currentRootedKey(text: string): string | undefined {
	const read = readFormSyntax(text);
	const node = read.ok ? read.node : undefined;
	if (node === undefined) return undefined;
	let root = core(node);
	while (root.kind === "child" && root.left !== undefined)
		root = core(root.left);
	return root.kind === "call" && root.name === "current"
		? formSyntaxKey(core(node))
		: undefined;
}

/** The predicate a generated nodeset holds on its row step, as the
 *  emitter prints it inside the nodeset: the `index`-th predicate of the
 *  last step, or undefined where the emitter wrote none. */
function rowPredicate(nodeset: WireExpr, index: number): WireExpr | undefined {
	if (nodeset.k !== "path") return undefined;
	return nodeset.steps.at(-1)?.predicates[index];
}

/** The owner list inside `suite/wire.ts::normalizeSpace`'s two `replace`
 *  calls, as `emitNormalizedExcludedOwnerIdsExpression` builds them. */
function normalizedList(wire: WireExpr): WireExpr {
	const outer =
		wire.k === "call" && wire.fn === "replace" ? wire.args[0] : undefined;
	const inner =
		outer?.k === "call" && outer.fn === "replace" ? outer.args[0] : undefined;
	if (inner === undefined)
		throw new Error(
			"The owner list is no longer written inside the whitespace normalization of `suite/wire.ts::normalizeSpace`. The search reader removes that wrapper before the list is read; change the two together.",
		);
	return inner;
}

/**
 * The ids of a form's earlier creates as a Save to Case block's expression
 * prints them under a print control. The emitter prints each from the node
 * the expression stands in, through `current()`
 * (`xform/caseOps.ts::bindOperationPaths`), where an author in CommCare HQ
 * may write the create block's absolute path (`paths`, the form's
 * `DraftForm.operationIdPaths`). Core resolves the two to one node wherever
 * the absolute path names one: a create outside every repeat, or a create in
 * the block's own repeat read outside a row predicate, which Core
 * contextualizes to the block's entry (`TreeReference.contextualize`), so
 * there the relocation is `default-reads-current`, as it is for an answer's
 * read (`xpath/wire/formReads.ts::placeBindingWithheld`). Inside a row
 * predicate (a runtime target's selector, or a row read's filter) the
 * absolute path of a create in a repeat names every entry, and the
 * relocation is `row-predicate-current`. Where the control withholds the
 * relocation at a site, the read prints the absolute path; a create of
 * Case Management, which no block holds, has none. The emitter asks the map
 * once per read, in print order, the order a site level counts.
 */
function relocatedOperationIds(
	doc: BlueprintDoc,
	formUuid: Uuid,
	ref: SlotContextRef,
	expression: Expression,
	types: ExpressionContext,
	ids: ReadonlyMap<Uuid, WireExpr> | undefined,
	paths: ReadonlyMap<string, Uuid> | undefined,
	rewrites: RewriteControl,
): ReadonlyMap<Uuid, WireExpr> | undefined {
	if (ids === undefined || paths === undefined || paths.size === 0) return ids;
	const absolute = new Map<Uuid, WireExpr>();
	for (const [text, uuid] of paths) {
		// The path the case reader built from the block's node names
		// (`saveToCase.ts::createPaths`), `/<root>/<name>/…/@case_id`.
		const [, , ...names] = text.split("/");
		if (names.length === 0) continue;
		absolute.set(
			uuid,
			w.form(
				names.map((name) =>
					name.startsWith("@") ? w.attr(name.slice(1)) : w.step(name),
				),
			),
		);
	}
	const repeated = new Set(
		(doc.forms[formUuid]?.caseOperations ?? []).flatMap((operation) =>
			operation.forEach?.repeat === undefined ? [] : [operation.uuid],
		),
	);
	const selector =
		ref.slot === "case_operation_target_expression" ||
		ref.slot === "case_operation_link_target_expression";
	const root = activeRowScope(types);
	const inRowPredicate = new Set<Uuid>();
	walkExpression(expression, {
		visitExpression(node, path) {
			if (node.kind !== "id-of") return;
			if (
				selector ||
				activeRowScope(expressionContextAtPath(expression, types, path)) !==
					root
			)
				inRowPredicate.add(node.opUuid);
		},
	});
	const relocated: ReadonlyMap<Uuid, WireExpr> = {
		get size() {
			return ids.size;
		},
		has: (uuid) => ids.has(uuid),
		get(uuid) {
			const printed = ids.get(uuid);
			const spelled = absolute.get(uuid);
			if (printed === undefined || spelled === undefined) return printed;
			return rewriteWithheld(
				rewrites,
				repeated.has(uuid) && inRowPredicate.has(uuid)
					? "row-predicate-current"
					: "default-reads-current",
			)
				? spelled
				: printed;
		},
		forEach: (visit, self) => ids.forEach(visit, self),
		entries: () => ids.entries(),
		keys: () => ids.keys(),
		values: () => ids.values(),
		[Symbol.iterator]: () => ids[Symbol.iterator](),
	};
	return relocated;
}

/** The text the production emitter writes for `expression` in `ref`'s
 *  slot, in `slotReadMode(doc, ref)`, with `rewrites` withheld or reported.
 *  Throws where the emitter refuses the tree, which the checker refuses. */
export function printSlot(
	doc: BlueprintDoc,
	ref: SlotContextRef,
	expression: Expression,
	env: ExpressionReadEnv,
	print: {
		readonly projection?: FormNodeProjection;
		readonly rewrites?: RewriteControl;
	} = {},
): string {
	return printSlotWith(
		doc,
		ref,
		expression,
		namingOf(env),
		env.operationIdPaths,
		print,
	);
}

/**
 * `printSlot` under a lookup naming the caller holds and with no rewrite withheld, which reads
 * nothing of a reading: the export's print of a document's own slot, as the canonical form asks
 * it of every rewrite it makes (`canon.ts`). Undefined where the emitter refuses the tree.
 */
export function printSlotUnder(
	doc: BlueprintDoc,
	ref: SlotContextRef,
	expression: Expression,
	naming: LookupWireNaming,
): string | undefined {
	try {
		return printSlotWith(doc, ref, expression, naming, NO_OPERATION_IDS, {});
	} catch (error) {
		rethrowWorkStop(error);
		return undefined;
	}
}

const NO_OPERATION_IDS: ExpressionReadEnv["operationIdPaths"] = new Map();

function printSlotWith(
	doc: BlueprintDoc,
	ref: SlotContextRef,
	expression: Expression,
	naming: LookupWireNaming,
	operationIdPaths: ExpressionReadEnv["operationIdPaths"],
	print: {
		readonly projection?: FormNodeProjection;
		readonly rewrites?: RewriteControl;
	},
): string {
	const mode = slotReadMode(doc, ref);
	const text = (wire: WireExpr | undefined): string => {
		if (wire === undefined) return "";
		return serializeWire(wire, mode).text;
	};
	const hq = (value: HqXPath | null): string =>
		value === null ? "" : hqXPathText(value);
	if (ref.entity === "module") {
		const mod = doc.modules[ref.uuid];
		if (mod === undefined)
			throw new Error(`The menu ${ref.uuid} is not in the document.`);
		const expressions = moduleExpressionContexts(doc, ref.uuid, naming);
		const rewrites = print.rewrites;
		switch (ref.slot) {
			case "module_display_condition":
				return text(
					emitModuleDisplayCondition(
						{ displayCondition: expression },
						expressions({ slot: ref.slot }),
						naming,
						rewrites,
					),
				);
			case "case_list_filter":
				// The case a menu above chose, under its id before HQ aligns a
				// child entry with its root menu, as the emitter writes it.
				return hq(
					projectCaseListFilter(
						expression,
						undefined,
						expressions,
						naming,
						caseListStepDatumId(doc, ref.uuid, "chainId"),
						rewrites,
					),
				);
			case "search_button_display_condition":
				return hq(
					projectSearchButtonCondition(
						expression,
						expressions,
						naming,
						rewrites,
					),
				);
			case "excluded_owner_ids":
				// The search reader registers the list without the whitespace
				// normalization the emitter writes around it, so the list is
				// printed without it too.
				return text(
					normalizedList(
						emitNormalizedExcludedOwnerIdsExpression(
							expression,
							expressions({ slot: ref.slot }),
							naming,
							searchInstanceOf(mod),
							rewrites,
						),
					),
				);
			case "case_list_column_expression": {
				const column = mod.caseListConfig?.columns.find(
					(candidate) => candidate.uuid === ref.member.columnUuid,
				);
				if (column?.kind !== "calculated")
					throw new Error(
						`The column ${ref.member.columnUuid} is no calculated column of its menu.`,
					);
				return text(
					hqExpressionField(
						{ ...column, expression },
						mod,
						doc,
						"details",
						naming,
						expressions,
						rewrites,
					),
				);
			}
			case "search_input_predicate":
				throw new Error("A search filter row prints as CSQL, never here.");
			default: {
				const input = mod.caseListConfig?.searchInputs.find(
					(candidate) => candidate.uuid === ref.member.searchInputUuid,
				);
				if (input === undefined)
					throw new Error(
						`The Search field ${ref.member.searchInputUuid} is not in its menu.`,
					);
				// The control reaches this slot's print alone: the field's other slots print too, as
				// the export prints them.
				const slot = ref.slot;
				const wire = searchPromptWire(
					withSearchSlot(input, slot, expression),
					undefined,
					expressions,
					naming,
					searchInstanceOf(mod),
					(one) => (one === slot ? rewrites : undefined),
				);
				switch (ref.slot) {
					case "search_input_default":
					case "search_input_hidden_value":
						return text(wire.defaultValue);
					case "search_input_required_when":
						return text(wire.required?.test);
					case "search_input_validation_rule":
						return text(wire.validation?.test);
					case "search_input_options":
						return text(
							wire.itemset === undefined
								? undefined
								: rowPredicate(wire.itemset.nodeset, 0),
						);
				}
			}
		}
	}
	const formUuid = slotForm(doc, ref);
	if (formUuid === undefined)
		throw new Error(`The slot ${ref.slot} of ${ref.uuid} has no form.`);
	const { emission, bindings } = formEmission(doc, formUuid, naming, print);
	if (ref.entity === "form") {
		if (ref.slot === "form_display_condition") {
			const moduleUuid = moduleUuidOfForm(doc, formUuid);
			if (moduleUuid === undefined)
				throw new Error(`The form ${formUuid} has no menu.`);
			const links = linkContextOf(doc, naming);
			const own = selectedCaseSessionDatum(doc, links, moduleUuid, formUuid);
			return text(
				emitFormDisplayConditionForHq(
					{ displayCondition: expression },
					emission.context(ref),
					naming,
					own?.id,
					entryDatumIdResolver(entryDatumIds(doc, links, moduleUuid, formUuid)),
					print.rewrites,
				),
			);
		}
		if (
			ref.slot === "form_selection_source" ||
			ref.slot === "form_entry_value"
		) {
			const menu = moduleUuidOfForm(doc, formUuid);
			if (!menu) throw new Error(`The form ${formUuid} has no menu.`);
			const datumId = entryDatumIdResolver(
				entryDatumIds(doc, linkContextOf(doc, naming), menu, formUuid),
			);
			return text(
				entryValueWire(
					doc,
					formUuid,
					ref.member.supplyUuid,
					ref.slot,
					expression,
					datumId,
					naming,
				),
			);
		}
		if (
			ref.slot === "form_link_condition" ||
			ref.slot === "form_link_datum_xpath"
		)
			return text(
				projectFormLinkSessionExpression(
					doc,
					linkContextOf(doc, naming),
					formUuid,
					expression,
					ref,
					print.rewrites,
				),
			);
		if (caseOperationSlot(ref)) {
			// A Save to Case block's expression prints with the bindings of the
			// node it stands in: answers in its repeat and earlier creates'
			// ids through `current()`, the case read from the block's case.
			const place = caseOperationPlaces(
				doc,
				formUuid,
				naming,
				formEmission(doc, formUuid, naming, {}).emission,
			).get(caseOperationPlaceKey(ref));
			if (place !== undefined) {
				// The control reaches this print as it reaches every other, so a
				// guard or a lowering the block's value holds is withheld here too.
				const types = emission.context(ref);
				const build = {
					target: "xform",
					types,
					form: emission.projection,
					bindings:
						print.rewrites === undefined
							? place
							: {
									...place,
									operationIds: relocatedOperationIds(
										doc,
										formUuid,
										ref,
										expression,
										types,
										place.operationIds,
										operationIdPaths.get(formUuid),
										print.rewrites,
									),
								},
					...(print.rewrites === undefined ? {} : { rewrites: print.rewrites }),
				} as const;
				return text(
					writesStoredInstantLiteral(doc, formUuid, ref, expression)
						? datetimeCaseValue(expression, build)
						: toWire(expression, build),
				);
			}
			if (ref.slot.startsWith("case_operation_"))
				throw new Error(
					`No Save to Case block of form ${formUuid} holds its ${ref.slot}, so Nova writes that expression nowhere in the form's source.`,
				);
		}
		return text(emission.lower(expression, ref));
	}
	if (isProseSlotRef(ref)) return text(emission.lower(expression, ref));
	const field = doc.fields[ref.uuid];
	const projection = emission.projection;
	switch (ref.slot) {
		case "validate": {
			const path = projection.path({ kind: "field", uuid: ref.uuid });
			if (path === undefined)
				throw new Error(`The question ${ref.uuid} has no path to print.`);
			const generated = planGeneratedNodes(doc, formUuid);
			const plan = planConstraintCollections(
				expression,
				ref.uuid,
				doc,
				path,
				(n) => generated.constraintCount(ref.uuid, n),
				print.rewrites,
			);
			return text(emission.lower(plan.expression, ref, plan.overrides));
		}
		case "default_value":
			return field !== undefined &&
				fieldBindType(
					field,
					effectiveCaseTypes(doc),
					fieldCaseWriteViews(doc, ref.uuid),
				) === "xsd:dateTime"
				? text(emission.startingDatetime(expression, ref))
				: text(emission.lower(expression, ref));
		case "lookup_options_source": {
			const choices =
				field !== undefined && "optionsSource" in field
					? (field.optionsSource as SelectOptionsSource | undefined)
					: undefined;
			const path = projection.path({ kind: "field", uuid: ref.uuid });
			if (choices === undefined || choices.kind === "inline" || !path)
				throw new Error(
					`The question ${ref.uuid} takes no choices from a table or from cases.`,
				);
			const formFields = bindLookupFilterFieldPaths(
				collectFieldLocations(doc, formUuid),
				path,
			);
			if (choices.kind === "cases")
				return text(
					rowPredicate(
						caseOptionsNodeset(
							{ ...choices, filter: expression },
							emission.context(ref),
							{
								formFields,
								formCaseProperty: bindings.formCaseProperty,
								userPropertySlugs: userPropertySlugsByUuid(doc),
								lookup: { naming, instanceScope: "xform" },
							},
							projection,
							print.rewrites,
						),
						1,
					),
				);
			return text(
				rowPredicate(
					lookupOptionsNodeset(
						{ ...choices, filter: expression },
						{
							target: "xform",
							types: emission.context(ref),
							naming,
							instanceScope: "xform",
							form: projection,
							bindings: {
								formFields,
								userPropertySlugs: userPropertySlugsByUuid(doc),
							},
							...(print.rewrites === undefined
								? {}
								: { rewrites: print.rewrites }),
						},
					),
					0,
				),
			);
		}
		default:
			return text(emission.lower(expression, ref));
	}
}

/** The instance a menu's Search answers are read from, as the HQ JSON
 *  projection names it. */
function searchInstanceOf(
	mod: BlueprintDoc["modules"][string],
): `search-input:${string}` | undefined {
	const config = mod.caseSearchConfig;
	if (config === undefined) return undefined;
	const wire = searchWireShape(config);
	return wire === undefined ? undefined : searchInputInstanceId(wire);
}

/** A Search field with one of its expression slots holding `expression`. */
function withSearchSlot<
	T extends NonNullable<
		BlueprintDoc["modules"][string]["caseListConfig"]
	>["searchInputs"][number],
>(input: T, slot: string, expression: Expression): T {
	const record = input as T & Record<string, unknown>;
	switch (slot) {
		case "search_input_default":
			return { ...record, default: expression };
		case "search_input_hidden_value":
			return { ...record, value: expression };
		case "search_input_required_when":
			return {
				...record,
				required: { ...(record.required as object), when: expression },
			};
		case "search_input_validation_rule":
			return {
				...record,
				validation: { ...(record.validation as object), rule: expression },
			};
		case "search_input_options":
			return {
				...record,
				options: { ...(record.options as object), filter: expression },
			};
		default:
			return input;
	}
}

// ── One slot judged ──────────────────────────────────────────────────

/** Why a registration did not bind: HQ's interpolation refused the text, its
 *  syntax did not parse, the binder refused it, or the slot is a `case` slot
 *  of a form whose entry Nova's projection gives no case-selecting datum. */
export type SlotRefusal =
	| {
			readonly kind: "interpolation";
			readonly code: "case-reference" | "fixture-value";
	  }
	| { readonly kind: "syntax" }
	| { readonly kind: "parse"; readonly issues: readonly FormParseIssue[] }
	| { readonly kind: "no-case-datum" };

export type SlotJudgment =
	| { readonly kind: "refused"; readonly cause: SlotRefusal }
	| {
			readonly kind: "bound";
			readonly candidate: Expression;
			/** `S` and `P` of the method. */
			readonly source: FormSyntax;
			readonly print: FormSyntax;
			readonly equal: boolean;
			/** The fold sites the bind used, as `foldId:from:to` of the source,
			 *  outermost first. */
			readonly foldSites: readonly string[];
			/** The innermost used fold site whose span holds the first
			 *  difference, where the trees differ. */
			readonly withdraw?: string;
			/** The source node at which the trees first differ. */
			readonly difference?: FormSyntax;
	  }
	/** The emitter refused to print the candidate (it throws only for a tree
	 *  the checker refuses); the checker's refusal is the claim. */
	| {
			readonly kind: "unprintable";
			readonly candidate: Expression;
			readonly source: FormSyntax;
			readonly foldSites: readonly string[];
	  };

/** HQ's text as a runtime reads it, for this registration. */
export function preparedSource(
	doc: BlueprintDoc,
	pending: PendingExpression,
):
	| { readonly ok: true; readonly syntax: FormSyntax; readonly text: string }
	| { readonly ok: false; readonly cause: SlotRefusal } {
	const mode = pending.mode;
	let slot: HqInterpolationSlot | undefined;
	if (
		mode.target === "hq-json" &&
		mode.interpolation !== "none" &&
		mode.interpolation !== "enum-key"
	) {
		slot = hqInterpolationSlot(doc, pending.ref, mode.interpolation);
		if (slot === undefined)
			return { ok: false, cause: { kind: "no-case-datum" } };
	}
	const read = syntaxOf(pending.text, slot);
	if (read.ok) return read;
	return {
		ok: false,
		cause:
			read.reason === "syntax"
				? { kind: "syntax" }
				: { kind: "interpolation", code: read.reason },
	};
}

/** The comparison of a slot's two trees: its rule set and, for a form slot,
 *  the source's own instance and itext ids mapped to Nova's. */
export function compareOptionsFor(
	doc: BlueprintDoc,
	pending: PendingExpression,
	env: ExpressionReadEnv,
	ruleSet: RuleSet,
): CompareOptions {
	const form = slotForm(doc, pending.ref);
	const xform = slotReadMode(doc, pending.ref).target === "xform";
	if (form === undefined || !xform) return { ruleSet };
	const sources = env.instanceSources.get(form);
	const units = env.itextUnits.get(form);
	const structure = formStructure(doc, form);
	return {
		ruleSet,
		instanceId: (id) => {
			const source = sources?.get(id);
			if (source === undefined) return id;
			const canonical = canonicalInstanceId(source);
			if (canonical === undefined) return id;
			return canonical.startsWith("item-list:")
				? canonical.slice("item-list:".length)
				: canonical;
		},
		itextId: (id) => {
			const unit = units?.get(id);
			if (unit === undefined) return id;
			return itextIdFor(doc, unit, structure) ?? id;
		},
	};
}

/** Nova's print of a candidate, as a runtime reads it: interpolated where
 *  the slot is one HQ interpolates, then parsed. Undefined where the
 *  emitter refuses the tree or the print does not read back. */
export function printedSyntax(
	doc: BlueprintDoc,
	pending: PendingExpression,
	candidate: Expression,
	env: ExpressionReadEnv,
	rewrites?: RewriteControl,
): FormSyntax | undefined {
	const form = slotForm(doc, pending.ref);
	const names = form === undefined ? undefined : env.sourceNames.get(form);
	let text: string;
	try {
		text = printSlot(doc, pending.ref, candidate, env, {
			...(form !== undefined && names !== undefined
				? { projection: sourceNodeProjection(doc, form, names) }
				: {}),
			...(rewrites === undefined ? {} : { rewrites }),
		});
	} catch (error) {
		rethrowWorkStop(error);
		return undefined;
	}
	const mode = slotReadMode(doc, pending.ref);
	if (
		mode.target === "hq-json" &&
		mode.interpolation !== "none" &&
		mode.interpolation !== "enum-key"
	) {
		const slot = hqInterpolationSlot(doc, pending.ref, mode.interpolation);
		if (slot === undefined) return undefined;
		const interpolated = interpolateHqXPath(text, slot);
		if (!interpolated.ok) return undefined;
		text = interpolated.text;
	}
	const read = readFormSyntax(text);
	if (!read.ok || read.node === undefined) return undefined;
	return read.node;
}

/** A registration's text bound to its candidate, with the fold sites the
 *  bind used. */
export interface BoundSlot {
	readonly candidate: Expression;
	/** `S` of the method: HQ's text as a runtime reads it. */
	readonly source: FormSyntax;
	/** The fold sites the bind used, as `foldId:from:to` of the source,
	 *  outermost first. */
	readonly foldSites: readonly string[];
	readonly spans: ReadonlyMap<
		string,
		{ readonly from: number; readonly to: number }
	>;
	/** Where the bind read the listed case inside another query of cases
	 *  (`current()/…` in a slot that lists cases), which no tree Nova holds
	 *  reads, so the candidate reads the inner row there. */
	readonly listedCaseInQuery?: true;
}

/** Bind `pending.text` against `doc` with every fold on but the `withdrawn`
 *  sites. */
export function bindSlot(
	doc: BlueprintDoc,
	pending: PendingExpression,
	env: ExpressionReadEnv,
	withdrawn: ReadonlySet<string>,
):
	| { readonly kind: "refused"; readonly cause: SlotRefusal }
	| { readonly kind: "bound"; readonly bound: BoundSlot } {
	const prepared = preparedSource(doc, pending);
	if (!prepared.ok) return { kind: "refused", cause: prepared.cause };
	const sites: FoldSites = {
		used: new Set(),
		spans: new Map(),
		plain: new Set(),
	};
	// A value a device works out inside a search row is no slot's whole source.
	const scope = scopeWith(
		doc,
		pending,
		env,
		withdrawn,
		sites,
		env.rowValues === true ? undefined : prepared.syntax,
	);
	const parsed = parseFormExpression(prepared.text, scope);
	if (!parsed.ok)
		return { kind: "refused", cause: { kind: "parse", issues: parsed.issues } };
	if (parsed.expression === undefined)
		return { kind: "refused", cause: { kind: "syntax" } };
	// A literal spelled as a date or a date and time is typed where its
	// position requires the type, as the typed one prints the same text.
	const context = holdsUntypedTemporalLiteral(parsed.expression)
		? slotContext(doc, pending.ref, lookupTypes(env))
		: undefined;
	const candidate =
		context === undefined
			? parsed.expression
			: typedWhereRequired(parsed.expression, context);
	const foldSites = [...sites.used].sort((a, b) => {
		const left = sites.spans.get(a);
		const right = sites.spans.get(b);
		if (left === undefined || right === undefined) return 0;
		return left.from - right.from || right.to - left.to;
	});
	return {
		kind: "bound",
		bound: {
			candidate,
			source: prepared.syntax,
			foldSites,
			spans: sites.spans,
			...(sites.listedCaseInQuery && { listedCaseInQuery: true }),
		},
	};
}

/** Print a bound candidate in its slot of `doc` and compare the print with
 *  the source's parsed tree: the judgment that holds or refuses the slot. */
export function judgeSlot(
	doc: BlueprintDoc,
	pending: PendingExpression,
	env: ExpressionReadEnv,
	bound: BoundSlot,
	rewrites?: RewriteControl,
): SlotJudgment {
	const { candidate, source, foldSites } = bound;
	const print = printedSyntax(doc, pending, candidate, env, rewrites);
	if (print === undefined)
		return { kind: "unprintable", candidate, source, foldSites };
	const context = slotContext(doc, pending.ref, lookupTypes(env));
	const compare = compareOptionsFor(
		doc,
		pending,
		env,
		context?.ruleSet ?? "form",
	);
	const difference = firstDifference(source, print, compare);
	if (difference === undefined)
		return { kind: "bound", candidate, source, print, equal: true, foldSites };
	let withdraw: string | undefined;
	let width = Number.POSITIVE_INFINITY;
	for (const site of foldSites) {
		const span = bound.spans.get(site);
		if (span === undefined) continue;
		if (span.from <= difference.from && difference.to <= span.to) {
			const own = span.to - span.from;
			if (own < width) {
				width = own;
				withdraw = site;
			}
		}
	}
	// A fold that joined the whole of a node's parts (a `concat` whose run
	// of literals is every argument) changes the node itself, which holds the
	// site rather than lying in it: the first site inside the node is the
	// one to withdraw.
	if (withdraw === undefined)
		withdraw = foldSites.find((site) => {
			const span = bound.spans.get(site);
			return (
				span !== undefined &&
				site.startsWith("protected-literal:") &&
				difference.kind === "call" &&
				difference.from <= span.from &&
				span.to <= difference.to
			);
		});
	return {
		kind: "bound",
		candidate,
		source,
		print,
		equal: false,
		foldSites,
		...(withdraw === undefined ? {} : { withdraw }),
		difference,
	};
}

/** One slot judged on its own, against a document that holds the app's
 *  other expressions: bind `pending.text` with every fold on but the
 *  `withdrawn` sites, print the candidate in `slotReadMode(doc, pending.ref)`
 *  with `rewrites` (absent: no rewrite withheld), compare. `readExpressions`
 *  runs the same three steps for every slot of a round; a reader that needs
 *  one slot judged again calls this. */
export function readExpression(
	doc: BlueprintDoc,
	pending: PendingExpression,
	env: ExpressionReadEnv,
	options: {
		readonly withdrawn?: ReadonlySet<string>;
		readonly rewrites?: RewriteControl;
	} = {},
): SlotJudgment {
	const bound = bindSlot(doc, pending, env, options.withdrawn ?? new Set());
	if (bound.kind === "refused") return bound;
	return judgeSlot(doc, pending, env, bound.bound, options.rewrites);
}

/** The lookup column types of the reading's catalog, as the parser's
 *  `formScopeContext` builds them. */
const typeIndexes = new WeakMap<object, LookupTypeIndex>();
export function lookupTypes(env: ExpressionReadEnv): LookupTypeIndex {
	let types = typeIndexes.get(env.lookup);
	if (types === undefined) {
		types = new Map(
			[...env.lookup.values()].map((table) => [
				table.id,
				new Map(table.columns.map((column) => [column.id, column.dataType])),
			]),
		);
		typeIndexes.set(env.lookup, types);
	}
	return types;
}
