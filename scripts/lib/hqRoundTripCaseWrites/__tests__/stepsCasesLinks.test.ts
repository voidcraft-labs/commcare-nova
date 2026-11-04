/**
 * The cutover's first three semantic steps (part 09 §7.4 to §7.6) over the
 * pre-step fixtures read raw and through the structure phase and the head
 * parse, the way the transform reaches them, and over shapes planted in
 * those parsed documents where no fixture holds one.
 *
 * Each step is the place one migration class could go wrong silently: a
 * close operation folded into the wrong close condition, an operation made
 * from field writes under an identity a second plan would not derive, a
 * write the own arm makes left on another operation, a link change named by
 * the wrong reason, or a carried create left where the gate refuses it.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	type BlueprintDoc,
	type CaseOperation,
	caseWriteOperationUuid,
	type Expression,
	type Form,
	type Uuid,
} from "@/lib/domain";
import type { LookupTypeIndex } from "@/lib/domain/expression/context";
import type { PropertyRef } from "@/lib/domain/expression/types";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { proseText } from "@/lib/domain/prose";
import { asUuid } from "@/lib/domain/uuid";
import {
	type MigrationNoticeEntry,
	migrationNoticeEntriesSchema,
} from "@/lib/notices/migrationNotice";
import { extensionChildren } from "../steps/extensionChildren";
import {
	FORM_LINK_SEMANTICS_CHANGES,
	formLinkSemantics,
} from "../steps/formLinkSemantics";
import {
	asSentence,
	writesIntoOperations,
} from "../steps/writesIntoOperations";
import { parseHead, structurePhase } from "../structure";
import type { LiftedFacts } from "../types";
import { rawFixture, readPreStepJson } from "./rawFixture";

interface Parsed {
	readonly appId: string;
	readonly doc: BlueprintDoc;
	readonly facts: LiftedFacts;
}

/** A fixture read raw, through the structure phase and the head parse. */
function parsed(id: string): Parsed {
	const appId = (readPreStepJson(`${id}.json`) as { appId: string }).appId;
	const structure = structurePhase(rawFixture(id));
	expect(structure.blockers).toEqual([]);
	const head = parseHead(appId, structure.persisted);
	if (!head.ok)
		throw new Error(
			`The fixture ${id} did not parse after the structure phase.`,
		);
	return { appId, doc: head.doc, facts: structure.facts };
}

/** A copy of `doc` with `edit` applied, a shape no fixture holds. */
function planted(doc: BlueprintDoc, edit: (copy: BlueprintDoc) => void) {
	const copy = structuredClone(doc);
	edit(copy);
	return copy;
}

function formOf(doc: BlueprintDoc, uuid: string): Form {
	const form = doc.forms[asUuid(uuid)];
	if (form === undefined) throw new Error(`No form ${uuid}.`);
	return form;
}

function operationOf(form: Form, uuid: string): CaseOperation {
	const operation = form.caseOperations?.find((op) => op.uuid === uuid);
	if (operation === undefined) throw new Error(`No operation ${uuid}.`);
	return operation;
}

function expectEntries(notice: readonly MigrationNoticeEntry[]): void {
	if (notice.length > 0) migrationNoticeEntriesSchema.parse(notice);
}

// ─── writes-into-operations ───────────────────────────────────────────────

describe("writes-into-operations: C9", () => {
	const DISCHARGE = "1f464df3-8247-5ccf-aa05-86edf8c270e3";
	const DISCHARGE_CLOSE = "c5445232-2877-5bbe-ad5a-620ca1e15da2";
	const WITH_NOTES = "21d60ff2-e245-5326-ab55-15fc7bc1c662";
	const WITH_NOTES_CLOSE = "38eb0ef1-cf56-5875-a958-8bf379d93861";
	const PER_ROW = "0c5e9e6c-36f8-5fc0-a034-d34a4a06f7fc";
	const CLOSE = "9c8b72af-7b14-593b-a020-7b956fa1f9ff";
	const CLOSE_ANYWAY = "3986a4cc-274e-5708-a38f-15ce05c8741c";

	const fixture = parsed("pre-step-own-close-operation");
	/** The fixture without the form whose close runs per row, so the other
	 *  three forms reach the rewrite. */
	const withoutPerRow = planted(fixture.doc, (doc) => {
		const perRow = asUuid(PER_ROW);
		delete doc.forms[perRow];
		for (const [moduleUuid, forms] of Object.entries(doc.formOrder))
			doc.formOrder[asUuid(moduleUuid)] = forms.filter(
				(uuid) => uuid !== perRow,
			);
	});

	it("stops the app at own-close-in-repeat where a close runs per row, rewriting nothing", () => {
		const result = writesIntoOperations(fixture.doc, fixture.facts);
		expect(result.blockers).toEqual([
			{
				code: "own-close-in-repeat",
				count: 1,
				findingCodes: [],
				places: [
					{
						entity: { kind: "form", uuid: PER_ROW, name: "Close per row" },
					},
				],
			},
		]);
		expect(result.doc).toBe(fixture.doc);
		expect(result.changes).toEqual([]);
		expect(result.notice).toEqual([]);
		expect(result.ownCloses).toEqual([]);
	});

	it("folds each close of the loaded case into the form's own close", () => {
		const before = withoutPerRow;
		const result = writesIntoOperations(before, fixture.facts);
		expect(result.blockers).toEqual([]);

		// A writeless close is removed; its condition is the form's.
		const discharge = formOf(result.doc, DISCHARGE);
		expect(discharge.type).toBe("close");
		expect(discharge.closeCondition).toEqual(
			operationOf(formOf(before, DISCHARGE), DISCHARGE_CLOSE).condition,
		);
		expect(discharge.caseOperations?.map((op) => op.action)).toEqual(["own"]);

		// A close holding writes becomes an update of the same case, keeping
		// its identity and writes; with no condition the close is every
		// submission's.
		const withNotes = formOf(result.doc, WITH_NOTES);
		const stored = operationOf(formOf(before, WITH_NOTES), WITH_NOTES_CLOSE);
		expect(withNotes.type).toBe("close");
		expect(withNotes.closeCondition).toBeUndefined();
		expect(operationOf(withNotes, WITH_NOTES_CLOSE)).toEqual({
			uuid: WITH_NOTES_CLOSE,
			id: "close_patient",
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
			writes: stored.writes,
		});

		// A close form's own close is one term of the `or`.
		const close = formOf(result.doc, CLOSE);
		const ownClose = formOf(before, CLOSE).closeCondition as Expression;
		expect(close.type).toBe("close");
		expect(close.closeCondition).toEqual({
			kind: "or",
			clauses: [
				ownClose,
				operationOf(formOf(before, CLOSE), CLOSE_ANYWAY).condition,
			],
		});
		expect(close.caseOperations?.some((op) => op.uuid === CLOSE_ANYWAY)).toBe(
			false,
		);

		// Only a follow-up made a close form gets the line.
		expect(result.notice).toEqual([
			{
				kind: "document",
				reason: "form-became-close-form",
				entity: { type: "form", uuid: DISCHARGE, nameAtMigration: "Discharge" },
			},
			{
				kind: "document",
				reason: "form-became-close-form",
				entity: {
					type: "form",
					uuid: WITH_NOTES,
					nameAtMigration: "Close with notes",
				},
			},
		]);
		expectEntries(result.notice);

		expect(result.ownCloses).toEqual([
			{
				formUuid: DISCHARGE,
				becameClose: true,
				takesPathOf: DISCHARGE_CLOSE,
				allHeldWrites: false,
			},
			{
				formUuid: WITH_NOTES,
				becameClose: true,
				takesPathOf: undefined,
				allHeldWrites: true,
			},
			{
				formUuid: CLOSE,
				becameClose: false,
				takesPathOf: CLOSE_ANYWAY,
				allHeldWrites: false,
			},
		]);
	});

	it("writes nothing applied a second time", () => {
		const once = writesIntoOperations(withoutPerRow, fixture.facts);
		const twice = writesIntoOperations(once.doc, fixture.facts);
		expect(twice.changes).toEqual([]);
		expect(twice.notice).toEqual([]);
		expect(twice.doc).toEqual(once.doc);
	});
});

describe("writes-into-operations: C9 over a condition that reads cases", () => {
	const id = "pre-step-close-reads-cases";
	const fixture = parsed(id);
	const at = (name: string) => testUuid(`${id}-${name}`);
	const prop = (
		property: string,
		via?: PropertyRef["via"],
		caseType = "member",
	): Expression => ({
		kind: "term",
		term: {
			kind: "prop",
			caseType,
			property,
			...(via !== undefined && { via }),
		},
	});
	const formCase = (caseType: string, property: string): Expression => ({
		kind: "term",
		term: { kind: "form-case", caseType, property },
	});
	const equals = (left: Expression, value: string): Expression => ({
		kind: "eq",
		left,
		right: { kind: "term", term: { kind: "literal", value } },
	});
	/** The fixture with the Leave form's close condition replaced. */
	const leaving = (condition: Expression) =>
		planted(fixture.doc, (doc) => {
			const close = doc.forms[at("leave")]?.caseOperations?.[0];
			if (close?.action !== "close") throw new Error("No Leave close.");
			close.condition = condition;
		});

	it("reads the loaded case, and the case above it through its parent link, as the form does", () => {
		const result = writesIntoOperations(fixture.doc, fixture.facts);
		expect(result.blockers).toEqual([]);
		// `#household/standing`: one `index/parent` hop, as the form walks.
		expect(formOf(result.doc, at("leave")).closeCondition).toEqual(
			equals(formCase("household", "standing"), "moved"),
		);
		expect(formOf(result.doc, at("retire")).closeCondition).toEqual(
			equals(formCase("member", "note"), "retired"),
		);
		expect(result.notice.map((entry) => entry.reason)).toEqual([
			"form-became-close-form",
			"form-became-close-form",
		]);
	});

	it.each([
		[
			"linked-case",
			"a case linked other than through its parent",
			prop("standing", { kind: "ancestor", via: [{ identifier: "host" }] }),
		],
		[
			"linked-case",
			"a case below it",
			prop("standing", { kind: "subcase", identifier: "parent" }),
		],
		[
			"other-case",
			"a case of another type",
			prop("standing", undefined, "household"),
		],
	] as const)(
		"stops the app at own-close-condition-reads-case where it reads %s: %s",
		(reason, _what, read) => {
			const before = leaving(equals(read, "moved"));
			const result = writesIntoOperations(before, fixture.facts);
			expect(result.blockers).toEqual([
				{
					code: "own-close-condition-reads-case",
					count: 1,
					findingCodes: [reason],
					places: [
						{
							entity: { kind: "form", uuid: at("leave"), name: "Leave" },
							findingCode: reason,
							message: expect.stringContaining(
								"“leave_household” in “Leave” closes the case the form opened when its condition holds",
							),
						},
					],
				},
			]);
			expect(result.doc).toBe(before);
			expect(result.changes).toEqual([]);
		},
	);

	// The checker is the oracle for what the form's close condition holds:
	// what it refuses is the blocker in its own words, and what it admits
	// moves, whatever kind it is.
	it("stops the app where the checker refuses the moved condition, in the checker's words", () => {
		const before = leaving({
			kind: "gt",
			left: { kind: "count", via: { kind: "subcase", identifier: "parent" } },
			right: { kind: "term", term: { kind: "literal", value: 0 } },
		});
		const result = writesIntoOperations(before, fixture.facts);
		expect(result.blockers).toEqual([
			{
				code: "own-close-condition-reads-case",
				count: 1,
				findingCodes: ["check:arm-unavailable"],
				places: [
					expect.objectContaining({
						findingCode: "check:arm-unavailable",
						message: expect.stringMatching(
							/^“leave_household” in “Leave” closes the case the form opened when its condition holds, and that condition can't be the form's close condition\. [^;]+\. You can rewrite the condition/,
						),
					}),
				],
			},
		]);
		expect(result.doc).toBe(before);
	});

	it("moves a condition the form's close condition holds, whatever its kind", () => {
		const answer: Expression = {
			kind: "term",
			term: { kind: "field", uuid: at("reason") },
		};
		const pattern: Expression = {
			kind: "matches-pattern",
			left: answer,
			pattern: "^moved",
		};
		const result = writesIntoOperations(leaving(pattern), fixture.facts);
		expect(result.blockers).toEqual([]);
		expect(formOf(result.doc, at("leave")).closeCondition).toEqual(pattern);
	});

	const TABLE = lookupTableIdSchema.parse(
		"00000000-0000-7000-8000-000000000001",
	);
	const KEY = lookupColumnIdSchema.parse(
		"00000000-0000-7000-8000-000000000002",
	);
	const LABEL = lookupColumnIdSchema.parse(
		"00000000-0000-7000-8000-000000000003",
	);
	const lookups: LookupTypeIndex = new Map([
		[
			TABLE,
			new Map([
				[KEY, "text"],
				[LABEL, "text"],
			]),
		],
	]);
	/** The label of the table row whose key is `key`. */
	const labelOf = (key: Expression): Expression => ({
		kind: "table-lookup",
		tableId: TABLE,
		resultColumnId: LABEL,
		where: {
			kind: "eq",
			left: {
				kind: "term",
				term: { kind: "table-column", tableId: TABLE, columnId: KEY },
			},
			right: key,
		},
	});

	// A table lookup's filter captures the row it is made in, so a read of
	// the case there is the operation's row, and becomes the form's read.
	it("reads the case inside a table lookup's filter as the form does", () => {
		const result = writesIntoOperations(
			leaving(equals(labelOf(prop("note")), "moved")),
			fixture.facts,
			lookups,
		);
		expect(result.blockers).toEqual([]);
		expect(formOf(result.doc, at("leave")).closeCondition).toEqual(
			equals(labelOf(formCase("member", "note")), "moved"),
		);
	});

	/** The fixture with the Retire form's close following a conditional
	 *  retype of its case to `alumnus`, the close's condition `condition`. */
	const retyped = (condition: Expression, graduated: Expression) =>
		planted(fixture.doc, (doc) => {
			doc.caseTypes?.push({
				name: "alumnus",
				parent_type: "household",
				properties: [{ name: "note", label: proseText("Note") }],
			});
			const retire = doc.forms[at("retire")];
			const close = retire?.caseOperations?.[0];
			if (close?.action !== "close") throw new Error("No Retire close.");
			close.caseType = "alumnus";
			close.condition = condition;
			retire.caseOperations = [
				{
					uuid: at("retire-graduate"),
					id: "graduate",
					action: "update",
					caseType: "member",
					target: { kind: "session" },
					retype: "alumnus",
					condition: graduated,
				},
				close,
			];
		});
	const graduated = equals(
		{ kind: "term", term: { kind: "field", uuid: at("note") } },
		"graduated",
	);

	// `main` ran a close of a case it retyped first only where the retype
	// ran (`caseOperationConditionalGuardUuids`), so the form's close keeps
	// the retype's condition beside the close's own.
	it("keeps the condition of a retype the close follows", () => {
		const own = equals(
			{ kind: "term", term: { kind: "field", uuid: at("note") } },
			"retired",
		);
		const result = writesIntoOperations(retyped(own, graduated), fixture.facts);
		expect(result.blockers).toEqual([]);
		expect(formOf(result.doc, at("retire")).closeCondition).toEqual({
			kind: "and",
			clauses: [own, graduated],
		});
	});

	// After the retype the operation reads its case as `alumnus`, whose
	// properties the form's read of the case as `member` need not name.
	it("stops the app where the close reads its case under the type a retype gave it", () => {
		const result = writesIntoOperations(
			retyped(equals(prop("note", undefined, "alumnus"), "retired"), graduated),
			fixture.facts,
		);
		expect(
			result.blockers.map(({ code, findingCodes }) => [code, findingCodes]),
		).toEqual([["own-close-condition-reads-case", ["retyped-case"]]]);
	});

	// Every read of the row, a walk from it to its related cases included,
	// reads it under the type the retype gave it.
	it.each<[string, Expression]>([
		[
			"a count of its child cases",
			{
				kind: "gt",
				left: { kind: "count", via: { kind: "subcase", identifier: "parent" } },
				right: { kind: "term", term: { kind: "literal", value: 0 } },
			},
		],
		[
			"a parent it has",
			{
				kind: "exists",
				via: { kind: "ancestor", via: [{ identifier: "parent" }] },
			},
		],
		[
			"its own link",
			{
				kind: "eq",
				left: {
					kind: "term",
					term: { kind: "case-index", identifier: "parent" },
				},
				right: { kind: "term", term: { kind: "literal", value: "" } },
			},
		],
		[
			"a table lookup's filter",
			equals(labelOf(prop("note", undefined, "alumnus")), "retired"),
		],
		[
			"a table lookup nested in another's filter",
			equals(labelOf(labelOf(prop("note", undefined, "alumnus"))), "retired"),
		],
	])(
		"stops the app where a close after a retype reads its case through %s",
		(_what, condition) => {
			const result = writesIntoOperations(
				retyped(condition, graduated),
				fixture.facts,
				lookups,
			);
			expect(
				result.blockers.map(({ code, findingCodes }) => [code, findingCodes]),
			).toEqual([["own-close-condition-reads-case", ["retyped-case"]]]);
		},
	);

	// A read of the row's own link, which only a case change has, is the
	// checker's refusal and so the blocker, not a failure the gate finds
	// later.
	it("stops the app where the condition reads something only a case change has", () => {
		const result = writesIntoOperations(
			leaving({
				kind: "eq",
				left: {
					kind: "term",
					term: { kind: "case-index", identifier: "parent" },
				},
				right: { kind: "term", term: { kind: "literal", value: "" } },
			}),
			fixture.facts,
		);
		expect(
			result.blockers.map(({ code, findingCodes }) => [code, findingCodes]),
		).toEqual([["own-close-condition-reads-case", ["check:row-scope"]]]);
	});

	// `reachableCaseTypes` stops at a type it met, so a case type that is its
	// own parent is read at one depth, the loaded case's: a read one parent
	// up names a case the form's walk can't, and is refused.
	it("stops the app where the parent read names a case the form's walk can't reach", () => {
		const selfParenting = planted(
			leaving(
				equals(
					prop("standing", {
						kind: "ancestor",
						via: [{ identifier: "parent" }],
					}),
					"moved",
				),
			),
			(doc) => {
				const member = doc.caseTypes?.find((type) => type.name === "member");
				if (member === undefined) throw new Error("No member type.");
				member.parent_type = "member";
				member.properties.push({
					name: "standing",
					label: proseText("Standing"),
				});
			},
		);
		const result = writesIntoOperations(selfParenting, fixture.facts);
		expect(
			result.blockers.map(({ code, findingCodes }) => [code, findingCodes]),
		).toEqual([["own-close-condition-reads-case", ["linked-case"]]]);
	});
});

// The blocker joins the checker's messages as sentences: one that ends on a
// mark, closing quotes or brackets after it included, keeps it, and one
// without a mark gets a full stop.
describe("writes-into-operations: a checker message as a sentence", () => {
	it.each([
		["a full stop", "It reads a case.", "It reads a case."],
		["a question mark", "Is it the case?", "Is it the case?"],
		[
			"a closing quote",
			'It says "no further walk."',
			'It says "no further walk."',
		],
		[
			"a curly closing quote",
			"It says \u201cdone.\u201d",
			"It says \u201cdone.\u201d",
		],
		[
			"a closing bracket",
			"It reads a case (its own.)",
			"It reads a case (its own.)",
		],
		["no mark", "It reads a case", "It reads a case."],
		["a quote without a mark", 'It reads "stage"', 'It reads "stage".'],
	] as const)("ends %s as a sentence", (_what, message, sentence) => {
		expect(asSentence(message)).toBe(sentence);
	});
});

describe("writes-into-operations: a capture's answer saved by an operation", () => {
	const id = "pre-step-capture-answer-written";
	const fixture = parsed(id);
	const at = (name: string) => testUuid(`${id}-${name}`);
	const answer: Expression = {
		kind: "term",
		term: { kind: "field", uuid: at("photo") },
	};
	/** The fixture with the Snap update's one write changed. */
	const writing = (
		edit: (operation: CaseOperation, doc: BlueprintDoc) => void,
	) =>
		planted(fixture.doc, (doc) => {
			const update = doc.forms[at("snap")]?.caseOperations?.[0];
			if (update === undefined) throw new Error("No Snap update.");
			edit(update, doc);
		});

	it("saves the capture's link where it saved the file's name, and names the change", () => {
		const result = writesIntoOperations(fixture.doc, fixture.facts);
		expect(result.blockers).toEqual([]);
		expect(
			operationOf(formOf(result.doc, at("snap")), at("snap-update")).writes,
		).toEqual([
			{
				property: "photo_name",
				value: {
					kind: "term",
					term: { kind: "capture-link", field: at("photo") },
				},
			},
		]);
		expect(result.changes[0]).toEqual({
			step: "writes-into-operations",
			kind: "capture-write-linked",
			entityUuid: at("snap"),
			detail: { writes: 1 },
		});
		expect(result.notice).toEqual([
			{
				kind: "document",
				reason: "capture-saves-link-not-name",
				entity: { type: "field", uuid: at("photo"), nameAtMigration: "photo" },
				detail: { form: "Snap", property: "photo_name" },
			},
		]);
		expectEntries(result.notice);
		const twice = writesIntoOperations(result.doc, fixture.facts);
		expect(twice.changes).toEqual([]);
		expect(twice.doc).toEqual(result.doc);
	});

	it.each([
		[
			"external-id",
			(operation: CaseOperation) => {
				if (operation.writes?.[0]) operation.writes[0].property = "external_id";
			},
			"saves the file “photo” captures as the case's external id",
		],
		[
			"property-type",
			(_operation: CaseOperation, doc: BlueprintDoc) => {
				const photoName = doc.caseTypes?.[0]?.properties.find(
					(property) => property.name === "photo_name",
				);
				if (photoName) photoName.data_type = "int";
			},
			"saves the file “photo” captures to “photo_name”, which holds a whole number",
		],
		[
			"case-name",
			(operation: CaseOperation) => {
				operation.name = answer;
			},
			"names its case with the file “photo” captures",
		],
	] as const)(
		"stops the app at capture-write-unlinkable where the link can't be saved: %s",
		(code, edit, sentence) => {
			const before = writing(edit);
			const result = writesIntoOperations(before, fixture.facts);
			expect(result.blockers).toEqual([
				expect.objectContaining({
					code: "capture-write-unlinkable",
					findingCodes: [code],
					places: [
						expect.objectContaining({
							entity: { kind: "field", uuid: at("photo"), name: "photo" },
							findingCode: code,
							message: expect.stringContaining(sentence),
						}),
					],
				}),
			]);
			expect(result.doc).toBe(before);
		},
	);

	// Two writes of one capture to one property in one form are one line, as
	// C5's `capture-saves-link` is one per question.
	it("names a question's link once per form and property, however many writes save it", () => {
		const before = planted(fixture.doc, (doc) => {
			const snap = doc.forms[at("snap")];
			snap?.caseOperations?.push({
				uuid: at("snap-create"),
				id: "copy_photo",
				action: "create",
				caseType: "patient",
				target: { kind: "new" },
				name: { kind: "term", term: { kind: "literal", value: "Copy" } },
				writes: [{ property: "photo_name", value: answer }],
			});
		});
		const result = writesIntoOperations(before, fixture.facts);
		expect(result.blockers).toEqual([]);
		expect(result.changes[0]).toMatchObject({
			kind: "capture-write-linked",
			detail: { writes: 2 },
		});
		expect(
			result.notice.filter(
				(entry) => entry.reason === "capture-saves-link-not-name",
			),
		).toHaveLength(1);
	});

	// No write may name a reserved property, whatever its value, which the
	// gate says itself.
	it("leaves a write to a reserved property to the gate", () => {
		const before = writing((operation) => {
			if (operation.writes?.[0]) operation.writes[0].property = "owner_id";
		});
		const result = writesIntoOperations(before, fixture.facts);
		expect(result.blockers).toEqual([]);
		expect(
			operationOf(formOf(result.doc, at("snap")), at("snap-update")).writes,
		).toEqual([{ property: "owner_id", value: answer }]);
		expect(
			result.notice.some(
				(entry) => entry.reason === "capture-saves-link-not-name",
			),
		).toBe(false);
	});
});

describe("writes-into-operations: C1 to C3", () => {
	const REGISTER = "195ebc95-cd9c-53f9-acb3-96c77e70ae25";
	const VISIT = "be01648f-79f0-5edb-a6e1-4ead8a75885f";
	const MEMBERS = "c3c48ec7-8141-5203-ac30-1ed1beba5f77";
	const fixture = parsed("targeted-migration-case-writes");
	const result = writesIntoOperations(fixture.doc, fixture.facts);
	const uuid = (
		formUuid: string,
		unit: Parameters<typeof caseWriteOperationUuid>[2],
	) => caseWriteOperationUuid(fixture.appId, asUuid(formUuid), unit);

	it("gives a registration its own arm, then a create per child bucket, under derived identities", () => {
		const own = uuid(REGISTER, "own");
		expect(
			formOf(result.doc, REGISTER).caseOperations?.map((op) => ({
				uuid: op.uuid,
				id: op.id,
				action: op.action,
				name: op.name,
				writes: op.writes?.map((write) => write.property),
				links: op.links,
				forEach: op.forEach,
			})),
		).toEqual([
			{
				uuid: own,
				id: "household",
				action: "own",
				name: {
					kind: "term",
					term: { kind: "field", uuid: "27def9a3-1fdd-5c47-a8b8-6805895447b3" },
				},
				writes: ["village"],
				links: undefined,
				forEach: undefined,
			},
			{
				uuid: uuid(REGISTER, "child:head:root"),
				id: "head",
				action: "create",
				name: {
					kind: "term",
					term: { kind: "field", uuid: "9d717382-f7b2-57ce-ad3e-1e3c6152da32" },
				},
				writes: undefined,
				links: [
					{
						identifier: "parent",
						relationship: "child",
						target: { kind: "op", opUuid: own },
						targetType: "household",
					},
				],
				forEach: undefined,
			},
			{
				uuid: uuid(REGISTER, `child:member:${MEMBERS}`),
				id: "member",
				action: "create",
				name: {
					kind: "term",
					term: { kind: "field", uuid: "57acecb2-bd5f-5b1e-a26d-794cbcb66382" },
				},
				writes: undefined,
				links: [
					{
						identifier: "parent",
						relationship: "child",
						target: { kind: "op", opUuid: own },
						targetType: "household",
					},
				],
				forEach: { repeat: MEMBERS },
			},
		]);
	});

	it("puts the own arm first, the root scope's stored operations next, the worker's record after them and a repeat's create last", () => {
		expect(
			formOf(result.doc, VISIT).caseOperations?.map((op) => [
				op.uuid,
				op.id,
				op.action,
			]),
		).toEqual([
			[uuid(VISIT, "own"), "household", "own"],
			["6dc85daf-9867-594b-a0a0-271936af71df", "add_referral", "create"],
			["4a45dfc2-917d-56b6-ae44-9c8c2cb6f252", "mark_visited", "update"],
			["bc6b22ee-3b53-5db2-ac4f-645c6acc2cfe", "flag_household", "update"],
			[uuid(VISIT, "usercase"), "commcare_user", "update"],
			["6c6e6403-ba94-5bc7-a1b2-23c53ffeb413", "add_arrival", "create"],
		]);
		const worker = operationOf(
			formOf(result.doc, VISIT),
			uuid(VISIT, "usercase"),
		);
		expect(worker.target).toEqual({ kind: "worker-record" });
		expect(worker.writes?.map((write) => write.property)).toEqual([
			"visits_done",
		]);
	});

	it("leaves another update of the own case an operation (class (e))", () => {
		for (const stored of [
			"4a45dfc2-917d-56b6-ae44-9c8c2cb6f252",
			"bc6b22ee-3b53-5db2-ac4f-645c6acc2cfe",
		])
			expect(operationOf(formOf(result.doc, VISIT), stored)).toEqual(
				operationOf(formOf(fixture.doc, VISIT), stored),
			);
		const own = operationOf(formOf(result.doc, VISIT), uuid(VISIT, "own"));
		expect(own.writes?.map((write) => write.property)).toEqual(["last_note"]);
	});

	it("plans the same document from the same facts, and nothing applied a second time", () => {
		expect(writesIntoOperations(fixture.doc, fixture.facts).doc).toEqual(
			result.doc,
		);
		const twice = writesIntoOperations(result.doc, fixture.facts);
		expect(twice.changes).toEqual([]);
		expect(twice.doc).toEqual(result.doc);
	});
});

describe("writes-into-operations: C10", () => {
	const REVIEW = "921a4e5a-e053-5026-a391-7c8cfe08b00a";
	const MARK = "ea00005a-cfcd-5a3e-a407-03f03023654a";
	const fixture = parsed("pre-step-duplicate-own-write");

	it("removes an update whose only write the own arm also makes", () => {
		const result = writesIntoOperations(fixture.doc, fixture.facts);
		const operations = formOf(result.doc, REVIEW).caseOperations ?? [];
		expect(
			operations.map((op) => [op.action, op.writes?.map((w) => w.property)]),
		).toEqual([["own", ["review_status"]]]);
		expect(result.changes).toContainEqual({
			step: "writes-into-operations",
			kind: "duplicate-own-write-removed",
			entityUuid: REVIEW,
			detail: { writes: 1, operations: 1 },
		});
		expect(result.notice).toEqual([]);
	});

	it("keeps an update that still writes something else, without the duplicate", () => {
		const doc = planted(fixture.doc, (copy) => {
			const mark = operationOf(formOf(copy, REVIEW), MARK);
			mark.writes?.push({
				property: "reviewed_by",
				value: { kind: "term", term: { kind: "literal", value: "nurse" } },
			});
		});
		const result = writesIntoOperations(doc, fixture.facts);
		const mark = operationOf(formOf(result.doc, REVIEW), MARK);
		expect(mark.writes?.map((write) => write.property)).toEqual([
			"reviewed_by",
		]);
		expect(result.changes).toContainEqual({
			step: "writes-into-operations",
			kind: "duplicate-own-write-removed",
			entityUuid: REVIEW,
			detail: { writes: 1, operations: 0 },
		});
	});
});

// ─── form-link-semantics ──────────────────────────────────────────────────

describe("form-link-semantics", () => {
	const seen = new Set<string>();
	function mapped(doc: BlueprintDoc) {
		const result = formLinkSemantics(doc);
		expect(result.blockers).toEqual([]);
		expectEntries(result.notice);
		for (const change of result.changes) seen.add(change.kind);
		return result;
	}
	function entry(
		reason: MigrationNoticeEntry["reason"],
		uuid: string,
		name: string,
		detail?: Record<string, string>,
	): MigrationNoticeEntry {
		return {
			kind: "document",
			reason,
			entity: { type: "form", uuid: asUuid(uuid), nameAtMigration: name },
			...(detail !== undefined && { detail }),
		} as MigrationNoticeEntry;
	}

	const INTAKE = "45245935-7634-5291-a0c9-6657df3715e5";
	const TRIAGE = "ef4bea41-ac16-5dad-a11b-65dbaf3b6591";
	const REFER = "e1bea635-3e2c-52b9-a568-7997919aa565";
	const PATIENTS = "81207617-b17d-513b-a91a-c1d1379afd27";
	const links = parsed("targeted-migration-form-links");
	const linksDoc = writesIntoOperations(links.doc, links.facts).doc;

	it("names each change of the stored links by its reason, with the names it reads", () => {
		const result = mapped(linksDoc);
		expect(result.notice).toEqual([
			entry("form-links-conditions-written", INTAKE, "Intake", { links: "1" }),
			entry("form-link-otherwise-set", INTAKE, "Intake", { to: "Visits" }),
			entry("form-link-otherwise-set", TRIAGE, "Triage", {
				toDestination: "module",
			}),
			entry("form-link-target-moved", REFER, "Refer", {
				from: "Patient visits",
				to: "Patients",
			}),
		]);
		expect(result.changes).toEqual([
			{
				step: "form-link-semantics",
				kind: "conditions-written",
				entityUuid: INTAKE,
				detail: { links: 1 },
			},
			{
				step: "form-link-semantics",
				kind: "otherwise-set",
				entityUuid: INTAKE,
				detail: {},
			},
			{
				step: "form-link-semantics",
				kind: "otherwise-set",
				entityUuid: TRIAGE,
				detail: {},
			},
			{
				step: "form-link-semantics",
				kind: "target-moved",
				entityUuid: REFER,
				detail: {},
			},
		]);
	});

	it("names a stored after-submit that never ran, dropped beside an unconditional last link", () => {
		const doc = planted(linksDoc, (copy) => {
			formOf(copy, INTAKE).postSubmit = "module";
		});
		expect(mapped(doc).notice).toContainEqual(
			entry("after-submit-destination-dropped", INTAKE, "Intake"),
		);
	});

	it("names a link to a submenu whose parent is off the menu, removed", () => {
		const doc = planted(linksDoc, (copy) => {
			const patients = copy.modules[asUuid(PATIENTS)];
			if (patients !== undefined) patients.hiddenFromMenu = true;
		});
		const result = mapped(doc);
		expect(result.notice).toContainEqual(
			entry("form-link-removed", REFER, "Refer", { to: "Patient visits" }),
		);
		expect(formOf(result.doc, REFER).formLinks).toBeUndefined();
	});

	it("names an unoffered built-in Otherwise with the place it replaced, and carried values a menu drops", () => {
		const fixture = parsed("pre-step-otherwise-unoffered");
		const result = mapped(writesIntoOperations(fixture.doc, fixture.facts).doc);
		const BATCH = "e98b5c06-a2ed-53ba-a6ff-19c41d5e05f6";
		const REVIEW = "088bfe2b-0c70-576f-a998-26c1ae609f3b";
		expect(result.notice).toEqual([
			entry("form-link-otherwise-set", BATCH, "Batch review", {
				toDestination: "previous",
			}),
			entry("form-link-datums-dropped", REVIEW, "Review", {
				to: "Member notes",
			}),
			entry("form-link-otherwise-set", BATCH, "Batch review", {
				toDestination: "module",
				from: "previous",
			}),
		]);
	});

	it("maps a document it already mapped to no change", () => {
		const once = formLinkSemantics(linksDoc);
		const twice = formLinkSemantics(once.doc);
		expect(twice.changes).toEqual([]);
		expect(twice.notice).toEqual([]);
	});

	it("has met every change kind of the map", () => {
		expect([...seen].sort()).toEqual([...FORM_LINK_SEMANTICS_CHANGES].sort());
	});
});

// ─── extension-children ───────────────────────────────────────────────────

describe("extension-children", () => {
	const PATIENTS = asUuid("24398078-9027-5e34-a003-8a167f0c8348");
	const ENROLLMENT = asUuid("64211602-4809-5136-a52b-5d784f479d52");
	const EPISODES = asUuid("b42e7474-ec0d-53b0-ac8b-dd06f9a21724");
	const ENROLL = "145a1192-eb99-5116-a297-183476567d42";
	const LINK = "57c180b2-530d-5fbe-a933-7d381e9561e2";

	const fixture = parsed("targeted-migration-extension-children");
	const base = formLinkSemantics(
		writesIntoOperations(fixture.doc, fixture.facts).doc,
	).doc;
	const episodeCreate = caseWriteOperationUuid(
		fixture.appId,
		asUuid(ENROLL),
		"extension:episode:root",
	);

	/** Enrollment's case list selects several cases: a blocker keeps its
	 *  menu basic. */
	function blocked(copy: BlueprintDoc): void {
		const enrollment = copy.modules[ENROLLMENT];
		if (enrollment?.caseListConfig === undefined)
			throw new Error("The fixture's Enrollment menu has no case list.");
		enrollment.caseListConfig.selection = { kind: "multiple", maximum: 5 };
	}
	function asSubmenu(copy: BlueprintDoc): void {
		const episodes = copy.modules[EPISODES];
		if (episodes !== undefined) episodes.parentModuleUuid = PATIENTS;
	}
	function patientsOffTheMenu(copy: BlueprintDoc): void {
		const patients = copy.modules[PATIENTS];
		if (patients !== undefined) patients.hiddenFromMenu = true;
	}
	function goesToMenu(caseType: string, to?: string): MigrationNoticeEntry {
		return {
			kind: "document",
			reason: "form-link-goes-to-menu",
			entity: { type: "form", uuid: asUuid(ENROLL), nameAtMigration: "Enroll" },
			detail: { ...(to !== undefined && { to }), caseType },
		};
	}

	it("makes the menu of an extension create a link carries advanced, once, without changing a link", () => {
		const result = extensionChildren(base);
		expect(result.blockers).toEqual([]);
		expect(result.doc.forms).toEqual(base.forms);
		expect([...result.carriedCreates]).toEqual([episodeCreate]);
		expect([...result.advancedModules]).toEqual([ENROLLMENT]);
		expect(result.notice).toEqual([
			{
				kind: "document",
				reason: "module-made-advanced",
				entity: {
					type: "module",
					uuid: ENROLLMENT,
					nameAtMigration: "Enrollment",
				},
				detail: { caseType: "episode" },
			},
		]);
		expectEntries(result.notice);
		expect(result.changes.map((change) => change.kind)).toEqual([
			"carried-create",
			"module-made-advanced",
		]);
	});

	it.each([
		{
			where: "to the target form's menu, offered from the form's menu",
			plant: [blocked],
			to: EPISODES as Uuid | undefined,
			name: "Episodes",
		},
		{
			where: "to the nearest menu above it, where the target's is not offered",
			plant: [blocked, asSubmenu],
			to: PATIENTS,
			name: "Patients",
		},
		{
			where: "away, to the app home, where no menu above it is offered",
			plant: [blocked, asSubmenu, patientsOffTheMenu],
			to: undefined,
			name: undefined,
		},
	])(
		"sends a link carrying a create a blocker refuses $where, its carried values dropped",
		({ plant, to, name }) => {
			const doc = planted(base, (copy) => {
				for (const edit of plant) edit(copy);
			});
			const result = extensionChildren(doc);
			expect(result.blockers).toEqual([]);
			expect([...result.advancedModules]).toEqual([]);
			expect([...result.carriedCreates]).toEqual([episodeCreate]);
			const form = formOf(result.doc, ENROLL);
			expect(form.formLinks).toEqual(
				to === undefined
					? undefined
					: [{ uuid: LINK, target: { type: "module", moduleUuid: to } }],
			);
			expect(result.notice).toEqual([goesToMenu("episode", name)]);
			expectEntries(result.notice);
			expect(result.changes.map((change) => change.kind)).toEqual([
				"carried-create",
				to === undefined ? "link-removed" : "link-goes-to-menu",
			]);
			// The retarget is the whole fix: nothing is left for a second pass.
			expect(extensionChildren(result.doc).changes).toEqual([]);
		},
	);

	it("sends a link to a menu where the advanced form cannot open the create it carries", () => {
		const doc = planted(base, (copy) => {
			const create = operationOf(formOf(copy, ENROLL), episodeCreate);
			create.writes = [
				{
					property: "status",
					value: { kind: "term", term: { kind: "literal", value: "new" } },
					condition: {
						kind: "eq",
						left: { kind: "term", term: { kind: "literal", value: "a" } },
						right: { kind: "term", term: { kind: "literal", value: "a" } },
					},
				},
			];
		});
		const result = extensionChildren(doc);
		expect(result.notice).toEqual([goesToMenu("episode", "Episodes")]);
		expect([...result.advancedModules]).toEqual([]);
	});

	it("lists a carried create that is not an extension apart", () => {
		const doc = planted(base, (copy) => {
			const create = operationOf(formOf(copy, ENROLL), episodeCreate);
			const link = create.links?.[0];
			if (link === undefined) throw new Error("The create has no link.");
			link.relationship = "child";
			link.identifier = "mother";
		});
		const result = extensionChildren(doc);
		expect(
			result.changes.map((change) => [change.kind, change.entityUuid]),
		).toEqual([
			["non-extension-carried-create", ENROLL],
			["module-made-advanced", ENROLLMENT],
		]);
		expect([...result.advancedModules]).toEqual([ENROLLMENT]);
	});

	it("changes nothing in an app no link carries a create in", () => {
		const other = parsed("targeted-migration-case-writes");
		const doc = formLinkSemantics(
			writesIntoOperations(other.doc, other.facts).doc,
		).doc;
		const result = extensionChildren(doc);
		expect(result.doc).toBe(doc);
		expect(result.changes).toEqual([]);
		expect(result.notice).toEqual([]);
	});
});
