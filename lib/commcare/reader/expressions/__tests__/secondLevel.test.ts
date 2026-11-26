/**
 * A slot held at the second level: its source differs from Nova's print only
 * where a named rewrite applies. The contract: the slot is held, its stored
 * tree prints back to the source with the rewrites withheld and to Nova's own
 * print with none, and the reading reports exactly the rewrites a first
 * publish brings. The failures this catches: a read the author spelled
 * `current()` printed as an absolute path once the rewrites are withheld, so
 * an ordinary lookup inside a repeat is refused as unrecognized; the same
 * in a Save to Case block's value, whose print kept every rewrite when the
 * reader withheld them, and whose absolute read of its own repeat's answer
 * could not be told from the block's own `current()` path; a relocation
 * reported for a read the author already wrote from `current()`; a fold the
 * first level withdrew proposed again when the held tree is read back from
 * Nova's print, so the stored tree is another expression (a lookup of a
 * clinic's case stored as the worker's own record).
 */
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import type { Expression, SlotContextRef } from "@/lib/domain/expression/types";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import type { Uuid } from "@/lib/domain/uuid";
import { sameXPathText } from "../../syntaxCompare";
import { type ExpressionReadEnv, readExpressions } from "../index";
import { printSlot } from "../readExpression";
import {
	fieldNamed,
	onlyForm,
	readEnv,
	registration,
} from "./expressionReadFixture";

const TABLE = "01890000-0000-7000-8000-000000000201" as LookupTableId;
const CODE = "01890000-0000-7000-8000-000000000202" as LookupColumnId;
const NAME = "01890000-0000-7000-8000-000000000203" as LookupColumnId;

const MAKE = "01890000-0000-7000-8000-000000000204" as Uuid;
const TOUCH = "01890000-0000-7000-8000-000000000205" as Uuid;
const LINK = "01890000-0000-7000-8000-000000000206" as Uuid;

function repeatDoc(withOperation = false): BlueprintDoc {
	return buildDoc(
		{
			caseTypes: [
				{
					name: "clinic",
					properties: [{ name: "clinic_name", label: "Clinic name" }],
				},
			],
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Survey",
							type: "survey",
							fields: [
								f({
									kind: "repeat",
									id: "r",
									label: "Members",
									repeat_mode: "user_controlled",
									children: [
										f({ kind: "text", id: "k", label: "Kind" }),
										f({ kind: "text", id: "j", label: "Other kind" }),
										f({ kind: "text", id: "clinic_id", label: "Clinic" }),
										f({ kind: "hidden", id: "h" }),
									],
								}),
							],
						},
					],
				},
			],
		},
		(built) => {
			if (!withOperation) return;
			// A clinic case made in each row of the repeat, saving a value
			// worked out from the row's own answers, and the case each row
			// names by its answer, updated.
			const form = onlyForm(built);
			const row = fieldNamed(built, "r");
			const kind: Expression = {
				kind: "term",
				term: { kind: "field", uuid: fieldNamed(built, "k") },
			};
			built.forms[form] = {
				...built.forms[form],
				caseOperations: [
					{
						uuid: MAKE,
						id: "make_clinic",
						action: "create",
						caseType: "clinic",
						target: { kind: "new" },
						name: kind,
						forEach: { repeat: row },
						writes: [{ property: "clinic_name", value: kind }],
					},
					{
						uuid: TOUCH,
						id: "touch_clinic",
						action: "update",
						caseType: "clinic",
						target: { kind: "expression", expr: kind },
						forEach: { repeat: row },
						writes: [{ property: "clinic_name", value: kind }],
					},
				],
			} as never;
		},
	);
}

function env(doc: BlueprintDoc): ExpressionReadEnv {
	return readEnv({
		lookup: new Map([
			[
				TABLE,
				{
					id: TABLE,
					name: "Kinds",
					tag: "t",
					columns: [
						{ id: CODE, wireName: "code", label: "Code", dataType: "text" },
						{ id: NAME, wireName: "name", label: "Name", dataType: "text" },
					],
				},
			],
		]) as ExpressionReadEnv["lookup"],
		instanceSources: new Map([
			[onlyForm(doc), new Map([["t", "jr://fixture/item-list:t"]])],
		]),
	});
}

const LOOKUP = (key: string) => `instance('t')/t_list/t[code = ${key}]/name`;

const WITHHOLD_ALL = new Set([
	"instant-comparison",
	"empty-rows-guard",
	"absent-session-value-guard",
	"row-predicate-current",
	"default-reads-current",
	"search-value-guards",
	"filter-identities-dropped",
	"validation-counts-moved",
] as const);

/** Read one slot and print what it holds, with every rewrite withheld and
 *  with none. */
function readSlot(
	doc: BlueprintDoc,
	refOf: (doc: BlueprintDoc) => SlotContextRef,
	text: string,
) {
	const readingEnv = env(doc);
	const ref = refOf(doc);
	const reading = readExpressions(
		doc,
		[registration(doc, ref, text)],
		readingEnv,
	);
	const tree = reading.bound[0];
	const prints =
		tree === undefined
			? undefined
			: {
					withheld: printSlot(reading.doc, ref, tree, readingEnv, {
						rewrites: { withhold: WITHHOLD_ALL },
					}),
					own: printSlot(reading.doc, ref, tree, readingEnv),
				};
	return { reading, tree, prints };
}

/** Read one calculate of the repeat's Hidden Value. */
function readCalculate(text: string) {
	return readSlot(
		repeatDoc(),
		(doc) => ({
			entity: "field",
			uuid: fieldNamed(doc, "h"),
			slot: "calculate",
		}),
		text,
	);
}

/** The value the repeated create saves to `clinic_name`, a record slot. */
function operationWriteRef(doc: BlueprintDoc): SlotContextRef {
	return {
		entity: "form",
		uuid: onlyForm(doc),
		slot: "case_operation_write_value",
		member: { operationUuid: MAKE, property: "clinic_name" },
	};
}

function readOperationWrite(text: string) {
	return readSlot(repeatDoc(true), operationWriteRef, text);
}

/** The case the repeated update names, a runtime target, which the block
 *  prints inside the `casedb` row predicate that selects it. */
function operationTargetRef(doc: BlueprintDoc): SlotContextRef {
	return {
		entity: "form",
		uuid: onlyForm(doc),
		slot: "case_operation_target_expression",
		member: { operationUuid: TOUCH },
	};
}

function readOperationTarget(text: string) {
	return readSlot(repeatDoc(true), operationTargetRef, text);
}

describe("a read the author spelled current() at a relocation site", () => {
	it("holds a lookup inside a repeat keyed by current(), reporting only its guard", () => {
		const text = LOOKUP("current()/../k");
		const { reading, tree, prints } = readCalculate(text);
		expect(reading.circumstances).toEqual([]);
		expect(tree).toBeDefined();
		expect(JSON.stringify(tree)).toContain('"spelling":"current"');
		expect(reading.rewrites.map((one) => one.id)).toEqual(["empty-rows-guard"]);
		expect(prints?.own).toContain("current()/../k");
		expect(
			sameXPathText(prints?.withheld ?? "", text, { ruleSet: "form" }),
		).toBe(true);
	});

	it("holds the same lookup keyed by the absolute path, reporting its relocation", () => {
		const text = LOOKUP("/data/r/k");
		const { reading, prints } = readCalculate(text);
		expect(reading.circumstances).toEqual([]);
		expect(reading.rewrites.map((one) => one.id).sort()).toEqual([
			"empty-rows-guard",
			"row-predicate-current",
		]);
		// The stored tree is the re-read of Nova's print, which reads the key
		// from `current()`.
		expect(prints?.own).toContain("current()/../k");
		expect(prints?.own).not.toContain("/data/r/k");
	});

	it("holds a slot that spells one read each way, reporting the one relocation", () => {
		const text = `concat(${LOOKUP("current()/../k")}, ${LOOKUP("/data/r/j")})`;
		const { reading, prints } = readCalculate(text);
		expect(reading.circumstances).toEqual([]);
		expect(reading.rewrites.map((one) => one.id).sort()).toEqual([
			"empty-rows-guard",
			"row-predicate-current",
		]);
		expect(prints?.own).toContain("current()/../k");
		expect(prints?.own).toContain("current()/../j");
	});
});

describe("a Save to Case block's read of its own repeat's answer", () => {
	// A Save to Case block prints an answer of its own repeat through its
	// binding, from `current()` at the block's node. A record rule holds no
	// `current` spelling, so the read the author wrote as that path and the
	// one written as an absolute path differ only in `absolute`, which alone
	// prints as written once the relocation is withheld.
	// Nova's print of the answer's read in a slot of the block: the path from
	// the slot's own node, which a target's sits one step above a value's.
	const own = (id: string, refOf = operationWriteRef) => {
		const doc = repeatDoc(true);
		return printSlot(
			doc,
			refOf(doc),
			{ kind: "term", term: { kind: "field", uuid: fieldNamed(doc, id) } },
			env(doc),
		);
	};

	it("holds a value read as the block's own path exactly", () => {
		const key = own("k");
		expect(key).toMatch(/^current\(\)\//);
		const { reading, tree, prints } = readOperationWrite(key);
		expect(reading.circumstances).toEqual([]);
		expect(reading.rewrites).toEqual([]);
		expect(tree).toBeDefined();
		expect(prints?.withheld).toBe(key);
	});

	it("holds the answer read by its absolute path as the whole value, reporting nothing", () => {
		// Core reads `/data/r/k` in the block's own entry, as the binding does.
		const { reading, tree, prints } = readOperationWrite("/data/r/k");
		expect(reading.circumstances).toEqual([]);
		expect(reading.rewrites).toEqual([]);
		expect(JSON.stringify(tree)).not.toContain('"spelling"');
		expect(prints?.own).toBe(own("k"));
	});

	it("holds a runtime target read by its absolute path, reporting its relocation", () => {
		// The target is printed inside the row predicate that selects the case.
		const { reading, tree, prints } = readOperationTarget("/data/r/k");
		expect(reading.circumstances).toEqual([]);
		expect(reading.rewrites.map((one) => one.id)).toEqual([
			"row-predicate-current",
		]);
		expect(JSON.stringify(tree)).not.toContain('"spelling"');
		expect(prints?.own).toBe(own("k", operationTargetRef));
	});

	it("holds a runtime target read as the block's own path exactly", () => {
		const { reading, prints } = readOperationTarget(
			own("k", operationTargetRef),
		);
		expect(reading.circumstances).toEqual([]);
		expect(reading.rewrites).toEqual([]);
		expect(prints?.withheld).toBe(own("k", operationTargetRef));
	});

	it("holds a target that spells one read each way, reporting the one relocation", () => {
		const text = `concat(${own("k", operationTargetRef)}, /data/r/j)`;
		const { reading, prints } = readOperationTarget(text);
		expect(reading.circumstances).toEqual([]);
		expect(reading.rewrites.map((one) => one.id)).toEqual([
			"row-predicate-current",
		]);
		expect(prints?.own).toBe(
			`concat(${own("k", operationTargetRef)}, ${own("j", operationTargetRef)})`,
		);
		expect(prints?.withheld).toBe(
			`concat(${own("k", operationTargetRef)}, ${own("j", operationTargetRef)})`,
		);
	});

	it("leaves out a guard the block's print adds once the guard is withheld", () => {
		// The block's value is printed through its binding, which took no
		// control: the guard on a value that can be absent stayed in the
		// withheld print, and the slot was refused as unrecognized.
		const language = "instance('commcaresession')/session/context/applanguage";
		const { reading, prints } = readOperationWrite(language);
		expect(reading.circumstances).toEqual([]);
		expect(reading.rewrites.map((one) => one.id)).toEqual([
			"absent-session-value-guard",
		]);
		expect(prints?.withheld).toBe(language);
	});
});

describe("an after-submit link's condition", () => {
	it("leaves out a guard the link's print adds once the guard is withheld", () => {
		// The link's condition is printed through the link's projection,
		// which took no control: the guard on a value that can be absent
		// stayed in the withheld print, and the slot was refused as
		// unrecognized.
		const doc = buildDoc({
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Survey",
							type: "survey",
							formLinks: [
								{
									uuid: LINK,
									condition: {
										kind: "eq",
										left: {
											kind: "term",
											term: { kind: "session-context", field: "applanguage" },
										},
										right: {
											kind: "term",
											term: { kind: "literal", value: "en" },
										},
									},
									target: { type: "this-form" },
								},
							],
							fields: [f({ kind: "text", id: "q", label: "Question" })],
						},
					],
				},
			],
		});
		const text =
			"instance('commcaresession')/session/context/applanguage = 'en'";
		const { reading, prints } = readSlot(
			doc,
			(built) => ({
				entity: "form",
				uuid: onlyForm(built),
				slot: "form_link_condition",
				member: { linkUuid: LINK },
			}),
			text,
		);
		expect(reading.circumstances).toEqual([]);
		expect(reading.rewrites.map((one) => one.id)).toEqual([
			"absent-session-value-guard",
		]);
		expect(prints?.withheld).toBe(text);
	});
});

describe("the tree a slot held at the second level stores", () => {
	it("is no fold the first level withdrew, printing Nova's own print exactly", () => {
		// The worker's-record fold proposes any casedb row with a type test and
		// one key, and the first level withdraws it here (its print is the
		// worker's record, not a clinic's case). Nova's print reads the key
		// from `current()`, so the slot is held at the second level and stores
		// the re-read of that print, which must withdraw the same fold.
		const text =
			"instance('casedb')/casedb/case[@case_type = 'clinic'][@case_id = /data/r/clinic_id]/clinic_name";
		const { reading, tree, prints } = readCalculate(text);
		expect(reading.circumstances).toEqual([]);
		expect(reading.rewrites.map((one) => one.id)).toEqual([
			"row-predicate-current",
		]);
		expect(JSON.stringify(tree)).not.toContain("session-user");
		expect(
			sameXPathText(
				prints?.own ?? "",
				"instance('casedb')/casedb/case[@case_type = 'clinic'][@case_id = current()/../clinic_id]/clinic_name",
				{ ruleSet: "form" },
			),
			prints?.own,
		).toBe(true);
	});
});

describe("a case choices filter held at the second level", () => {
	// The filter prints inside the itemset's `casedb` row through `caseOptionsNodeset`, which
	// takes the reader's control like every other print. The failure it catches: the control
	// dropped before the filter's print, so a filter spelled without a rewrite Nova's print
	// reaches is left unrecognized at both levels.
	function choicesDoc(): BlueprintDoc {
		return buildDoc({
			caseTypes: [
				{
					name: "clinic",
					properties: [
						{ name: "clinic_name", label: "Clinic name" },
						{ name: "kind", label: "Kind" },
					],
				},
			],
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Survey",
							type: "survey",
							fields: [
								f({
									kind: "repeat",
									id: "r",
									label: "Members",
									repeat_mode: "user_controlled",
									children: [
										f({ kind: "text", id: "k", label: "Kind" }),
										f({
											kind: "single_select",
											id: "pick",
											label: "Clinic",
											optionsSource: {
												kind: "cases",
												caseType: "clinic",
												labelProperty: "clinic_name",
											},
										}),
									],
								}),
							],
						},
					],
				},
			],
		});
	}

	it("holds a filter keyed by its repeat's answer by the absolute path, reporting its relocation", () => {
		const text = "kind = /data/r/k";
		const { reading, prints } = readSlot(
			choicesDoc(),
			(doc) => ({
				entity: "field",
				uuid: fieldNamed(doc, "pick"),
				slot: "lookup_options_source",
			}),
			text,
		);
		expect(reading.circumstances).toEqual([]);
		expect(reading.rewrites.map((one) => one.id)).toEqual([
			"row-predicate-current",
		]);
		expect(prints?.own).toContain("current()/../k");
	});
});
