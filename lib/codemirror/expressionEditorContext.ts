/**
 * One expression slot's editor context: the parse scope its text binds
 * against, the per-form reference projection its `#form/` and `#<type>/`
 * completions read, the vocabulary every other completion source offers,
 * and the check the linter and the save gate share.
 *
 * Everything here is derived from one snapshot of the document and the
 * slot's profile, so the editor offers, underlines and refuses exactly what
 * the commit gate does. A session-scoped slot (an after-submit link's
 * condition or carried value) is such because its profile says so, never
 * because a caller passed a flag.
 */

import {
	entryDatumIds,
	type FormLinkProjectionContext,
	formLinkProjectionContext,
} from "@/lib/commcare/formLinkProjection";
import { CASE_LIST_SEARCH_TEXT_DATA_NAME } from "@/lib/commcare/sessionContext";
import { parseFormExpression } from "@/lib/commcare/xpath/expressionAst";
import { formNodeProjection } from "@/lib/commcare/xpath/formNodeProjection";
import type { FormParseScope } from "@/lib/commcare/xpath/formParseScope";
import {
	expressionEditVerdict,
	formLogicFinding,
	lookupTypeIndex,
} from "@/lib/doc/commitVerdicts";
import { formParseScopeForSlot } from "@/lib/doc/expressionText";
import { lookupExpressionDefinitions } from "@/lib/doc/lookupExpressionContext";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import {
	BUILT_IN_USER_PROPERTIES,
	orderedLocationProperties,
	orderedOrganizationLevels,
	type ProseTemplate,
	projectProseTemplate,
	type Uuid,
} from "@/lib/domain";
import {
	type ExpressionContext,
	type LookupDefinitionIndex,
	slotContext,
} from "@/lib/domain/expression/context";
import type { FormStructure } from "@/lib/domain/expression/formStructure";
import { spanFor } from "@/lib/domain/expression/spans";
import { checkExpression } from "@/lib/domain/expression/typeChecker";
import type {
	DatumRef,
	ExpressionSlotRef,
	FormNodeRef,
} from "@/lib/domain/expression/types";
import { orderedCaseOperations } from "@/lib/domain/forms";
import { unavailablePlatform } from "@/lib/domain/platforms";
import { userPropertiesOf } from "@/lib/domain/users";
import {
	buildFormReferenceContext,
	type FormReferenceContext,
} from "./formReferenceContext";

/** One refusal of the text as typed, at its span. */
export interface ExpressionFinding {
	readonly from: number;
	readonly to: number;
	readonly message: string;
}

/** A named value a completion offers, with what the person knows it by. */
export interface NamedRead {
	readonly name: string;
	readonly label?: string;
}

/** What a slot can read, each by the name it prints. Each list holds only
 * what the parser binds and the checker admits at this slot, so a
 * completion is never offered and then refused. */
export interface ExpressionReads {
	/** The Project's data tables, each by its tag. */
	readonly tables: ReadonlyArray<{
		readonly tag: string;
		readonly name: string;
		readonly columns: ReadonlyArray<{
			readonly wireName: string;
			readonly label: string;
		}>;
	}>;
	/** The organization's places, present only when the app has levels. */
	readonly places?: {
		readonly levels: ReadonlyArray<{
			readonly code: string;
			readonly name: string;
		}>;
		readonly properties: ReadonlyArray<{
			readonly slug: string;
			readonly label: string;
		}>;
	};
	/** The instance id a several-case form reads its chosen cases under. */
	readonly selectedCases?: string;
	/** What the search that opened this form found: the searched case type's
	 *  properties, standard ones included. */
	readonly searchResults?: { readonly properties: readonly NamedRead[] };
	/** A no-matches form's search fields, by name. */
	readonly searchInputs?: readonly string[];
	/** The session values the form's entry supplies, each labelled by what
	 *  it holds. */
	readonly sessionData: ReadonlyArray<{
		readonly id: string;
		readonly label: string;
	}>;
	/** The session context fields a new read may name. */
	readonly sessionContext: readonly NamedRead[];
	/** Worker information under `session/user/data/`: the app's own, then
	 *  the built-in fields it does not shadow. */
	readonly workers: readonly NamedRead[];
	/** The effective case catalog a records query reads: each type's
	 *  properties (standard ones included) and its `index/` relations. */
	readonly caseTypes: ReadonlyArray<{
		readonly name: string;
		readonly properties: readonly NamedRead[];
		readonly relations: readonly string[];
	}>;
	/** The questions reachable as relative steps from the slot's context
	 *  node, after the steps already written (`..`, `.` or a name). Absent
	 *  where the slot has no form node. */
	readonly relative?: (
		steps: readonly string[],
	) => readonly RelativeStep[] | undefined;
	/** A static select's choices when `operand` reads that select's answer. */
	readonly choicesOpposite: (operand: string) => readonly NamedRead[];
	/** The slot's own choices, when it is a static select's starting value. */
	readonly slotChoices?: readonly NamedRead[];
}

export interface RelativeStep extends NamedRead {
	/** A group or repeat, whose questions are steps below it. */
	readonly container: boolean;
}

/** Editable expressions always carry their actual slot, its parse scope and
 * the one check the linter and the save gate share. */
export interface ExpressionEditorContext {
	readonly slot: ExpressionSlotRef;
	readonly scope: FormParseScope;
	readonly reference: FormReferenceContext;
	readonly reads: ExpressionReads;
	readonly check: (text: string) => readonly ExpressionFinding[];
}

/** The session context fields a new read names, with their labels as the
 * card editor shows them. The window width is offered only where the slot's
 * profile admits it (`SlotProfile.windowWidth`), as the checker reads it. */
const SESSION_CONTEXT_OFFERED: readonly NamedRead[] = [
	{ name: "userid", label: "Current user's ID" },
	{ name: "username", label: "Current user's name" },
	{ name: "deviceid", label: "This device's ID" },
	{ name: "appversion", label: "App version" },
	{ name: "drift", label: "Device clock offset" },
	{ name: "window_width", label: "Window width" },
	{ name: "applanguage", label: "App language" },
];

/** The case list's search text, `session/data/stringquery`, by the card's
 * label, offered where the checker admits it: a form's questions and
 * Connect settings, in a form that opens after exactly one case list. */
const CASE_LIST_SEARCH_TEXT_READ = {
	id: CASE_LIST_SEARCH_TEXT_DATA_NAME,
	label: "Case list search text",
} as const;

const CONTAINER_KINDS = new Set(["group", "section", "repeat"]);

/** Derive editing semantics from the actual owner and slot, never a form default. */
export function buildExpressionEditorContext(
	doc: BlueprintDoc,
	slot: ExpressionSlotRef,
	lookupContext: LookupValidationContext,
	options: { readonly form?: FormStructure } = {},
): ExpressionEditorContext | undefined {
	const context = slotContext(
		doc,
		slot,
		lookupTypeIndex(lookupContext),
		options,
	);
	const form = context?.form;
	if (context === undefined || form === undefined) return undefined;
	const references = buildFormReferenceContext(doc, form.formUuid);
	if (references === undefined) return undefined;
	const lookup = lookupExpressionDefinitions(lookupContext);
	const scope = formParseScopeForSlot(doc, slot, lookup, options);
	const reference: FormReferenceContext = {
		...references,
		...(context.profile.formAnswers
			? {}
			: { validPaths: new Set<string>(), formEntries: [] }),
		...(context.profile.caseData ? {} : { reachableCaseTypes: undefined }),
		scope: context.profile.scope === "session" ? "session" : "form",
	};
	return {
		slot,
		scope,
		reference,
		reads: slotReads(doc, scope, context, lookup),
		check: (text) => checkText(text, scope, context),
	};
}

/** Each parse issue at its span; then, when the text parses, the slot
 * checker's findings at the spans of the text as typed; then the
 * target-compatibility verdict over the whole text. */
function checkText(
	text: string,
	scope: FormParseScope,
	context: ExpressionContext,
): readonly ExpressionFinding[] {
	const parsed = parseFormExpression(text, scope);
	if (!parsed.ok)
		return parsed.issues.map(({ from, to, message }) => ({
			from,
			to,
			message,
		}));
	const expression = parsed.expression;
	if (expression === undefined) return [];
	const result = checkExpression(expression, context);
	if (result.errors.length > 0)
		return result.errors.map((error) => {
			const span = spanFor(parsed.spans, error.path) ?? {
				from: 0,
				to: text.length,
			};
			return {
				from: span.from,
				to: Math.min(span.to, text.length),
				message: formLogicFinding(error, context, expression).message,
			};
		});
	const verdict = expressionEditVerdict(expression, context);
	return verdict.ok
		? []
		: [{ from: 0, to: text.length, message: verdict.reason }];
}

/** What a session value holds, as the person knows it. */
export function datumLabel(
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
 * context is built for every slot, so one snapshot builds it once (as
 * `validator/rules/form.ts::projectionContextFor` does). */
const entryProjections = new WeakMap<BlueprintDoc, FormLinkProjectionContext>();

function entryProjectionFor(doc: BlueprintDoc): FormLinkProjectionContext {
	const held = entryProjections.get(doc);
	if (held !== undefined) return held;
	const built = formLinkProjectionContext(doc, { entryMetadataOnly: true });
	entryProjections.set(doc, built);
	return built;
}

/** Each case type's `index/` relations: `parent` where the catalog names a
 * parent type, and every identifier a case operation links that type by. */
function caseRelations(doc: BlueprintDoc): ReadonlyMap<string, Set<string>> {
	const relations = new Map<string, Set<string>>();
	const add = (caseType: string, identifier: string) => {
		const held = relations.get(caseType) ?? new Set<string>();
		held.add(identifier);
		relations.set(caseType, held);
	};
	for (const type of doc.caseTypes ?? [])
		if (type.parent_type) add(type.name, "parent");
	for (const form of Object.values(doc.forms))
		for (const operation of orderedCaseOperations(form))
			for (const link of operation.links ?? [])
				add(operation.caseType, link.identifier);
	return relations;
}

/**
 * The secondary instances and the paths the slot reads, from the same facts
 * the parser binds against and the checker admits by: the Project's tables,
 * places when the app has levels, the chosen cases only in the questions of
 * a several-case form, the search's results only where the entry carries
 * the inline query, a no-matches form's search fields, the session values
 * the entry supplies, the case catalog, worker information, the questions
 * a relative step reaches and a static select's choices.
 */
function slotReads(
	doc: BlueprintDoc,
	scope: FormParseScope,
	context: ExpressionContext,
	lookup: LookupDefinitionIndex | "unavailable",
): ExpressionReads {
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
	const relations = caseRelations(doc);
	const custom = Object.values(userPropertiesOf(doc));
	const customSlugs = new Set(custom.map((property) => property.slug));
	const choicesOf = (field: Uuid) => optionReads(doc, form, field);
	const slotField =
		scope.slot.entity === "field" && scope.slot.slot === "default_value"
			? scope.slot.uuid
			: undefined;
	const slotChoices =
		slotField === undefined ? undefined : choicesOf(slotField);
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
		...(form?.noMatchesForm ||
		(form?.searchFirstModule === true && context.profile.scope === "form")
			? { searchInputs: form.searchInputs.map((input) => input.name) }
			: {}),
		sessionData: [
			...rows.flatMap((row) => {
				const ref = row.refs[0];
				return row.scalar && ref !== undefined
					? [{ id: row.id, label: datumLabel(doc, ref, ownCaseType) }]
					: [];
			}),
			...(context.profile.caseListSearchText &&
			unavailablePlatform("case-list-search-text", context.platforms) ===
				undefined &&
			context.supplies.refs.filter(
				(supply) => supply.ref.kind === "selected-case",
			).length === 1
				? [CASE_LIST_SEARCH_TEXT_READ]
				: []),
		],
		sessionContext:
			context.profile.windowWidth &&
			unavailablePlatform("window-width", context.platforms) === undefined
				? SESSION_CONTEXT_OFFERED
				: SESSION_CONTEXT_OFFERED.filter(
						(read) => read.name !== "window_width",
					),
		workers: [
			...custom.map((property) => ({
				name: property.slug,
				label: property.label,
			})),
			...BUILT_IN_USER_PROPERTIES.filter(
				(property) => !customSlugs.has(property.slug),
			).map((property) => ({ name: property.slug, label: property.label })),
		],
		caseTypes: context.facts.caseTypes.map((type) => ({
			name: type.name,
			properties: type.properties.map((property) => ({
				name: property.name,
				label: projectProseTemplate(property.label, doc).text,
			})),
			relations: [...(relations.get(type.name) ?? [])],
		})),
		...(context.profile.formAnswers &&
		form !== undefined &&
		context.contextNode !== undefined
			? { relative: relativeReads(doc, context) }
			: {}),
		choicesOpposite: (operand) => {
			const parsed = parseFormExpression(operand, {
				...scope,
				current: undefined,
			});
			if (!parsed.ok || parsed.expression?.kind !== "term") return [];
			const term = parsed.expression.term;
			return term.kind === "field" && term.role === undefined
				? (choicesOf(term.uuid) ?? [])
				: [];
		},
		...(slotChoices === undefined ? {} : { slotChoices }),
	};
}

/** A static select's choices, by value with their labels. */
function optionReads(
	doc: BlueprintDoc,
	form: ExpressionContext["form"],
	field: Uuid,
): readonly NamedRead[] | undefined {
	const choices = form?.fields.get(field)?.choices;
	if (choices?.kind !== "inline") return undefined;
	const declared = doc.fields[field];
	const source =
		declared !== undefined && "optionsSource" in declared
			? declared.optionsSource
			: undefined;
	const labels =
		source?.kind === "inline"
			? new Map(source.options.map((option) => [option.uuid, option.label]))
			: new Map<Uuid, ProseTemplate>();
	return choices.options.map((option) => {
		const label = labels.get(option.uuid);
		return {
			name: option.value,
			...(label === undefined
				? {}
				: { label: projectProseTemplate(label, doc).text }),
		};
	});
}

/** A question's label as the person reads it, or its id when it has none
 * (a pending declaration or a hidden value). */
export function fieldLabel(doc: BlueprintDoc, uuid: Uuid, id: string): string {
	const field = doc.fields[uuid];
	const label =
		field !== undefined && "label" in field
			? (field.label as ProseTemplate | undefined)
			: undefined;
	const text =
		label === undefined ? "" : projectProseTemplate(label, doc).text.trim();
	return text === "" ? id : text;
}

/** The questions a relative path reaches from the slot's context node. */
function relativeReads(
	doc: BlueprintDoc,
	context: ExpressionContext,
): (steps: readonly string[]) => readonly RelativeStep[] | undefined {
	return (steps) => {
		const form = context.form;
		const start = context.contextNode;
		if (form === undefined || start === undefined) return undefined;
		const projection = formNodeProjection(doc, form);
		const { graph } = projection;
		let node: FormNodeRef | undefined = start;
		for (const step of steps) {
			if (node === undefined) return undefined;
			if (step === "..") node = graph.parent(node);
			else if (step !== ".") {
				const current: FormNodeRef = node;
				node = graph
					.children(current)
					.find(
						(child) =>
							child.kind === "field" &&
							child.role === undefined &&
							projection.step(child)?.name === step,
					);
			}
		}
		if (node === undefined) return undefined;
		return graph.children(node).flatMap((child): RelativeStep[] => {
			if (child.kind !== "field" || child.role !== undefined) return [];
			const field = form.fields.get(child.uuid);
			const name = projection.step(child)?.name;
			if (field === undefined || name === undefined) return [];
			const container = CONTAINER_KINDS.has(field.kind);
			if (!container && field.kind === "label") return [];
			return [
				{ name, label: fieldLabel(doc, child.uuid, field.id), container },
			];
		});
	};
}
