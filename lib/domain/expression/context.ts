import { formCaseSelections } from "../advancedEntryDatums";
import { ancestorWalk } from "../advancedModule";
import { registrationMintsOwnCaseId } from "../basicCaseSlots";
import type { BlueprintDoc, CaseType } from "../blueprint";
import type { CasePropertyDataType } from "../casePropertyTypes";
import {
	caseDataTypeForFieldKind,
	caseRefAcceptMap,
	reachableCaseTypes,
	toReachableIndex,
} from "../caseTypes";
import { detailConditionFixtures, detailTabForColumn } from "../detailTabs";
import {
	detailEntrySupplies,
	type EntryDatumSupplies,
	entryDatumSupplies,
	formLinkTargetSupplies,
	loadedSearchModules,
	sharedFormDatumSupplies,
} from "../entryDatumSupplies";
import { formOfField } from "../fieldForm";
import type { SelectOption } from "../fields";
import { resolveFormLinkTarget } from "../formLinkTargets";
import {
	caseWriteKeyOf,
	operationCaseType,
	orderedCaseOperations,
	sameCaseWriteKey,
} from "../forms";
import { menuWithInheritedCaseSettings } from "../listedForms";
import type { TranslationUnitId } from "../localization";
import type {
	LookupColumnId,
	LookupMemberId,
	LookupTableId,
} from "../lookupIds";
import {
	afterEmptySearchRegistrationFormOf,
	caseListsOffering,
} from "../menuForms";
import { formRouteBeforeCase } from "../menuScreens";
import {
	effectiveCaseSearchConfig,
	moduleFormsReadSearch,
	projectSearchOf,
	SEARCH_INPUT_TYPE_DEFAULT_EXPECTED_TYPES,
	searchInputRuntimeValueType,
} from "../modules";
import {
	type LocationProperty,
	locationPropertiesOf,
	type OrganizationLevel,
	organizationLevelsOf,
} from "../organization";
import { declaredPlatforms, type Platform } from "../platforms";
import { proseText } from "../prose";
import { searchSupplierAddresses } from "../referenceNames";
import {
	expressionSlotValues,
	FIELD_REFERENCE_SLOTS,
	type FieldReferenceSlot,
	FORM_REFERENCE_SLOTS,
	type FormReferenceSlot,
} from "../referenceSlots";
import {
	isFacetWriteThroughIndex,
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
import { resolveRelationDestination } from "./relationDestination";
import type { Held, ScalarHeld, ScalarType } from "./typeChecker";
import { expressionRowScope } from "./typeChecker";
import { datumRefKey, type FormNodeRef, type SlotContextRef } from "./types";

export type LookupTypeIndex = ReadonlyMap<
	LookupTableId,
	ReadonlyMap<string, CasePropertyDataType>
>;
/** Names for parsing and wire projection; no table rows or persistence layer. */
export type LookupDefinitionIndex = ReadonlyMap<
	LookupTableId,
	{
		readonly id: LookupTableId;
		readonly name: string;
		readonly tag: string;
		readonly attributes?: readonly {
			readonly id: LookupMemberId;
			readonly wireName: string;
			readonly label: string;
		}[];
		readonly columns: readonly {
			readonly repeated?: true;
			readonly properties?: readonly {
				readonly id: LookupMemberId;
				readonly wireName: string;
				readonly label: string;
			}[];
			readonly id: LookupColumnId;
			readonly wireName: string;
			readonly label: string;
			readonly dataType: CasePropertyDataType;
		}[];
	}
>;
export interface SearchInputDecl {
	readonly supplier?: Uuid;
	readonly supplierId?: string;
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
	| { readonly kind: "worker-group"; readonly root: "worker-groups" }
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
	readonly projectSearchMenus?: ReadonlySet<Uuid>;
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
	/** Each ancestor type the form reads across a hop no one index name
	 * walks for every case the app links (`advancedModule.ts::ancestorWalk`),
	 * with the first such hop: a read of that type walks one name and reads
	 * blank for the cases linked under another, or a case other than the one
	 * a worker chose. */
	readonly ancestorHopsUnresolved: ReadonlyMap<string, AncestorHopUnresolved>;
	/** False on a registration whose entry gives the case it creates no
	 * session value (its change is a Save to Case block,
	 * `basicCaseSlots.ts::registrationMintsOwnCaseId`): no read of that case
	 * or the cases above it has an id to start from. True on every other
	 * form. */
	readonly ownCaseIdMinted: boolean;
	readonly searchInputs: readonly SearchInputDecl[];
	/** Whether the form is its module's `after-empty-search` registration form
	 * (`menuForms.ts::afterEmptySearchRegistrationFormOf`), which opens from
	 * Results after a search found nothing and carries the Search answers. */
	readonly caseListRegistrationForm: boolean;
	/** A second list can open the same hidden form without running its owning menu's search. */
	readonly opensFromAnotherList?: boolean;
	/** Whether the form's menu has its forms read the search, so its forms
	 * open after the inline query that keeps the Search answers
	 * (`search-input:results:inline`). */
	readonly formsReadSearchModule: boolean;
	readonly searchResultsName?: string;
	/** The menus whose query steps are in this form's entry, by their current authored names. */
	readonly searchSuppliers?: readonly { module: Uuid; resultsName?: string }[];
	/** Whether a translation unit this form's questions or choices own shows
	 * an answer in some language (`translationUnits.ts::formTranslationUnits`).
	 * Asked only by a `jr:itext` or `jr:choice-name` read, so a form with none
	 * never builds the document's translation-unit snapshot. */
	readonly unitShowsAnswer: (unitId: TranslationUnitId) => boolean;
}
/** A hop from `childType` to its catalog parent `parentType` that the app
 * links under `identifiers`, with no one of them on every case it links
 * (`no-name`), or with `child-name`'s `identifier`, the one name its child
 * links use and so the one a parent selection lists a case under, missing
 * from some (`advancedModule.ts::ancestorWalk`). */
export interface AncestorHopUnresolved {
	readonly childType: string;
	readonly parentType: string;
	readonly identifiers: readonly string[];
	readonly why:
		| { readonly kind: "no-name" }
		| { readonly kind: "child-name"; readonly identifier: string };
}
/** The ancestor types a form of `moduleCaseType` reads across a hop no one
 * index name walks, each with the first such hop below it. */
function ancestorHopsUnresolvedOf(
	doc: BlueprintDoc,
	moduleCaseType: string | undefined,
	caseTypes: readonly CaseType[],
): ReadonlyMap<string, AncestorHopUnresolved> {
	const result = new Map<string, AncestorHopUnresolved>();
	let below: string | undefined;
	let unresolved: AncestorHopUnresolved | undefined;
	for (const type of reachableCaseTypes(moduleCaseType, caseTypes)) {
		if (below !== undefined && unresolved === undefined) {
			const walk = ancestorWalk(doc, below, type.name);
			if (walk.kind === "several")
				unresolved = {
					childType: below,
					parentType: type.name,
					identifiers: walk.identifiers,
					why: walk.why,
				};
		}
		if (unresolved !== undefined) result.set(type.name, unresolved);
		below = type.name;
	}
	return result;
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
	readonly detailConditionFixtures?: ReadonlySet<LookupTableId | "places">;
	/** A value of a server search condition that a device works out before
	 * the search runs (`searchRuntimeValues.ts`): the slot names no device
	 * target, yet Core evaluates this expression. */
	readonly runsOnDevice?: true;
	/** A displayed condition also reads the Search result snapshot when its menu offers Search. */
	readonly runsOnSearchResults?: true;
	/** The translated pieces this calculated field owns. */
	readonly caseTexts?: readonly {
		readonly uuid: Uuid;
		readonly label: string;
	}[];
	/** The platforms the app declares (`declaredPlatforms`): what an
	 * expression leaf one platform lacks is refused against. */
	readonly platforms: readonly Platform[];
}
export type RecordQueryRowScope =
	| { readonly kind: "case"; readonly caseType?: string }
	| {
			readonly kind: "table";
			readonly tableId: LookupTableId;
			readonly capturedCase?: Extract<RecordQueryRowScope, { kind: "case" }>;
	  }
	| { readonly kind: "location" }
	| { readonly kind: "worker-group" };
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
		/** What CommCare holds a form answer as, where its type alone does
		 * not say: a Hidden Value's settled held class (inference's
		 * `hiddenHeld`), the one the gate reads, so a yes or no Hidden Value
		 * stands as a condition here as it does there. Absent is the class
		 * its type gives. */
		readonly formFieldHeld: ReadonlyMap<Uuid, ScalarHeld>;
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
				orderedCaseOperations(form).flatMap((operation) =>
					operation.action === "create"
						? [[operation.uuid, operation.caseType] as const]
						: [],
				),
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
		projectSearchMenus: new Set(
			Object.values(doc.modules)
				.filter((module) => projectSearchOf(module) !== undefined)
				.map((module) => module.uuid),
		),
		moduleCaseTypes: new Map(
			Object.values(doc.modules).flatMap((module) => {
				const value = menuWithInheritedCaseSettings(doc, module.uuid)?.caseType;
				return value === undefined ? [] : [[module.uuid, value] as const];
			}),
		),
	};
	untypedFacts.set(doc, result);
	return result;
}

/** A project service returns its own rows. Ordinary search guarantees one
 * record type and can add related cases beside the actual matches. */
export function readsProjectSearchResults(
	ctx: ExpressionContext,
	supplier?: Uuid,
): boolean {
	const source = supplier ?? ctx.supplies.searchResults?.module;
	return (
		source !== undefined && ctx.facts.projectSearchMenus?.has(source) === true
	);
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
	readonly formFieldHeld?: RecordQueryContext["bindings"]["formFieldHeld"];
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
			formFieldHeld: input.formFieldHeld ?? new Map(),
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
	const supplied = loadedSearchModules(
		entryDatumSupplies(
			doc,
			{ kind: "form", module: structure.moduleUuid, form: structure.formUuid },
			structure,
		),
	);
	const menuNames = supplied.some((uuid) => uuid !== structure.moduleUuid)
		? searchSupplierAddresses(doc.modules)
		: undefined;
	const searchInputs = [
		...new Set([structure.moduleUuid, ...supplied]),
	].flatMap((uuid) => {
		const owner = doc.modules[uuid];
		return (owner?.caseListConfig?.searchInputs ?? []).map((input) => ({
			uuid: input.uuid,
			name: input.name,
			data_type: searchInputRuntimeValueType(input),
			...(uuid !== structure.moduleUuid && {
				supplier: uuid,
				supplierId: menuNames?.get(uuid),
			}),
		}));
	});
	return {
		...structure,
		fields,
		searchResultsName: module?.searchResultsName,
		searchSuppliers: supplied.map((uuid) => ({
			module: uuid,
			resultsName: doc.modules[uuid].searchResultsName,
		})),
		searchInputs,
		caseListRegistrationForm:
			afterEmptySearchRegistrationFormOf(doc, structure.moduleUuid) ===
			structure.formUuid,
		...(afterEmptySearchRegistrationFormOf(doc, structure.moduleUuid) ===
			structure.formUuid &&
			caseListsOffering(doc, structure.formUuid).length > 0 && {
				opensFromAnotherList: true,
			}),
		formsReadSearchModule:
			module !== undefined && moduleFormsReadSearch(module),
		unitShowsAnswer: (unitId) =>
			formTranslationUnits(doc, structure.formUuid).get(unitId)?.showsAnswer ===
			true,
		readableCaseTypes: readableCaseTypesOf(
			doc,
			facts.caseTypes,
			module?.caseType,
			structure.type,
		),
		ancestorHopsUnresolved: ancestorHopsUnresolvedOf(
			doc,
			module?.caseType,
			facts.caseTypes,
		),
		ownCaseIdMinted:
			structure.type !== "registration" ||
			doc.forms[structure.formUuid]?.type !== "registration" ||
			registrationMintsOwnCaseId(doc, structure.formUuid),
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
	const module =
		moduleUuid === undefined
			? undefined
			: menuWithInheritedCaseSettings(doc, moduleUuid);
	if (module === undefined || moduleUuid === undefined) return undefined;
	const searchInputs = (module.caseListConfig?.searchInputs ?? []).map(
		(input) => ({
			uuid: input.uuid,
			name: input.name,
			data_type: searchInputRuntimeValueType(input),
		}),
	);
	let profile: SlotProfile;
	let caseTexts: ExpressionContext["caseTexts"];
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
		if (
			(slot.slot === "option_label" || slot.slot === "option_extended_text") &&
			(field.choices?.kind !== "inline" ||
				!field.choices.options.some(
					(option) => option.uuid === slot.member.optionUuid,
				))
		)
			return undefined;
		// A query repeat's `relevant` evaluates at its row, in both placements.
		sourceNode = { kind: "field", uuid: slot.uuid };
		if (slot.slot === "assessment_user_score") {
			if (field.activityKind !== "assessment") return undefined;
			sourceNode = {
				kind: "connect-assessment",
				activity: slot.uuid,
				role: "score",
			};
		} else if (
			slot.slot === "deliver_entity_id" ||
			slot.slot === "deliver_entity_name" ||
			slot.slot === "deliver_work_area_id"
		) {
			if (field.activityKind !== "delivery") return undefined;
			const role = {
				deliver_entity_id: "entity-id",
				deliver_entity_name: "entity-name",
				deliver_work_area_id: "work-area-id",
			} as const;
			sourceNode = {
				kind: "connect-delivery",
				activity: slot.uuid,
				role: role[slot.slot],
			};
		}
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
					: slot.slot === "repeat_count"
						? { kind: "repeat-count" }
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
		supplies = sharedFormDatumSupplies(
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
		supplies = sharedFormDatumSupplies(
			doc,
			{
				kind: "form",
				module: moduleUuid,
				form: slot.uuid,
			},
			options.form,
		);
		if (
			slot.slot === "form_selection_source" ||
			slot.slot === "form_entry_value"
		) {
			if (!saved) return undefined;
			const choices = formCaseSelections(doc, slot.uuid);
			const values = saved.computedDatums ?? [];
			const rows = slot.slot === "form_selection_source" ? choices : values;
			const index = rows.findIndex(
				(row) => row.uuid === slot.member.supplyUuid,
			);
			if (index < 0) return undefined;
			const prefix =
				slot.slot === "form_selection_source"
					? choices.slice(0, index)
					: choices;
			const earlierValues =
				slot.slot === "form_entry_value" ? values.slice(0, index) : [];
			supplies = {
				refs: supplies.refs.filter(({ ref }) => {
					if (ref.kind === "form-selection")
						return prefix.some((row) => row.uuid === ref.selection);
					if (ref.kind === "entry-value")
						return earlierValues.some((row) => row.uuid === ref.datum);
					if (ref.kind === "worker-record")
						return prefix.some((row) => row.source.kind === "worker-record");
					if (ref.kind === "selected-case")
						return (
							prefix.filter(
								(row) =>
									row.source.kind === "choose" &&
									row.source.module === ref.module,
							).length === 1
						);
					return false;
				}),
			};
			profile = slotProfile("form", "session", ["SU", "HQ", "PV"], {
				kind: "value",
			});
		} else if (
			slot.slot === "form_display_condition" ||
			slot.slot === "form_badge"
		) {
			if (saved === undefined) return undefined;
			const caseFirst =
				formRouteBeforeCase(doc, moduleUuid, slot.uuid, options.form) ===
				undefined;
			profile = slotProfile(
				"record",
				"session",
				["SU", "HQ", "PV"],
				slot.slot === "form_badge" ? { kind: "value" } : { kind: "condition" },
				{ caseData: caseFirst || slot.slot === "form_badge" },
			);
			if (caseFirst)
				rows = [{ kind: "case", root: "casedb", caseType: module.caseType }];
			supplies = sharedFormDatumSupplies(
				doc,
				{
					kind: "form-menu",
					module: moduleUuid,
					form: slot.uuid,
				},
				options.form,
			);
		} else if (
			slot.slot === "form_open_condition" ||
			slot.slot === "form_close_condition"
		) {
			// Form logic over the form's answers, read once as the form is
			// submitted: the own case's Case Management condition or the
			// relevance of its Save to Case block.
			profile = slotProfile(
				"form",
				"form",
				["XF", "HQ", "PV"],
				{ kind: "condition" },
				{ searchInputs: form.searchInputs },
			);
		} else if (
			slot.slot === "form_link_condition" ||
			slot.slot === "form_link_datum_xpath"
		) {
			const link = form.links.get(slot.member.linkUuid);
			if (link === undefined) return undefined;
			// The otherwise link has no condition slot.
			if (slot.slot === "form_link_condition" && link.role === "otherwise")
				return undefined;
			// `this-form` is the form this structure reads, in its own menu,
			// which a prepared form may not hold in the saved document yet.
			const target = resolveFormLinkTarget(
				{ formOrder: { [form.moduleUuid]: [form.formUuid] } },
				form.formUuid,
				link.target,
			);
			if (target === undefined) return undefined;
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
			targetSupplies = formLinkTargetSupplies(doc, target);
		} else if ("member" in slot && "operationUuid" in slot.member) {
			if (saved === undefined) return undefined;
			const member = slot.member;
			const operations = orderedCaseOperations(saved);
			const index = operations.findIndex(
				(operation) => operation.uuid === member.operationUuid,
			);
			const operation = operations[index];
			if (operation === undefined) return undefined;
			const write =
				"property" in member
					? operation.writes?.find((candidate) =>
							sameCaseWriteKey(caseWriteKeyOf(candidate), {
								property: member.property,
								...(member.via === undefined ? {} : { via: [...member.via] }),
							}),
						)
					: undefined;
			if ("property" in member && write === undefined) return undefined;
			if (
				"identifier" in member &&
				!operation.links?.some((link) => link.identifier === member.identifier)
			)
				return undefined;
			const condition =
				slot.slot === "case_operation_condition" ||
				slot.slot === "case_operation_close_condition" ||
				slot.slot === "case_operation_owner_condition" ||
				slot.slot === "case_operation_write_condition";
			const target =
				(slot.slot === "case_operation_target_expression" &&
					operation.target?.kind !== "new") ||
				slot.slot === "case_operation_link_target_expression";
			// A write lands on the operation's case after any retype, or through
			// `via` on the case above it; the form's own change saves to its
			// module's case.
			const operationType =
				operation.retype ?? operationCaseType(doc, slot.uuid, operation);
			const viaDestination =
				write?.via === undefined || operationType === undefined
					? undefined
					: resolveRelationDestination(
							{ kind: "ancestor", via: write.via },
							operationType,
							doc.caseTypes ?? [],
						);
			const destinationType =
				viaDestination === undefined
					? operationType
					: viaDestination.ok
						? viaDestination.caseType
						: undefined;
			// A facet, and the name or owner of a case above saved through
			// `via`, take an identifier's text.
			const facetText =
				!("property" in member) ||
				(write !== undefined && isFacetWriteThroughIndex(write));
			const destinations: CasePropertyDataType[] = facetText
				? ["text"]
				: destinationType === undefined
					? []
					: [
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
						];
			profile = slotProfile(
				"record",
				"submission",
				["XF", "PG"],
				condition
					? { kind: "condition" }
					: {
							kind: "assignment",
							destinations,
							...(facetText && {
								identifierText: true as const,
							}),
						},
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
					captureLinkWholeValue: slot.slot === "case_operation_write_value",
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
		} else return undefined;
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
		if (slot.slot === "case_list_mapping_condition") {
			const column = module.caseListConfig?.columns.find(
				(entry) => entry.uuid === slot.member.columnUuid,
			);
			if (
				(column?.kind !== "id-mapping" && column?.kind !== "image-map") ||
				!column.mapping.some((row) => row.uuid === slot.member.rowUuid)
			)
				return undefined;
		}
		if (
			slot.slot === "search_filter_value" &&
			!module.caseListConfig?.searchFilters?.some(
				(filter) =>
					"target" in filter && filter.uuid === slot.member.filterUuid,
			)
		)
			return undefined;
		if (
			slot.slot === "project_search_parameter" &&
			!projectSearchOf(module)?.defaults.some(
				(parameter) => parameter.uuid === slot.member.parameterUuid,
			)
		)
			return undefined;
		if (slot.slot === "case_list_column_expression") {
			const column = module.caseListConfig?.columns.find(
				(entry) => entry.uuid === slot.member.columnUuid,
			);
			if (column?.kind !== "calculated") return undefined;
			caseTexts = column.texts;
		}
		if (
			slot.slot === "case_list_sort_expression" &&
			!module.caseListConfig?.calculatedSorts?.some(
				(rule) => rule.uuid === slot.member.sortUuid,
			)
		)
			return undefined;
		const orderValue =
			slot.slot === "case_list_sort_expression" ||
			slot.slot === "case_list_mapping_condition" ||
			slot.slot === "case_list_column_expression";
		const tabUuid =
			"member" in slot && "tabUuid" in slot.member
				? slot.member.tabUuid
				: undefined;
		const tab =
			tabUuid &&
			module.caseListConfig?.detailTabs?.find((tab) => tab.uuid === tabUuid);
		if ("member" in slot && "tabUuid" in slot.member && !tab) return undefined;
		const caseSlot = [
			"case_list_mapping_condition",
			"case_form_context_line",
			"case_detail_tab_filter",
			"case_detail_tab_rows",
			"case_detail_tab_condition",
			"case_list_filter",
			"case_search_filter",
			"case_list_column_expression",
			"case_list_sort_expression",
			"search_input_predicate",
		].includes(slot.slot);
		if (caseSlot && module.caseType === undefined) return undefined;
		const condition = [
			"case_list_mapping_condition",
			"case_detail_tab_filter",
			"case_detail_tab_condition",
			"module_display_condition",
			"case_list_action_condition",
			"case_list_filter",
			"case_search_filter",
			"search_button_display_condition",
			"search_input_predicate",
			"search_input_options",
			"search_input_required_when",
			"search_input_validation_rule",
		].includes(slot.slot);
		const admitsInputs = [
			"case_list_mapping_condition",
			"search_filter_value",
			"case_list_filter",
			"case_search_filter",
			"case_list_column_expression",
			"case_list_sort_expression",
			"search_input_predicate",
			"excluded_owner_ids",
			"project_search_parameter",
			"search_input_required_when",
			"search_input_validation_rule",
		].includes(slot.slot);
		const searchable = effectiveCaseSearchConfig(module) !== undefined;
		const targets: readonly import("./profiles").ExpressionTarget[] =
			slot.slot === "case_list_mapping_condition"
				? ["SU", "HQ", "PG", "PV"]
				: slot.slot === "case_detail_tab_rows" ||
						slot.slot === "case_detail_tab_filter" ||
						slot.slot === "case_detail_tab_condition" ||
						slot.slot === "case_form_context_line"
					? ["HQ", "SU", "PV", "PG"]
					: slot.slot === "search_input_predicate" ||
							slot.slot === "case_search_filter"
						? ["CS", "PG"]
						: slot.slot === "case_list_filter"
							? searchable &&
								module.caseListConfig?.searchCondition === undefined
								? ["SU", "HQ", "CS", "PG"]
								: ["SU", "HQ", "PG"]
							: orderValue
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
				...(slot.slot === "module_badge" ||
				slot.slot === "module_display_condition"
					? { caseData: true }
					: {}),
				searchInputs: admitsInputs ? searchInputs : [],
				patternMatching:
					slot.slot === "search_input_required_when" ||
					slot.slot === "search_input_validation_rule",
				here: orderValue,
			},
		);
		if (slot.slot === "excluded_owner_ids")
			profile = { ...profile, expectation: { kind: "value", type: "text" } };
		if (caseSlot)
			rows = [
				{
					kind: "case",
					root:
						slot.slot === "search_input_predicate" ||
						slot.slot === "case_search_filter"
							? "results"
							: "casedb",
					caseType: module.caseType,
				},
			];
		if (slot.slot === "case_detail_tab_rows")
			profile = { ...profile, expectation: { kind: "value", many: true } };
		if (slot.slot === "case_detail_tab_filter") {
			if (tab?.rowSource?.kind !== "children") return undefined;
			rows = [
				{ kind: "case", root: "casedb", caseType: tab.rowSource.caseType },
			];
		}
		if (slot.slot === "case_list_column_expression") {
			const tab = detailTabForColumn(
				module.caseListConfig,
				slot.member.columnUuid,
			);
			const source = tab?.rowSource;
			if (source?.kind === "children")
				rows = [{ kind: "case", root: "casedb", caseType: source.caseType }];
			if (tab && source?.kind === "records") {
				const context = slotContext(
					doc,
					{
						entity: "module",
						uuid: moduleUuid,
						slot: "case_detail_tab_rows",
						member: {
							tabUuid: tab.uuid,
						},
					},
					lookupTables,
					options,
				);
				const row = context && expressionRowScope(source.rows, context);
				if (row) {
					rows = [row];
					profile = {
						...profile,
						...(row.kind !== "case" && {
							targets: new Set<import("./profiles").ExpressionTarget>([
								"HQ",
								"SU",
								"PV",
							]),
						}),
						scope:
							row.kind === "table"
								? "table"
								: row.kind === "location"
									? "global"
									: "case",
					};
				}
			}
		}
		// The case list filter and an advanced search input's condition run at
		// the module's case list step, after the selections before its own
		// (`lib/domain/entryDatumSupplies.ts`).
		if (
			slot.slot === "case_list_filter" ||
			slot.slot === "case_list_action_condition"
		)
			supplies = entryDatumSupplies(doc, {
				kind: "case-list",
				module: moduleUuid,
			});
		if (
			slot.slot === "case_detail_tab_rows" ||
			slot.slot === "case_detail_tab_filter" ||
			slot.slot === "case_detail_tab_condition" ||
			slot.slot === "case_form_context_line" ||
			(slot.slot === "case_list_column_expression" &&
				detailTabForColumn(module.caseListConfig, slot.member.columnUuid))
		) {
			// The earlier selections are available on every path into this
			// selector. An inline search also supplies the rows from which its
			// worker just chose a case on every path into its detail.
			supplies = detailEntrySupplies(doc, moduleUuid);
		}
		if (
			slot.slot === "search_input_predicate" ||
			slot.slot === "search_filter_value" ||
			slot.slot === "case_search_filter" ||
			slot.slot === "project_search_parameter"
		)
			supplies = entryDatumSupplies(doc, {
				kind: "search",
				module: moduleUuid,
			});
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
			if (slot.slot === "search_input_default" && "type" in input)
				profile = {
					...profile,
					expectation: {
						kind: "value",
						type: SEARCH_INPUT_TYPE_DEFAULT_EXPECTED_TYPES[input.type],
					},
				};
		}
	}
	profile = {
		...profile,
		// The case list's search text is session data a form's questions and
		// Connect settings read; a record slot has no spelling of it.
		caseListSearchText: profile.ruleSet === "form" && profile.scope === "form",
		// The window width reaches only a request that loads a menu or a list:
		// every module slot and a form's display condition, never a slot a form
		// evaluates (questions, Connect, case operations, links, choice filters).
		windowWidth:
			slot.entity === "module" ||
			(slot.entity === "form" &&
				(slot.slot === "form_display_condition" || slot.slot === "form_badge")),
	};
	return {
		slot,
		...(slot.entity === "module" &&
			slot.slot === "case_detail_tab_condition" &&
			module.caseListConfig && {
				detailConditionFixtures: detailConditionFixtures(doc, module),
			}),
		ruleSet: profile.ruleSet,
		...(caseTexts !== undefined && { caseTexts }),
		...(slot.slot === "case_list_mapping_condition" &&
			effectiveCaseSearchConfig(module) !== undefined && {
				runsOnSearchResults: true,
			}),
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
		platforms: declaredPlatforms(doc),
	};
}
