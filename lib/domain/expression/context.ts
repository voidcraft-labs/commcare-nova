import type { BlueprintDoc, CaseType } from "../blueprint";
import type { CasePropertyDataType } from "../casePropertyTypes";
import {
	caseDataTypeForFieldKind,
	caseRefAcceptMap,
	reachableCaseTypes,
	toReachableIndex,
} from "../caseTypes";
import {
	type EntryDatumSupplies,
	entryDatumSupplies,
	formLinkTargetSupplies,
} from "../entryDatumSupplies";
import { formOfField } from "../fieldForm";
import type { SelectOption } from "../fields";
import { orderedCaseOperations } from "../forms";
import type { TranslationUnitId } from "../localization";
import type { LookupColumnId, LookupTableId } from "../lookupIds";
import { moduleIsCaseFirst } from "../menuForms";
import {
	effectiveCaseSearchConfig,
	SEARCH_INPUT_TYPE_DEFAULT_EXPECTED_TYPES,
	searchInputRuntimeValueType,
} from "../modules";
import {
	type LocationProperty,
	locationPropertiesOf,
	type OrganizationLevel,
	organizationLevelsOf,
} from "../organization";
import { proseText } from "../prose";
import {
	expressionSlotValues,
	FIELD_REFERENCE_SLOTS,
	type FieldReferenceSlot,
	FORM_REFERENCE_SLOTS,
	type FormReferenceSlot,
} from "../referenceSlots";
import {
	STANDARD_CASE_LIST_PROPERTY_DATA_TYPES,
	standardCasePropertyDisplayLabel,
} from "../standardCaseProperties";
import { formTranslationUnits } from "../translationUnits";
import { userPropertySlugsByUuid } from "../users";
import type { Uuid } from "../uuid";
import { expressionChildren } from "./children";
import {
	type FormStructure,
	type FormStructureField,
	formStructure,
} from "./formStructure";
import { inferExpressionTypes } from "./inference";
import { type RuleSet, type SlotProfile, slotProfile } from "./profiles";
import type { Held, ScalarHeld, ScalarType } from "./typeChecker";
import { datumRefKey, type FormNodeRef, type SlotContextRef } from "./types";

export type LookupTypeIndex = ReadonlyMap<
	LookupTableId,
	ReadonlyMap<LookupColumnId, CasePropertyDataType>
>;
/** Names for parsing and wire projection; no table rows or persistence layer. */
export type LookupDefinitionIndex = ReadonlyMap<
	LookupTableId,
	{
		readonly id: LookupTableId;
		readonly name: string;
		readonly tag: string;
		readonly columns: readonly {
			readonly id: LookupColumnId;
			readonly wireName: string;
			readonly label: string;
			readonly dataType: CasePropertyDataType;
		}[];
	}
>;
export interface SearchInputDecl {
	readonly uuid: Uuid;
	readonly name: string;
	readonly data_type?: CasePropertyDataType;
}
export interface CaseRowScope {
	readonly kind: "case";
	readonly root: "casedb" | "results" | "results:inline";
	readonly caseType?: string;
}
export type RowScope =
	| CaseRowScope
	| {
			readonly kind: "table";
			readonly root: "table";
			readonly tableId: LookupTableId;
			readonly capturedCase?: CaseRowScope;
	  }
	| { readonly kind: "location"; readonly root: "locations" }
	| { readonly kind: "repeat"; readonly root: "form"; readonly repeat: Uuid };
/** The per-document facts the checker reads. `caseTypes`, `hiddenTypes`,
 * `hiddenHeld` and `clockLost` are inference's (`inference.ts`); the rest are
 * read from the document as authored. */
export interface ExpressionFacts {
	/** The effective catalog, standard properties included. */
	readonly caseTypes: readonly CaseType[];
	/** A Hidden Value's data type; absent is unknown. */
	readonly hiddenTypes: ReadonlyMap<Uuid, CasePropertyDataType>;
	/** What Core holds for a Hidden Value, from its bind, its source slot and
	 * its result (`Recalculate.java::wrapData`, `SetValueAction.java::processAction`). */
	readonly hiddenHeld: ReadonlyMap<Uuid, ScalarHeld>;
	/** Hidden Values whose date and time may have lost its clock. */
	readonly clockLost: ReadonlySet<Uuid>;
	readonly options: ReadonlyMap<Uuid, readonly SelectOption[]>;
	readonly userPropertySlugs: ReadonlyMap<Uuid, string>;
	readonly organizationLevels: Readonly<Record<string, OrganizationLevel>>;
	readonly locationProperties: ReadonlyMap<Uuid, LocationProperty>;
	readonly moduleCaseTypes: ReadonlyMap<Uuid, string>;
	readonly moduleUuids: ReadonlySet<Uuid>;
	readonly operationCaseTypes: ReadonlyMap<Uuid, string>;
	readonly moduleSearchInputs: ReadonlyMap<Uuid, readonly SearchInputDecl[]>;
}
export interface FormExpressionFacts extends FormStructure {
	readonly fields: ReadonlyMap<
		Uuid,
		FormStructureField & {
			readonly type: CasePropertyDataType | undefined;
			readonly held: Held;
			readonly repeats: readonly Uuid[];
		}
	>;
	readonly readableCaseTypes: ReadonlyMap<string, ReadonlySet<string>>;
	readonly searchInputs: readonly SearchInputDecl[];
	readonly noMatchesForm: boolean;
	/** Whether a translation unit this form's questions or choices own shows
	 * an answer in some language (`translationUnits.ts::formTranslationUnits`).
	 * Asked only by a `jr:itext` or `jr:choice-name` read, so a form with none
	 * never builds the document's translation-unit snapshot. */
	readonly unitShowsAnswer: (unitId: TranslationUnitId) => boolean;
}
/** The actual slot stays fixed while rows and the lexical form node rebind. */
export interface ExpressionContext {
	readonly slot: SlotContextRef;
	readonly ruleSet: RuleSet;
	readonly profile: SlotProfile;
	readonly facts: ExpressionFacts;
	readonly form?: FormExpressionFacts;
	readonly sourceNode?: FormNodeRef;
	readonly contextNode?: FormNodeRef;
	readonly rows: readonly RowScope[];
	readonly lookupTables: LookupTypeIndex;
	readonly supplies: EntryDatumSupplies;
	readonly targetSupplies?: EntryDatumSupplies;
	/** A value of a server search condition that a device works out before
	 * the search runs (`searchRuntimeValues.ts`): the slot names no device
	 * target, yet Core evaluates this expression. */
	readonly runsOnDevice?: true;
}
export type RecordQueryRowScope =
	| { readonly kind: "case"; readonly caseType?: string }
	| {
			readonly kind: "table";
			readonly tableId: LookupTableId;
			readonly capturedCase?: Extract<RecordQueryRowScope, { kind: "case" }>;
	  }
	| { readonly kind: "location" };
/** A SQL query has no authored slot, device target, or form evaluation node. */
export interface RecordQueryContext {
	readonly kind: "record-query";
	readonly ruleSet: "record";
	readonly facts: Pick<
		ExpressionFacts,
		"caseTypes" | "userPropertySlugs" | "organizationLevels"
	>;
	readonly rows: readonly RecordQueryRowScope[];
	readonly lookupTables: LookupTypeIndex;
	readonly bindings: {
		/** `_any` is a form answer whose type is unknown; absent from the map is
		 * no answer of this form. */
		readonly formFieldTypes: ReadonlyMap<
			Uuid,
			CasePropertyDataType | Extract<ScalarType, "_any"> | undefined
		>;
		readonly knownInputs: readonly SearchInputDecl[];
		readonly operationIds: ReadonlySet<Uuid>;
	};
}
export type TypingContext = ExpressionContext | RecordQueryContext;
export function activeRowScope(ctx: ExpressionContext): RowScope | undefined;
export function activeRowScope(
	ctx: RecordQueryContext,
): RecordQueryRowScope | undefined;
export function activeRowScope(
	ctx: TypingContext,
): RowScope | RecordQueryRowScope | undefined;
export function activeRowScope(
	ctx: TypingContext,
): RowScope | RecordQueryRowScope | undefined {
	return ctx.rows.at(-1);
}
export function pushRowScope(
	ctx: ExpressionContext,
	row: RowScope,
): ExpressionContext;
export function pushRowScope(
	ctx: RecordQueryContext,
	row: RecordQueryRowScope,
): RecordQueryContext;
export function pushRowScope(
	ctx: TypingContext,
	row: RowScope | RecordQueryRowScope,
): TypingContext {
	if ("kind" in ctx) {
		if (row.kind === "repeat")
			throw new Error("A record query cannot bind a form repeat row.");
		return { ...ctx, rows: [...ctx.rows, row] };
	}
	if (!("root" in row))
		throw new Error("An authored expression row is missing its instance root.");
	return { ...ctx, rows: [...ctx.rows, row] };
}
export function withFormContextNode(
	ctx: ExpressionContext,
	node: FormNodeRef,
): ExpressionContext {
	return { ...ctx, contextNode: node };
}

/** The facts no inference decides. */
export type UntypedExpressionFacts = Omit<
	ExpressionFacts,
	"caseTypes" | "hiddenTypes" | "hiddenHeld" | "clockLost"
>;

const untypedFacts = new WeakMap<BlueprintDoc, UntypedExpressionFacts>();
const documentFacts = new WeakMap<BlueprintDoc, ExpressionFacts>();
const formFacts = new WeakMap<BlueprintDoc, Map<Uuid, FormExpressionFacts>>();
/** Form facts built over provisional facts (inference's passes), keyed by
 * the facts object so the document's own form facts are never replaced. */
const provisionalFormFacts = new WeakMap<
	ExpressionFacts,
	Map<Uuid, FormExpressionFacts>
>();
const countReferences = new WeakMap<
	BlueprintDoc,
	Map<Uuid, ReadonlySet<Uuid>>
>();

export function untypedExpressionFacts(
	doc: BlueprintDoc,
): UntypedExpressionFacts {
	const cached = untypedFacts.get(doc);
	if (cached !== undefined) return cached;
	const options = new Map<Uuid, readonly SelectOption[]>();
	for (const field of Object.values(doc.fields))
		if ("optionsSource" in field && field.optionsSource.kind === "inline")
			options.set(field.uuid, field.optionsSource.options);
	const result: UntypedExpressionFacts = {
		options,
		moduleUuids: new Set(
			Object.values(doc.modules).map((module) => module.uuid),
		),
		operationCaseTypes: new Map(
			Object.values(doc.forms).flatMap((form) =>
				orderedCaseOperations(form)
					.filter((operation) => operation.action === "create")
					.map((operation) => [operation.uuid, operation.caseType] as const),
			),
		),
		moduleSearchInputs: new Map(
			Object.values(doc.modules).map((module) => [
				module.uuid,
				(module.caseListConfig?.searchInputs ?? []).map((input) => ({
					uuid: input.uuid,
					name: input.name,
					data_type: searchInputRuntimeValueType(input),
				})),
			]),
		),
		userPropertySlugs: userPropertySlugsByUuid(doc),
		organizationLevels: organizationLevelsOf(doc),
		locationProperties: new Map(
			Object.values(locationPropertiesOf(doc)).map((property) => [
				property.uuid,
				property,
			]),
		),
		moduleCaseTypes: new Map(
			Object.values(doc.modules).flatMap((module) =>
				module.caseType === undefined
					? []
					: [[module.uuid, module.caseType] as const],
			),
		),
	};
	untypedFacts.set(doc, result);
	return result;
}

export function expressionFacts(doc: BlueprintDoc): ExpressionFacts {
	const cached = documentFacts.get(doc);
	if (cached !== undefined) return cached;
	const inference = inferExpressionTypes(doc);
	const result: ExpressionFacts = {
		...untypedExpressionFacts(doc),
		caseTypes: inference.caseTypes,
		hiddenTypes: inference.hiddenTypes,
		hiddenHeld: inference.hiddenHeld,
		clockLost: inference.clockLost,
	};
	documentFacts.set(doc, result);
	return result;
}

/** Standard properties are the same typed catalog facts for authored slots and SQL. */
export function withStandardCaseProperties(
	caseTypes: readonly CaseType[],
): readonly CaseType[] {
	return caseTypes.map((type) => {
		const named = new Set(type.properties.map((property) => property.name));
		return {
			...type,
			properties: [
				...type.properties,
				...Object.entries(STANDARD_CASE_LIST_PROPERTY_DATA_TYPES).flatMap(
					([name, data_type]) =>
						named.has(name)
							? []
							: [
									{
										name,
										data_type,
										label: proseText(standardCasePropertyDisplayLabel(name)),
									},
								],
				),
			],
		};
	});
}

export function recordQueryContext(input: {
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType?: string;
	readonly lookupTables?: LookupTypeIndex;
	readonly lookupTableId?: LookupTableId;
	readonly formFieldTypes?: RecordQueryContext["bindings"]["formFieldTypes"];
	readonly knownInputs?: readonly SearchInputDecl[];
	readonly organizationLevels?: Readonly<Record<string, OrganizationLevel>>;
	readonly userPropertySlugs?: ReadonlyMap<Uuid, string>;
	readonly operationIds?: ReadonlySet<Uuid>;
}): RecordQueryContext {
	const row: RecordQueryRowScope = {
		kind: "case",
		...(input.currentCaseType === undefined
			? {}
			: { caseType: input.currentCaseType }),
	};
	return {
		kind: "record-query",
		ruleSet: "record",
		facts: {
			caseTypes: withStandardCaseProperties(input.caseTypes),
			userPropertySlugs: input.userPropertySlugs ?? new Map(),
			organizationLevels: input.organizationLevels ?? {},
		},
		rows:
			input.lookupTableId === undefined
				? [row]
				: [{ kind: "table", tableId: input.lookupTableId, capturedCase: row }],
		lookupTables: input.lookupTables ?? new Map(),
		bindings: {
			formFieldTypes: input.formFieldTypes ?? new Map(),
			knownInputs: input.knownInputs ?? [],
			operationIds: input.operationIds ?? new Set(),
		},
	};
}

/** What a visible question's answer unpacks to
 * (`XPathPathExpr.java::unpackValue`): a time has no TimeData arm, so its text. */
function visibleHeld(type: CasePropertyDataType | undefined): ScalarHeld {
	return type === "int" || type === "decimal"
		? "number"
		: type === "date" || type === "datetime"
			? "date"
			: "string";
}
/** Each field's enclosing repeats, outermost first: structure alone, so
 * kept per structure while inference's passes rebuild the typed facts. */
const structureRepeats = new WeakMap<
	FormStructure,
	ReadonlyMap<Uuid, readonly Uuid[]>
>();
function repeatsOf(
	structure: FormStructure,
): ReadonlyMap<Uuid, readonly Uuid[]> {
	const cached = structureRepeats.get(structure);
	if (cached !== undefined) return cached;
	const result = new Map<Uuid, readonly Uuid[]>();
	for (const [uuid, field] of structure.fields) {
		const repeats: Uuid[] = [];
		const seen = new Set<Uuid>();
		let parent = field.parent;
		while (!seen.has(parent)) {
			seen.add(parent);
			const ancestor = structure.fields.get(parent);
			if (ancestor === undefined) break;
			if (ancestor.kind === "repeat") repeats.unshift(parent);
			parent = ancestor.parent;
		}
		result.set(uuid, repeats);
	}
	structureRepeats.set(structure, result);
	return result;
}
/** The case types a form reads, per catalog: one catalog serves many
 * passes of inference and every form of a module. */
const readableByCatalog = new WeakMap<
	readonly CaseType[],
	WeakMap<BlueprintDoc, Map<string, ReadonlyMap<string, ReadonlySet<string>>>>
>();
function readableCaseTypesOf(
	doc: BlueprintDoc,
	caseTypes: readonly CaseType[],
	moduleCaseType: string | undefined,
	formType: FormStructure["type"],
): ReadonlyMap<string, ReadonlySet<string>> {
	let byDoc = readableByCatalog.get(caseTypes);
	if (byDoc === undefined) {
		byDoc = new WeakMap();
		readableByCatalog.set(caseTypes, byDoc);
	}
	let byKey = byDoc.get(doc);
	if (byKey === undefined) {
		byKey = new Map();
		byDoc.set(doc, byKey);
	}
	const key = JSON.stringify([moduleCaseType ?? null, formType]);
	const cached = byKey.get(key);
	if (cached !== undefined) return cached;
	const result = caseRefAcceptMap(
		toReachableIndex(reachableCaseTypes(moduleCaseType, [...caseTypes]), doc),
		formType,
	);
	byKey.set(key, result);
	return result;
}
function buildFormFacts(
	doc: BlueprintDoc,
	structure: FormStructure,
	facts: ExpressionFacts,
): FormExpressionFacts {
	const module = doc.modules[structure.moduleUuid];
	const fields = new Map<
		Uuid,
		FormExpressionFacts["fields"] extends ReadonlyMap<Uuid, infer F> ? F : never
	>();
	const repeatsByField = repeatsOf(structure);
	for (const [uuid, field] of structure.fields) {
		const type =
			field.kind === "hidden"
				? facts.hiddenTypes.get(uuid)
				: caseDataTypeForFieldKind(field.kind);
		const held: Held =
			field.kind === "hidden"
				? (facts.hiddenHeld.get(uuid) ?? "string")
				: visibleHeld(type);
		fields.set(uuid, {
			...field,
			type,
			held,
			repeats: repeatsByField.get(uuid) ?? [],
		});
	}
	const searchInputs = (module?.caseListConfig?.searchInputs ?? []).map(
		(input) => ({
			uuid: input.uuid,
			name: input.name,
			data_type: searchInputRuntimeValueType(input),
		}),
	);
	return {
		...structure,
		fields,
		searchInputs,
		noMatchesForm: structure.entry?.kind === "search-no-matches",
		unitShowsAnswer: (unitId) =>
			formTranslationUnits(doc, structure.formUuid).get(unitId)?.showsAnswer ===
			true,
		readableCaseTypes: readableCaseTypesOf(
			doc,
			facts.caseTypes,
			module?.caseType,
			structure.type,
		),
	};
}
export function formExpressionFacts(
	doc: BlueprintDoc,
	formUuid: Uuid,
): FormExpressionFacts | undefined {
	const cached = formFacts.get(doc)?.get(formUuid);
	if (cached !== undefined) return cached;
	const structure = formStructure(doc, formUuid);
	if (structure === undefined) return undefined;
	const result = buildFormFacts(doc, structure, expressionFacts(doc));
	let byForm = formFacts.get(doc);
	if (byForm === undefined) {
		byForm = new Map();
		formFacts.set(doc, byForm);
	}
	byForm.set(formUuid, result);
	return result;
}
function provisionalFormExpressionFacts(
	doc: BlueprintDoc,
	formUuid: Uuid,
	facts: ExpressionFacts,
): FormExpressionFacts | undefined {
	const cached = provisionalFormFacts.get(facts)?.get(formUuid);
	if (cached !== undefined) return cached;
	const structure = formStructure(doc, formUuid);
	if (structure === undefined) return undefined;
	const result = buildFormFacts(doc, structure, facts);
	let byForm = provisionalFormFacts.get(facts);
	if (byForm === undefined) {
		byForm = new Map();
		provisionalFormFacts.set(facts, byForm);
	}
	byForm.set(formUuid, result);
	return result;
}

/** Only the final immutable document is scanned. A pending parser never needs
 * count carrier materialization to bind its potential coordinate. */
export function referencedCountResults(
	doc: BlueprintDoc,
	formUuid: Uuid,
): ReadonlySet<Uuid> {
	const cached = countReferences.get(doc)?.get(formUuid);
	if (cached !== undefined) return cached;
	const result = new Set<Uuid>();
	const visit = (
		node: import("./types").Expression | import("./types").Term,
	): void => {
		if (
			node.kind === "form-node" &&
			node.node.kind === "repeat" &&
			node.node.role === "count-result"
		)
			result.add(node.node.repeat);
		if ("filters" in node)
			for (const filter of node.filters ?? [])
				if (
					filter.step.kind === "repeat" &&
					filter.step.role === "count-result"
				)
					result.add(filter.step.repeat);
		for (const child of expressionChildren(node))
			if (child.kind !== "relation") visit(child.value);
	};
	const structure = formStructure(doc, formUuid);
	if (structure !== undefined) {
		for (const value of expressionSlotValues(doc, {
			entity: "form",
			uuid: formUuid,
		}))
			visit(value.expression);
		for (const uuid of structure.fields.keys())
			for (const value of expressionSlotValues(doc, { entity: "field", uuid }))
				visit(value.expression);
	}
	let byForm = countReferences.get(doc);
	if (byForm === undefined) {
		byForm = new Map();
		countReferences.set(doc, byForm);
	}
	byForm.set(formUuid, result);
	return result;
}

function ownerForm(doc: BlueprintDoc, slot: SlotContextRef): Uuid | undefined {
	if (slot.entity === "form")
		return doc.forms[slot.uuid] === undefined ? undefined : slot.uuid;
	if (slot.entity !== "field" || doc.fields[slot.uuid] === undefined)
		return undefined;
	return formOfField(doc, slot.uuid);
}

/**
 * Resolve an actual owning slot, including an absent optional expression.
 * `options.facts` replaces the document's facts: inference types each Hidden
 * Value in its real slot over its provisional facts, which never reach the
 * document's caches.
 */
export function slotContext(
	doc: BlueprintDoc,
	slot: SlotContextRef,
	lookupTables: LookupTypeIndex,
	options: {
		readonly form?: FormStructure;
		readonly facts?: ExpressionFacts;
	} = {},
): ExpressionContext | undefined {
	const facts = options.facts ?? expressionFacts(doc);
	const formUuid = options.form?.formUuid ?? ownerForm(doc, slot);
	let form =
		options.form === undefined
			? formUuid === undefined
				? undefined
				: options.facts === undefined
					? formExpressionFacts(doc, formUuid)
					: provisionalFormExpressionFacts(doc, formUuid, options.facts)
			: buildFormFacts(doc, options.form, facts);
	const moduleUuid = slot.entity === "module" ? slot.uuid : form?.moduleUuid;
	const module = moduleUuid === undefined ? undefined : doc.modules[moduleUuid];
	if (module === undefined || moduleUuid === undefined) return undefined;
	const searchInputs = (module.caseListConfig?.searchInputs ?? []).map(
		(input) => ({
			uuid: input.uuid,
			name: input.name,
			data_type: searchInputRuntimeValueType(input),
		}),
	);
	let profile: SlotProfile;
	let rows: RowScope[] = [];
	let sourceNode: FormNodeRef | undefined;
	let supplies: EntryDatumSupplies = { refs: [] };
	let targetSupplies: EntryDatumSupplies | undefined;
	if (slot.entity === "field") {
		const field = form?.fields.get(slot.uuid);
		const declaration: FieldReferenceSlot | undefined =
			FIELD_REFERENCE_SLOTS.find((entry) => entry.slot === slot.slot);
		if (
			field === undefined ||
			form === undefined ||
			declaration === undefined ||
			!declaration.appliesTo.includes(field.kind) ||
			(declaration.repeatModes !== undefined &&
				!declaration.repeatModes.includes(field.repeatMode as never))
		)
			return undefined;
		if (slot.slot === "option_label" && !field.choices?.kind) return undefined;
		if (
			slot.slot === "option_label" &&
			(field.choices?.kind !== "inline" ||
				!field.choices.options.some(
					(option) => option.uuid === slot.member.optionUuid,
				))
		)
			return undefined;
		sourceNode = { kind: "field", uuid: slot.uuid };
		if (slot.slot === "relevant" && field.repeatMode === "query_bound")
			sourceNode = { kind: "field", uuid: slot.uuid, role: "query-wrapper" };
		if (slot.slot === "repeat_count")
			sourceNode = { kind: "repeat", repeat: slot.uuid, role: "count-result" };
		if (slot.slot === "ids_query")
			sourceNode = { kind: "repeat", repeat: slot.uuid, role: "query-ids" };
		const condition = ["relevant", "validate", "required"].includes(slot.slot);
		profile = slotProfile(
			"form",
			"form",
			["XF", "PV"],
			condition
				? { kind: "condition" }
				: // A query-bound repeat's ids query is the node-set of its rows.
					slot.slot === "ids_query"
					? { kind: "value", many: true }
					: { kind: "value" },
			{ searchInputs: form.searchInputs },
		);
		if (slot.slot === "lookup_options_source") {
			const choices = field.choices;
			if (choices === undefined || choices.kind === "inline") return undefined;
			profile = slotProfile(
				"record",
				choices.kind === "cases" ? "case" : "table",
				["XF", "PV"],
				{ kind: "condition" },
				{ formAnswers: true },
			);
			rows =
				choices.kind === "cases"
					? [
							{
								kind: "case",
								root: "casedb",
								caseType: choices.caseType,
							},
						]
					: [
							{
								kind: "table",
								root: "table",
								tableId: choices.tableId,
							},
						];
		}
		supplies = entryDatumSupplies(
			doc,
			{
				kind: "form",
				module: moduleUuid,
				form: form.formUuid,
			},
			options.form,
		);
	} else if (slot.entity === "form") {
		const saved = doc.forms[slot.uuid];
		const declaration: FormReferenceSlot | undefined =
			FORM_REFERENCE_SLOTS.find((entry) => entry.slot === slot.slot);
		if (
			form === undefined ||
			declaration === undefined ||
			!declaration.formTypes.includes(form.type)
		)
			return undefined;
		supplies = entryDatumSupplies(
			doc,
			{
				kind: "form",
				module: moduleUuid,
				form: slot.uuid,
			},
			options.form,
		);
		if (slot.slot === "form_display_condition") {
			if (saved === undefined) return undefined;
			const caseFirst = moduleIsCaseFirst(doc, moduleUuid, options.form);
			profile = slotProfile(
				"record",
				"session",
				["SU", "HQ", "PV"],
				{ kind: "condition" },
				{ caseData: caseFirst },
			);
			if (caseFirst)
				rows = [{ kind: "case", root: "casedb", caseType: module.caseType }];
			supplies = entryDatumSupplies(
				doc,
				{
					kind: "form-menu",
					module: moduleUuid,
					form: slot.uuid,
				},
				options.form,
			);
		} else if (
			slot.slot === "form_link_condition" ||
			slot.slot === "form_link_datum_xpath"
		) {
			const link = form.links.get(slot.member.linkUuid);
			if (link === undefined) return undefined;
			if (
				slot.slot === "form_link_datum_xpath" &&
				!link.datums.some(
					(datum) => datumRefKey(datum) === datumRefKey(slot.member.datum),
				)
			)
				return undefined;
			profile = slotProfile(
				"form",
				"session",
				["SU", "HQ", "PV"],
				slot.slot === "form_link_condition"
					? { kind: "condition" }
					: { kind: "value" },
				{ searchInputs: form.searchInputs },
			);
			form = {
				...form,
				readableCaseTypes: caseRefAcceptMap(
					toReachableIndex(
						reachableCaseTypes(module.caseType, facts.caseTypes),
						doc,
					),
					form.type,
					"session",
				),
			};
			targetSupplies = formLinkTargetSupplies(doc, link.target);
		} else if ("member" in slot && "operationUuid" in slot.member) {
			if (saved === undefined) return undefined;
			const member = slot.member;
			const operations = orderedCaseOperations(saved);
			const index = operations.findIndex(
				(operation) => operation.uuid === member.operationUuid,
			);
			const operation = operations[index];
			if (operation === undefined) return undefined;
			if (
				"property" in member &&
				!operation.writes?.some((write) => write.property === member.property)
			)
				return undefined;
			if (
				"identifier" in member &&
				!operation.links?.some((link) => link.identifier === member.identifier)
			)
				return undefined;
			const condition =
				slot.slot === "case_operation_condition" ||
				slot.slot === "case_operation_write_condition";
			const target =
				slot.slot === "case_operation_target_expression" ||
				slot.slot === "case_operation_link_target_expression";
			const destinationType = operation.retype ?? operation.caseType;
			const destinations: CasePropertyDataType[] =
				"property" in member
					? [
							...new Set([
								...(doc.caseTypes
									?.find((type) => type.name === destinationType)
									?.properties.flatMap((property) =>
										property.name === member.property &&
										property.data_type !== undefined
											? [property.data_type]
											: [],
									) ?? []),
								...(inferExpressionTypes(doc)
									.writerOpinions.get(destinationType)
									?.get(member.property) ?? []),
							]),
						]
					: ["text"];
			profile = slotProfile(
				"record",
				"submission",
				["XF", "PG"],
				condition
					? { kind: "condition" }
					: { kind: "assignment", destinations },
				{
					operationIds: new Set(
						target
							? []
							: operations
									.slice(0, index)
									.filter((candidate) => candidate.action === "create")
									.map((candidate) => candidate.uuid),
					),
					ownerValues: slot.slot === "case_operation_owner",
				},
			);
			rows = [{ kind: "case", root: "casedb", caseType: module.caseType }];
			// A repeated operation's case block sits in each entry of its repeat,
			// so its expressions read that entry's answers (Core contextualizes
			// a bind against its own node, `TreeReference.java::contextualize`).
			if (
				operation.forEach !== undefined &&
				form.fields.get(operation.forEach.repeat)?.kind === "repeat"
			)
				sourceNode = { kind: "field", uuid: operation.forEach.repeat };
		} else {
			const block =
				slot.slot === "assessment_user_score" ? "assessment" : "deliver_unit";
			if (form.connect[block] === undefined) return undefined;
			sourceNode =
				slot.slot === "assessment_user_score"
					? { kind: "connect-assessment", form: slot.uuid, role: "score" }
					: {
							kind: "connect-delivery",
							form: slot.uuid,
							role:
								slot.slot === "deliver_entity_id" ? "entity-id" : "entity-name",
						};
			profile = slotProfile(
				"form",
				"form",
				["XF"],
				{ kind: "value" },
				{ searchInputs: form.searchInputs },
			);
		}
	} else {
		const searchInputUuid =
			"member" in slot && "searchInputUuid" in slot.member
				? slot.member.searchInputUuid
				: undefined;
		const input =
			searchInputUuid !== undefined
				? module.caseListConfig?.searchInputs.find(
						(entry) => entry.uuid === searchInputUuid,
					)
				: undefined;
		if (
			"member" in slot &&
			"searchInputUuid" in slot.member &&
			input === undefined
		)
			return undefined;
		if (slot.slot === "case_list_column_expression") {
			const column = module.caseListConfig?.columns.find(
				(entry) => entry.uuid === slot.member.columnUuid,
			);
			if (column?.kind !== "calculated") return undefined;
		}
		const caseSlot = [
			"case_list_filter",
			"case_list_column_expression",
			"search_input_predicate",
		].includes(slot.slot);
		if (caseSlot && module.caseType === undefined) return undefined;
		const condition = [
			"module_display_condition",
			"case_list_filter",
			"search_button_display_condition",
			"search_input_predicate",
			"search_input_options",
			"search_input_required_when",
			"search_input_validation_rule",
		].includes(slot.slot);
		const admitsInputs = [
			"case_list_filter",
			"case_list_column_expression",
			"search_input_predicate",
			"excluded_owner_ids",
			"search_input_required_when",
			"search_input_validation_rule",
		].includes(slot.slot);
		const searchable = effectiveCaseSearchConfig(module) !== undefined;
		const targets: readonly import("./profiles").ExpressionTarget[] =
			slot.slot === "search_input_predicate"
				? ["CS", "PG"]
				: slot.slot === "case_list_filter"
					? searchable
						? ["SU", "HQ", "CS", "PG"]
						: ["SU", "HQ", "PG"]
					: slot.slot === "case_list_column_expression"
						? searchable
							? ["SU", "HQ", "CS", "PG", "PV"]
							: ["SU", "HQ", "PG", "PV"]
						: slot.slot === "excluded_owner_ids"
							? ["SU", "CS", "PG"]
							: ["SU", "HQ", "PV"];
		profile = slotProfile(
			"record",
			caseSlot ? "case" : "global",
			targets,
			condition ? { kind: "condition" } : { kind: "value" },
			{
				searchInputs: admitsInputs ? searchInputs : [],
				patternMatching:
					slot.slot === "search_input_required_when" ||
					slot.slot === "search_input_validation_rule",
				here: slot.slot === "case_list_column_expression",
			},
		);
		if (slot.slot === "excluded_owner_ids")
			profile = { ...profile, expectation: { kind: "value", type: "text" } };
		if (caseSlot)
			rows = [
				{
					kind: "case",
					root: slot.slot === "search_input_predicate" ? "results" : "casedb",
					caseType: module.caseType,
				},
			];
		if (slot.slot === "search_input_options") {
			if (input === undefined || !("options" in input)) return undefined;
			rows = [{ kind: "table", root: "table", tableId: input.options.tableId }];
			profile = { ...profile, scope: "table" };
		}
		if (input !== undefined) {
			if (slot.slot === "search_input_predicate" && input.kind !== "advanced")
				return undefined;
			if (slot.slot === "search_input_hidden_value" && input.kind !== "hidden")
				return undefined;
			if (
				[
					"search_input_default",
					"search_input_required_when",
					"search_input_validation_rule",
				].includes(slot.slot) &&
				input.kind === "hidden"
			)
				return undefined;
			if (
				slot.slot === "search_input_default" &&
				"type" in input &&
				input.type === "date-range"
			)
				return undefined;
			if (
				slot.slot === "search_input_default" &&
				"type" in input &&
				input.type !== "date-range"
			)
				profile = {
					...profile,
					expectation: {
						kind: "value",
						type: SEARCH_INPUT_TYPE_DEFAULT_EXPECTED_TYPES[input.type],
					},
				};
		}
	}
	return {
		slot,
		ruleSet: profile.ruleSet,
		profile,
		facts,
		...(form === undefined ? {} : { form }),
		...(sourceNode === undefined
			? {}
			: { sourceNode, contextNode: sourceNode }),
		rows,
		lookupTables,
		supplies,
		...(targetSupplies === undefined ? {} : { targetSupplies }),
	};
}
