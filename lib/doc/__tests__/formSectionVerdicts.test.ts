/** Section and expression prechecks agree with the real move's commit gate. */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	type FieldSpec,
	f,
} from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import {
	parseFormExpressionForSlot,
	projectFormExpression,
} from "@/lib/doc/expressionText";
import {
	fieldPlacementVerdict,
	formIsSectioned,
	formOfField,
	formSectionsOf,
	landingSectionOf,
	sectionOf,
	subtreeHasUserRepeat,
} from "@/lib/doc/formSectionVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutation } from "@/lib/doc/mutations";
import { mutationSchema, type Uuid } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { expressionSlotValue } from "@/lib/domain/referenceSlots";
import { assertAdmittedDoc } from "./admittedDoc";

const FORM = testUuid("frm-sectioned");
const FLAT = testUuid("frm-flat");
const S1 = testUuid("sec-1");
const S2 = testUuid("sec-2");
const NAME = testUuid("fld-name");
const AGE = testUuid("fld-age");
const GROUP = testUuid("fld-group");
const PHONE = testUuid("fld-phone");
const VISIT_DATE = testUuid("fld-visit-date");
const FLAT_A = testUuid("fld-flat-a");
const FLAT_GROUP = testUuid("fld-flat-group");
const FLAT_REPEAT = testUuid("fld-flat-repeat");
const DETAILS = testUuid("fld-move-details");
const SUMMARY = testUuid("fld-move-summary");
const summarySlot = {
	entity: "field",
	uuid: SUMMARY,
	slot: "calculate",
} as const;

function expressionMoveFixture(source: string) {
	const doc = buildDoc({
		appName: "Expression moves",
		modules: [
			{
				name: "M",
				forms: [
					{
						uuid: FLAT,
						name: "Visit",
						type: "survey",
						fields: [
							f({
								kind: "repeat",
								uuid: FLAT_REPEAT,
								id: "visits",
								repeat_mode: "user_controlled",
								children: [
									f({
										kind: "group",
										uuid: DETAILS,
										id: "details",
										children: [
											f({ kind: "date", uuid: VISIT_DATE, id: "visited_on" }),
										],
									}),
								],
							}),
							f({ kind: "group", uuid: FLAT_GROUP, id: "other", children: [] }),
							f({ kind: "hidden", uuid: SUMMARY, id: "summary" }),
						],
					},
				],
			},
		],
	});
	const parsed = parseFormExpressionForSlot(
		doc,
		summarySlot,
		source,
		"unavailable",
	);
	if (!parsed.ok || parsed.expression === undefined)
		throw new Error("The move fixture must parse.");
	const expression = parsed.expression;
	const saved = produce(doc, (draft) => {
		applyMutation(draft, {
			kind: "updateField",
			uuid: SUMMARY,
			targetKind: "hidden",
			patch: { calculate: expression },
		});
	});
	assertAdmittedDoc(saved);
	return saved;
}

/**
 * Sectioned: [S1: name, group(phone)] [S2: age]
 * Flat: a, group(), repeat visits (user-controlled, holds visit_date)
 */
function fixture() {
	const doc = buildDoc({
		appName: "Verdicts",
		modules: [
			{
				name: "M",
				forms: [
					{
						uuid: FORM,
						name: "Sectioned",
						type: "survey",
						fields: [
							f({
								kind: "section",
								uuid: S1,
								id: "s1",
								label: proseText("One"),
								children: [
									f({ kind: "text", uuid: NAME, id: "name" }),
									f({
										kind: "group",
										uuid: GROUP,
										id: "g",
										children: [f({ kind: "text", uuid: PHONE, id: "phone" })],
									}),
								],
							}),
							f({
								kind: "section",
								uuid: S2,
								id: "s2",
								children: [f({ kind: "int", uuid: AGE, id: "age" })],
							}),
						],
					},
					{
						uuid: FLAT,
						name: "Flat",
						type: "survey",
						fields: [
							f({ kind: "text", uuid: FLAT_A, id: "a" }),
							f({ kind: "group", uuid: FLAT_GROUP, id: "g", children: [] }),
							f({
								kind: "repeat",
								uuid: FLAT_REPEAT,
								id: "visits",
								repeat_mode: "user_controlled",
								children: [f({ kind: "date", uuid: VISIT_DATE, id: "d" })],
							}),
						],
					},
				],
			},
		],
	});
	assertAdmittedDoc(doc);
	return doc;
}

describe("section readers", () => {
	it("list a form's root sections in page order and say whether it is sectioned", () => {
		const doc = fixture();
		expect(formSectionsOf(doc, FORM)).toEqual([S1, S2]);
		expect(formIsSectioned(doc, FORM)).toBe(true);
		expect(formSectionsOf(doc, FLAT)).toEqual([]);
		expect(formIsSectioned(doc, FLAT)).toBe(false);
	});

	it("find the page a field is on, at any depth, and the form it belongs to", () => {
		const doc = fixture();
		expect(sectionOf(doc, NAME)).toBe(S1);
		expect(sectionOf(doc, PHONE)).toBe(S1);
		expect(sectionOf(doc, AGE)).toBe(S2);
		expect(sectionOf(doc, S1)).toBeUndefined();
		expect(sectionOf(doc, FLAT_A)).toBeUndefined();
		expect(landingSectionOf(doc, S2)).toBe(S2);
		expect(landingSectionOf(doc, GROUP)).toBe(S1);
		expect(landingSectionOf(doc, FLAT_GROUP)).toBeUndefined();
		expect(formOfField(doc, PHONE)).toBe(FORM);
		expect(formOfField(doc, FLAT_REPEAT)).toBe(FLAT);
	});

	it("see an add-entries repeat anywhere below a field", () => {
		const doc = fixture();
		expect(subtreeHasUserRepeat(doc, FLAT_REPEAT)).toBe(true);
		expect(subtreeHasUserRepeat(doc, VISIT_DATE)).toBe(false);
		expect(subtreeHasUserRepeat(doc, FLAT_GROUP)).toBe(false);
		expect(subtreeHasUserRepeat(doc, GROUP)).toBe(false);
	});
});

describe("fieldPlacementVerdict", () => {
	it.each([
		"../visits[1]/details/visited_on",
		"/data/visits[1]/details/visited_on",
	])(
		"refuses moving a descendant out of the filtered path %s before drop",
		(source) => {
			const doc = expressionMoveFixture(source);
			const move = mutationSchema.parse(
				JSON.parse(
					JSON.stringify({
						kind: "moveField",
						uuid: DETAILS,
						toParentUuid: FLAT,
						after: null,
					}),
				),
			);
			const verdict = fieldPlacementVerdict(doc, {
				uuid: DETAILS,
				kind: "group",
				toParentUuid: FLAT,
			});
			expect(verdict).toMatchObject({
				ok: false,
				reason: "expression-no-path",
			});
			if (verdict.ok) throw new Error("Expected the move precheck to refuse.");
			expect(verdict.message).toContain('"details"');
			expect(verdict.message).toContain('"summary"');
			expect(verdict.message).toContain("calculated value");
			const committed = mutationCommitVerdict(
				doc,
				[move],
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			expect(committed.ok).toBe(false);
			if (committed.ok)
				throw new Error("Expected the actual move to be refused.");
			expect(committed.nextDoc.fieldParent[DETAILS]).toBe(FLAT);
			expect(committed.findings).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						code: "INVALID_REF",
						details: expect.objectContaining({
							checkReason: "form-filter-step",
						}),
					}),
				]),
			);
			expect(doc.fieldParent[DETAILS]).toBe(FLAT_REPEAT);
		},
	);

	it.each([FLAT_REPEAT, SUMMARY])(
		"keeps a reachable relative path when moving %s",
		(uuid) => {
			const doc = expressionMoveFixture("../visits[1]/details/visited_on");
			const field = doc.fields[uuid];
			expect(
				fieldPlacementVerdict(doc, {
					uuid,
					kind: field.kind,
					toParentUuid: FLAT_GROUP,
				}),
			).toEqual({ ok: true });
			const committed = mutationCommitVerdict(
				doc,
				[{ kind: "moveField", uuid, toParentUuid: FLAT_GROUP, after: null }],
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			expect(committed).toMatchObject({ ok: true });
			const expression = expressionSlotValue(committed.nextDoc, summarySlot);
			if (expression === undefined)
				throw new Error("Expected the saved calculation.");
			expect(
				projectFormExpression(
					committed.nextDoc,
					summarySlot,
					expression,
					"unavailable",
				),
			).toMatchObject({
				text:
					uuid === FLAT_REPEAT
						? "../other/visits[1]/details/visited_on"
						: "../../visits[1]/details/visited_on",
				unresolved: [],
			});
			expect(expression).toBe(expressionSlotValue(doc, summarySlot));
		},
	);

	it("lets a question land inside a section, and refuses it at a sectioned root", () => {
		const doc = fixture();
		expect(
			fieldPlacementVerdict(doc, { kind: "text", toParentUuid: S2 }),
		).toEqual({ ok: true });
		expect(
			fieldPlacementVerdict(doc, {
				uuid: FLAT_A,
				kind: "text",
				toParentUuid: S1,
			}),
		).toEqual({ ok: true });
		const loose = fieldPlacementVerdict(doc, {
			kind: "text",
			toParentUuid: FORM,
		});
		expect(loose).toEqual({
			ok: false,
			reason: "loose-field-in-sectioned-form",
			message:
				"This form is split into sections, so a question belongs inside one. Add it to a section, or remove the sections first.",
		});
	});

	it("lets anything land at the root of a single-page form", () => {
		const doc = fixture();
		expect(
			fieldPlacementVerdict(doc, { kind: "text", toParentUuid: FLAT }),
		).toEqual({ ok: true });
		expect(
			fieldPlacementVerdict(doc, { kind: "section", toParentUuid: FLAT }),
		).toEqual({ ok: true });
		expect(
			fieldPlacementVerdict(doc, {
				kind: "repeat",
				toParentUuid: FLAT,
				subtreeHasUserRepeat: true,
			}),
		).toEqual({ ok: true });
	});

	it("keeps a section at the top level of its own form", () => {
		const doc = fixture();
		expect(
			fieldPlacementVerdict(doc, { kind: "section", toParentUuid: FORM }),
		).toEqual({ ok: true });
		expect(
			fieldPlacementVerdict(doc, {
				uuid: S1,
				kind: "section",
				toParentUuid: FORM,
			}),
		).toEqual({ ok: true });
		expect(
			fieldPlacementVerdict(doc, { kind: "section", toParentUuid: GROUP }).ok,
		).toBe(false);
		expect(
			fieldPlacementVerdict(doc, { kind: "section", toParentUuid: S1 }),
		).toMatchObject({ ok: false, reason: "section-not-root" });
		expect(
			fieldPlacementVerdict(doc, {
				uuid: S1,
				kind: "section",
				toParentUuid: FLAT,
			}),
		).toMatchObject({ ok: false, reason: "section-other-form" });
	});

	it("refuses an add-entries repeat under a section, at any depth, and allows a bound one", () => {
		const doc = fixture();
		expect(
			fieldPlacementVerdict(doc, {
				uuid: FLAT_REPEAT,
				kind: "repeat",
				toParentUuid: S1,
			}),
		).toMatchObject({ ok: false, reason: "user-repeat-in-section" });
		// Into a group that sits on a page: still a page.
		expect(
			fieldPlacementVerdict(doc, {
				uuid: FLAT_REPEAT,
				kind: "repeat",
				toParentUuid: GROUP,
			}),
		).toMatchObject({ ok: false, reason: "user-repeat-in-section" });
		// A new repeat: the caller says what it is.
		expect(
			fieldPlacementVerdict(doc, {
				kind: "repeat",
				toParentUuid: S1,
				subtreeHasUserRepeat: true,
			}).ok,
		).toBe(false);
		expect(
			fieldPlacementVerdict(doc, {
				kind: "repeat",
				toParentUuid: S1,
				subtreeHasUserRepeat: false,
			}),
		).toEqual({ ok: true });
		// A group without a repeat is eligible.
		expect(
			fieldPlacementVerdict(doc, {
				uuid: FLAT_GROUP,
				kind: "group",
				toParentUuid: S2,
			}),
		).toEqual({ ok: true });
	});
});

const MANY = testUuid("frm-many");
const Q = testUuid("fld-many-q");
const N = testUuid("fld-many-n");
const VISITS = testUuid("fld-many-visits");
const INNER = testUuid("fld-many-inner");
const BOX = testUuid("fld-many-box");
const SUB = testUuid("fld-many-sub");
const DEEP = testUuid("fld-many-deep");
const READER = testUuid("fld-many-reader");
const HOLDER = testUuid("fld-many-holder");
const COUNTED = testUuid("fld-many-counted");
const SPOT = testUuid("fld-many-spot");

/**
 * Root: q, n, spot(), [extra], counted (count-bound by `countSource`),
 * visits (add-entries): inner, box(), sub (add-entries): deep, [extra]
 */
function manyFixture(
	extra: {
		readonly root?: readonly FieldSpec[];
		readonly visits?: readonly FieldSpec[];
		readonly sub?: readonly FieldSpec[];
		readonly countSource?: string;
	} = {},
): BlueprintDoc {
	const doc = buildDoc({
		appName: "Repeat readers",
		modules: [
			{
				name: "M",
				forms: [
					{
						uuid: MANY,
						name: "Visits",
						type: "survey",
						fields: [
							f({ kind: "text", uuid: Q, id: "q" }),
							f({ kind: "int", uuid: N, id: "n" }),
							f({ kind: "group", uuid: SPOT, id: "spot", children: [] }),
							...(extra.root ?? []),
							f({
								kind: "repeat",
								uuid: COUNTED,
								id: "counted",
								repeat_mode: "count_bound",
								repeat_count: extra.countSource ?? "2",
								children: [],
							}),
							f({
								kind: "repeat",
								uuid: VISITS,
								id: "visits",
								repeat_mode: "user_controlled",
								children: [
									f({ kind: "text", uuid: INNER, id: "inner" }),
									f({ kind: "group", uuid: BOX, id: "box", children: [] }),
									f({
										kind: "repeat",
										uuid: SUB,
										id: "sub",
										repeat_mode: "user_controlled",
										children: [
											f({ kind: "text", uuid: DEEP, id: "deep" }),
											...(extra.sub ?? []),
										],
									}),
									...(extra.visits ?? []),
								],
							}),
						],
					},
				],
			},
		],
	});
	assertAdmittedDoc(doc);
	return doc;
}

const reader = (calculate: string): FieldSpec =>
	f({ kind: "hidden", uuid: READER, id: "reader", calculate });

function move(uuid: Uuid, toParentUuid: Uuid) {
	return { kind: "moveField" as const, uuid, toParentUuid, after: null };
}

/** Both the precheck and the real move's commit gate refuse, at the reader. */
function expectManyValuesRefusal(
	doc: BlueprintDoc,
	uuid: Uuid,
	toParentUuid: Uuid,
	readerUuid: Uuid,
): string {
	const verdict = fieldPlacementVerdict(doc, {
		uuid,
		kind: doc.fields[uuid].kind,
		toParentUuid,
	});
	expect(verdict).toMatchObject({
		ok: false,
		reason: "expression-many-values",
	});
	if (verdict.ok) throw new Error("Expected the move precheck to refuse.");
	const committed = mutationCommitVerdict(
		doc,
		[move(uuid, toParentUuid)],
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(committed.ok).toBe(false);
	if (committed.ok) throw new Error("Expected the actual move to be refused.");
	expect(committed.findings).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				code: "XPATH_MANY_VALUES",
				details: expect.objectContaining({ checkCode: "many-values" }),
				location: expect.objectContaining({ fieldUuid: readerUuid }),
			}),
		]),
	);
	expect(doc.fieldParent[uuid]).not.toBe(toParentUuid);
	return verdict.message;
}

function expectAdmittedMove(
	doc: BlueprintDoc,
	uuid: Uuid,
	toParentUuid: Uuid,
): void {
	expect(
		fieldPlacementVerdict(doc, {
			uuid,
			kind: doc.fields[uuid].kind,
			toParentUuid,
		}),
	).toEqual({ ok: true });
	expect(
		mutationCommitVerdict(
			doc,
			[move(uuid, toParentUuid)],
			LOOKUP_CONTEXT_UNAVAILABLE,
		),
	).toMatchObject({ ok: true });
}

describe("fieldPlacementVerdict and one-value readers of a repeat", () => {
	it("refuses moving an answer into a repeat while a reader outside needs one value", () => {
		const doc = manyFixture({ root: [reader("#form/q = 'yes'")] });
		const message = expectManyValuesRefusal(doc, Q, VISITS, READER);
		expect(message).toBe(
			'Moving "q" here changes "reader"\'s calculated value. This reads an answer from every entry of the repeat "visits" where it needs one value. You can count or join the entries, or read just one of them.',
		);
	});

	it.each(["count(#form/q) > 0", "join(' ', #form/q)"])(
		"admits the same move for a reader that takes every value: %s",
		(source) => {
			expectAdmittedMove(manyFixture({ root: [reader(source)] }), Q, VISITS);
		},
	);

	it("admits a move inside the repeat for a reader that names one entry", () => {
		const doc = manyFixture({
			root: [reader("#form/visits[1]/inner = 'yes'")],
		});
		expectAdmittedMove(doc, INNER, BOX);
	});

	it("admits a move inside the repeat for a reader that filters the entries", () => {
		const doc = manyFixture({
			root: [reader("#form/visits[inner = 'yes']/inner = 'yes'")],
		});
		expectAdmittedMove(doc, INNER, BOX);
	});

	it("refuses moving a reader out of the repeat whose answer it reads", () => {
		const doc = manyFixture({ visits: [reader("../inner = 'yes'")] });
		expectManyValuesRefusal(doc, READER, MANY, READER);
	});

	it("refuses moving a group out of the repeat while a reader inside it reads an entry's answer", () => {
		const doc = manyFixture({
			visits: [
				f({
					kind: "group",
					uuid: HOLDER,
					id: "holder",
					children: [reader("#form/visits/inner = 'yes'")],
				}),
			],
		});
		expectManyValuesRefusal(doc, HOLDER, MANY, READER);
	});

	it("admits moving a reader into the repeat it reads", () => {
		const doc = manyFixture({
			root: [reader("count(#form/visits/inner) > 0")],
		});
		expectAdmittedMove(doc, READER, VISITS);
	});

	it("refuses moving a reader out of a nested repeat into the outer one", () => {
		const doc = manyFixture({ sub: [reader("../deep = 'yes'")] });
		expectManyValuesRefusal(doc, READER, VISITS, READER);
	});

	it("refuses moving an answer into the repeat a repeat count reads it for", () => {
		const doc = manyFixture({ countSource: "#form/n" });
		expectManyValuesRefusal(doc, N, COUNTED, COUNTED);
		expectAdmittedMove(doc, N, SPOT);
	});

	it("refuses moving an answer into a repeat while a label outside shows it", () => {
		const doc = manyFixture({
			root: [
				f({
					kind: "label",
					uuid: HOLDER,
					id: "shown",
					label: {
						parts: [
							{ kind: "text", text: "You said " },
							{ kind: "field-ref", uuid: Q },
						],
					},
				}),
			],
		});
		const verdict = fieldPlacementVerdict(doc, {
			uuid: Q,
			kind: "text",
			toParentUuid: VISITS,
		});
		expect(verdict).toMatchObject({
			ok: false,
			reason: "expression-many-values",
			message: expect.stringContaining('"shown"\'s label'),
		});
		const committed = mutationCommitVerdict(
			doc,
			[move(Q, VISITS)],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(committed).toMatchObject({ ok: false });
		if (committed.ok)
			throw new Error("Expected the actual move to be refused.");
		expect(committed.findings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "XPATH_MANY_VALUES",
					details: expect.objectContaining({ checkCode: "many-values" }),
					location: expect.objectContaining({ fieldUuid: HOLDER }),
				}),
			]),
		);
		expectAdmittedMove(doc, Q, SPOT);
	});
});

describe("fieldPlacementVerdict and the form's own case writes", () => {
	const SAVER = testUuid("fld-case-saver");
	const ENTRIES = testUuid("fld-case-entries");
	const ELSEWHERE = testUuid("fld-case-elsewhere");
	function caseWriteFixture(): BlueprintDoc {
		const doc = buildDoc({
			appName: "Case write moves",
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "age", label: proseText("Age") }],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Follow up",
							type: "followup",
							fields: [
								f({
									kind: "text",
									uuid: SAVER,
									id: "age",
									caseWrite: { caseType: "patient", property: "age" },
								}),
								f({
									kind: "repeat",
									uuid: ENTRIES,
									id: "visits",
									repeat_mode: "user_controlled",
									children: [f({ kind: "text", id: "note" })],
								}),
								f({
									kind: "group",
									uuid: ELSEWHERE,
									id: "other",
									children: [],
								}),
							],
						},
					],
				},
			],
		});
		assertAdmittedDoc(doc);
		return doc;
	}

	it("refuses moving a question that saves to the form's case into a repeat, before projecting it", () => {
		const doc = caseWriteFixture();
		const verdict = fieldPlacementVerdict(doc, {
			uuid: SAVER,
			kind: "text",
			toParentUuid: ENTRIES,
		});
		expect(verdict).toEqual({
			ok: false,
			reason: "case-write-placement",
			message: expect.stringContaining(
				'inside the repeat "visits", and a form saves that case once',
			),
		});
		expect(
			mutationCommitVerdict(
				doc,
				[
					{
						kind: "moveField",
						uuid: SAVER,
						toParentUuid: ENTRIES,
						after: null,
					},
				],
				LOOKUP_CONTEXT_UNAVAILABLE,
			).ok,
		).toBe(false);
	});

	it("admits the same question moving into a group outside the repeat", () => {
		const doc = caseWriteFixture();
		expect(
			fieldPlacementVerdict(doc, {
				uuid: SAVER,
				kind: "text",
				toParentUuid: ELSEWHERE,
			}),
		).toEqual({ ok: true });
	});
});
