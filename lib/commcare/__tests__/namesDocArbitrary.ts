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
 * list there would move every existing seed's draws. This family draws a
 * document of `suiteDocArbitrary` beside a stream of its own name draws and
 * applies the names after both draws, with no further random call. Only
 * documents the commit gate admits are kept.
 */
import * as fc from "fast-check";
import { testUuid } from "@/__tests__/helpers/uuid";
import { runValidation } from "@/lib/commcare/validator/runner";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	type CaseOperation,
	type Field,
	isContainer,
	proseText,
	type Uuid,
} from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression/types";
import { suiteDocArbitrary } from "./suiteDocArbitrary";

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
	/** A field id for each of the first root fields of each form, in order. */
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

/** Give the first root fields of each form the drawn ids, where no sibling holds one. */
function renameFields(doc: BlueprintDoc, ids: readonly string[]): void {
	for (const formUuid of Object.keys(doc.forms) as Uuid[]) {
		const children = doc.fieldOrder[formUuid] ?? [];
		const taken = new Set(children.map((uuid) => doc.fields[uuid]?.id));
		children.forEach((uuid, index) => {
			const field = doc.fields[uuid];
			const id = ids[index];
			if (field === undefined || id === undefined || taken.has(id)) return;
			taken.delete(field.id);
			taken.add(id);
			doc.fields[uuid] = { ...field, id } as Field;
		});
		// A group named `a` holding `a-b` meets the itext key's doubled hyphen.
		for (const uuid of children) {
			const field = doc.fields[uuid];
			if (field === undefined || !isContainer(field)) continue;
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

/** Name the first Search field of the first menu that has one `first-name`. */
function renameSearchField(doc: BlueprintDoc): void {
	for (const moduleUuid of doc.moduleOrder) {
		const mod = doc.modules[moduleUuid];
		const inputs = mod?.caseListConfig?.searchInputs ?? [];
		const [first] = inputs;
		if (mod?.caseListConfig === undefined || first === undefined) continue;
		if (inputs.some((input) => input.name === NAMES_SEARCH_FIELD)) return;
		doc.modules[moduleUuid] = {
			...mod,
			caseListConfig: {
				...mod.caseListConfig,
				searchInputs: [
					{ ...first, name: NAMES_SEARCH_FIELD },
					...inputs.slice(1),
				],
			},
		};
		return;
	}
}

/** The drawn document with the drawn names applied. */
export function withNames(drawn: BlueprintDoc, draws: NameDraws): BlueprintDoc {
	const doc = renameCaseTypes(structuredClone(drawn), draws.caseTypes);
	renameFields(doc, draws.fieldIds);
	addChoicesAndWrites(doc, draws.choiceValues, draws.writtenProperties);
	renameSearchField(doc);
	rebuildFieldParent(doc);
	return doc;
}

/** Whether the commit gate admits the document. */
function admitted(doc: BlueprintDoc): boolean {
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).length === 0;
}

export const namesDocArbitrary: fc.Arbitrary<BlueprintDoc> = fc
	.tuple(suiteDocArbitrary, nameDrawsArbitrary)
	.map(([drawn, draws]) => withNames(drawn, draws))
	.filter(admitted);

// ── Census ─────────────────────────────────────────────────────────

/** Whether a question id holds a hyphen. */
export function hasHyphenatedFieldId(doc: BlueprintDoc): boolean {
	return Object.values(doc.fields).some((field) => field.id.includes("-"));
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
