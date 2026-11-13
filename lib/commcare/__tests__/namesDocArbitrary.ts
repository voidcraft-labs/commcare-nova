/**
 * Documents whose names fill the grammars Nova holds, for the XForm and suite
 * oracle corpora: question ids holding hyphens, case types that start with a
 * digit or a hyphen or are one of reference text's fixed words, written
 * properties holding a hyphen and the properties `state` and `category`,
 * selects of one option, choice values holding a quote mark, and a Search
 * field whose name holds a hyphen.
 *
 * The other generators draw names from fixed lists, and the proof lane's fuzz
 * documents are drawn from them (`proof/corpus/fuzzSample.ts`), so a longer
 * list there would move every existing seed's draws. This family draws three
 * things side by side: a document of `suiteDocArbitrary`, which gives the
 * module shapes; a form core as `xformDocArbitrary` draws one (field trees of
 * groups and repeats nested two deep and, for about one form in four, pages),
 * which joins the first form; and a stream of its own name draws. It applies
 * the names after every draw, with no further random call, to the children of
 * every form and every group, repeat and page, so a group `a` holding `a-b`
 * meets the itext key's doubled hyphen at any depth.
 */
import * as fc from "fast-check";
import { Immer } from "immer";
import { expect } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { planDatetimeSplits } from "@/lib/doc/datetimeSplit";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { holdsUserRepeat } from "@/lib/doc/groupFieldLists";
import { applyMutations } from "@/lib/doc/mutations";
import {
	type BlueprintDoc,
	type CaseOperation,
	effectiveSimpleSearchModeKind,
	type Field,
	isContainer,
	proseText,
	type SearchInputDef,
	type Uuid,
} from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression/types";
import { suiteDocArbitrary } from "./suiteDocArbitrary";
import {
	buildField,
	type FieldBuildCtx,
	type FieldDraft,
	type FieldGenSpec,
	fieldSpecArb,
	hasSectionedForm,
	IdMinter,
	mappedAsTheCutoverMaps,
	pickSiblingId,
	resolveArbitraryDocument,
	sectionRoot,
	sectionsChoiceArb,
} from "./xformDocArbitrary";

export const NAMES_FIELD_IDS = [
	"first-name",
	"copy-1-of-age",
	"a-",
	"a",
	"a-b",
] as const;
export const NAMES_CASE_TYPES = [
	"case",
	"parent",
	"user",
	"1st-visit",
	"-flagged",
	"2024",
	"patient",
] as const;
export const NAMES_WRITTEN_PROPERTIES = [
	"first-name",
	"state",
	"category",
	"visit-count",
] as const;
export const NAMES_CHOICE_VALUES = [
	"it's",
	'say"hi"',
	"back`tick",
	"plain",
] as const;
export const NAMES_SEARCH_FIELD = "first-name";

/** The names one document takes, drawn apart from the document. */
interface NameDraws {
	/** A field id for each of the first children of every form and every
	 *  group, repeat and page, by position. */
	readonly fieldIds: readonly string[];
	/** The case type each of the document's case types becomes, in catalog order. */
	readonly caseTypes: readonly string[];
	/** Properties a form's own case change also writes. */
	readonly writtenProperties: readonly string[];
	/** The choices of a single select added to the first form. */
	readonly choiceValues: readonly string[];
}

const nameDrawsArbitrary: fc.Arbitrary<NameDraws> = fc.record({
	fieldIds: fc.shuffledSubarray([...NAMES_FIELD_IDS], { minLength: 1 }),
	caseTypes: fc.shuffledSubarray([...NAMES_CASE_TYPES], {
		minLength: NAMES_CASE_TYPES.length,
	}),
	writtenProperties: fc.shuffledSubarray([...NAMES_WRITTEN_PROPERTIES], {
		minLength: 1,
	}),
	choiceValues: fc.shuffledSubarray([...NAMES_CHOICE_VALUES], {
		minLength: 1,
		maxLength: 3,
	}),
});

/** The keys whose string value names a case type. */
const CASE_TYPE_KEYS = new Set([
	"caseType",
	"parent_type",
	"targetType",
	"throughCaseType",
	"ofCaseType",
	"ownerCaseType",
]);

/** `value` with every case type `renamed` names, under a key that names one, renamed. */
function withCaseTypes(
	value: unknown,
	renamed: ReadonlyMap<string, string>,
): unknown {
	if (Array.isArray(value))
		return value.map((item) => withCaseTypes(item, renamed));
	if (value === null || typeof value !== "object") return value;
	const out: Record<string, unknown> = Object.create(
		Object.getPrototypeOf(value),
	);
	for (const [key, item] of Object.entries(value)) {
		out[key] =
			CASE_TYPE_KEYS.has(key) && typeof item === "string"
				? (renamed.get(item) ?? item)
				: withCaseTypes(item, renamed);
	}
	return out;
}

function renameCaseTypes(
	doc: BlueprintDoc,
	draws: readonly string[],
): BlueprintDoc {
	const renamed = new Map<string, string>();
	(doc.caseTypes ?? []).forEach((caseType, index) => {
		const name = draws[index];
		if (name !== undefined) renamed.set(caseType.name, name);
	});
	const next = withCaseTypes(doc, renamed) as BlueprintDoc;
	return {
		...next,
		caseTypes:
			next.caseTypes === null
				? null
				: next.caseTypes.map((caseType) => ({
						...caseType,
						name: renamed.get(caseType.name) ?? caseType.name,
					})),
	};
}

/** Give the first children of `parentUuid` the drawn ids, where no sibling
 *  holds one, then do the same inside each container among them; a
 *  container's first child is named `a-b`, so a container the draws name `a`
 *  holds `a-b` and meets the itext key's doubled hyphen. */
function renameChildren(
	doc: BlueprintDoc,
	parentUuid: Uuid,
	ids: readonly string[],
): void {
	const children = doc.fieldOrder[parentUuid] ?? [];
	const taken = new Set(children.map((uuid) => doc.fields[uuid]?.id));
	children.forEach((uuid, index) => {
		const field = doc.fields[uuid];
		const id = ids[index];
		if (field === undefined || id === undefined || taken.has(id)) return;
		taken.delete(field.id);
		taken.add(id);
		doc.fields[uuid] = { ...field, id } as Field;
	});
	for (const uuid of children) {
		const field = doc.fields[uuid];
		if (field === undefined || !isContainer(field)) continue;
		renameChildren(doc, uuid, ids);
		const nested = doc.fieldOrder[uuid] ?? [];
		const [first] = nested;
		const child = first === undefined ? undefined : doc.fields[first];
		if (
			child !== undefined &&
			first !== undefined &&
			!nested.some((sibling) => doc.fields[sibling]?.id === "a-b")
		)
			doc.fields[first] = { ...child, id: "a-b" } as Field;
	}
}

/** Give every form's field tree the drawn ids, at every depth. */
function renameFields(doc: BlueprintDoc, ids: readonly string[]): void {
	for (const formUuid of Object.keys(doc.forms) as Uuid[])
		renameChildren(doc, formUuid, ids);
}

/** Add, to the first form, a single select over the drawn choices and a text
 *  question whose answer its own case change writes to each drawn property. */
function addChoicesAndWrites(
	doc: BlueprintDoc,
	choiceValues: readonly string[],
	properties: readonly string[],
): void {
	const formUuid = Object.keys(doc.forms)[0] as Uuid | undefined;
	if (formUuid === undefined) return;
	const order = doc.fieldOrder[formUuid] ?? [];
	const taken = new Set(order.map((uuid) => doc.fields[uuid]?.id));
	const choice = testUuid("names-fuzz-choice");
	if (!taken.has("choice")) {
		doc.fields[choice] = {
			uuid: choice,
			kind: "single_select",
			id: "choice",
			label: proseText("Choice"),
			optionsSource: {
				kind: "inline",
				options: choiceValues.map((value, index) => ({
					uuid: testUuid(`names-fuzz-choice-option-${index}`),
					value,
					label: proseText(`Choice ${index + 1}`),
				})),
			},
		} as Field;
		order.push(choice);
	}
	for (const [uuid, form] of Object.entries(doc.forms) as [
		Uuid,
		BlueprintDoc["forms"][Uuid],
	][]) {
		const own = form.caseOperations?.[0];
		if (own?.action !== "own") continue;
		const children = doc.fieldOrder[uuid] ?? [];
		if (children.some((child) => doc.fields[child]?.id === "said")) continue;
		const said = testUuid(`names-fuzz-said-${uuid}`);
		doc.fields[said] = {
			uuid: said,
			kind: "text",
			id: "said",
			label: proseText("Said"),
		} as Field;
		children.push(said);
		doc.fieldOrder[uuid] = children;
		const written = new Set((own.writes ?? []).map((write) => write.property));
		const value = {
			kind: "term",
			term: { kind: "field", uuid: said },
		} as Expression;
		const caseOperations = [...(form.caseOperations ?? [])];
		caseOperations[0] = {
			...own,
			writes: [
				...(own.writes ?? []),
				...properties
					.filter((property) => !written.has(property))
					.map((property) => ({ property, value })),
			],
		} as CaseOperation;
		doc.forms[uuid] = { ...form, caseOperations };
		break;
	}
	doc.fieldOrder[formUuid] = order;
}

/**
 * Whether a Search field keeps a name that differs from the property it
 * searches. A simple range field and a simple multiple-choice field match
 * the property their name spells, so each must keep the name equal to it.
 */
function takesAnotherName(input: SearchInputDef): boolean {
	return (
		input.kind !== "simple" ||
		(effectiveSimpleSearchModeKind(input) !== "range" &&
			input.type !== "multi-select")
	);
}

/** Name `first-name` the first Search field, of the first menu holding one,
 *  whose name may differ from the property it searches. */
function renameSearchField(doc: BlueprintDoc): void {
	for (const moduleUuid of doc.moduleOrder) {
		const mod = doc.modules[moduleUuid];
		const inputs = mod?.caseListConfig?.searchInputs ?? [];
		if (mod?.caseListConfig === undefined) continue;
		if (inputs.some((input) => input.name === NAMES_SEARCH_FIELD)) return;
		const index = inputs.findIndex(takesAnotherName);
		if (index === -1) continue;
		doc.modules[moduleUuid] = {
			...mod,
			caseListConfig: {
				...mod.caseListConfig,
				searchInputs: inputs.map((input, at) =>
					at === index ? { ...input, name: NAMES_SEARCH_FIELD } : input,
				),
			},
		};
		return;
	}
}

/** A form core as `xformDocArbitrary` draws one: its root field trees and,
 *  where drawn, its page titles. */
interface FormCoreDraw {
	readonly fields: readonly FieldGenSpec[];
	readonly sections: ReadonlyArray<string | undefined> | undefined;
}

/** `xformDocArbitrary`'s form core, drawn from its own arbitraries: a paged
 *  form's trees hold no repeat workers add rows to, as there. */
const formCoreDrawArbitrary: fc.Arbitrary<FormCoreDraw> =
	sectionsChoiceArb.chain((sections) =>
		fc.record({
			fields: fc.array(
				fieldSpecArb(2, { noUserRepeat: sections !== undefined }),
				{ minLength: 1, maxLength: 4 },
			),
			sections: fc.constant(sections),
		}),
	);

/** A minter whose identities no draw of `suiteDocArbitrary` holds, nor any
 *  other minter of this family, each naming its own `namespace`. */
class FormCoreMinter extends IdMinter {
	constructor(private readonly namespace: string) {
		super();
	}
	override uuid(prefix: string): Uuid {
		return super.uuid(`names-${this.namespace}-${prefix}`);
	}
}

/** The document's first form, the one the form core and the choices join. */
function firstFormUuid(doc: BlueprintDoc): Uuid | undefined {
	return Object.keys(doc.forms)[0] as Uuid | undefined;
}

const UNFROZEN = new Immer({ autoFreeze: false });

/** The document with each date-and-time question split where the app it
 *  was drawn for runs in Web Apps, which has no entry for one: the drawn
 *  module shapes keep the declaration they were drawn under, and the form
 *  core runs where they run (`lib/doc/datetimeSplit.ts`, the split the
 *  platform declaration makes). */
function runsWhereDrawn(doc: BlueprintDoc): BlueprintDoc {
	if (doc.appSettings.runsOnlyOn === "android") return doc;
	const split = planDatetimeSplits(structuredClone(doc));
	if (!split.ok) throw new Error(split.message);
	if (split.mutations.length === 0) return doc;
	return UNFROZEN.produce(doc, (draft) => {
		applyMutations(draft, split.mutations);
	});
}

/** The document with the drawn field trees added to the root of its first
 *  form, each under a sibling-pool id no root sibling holds, their drawn
 *  expressions bound and mapped as every generator maps a draw, and run
 *  where the drawn app runs. */
function withFormCore(doc: BlueprintDoc, core: FormCoreDraw): BlueprintDoc {
	const formUuid = firstFormUuid(doc);
	if (formUuid === undefined) return doc;
	const fieldOrder = doc.fieldOrder;
	fieldOrder[formUuid] ??= [];
	const ctx: FieldBuildCtx = {
		minter: new FormCoreMinter("core"),
		fields: doc.fields as Record<Uuid, FieldDraft>,
		fieldOrder,
		caseWrites: new Map(),
	};
	const taken = new Set(
		fieldOrder[formUuid].map((uuid) => doc.fields[uuid]?.id),
	);
	let pool = 0;
	for (const spec of core.fields) {
		while (taken.has(pickSiblingId(pool))) pool++;
		const id = pickSiblingId(pool);
		taken.add(id);
		buildField(ctx, formUuid, id, spec);
	}
	return runsWhereDrawn(
		withoutReferenceIndex(
			mappedAsTheCutoverMaps(
				resolveArbitraryDocument(withoutReferenceIndex(doc)),
			),
		),
	);
}

/** Page the first form as `xformDocArbitrary` pages a form, after every
 *  question has joined it, where it holds no repeat workers add rows to. */
function pageFirstForm(doc: BlueprintDoc, core: FormCoreDraw): void {
	const formUuid = firstFormUuid(doc);
	if (
		formUuid === undefined ||
		core.sections === undefined ||
		holdsUserRepeat(doc, formUuid)
	)
		return;
	sectionRoot(
		{
			minter: new FormCoreMinter("page"),
			fields: doc.fields as Record<Uuid, FieldDraft>,
			fieldOrder: doc.fieldOrder,
			caseWrites: new Map(),
		},
		formUuid,
		core.sections,
	);
}

/** `doc` without its reference index, which edits made in place leave
 *  behind; the next reader builds it again. */
function withoutReferenceIndex(doc: BlueprintDoc): BlueprintDoc {
	const { refIndex: _refIndex, ...rest } = doc;
	return rest as BlueprintDoc;
}

/** The drawn document with the drawn form core joined and the drawn names
 *  applied. */
export function withNames(
	drawn: BlueprintDoc,
	core: FormCoreDraw,
	draws: NameDraws,
): BlueprintDoc {
	const grafted = withFormCore(structuredClone(drawn), core);
	const doc = renameCaseTypes(withoutReferenceIndex(grafted), draws.caseTypes);
	renameFields(doc, draws.fieldIds);
	addChoicesAndWrites(doc, draws.choiceValues, draws.writtenProperties);
	renameSearchField(doc);
	pageFirstForm(doc, core);
	rebuildFieldParent(doc);
	return withoutReferenceIndex(doc);
}

/**
 * Every document the family draws. None is filtered: the commit gate inside
 * `compilerEvidence.ts::checkCompilerEvidence` judges each one, so a name the
 * gate refuses fails the sample that drew it.
 */
export const namesDocArbitrary: fc.Arbitrary<BlueprintDoc> = fc
	.tuple(suiteDocArbitrary, formCoreDrawArbitrary, nameDrawsArbitrary)
	.map(([drawn, core, draws]) => withNames(drawn, core, draws));

// ── Census ─────────────────────────────────────────────────────────

/** Whether a question id holds a hyphen. */
export function hasHyphenatedFieldId(doc: BlueprintDoc): boolean {
	return Object.values(doc.fields).some((field) => field.id.includes("-"));
}

/** Whether a container holds a child whose id holds a hyphen. */
export function hasNestedHyphenatedFieldId(doc: BlueprintDoc): boolean {
	return Object.entries(doc.fieldOrder).some(
		([parentUuid, children]) =>
			doc.fields[parentUuid as Uuid] !== undefined &&
			children.some((uuid) => doc.fields[uuid]?.id.includes("-")),
	);
}

/** Whether a case type starts with a digit. */
export function hasDigitLeadingCaseType(doc: BlueprintDoc): boolean {
	return (doc.caseTypes ?? []).some((caseType) => /^\d/.test(caseType.name));
}

/** Whether a menu lists the case type `case`. */
export function hasCaseNamedCase(doc: BlueprintDoc): boolean {
	return Object.values(doc.modules).some((mod) => mod.caseType === "case");
}

function inlineOptionValues(field: Field): string[] | undefined {
	if (field.kind !== "single_select" && field.kind !== "multi_select")
		return undefined;
	const source = field.optionsSource;
	return source?.kind === "inline"
		? source.options.map((option) => option.value)
		: undefined;
}

/** Whether a select holds exactly one option. */
export function hasOneOptionSelect(doc: BlueprintDoc): boolean {
	return Object.values(doc.fields).some(
		(field) => inlineOptionValues(field)?.length === 1,
	);
}

/** Whether a choice value holds a quote mark. */
export function hasQuotedChoiceValue(doc: BlueprintDoc): boolean {
	return Object.values(doc.fields).some((field) =>
		(inlineOptionValues(field) ?? []).some((value) => /['"`]/.test(value)),
	);
}

/** Whether a Search field's name holds a hyphen. */
export function hasHyphenatedSearchField(doc: BlueprintDoc): boolean {
	return Object.values(doc.modules).some((mod) =>
		(mod.caseListConfig?.searchInputs ?? []).some((input) =>
			input.name.includes("-"),
		),
	);
}

/** Whether a case change writes `state`, `category` or a hyphenated property. */
export function hasNamedWrite(doc: BlueprintDoc): boolean {
	return Object.values(doc.forms).some((form) =>
		(form.caseOperations ?? []).some((operation) =>
			("writes" in operation ? (operation.writes ?? []) : []).some(
				(write) =>
					write.property === "state" ||
					write.property === "category" ||
					write.property.includes("-"),
			),
		),
	);
}

/** What a names sample drew, counted per document. */
export interface NamesCensus {
	total: number;
	hyphenatedId: number;
	nestedHyphenatedId: number;
	pagedForm: number;
	digitType: number;
	typeNamedCase: number;
	oneOption: number;
	quotedValue: number;
	namedWrite: number;
	hyphenatedSearchField: number;
}

export function emptyNamesCensus(): NamesCensus {
	return {
		total: 0,
		hyphenatedId: 0,
		nestedHyphenatedId: 0,
		pagedForm: 0,
		digitType: 0,
		typeNamedCase: 0,
		oneOption: 0,
		quotedValue: 0,
		namedWrite: 0,
		hyphenatedSearchField: 0,
	};
}

/** Count one document the sample checked. */
export function countNames(census: NamesCensus, doc: BlueprintDoc): void {
	census.total++;
	if (hasHyphenatedFieldId(doc)) census.hyphenatedId++;
	if (hasNestedHyphenatedFieldId(doc)) census.nestedHyphenatedId++;
	if (hasSectionedForm(doc)) census.pagedForm++;
	if (hasDigitLeadingCaseType(doc)) census.digitType++;
	if (hasCaseNamedCase(doc)) census.typeNamedCase++;
	if (hasOneOptionSelect(doc)) census.oneOption++;
	if (hasQuotedChoiceValue(doc)) census.quotedValue++;
	if (hasNamedWrite(doc)) census.namedWrite++;
	if (hasHyphenatedSearchField(doc)) census.hyphenatedSearchField++;
}

/** Each sample held every class of name the family draws, so a generator
 *  that stops drawing one fails by that class's name. */
export function expectNamesCensus(census: NamesCensus, runs: number): void {
	expect(census.total).toBe(runs);
	for (const [name, count] of Object.entries(census)) {
		expect(count, `documents holding ${name}`).toBeGreaterThan(0);
	}
}
