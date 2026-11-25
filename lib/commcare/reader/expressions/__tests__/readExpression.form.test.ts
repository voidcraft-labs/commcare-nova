/**
 * One form slot read from an app's text: bound through the parser's reading
 * hook, printed by the production XForm emitter and compared. The failures
 * this holds: an own-case walk or the usercase selector left a query, a
 * default that reads the case read as anything but the preload it is, a form
 * of HQ's naming an instance otherwise, a question with a generated-looking
 * name taken for a generated node, a function Core does not answer or a
 * hashtag Core's lexer refuses accepted, an axis spelling of a form path
 * refused, an itext id of HQ's read as Nova's own, an instance declared from
 * `jr://fixture/user-groups` claiming the entry for a source Nova doesn't
 * read, a generated node the form reader set aside left unread (under its
 * own name or another suffix), a node the document holds expanded as a
 * generated one, a calculate that reads itself expanded without end, and a
 * read of a count placement's rows not read back through the source's names.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	type FieldSpec,
	f,
} from "@/lib/__tests__/docHelpers";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import {
	caseOperationFixture,
	operationScenarios,
} from "@/lib/commcare/__tests__/caseOperationFixture";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import type { Expression, SlotContextRef } from "@/lib/domain/expression/types";
import { lookupTableIdSchema } from "@/lib/domain/lookupIds";
import { simpleSearchInputDef } from "@/lib/domain/modules";
import type { ProseTemplate } from "@/lib/domain/prose";
import { expressionSlotKey } from "@/lib/domain/referenceSlots";
import { wireTable } from "../../../lookup/__tests__/lookupWireCorpus";
import { readExpressions } from "../index";
import { readExpression } from "../readExpression";
import {
	fieldNamed,
	onlyForm,
	readEnv,
	registration,
} from "./expressionReadFixture";
import { judgeReadBack, readEmission } from "./readBackCorpus";

const OWN =
	"instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]";

function visitDoc() {
	return buildDoc({
		caseTypes: [
			{
				name: "household",
				properties: [{ name: "village", label: "Village" }],
			},
			{
				name: "patient",
				parent_type: "household",
				properties: [
					{ name: "age", label: "Age", data_type: "int" },
					{ name: "dob", label: "Date of birth", data_type: "date" },
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({ kind: "text", id: "q1", label: "Q1" }),
							f({ kind: "text", id: "nova_trimmed_x", label: "Trimmed" }),
						],
					},
				],
			},
		],
	});
}

function held(judgment: ReturnType<typeof readExpression>): Expression {
	expect(judgment.kind).toBe("bound");
	if (judgment.kind !== "bound") throw new Error("not bound");
	expect(judgment.equal).toBe(true);
	return judgment.candidate;
}

describe("a form slot's text read through the reading hook", () => {
	it("reads the own case's walk as the form's case, at depth 0 and 1", () => {
		const doc = visitDoc();
		const q1 = fieldNamed(doc, "q1");
		const ref = { entity: "field", uuid: q1, slot: "relevant" } as const;
		const own = held(
			readExpression(doc, registration(doc, ref, `${OWN}/age > 5`), readEnv()),
		);
		expect(own).toMatchObject({
			kind: "gt",
			left: {
				kind: "term",
				term: { kind: "form-case", caseType: "patient", property: "age" },
			},
		});
		const parent = held(
			readExpression(
				doc,
				registration(
					doc,
					ref,
					`instance('casedb')/casedb/case[@case_id = ${OWN}/index/parent]/village = 'x'`,
				),
				readEnv(),
			),
		);
		expect(parent).toMatchObject({
			kind: "eq",
			left: {
				kind: "term",
				term: { kind: "form-case", caseType: "household", property: "village" },
			},
		});
	});

	it("reads the usercase selector as the worker's record", () => {
		const doc = visitDoc();
		const ref = {
			entity: "field",
			uuid: fieldNamed(doc, "q1"),
			slot: "relevant",
		} as const;
		const tree = held(
			readExpression(
				doc,
				registration(
					doc,
					ref,
					"instance('casedb')/casedb/case[@case_type = 'commcare-user'][hq_user_id = instance('commcaresession')/session/context/userid]/role = 'chw'",
				),
				readEnv(),
			),
		);
		expect(tree).toMatchObject({
			kind: "eq",
			left: {
				kind: "term",
				term: { kind: "session-user", field: "role", source: "worker-record" },
			},
		});
	});

	it("reads a default that is the own case's property as the preload", () => {
		const doc = visitDoc();
		const ref = {
			entity: "field",
			uuid: fieldNamed(doc, "q1"),
			slot: "default_value",
		} as const;
		const tree = held(
			readExpression(doc, registration(doc, ref, `${OWN}/age`), readEnv()),
		);
		expect(tree).toEqual({
			kind: "term",
			term: { kind: "form-case", caseType: "patient", property: "age" },
		});
	});

	it("reads an instance the form declares under another id by its source", () => {
		const doc = visitDoc();
		const form = onlyForm(doc);
		const ref = {
			entity: "field",
			uuid: fieldNamed(doc, "q1"),
			slot: "relevant",
		} as const;
		const env = readEnv({
			instanceSources: new Map([
				[
					form,
					new Map([
						["cases", "jr://instance/casedb"],
						["session", "jr://instance/session"],
					]),
				],
			]),
		});
		held(
			readExpression(
				doc,
				registration(
					doc,
					ref,
					"instance('cases')/casedb/case[@case_id = instance('session')/session/data/case_id]/age > 5",
				),
				env,
			),
		);
	});

	it.each([
		[
			"casedb",
			"jr://instance/selected-entities/casedb",
			"instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/age > 5",
		],
		[
			"worker",
			"jr://instance/selected-entities/commcaresession",
			"instance('worker')/session/context/userid = 'visitor'",
		],
		[
			"locations",
			"jr://instance/selected-entities/locations",
			"count(instance('locations')/locations/location) > 0",
		],
		[
			"item-list:locations",
			"jr://instance/selected-entities/item-list:locations",
			"count(instance('item-list:locations')/locations_list/locations) > 0",
		],
		[
			"results",
			"jr://fixture/results",
			"count(instance('results')/results/case) > 0",
		],
	])(
		"refuses %s reading another instance family on a native path",
		(id, source, expression) => {
			const doc = visitDoc();
			const ref = {
				entity: "field",
				uuid: fieldNamed(doc, "q1"),
				slot: "relevant",
			} as const;
			const outcome = readExpression(
				doc,
				registration(doc, ref, expression),
				readEnv({
					instanceSources: new Map([[onlyForm(doc), new Map([[id, source]])]]),
				}),
			);
			expect(outcome).toMatchObject({
				kind: "refused",
				cause: { kind: "parse", issues: [{ code: "instance-unknown" }] },
			});
		},
	);

	it("reads a question named like a generated node as the question", () => {
		const doc = visitDoc();
		const trimmed = fieldNamed(doc, "nova_trimmed_x");
		const ref = {
			entity: "field",
			uuid: fieldNamed(doc, "q1"),
			slot: "relevant",
		} as const;
		const tree = held(
			readExpression(
				doc,
				registration(doc, ref, "/data/nova_trimmed_x = 'a'"),
				readEnv(),
			),
		);
		expect(tree).toMatchObject({
			kind: "eq",
			left: { kind: "term", term: { kind: "field", uuid: trimmed } },
		});
	});

	it("holds an axis spelling of the question's own node", () => {
		const doc = visitDoc();
		const ref = {
			entity: "field",
			uuid: fieldNamed(doc, "q1"),
			slot: "validate",
		} as const;
		held(
			readExpression(
				doc,
				registration(doc, ref, "self::node() != 'x'"),
				readEnv(),
			),
		);
	});

	it("refuses a function Core does not answer and a hashtag Core cannot lex", () => {
		const doc = visitDoc();
		const ref = {
			entity: "field",
			uuid: fieldNamed(doc, "q1"),
			slot: "relevant",
		} as const;
		for (const [text, code] of [
			["normalize-space(/data/q1) = ''", "unknown-function"],
			["is-blank(/data/q1)", "unknown-function"],
			["#form/q1 = 'a'", "unknown-hashtag"],
		] as const) {
			const judgment = readExpression(
				doc,
				registration(doc, ref, text),
				readEnv(),
			);
			expect(judgment.kind).toBe("refused");
			if (judgment.kind !== "refused") continue;
			expect(judgment.cause).toMatchObject({
				kind: "parse",
				issues: [expect.objectContaining({ code })],
			});
		}
	});

	it("reads an itext id of HQ's through the unit the form reader read it as", () => {
		const doc = visitDoc();
		const q1 = fieldNamed(doc, "q1");
		const ref = {
			entity: "field",
			uuid: fieldNamed(doc, "nova_trimmed_x"),
			slot: "relevant",
		} as const;
		const pending = registration(doc, ref, "jr:itext('hq-label-1') = 'Q1'");
		const units = readEnv({
			itextUnits: new Map([
				[
					onlyForm(doc),
					new Map([["hq-label-1", { field: q1, role: "field-label" }]]),
				],
			]),
		});
		expect(held(readExpression(doc, pending, units))).toMatchObject({
			kind: "eq",
			left: { kind: "itext", unit: { field: q1, role: "field-label" } },
		});
		// HQ's id names no unit of Nova's own: without the form reader's
		// reading of it, the text is not held.
		const unmapped = readExpression(doc, pending, readEnv());
		expect(unmapped.kind === "bound" && unmapped.equal).toBe(false);
	});

	it("binds each table to its declared source in the form and to its suite id outside the form", () => {
		const doc = visitDoc();
		const form = onlyForm(doc);
		const locations = {
			id: lookupTableIdSchema.parse("11111111-1111-7111-8111-111111111111"),
			tag: "locations",
			name: "Location codes",
			columns: [],
		};
		const results = {
			id: lookupTableIdSchema.parse("22222222-2222-7222-8222-222222222222"),
			tag: "results",
			name: "Result codes",
			columns: [],
		};
		const env = readEnv({
			lookup: new Map([
				[locations.id, locations],
				[results.id, results],
			]),
			instanceSources: new Map([
				[
					form,
					new Map([
						["item-list:results", "jr://fixture/item-list:locations"],
						["results-1", "jr://fixture/item-list:results"],
						["locations", "jr://fixture/locations"],
					]),
				],
			]),
		});
		const field = {
			entity: "field",
			uuid: fieldNamed(doc, "q1"),
			slot: "relevant",
		} as const;
		const tree = held(
			readExpression(
				doc,
				registration(
					doc,
					field,
					"count(instance('item-list:results')/locations_list/locations) > count(instance('results-1')/results_list/results)",
				),
				env,
			),
		);
		expect(tree).toMatchObject({
			kind: "gt",
			left: {
				kind: "count",
				via: { kind: "table-rows", tableId: locations.id },
			},
			right: {
				kind: "count",
				via: { kind: "table-rows", tableId: results.id },
			},
		});
		const list = held(
			readExpression(
				doc,
				registration(
					doc,
					{ entity: "form", uuid: form, slot: "form_display_condition" },
					"count(instance('item-list:results')/results_list/results) > 0",
				),
				env,
			),
		);
		expect(list).toMatchObject({
			left: { via: { kind: "table-rows", tableId: results.id } },
		});
	});

	it("distinguishes a missing suite instance, a rewritten column, a preserved decimal period and a stored-only XML name", () => {
		const doc = visitDoc();
		const form = onlyForm(doc);
		const ref = {
			entity: "form",
			uuid: form,
			slot: "form_display_condition",
		} as const;
		const judge = (tag: string, column: string, condition: string) => {
			const table = wireTable(tag, [{ name: column, type: "text" }]);
			return readExpression(
				doc,
				registration(doc, ref, condition),
				readEnv({ lookup: new Map([[table.id, table]]) }),
			);
		};
		const read = (tag: string, column: string) =>
			`count(instance('item-list:${tag}')/${tag}_list/${tag}[${column} = 'garden']) > 0`;
		expect(judge("meeting.1", "code", read("meeting.1", "code"))).toMatchObject(
			{
				kind: "refused",
				cause: {
					entryId:
						"expressions-and-data/lookup-table-instance-undiscovered-in-suite",
					name: "meeting.1",
				},
			},
		);
		expect(
			judge("zones", "zone.name", read("zones", "zone.name")),
		).toMatchObject({
			kind: "refused",
			cause: {
				entryId: "expressions-and-data/dotted-column-interpolated-in-suite",
				name: "zone.name",
			},
		});
		expect(judge("zones", "zone.1", read("zones", "zone.1"))).toMatchObject({
			kind: "bound",
			equal: true,
		});
		expect(judge("zones", "名前", read("zones", "名前"))).toMatchObject({
			kind: "refused",
			cause: {
				entryId:
					"expressions-and-data/tag-or-field-name-core-s-xpath-lexer-does-not-read-as-a-name-any",
				name: "名前",
			},
		});
		expect(
			judge(
				"zones",
				"zone.name",
				`#case/age > 1 and ${read("zones", "zone.name")}`,
			),
		).toMatchObject({
			kind: "refused",
			cause: {
				entryId: "expressions-and-data/dotted-column-interpolated-in-suite",
				name: "zone.name",
			},
		});
		expect(
			judge("zones", "zone.name", "'zone.name' = 'zone.name'"),
		).toMatchObject({ kind: "bound", equal: true });
		// HQ checks a form's display condition with js-xpath, whose names are
		// unaccented: a Greek tag or column fails HQ's own build there.
		for (const [tag, column, name] of [
			["ζωνες", "zone.1", "ζωνες"],
			["zones", "région", "région"],
		])
			expect(judge(tag, column, read(tag, column))).toMatchObject({
				kind: "refused",
				cause: {
					entryId:
						"expressions-and-data/non-ascii-lookup-name-in-a-condition-hq-checks",
					name,
				},
			});
	});

	it("reads an instance declared from jr://fixture/user-groups as the groups read Nova holds later", () => {
		const doc = visitDoc();
		const ref = {
			entity: "field",
			uuid: fieldNamed(doc, "q1"),
			slot: "relevant",
		} as const;
		const pending = registration(
			doc,
			ref,
			"count(instance('usergroups')/groups/group) > 0",
		);
		const judgment = readExpression(
			doc,
			pending,
			readEnv({
				instanceSources: new Map([
					[
						onlyForm(doc),
						new Map([["usergroups", "jr://fixture/user-groups"]]),
					],
				]),
			}),
		);
		expect(held(judgment)).toMatchObject({
			kind: "gt",
			left: { kind: "count", via: { kind: "worker-groups", where: [] } },
		});
	});

	it("reads what Core's own spelling of normalize-space prints back", () => {
		const doc = visitDoc();
		const ref = {
			entity: "field",
			uuid: fieldNamed(doc, "q1"),
			slot: "relevant",
		} as const;
		const tree = held(
			readExpression(
				doc,
				registration(
					doc,
					ref,
					"replace(replace(/data/q1, '[ \\t\\r\\n]+', ' '), '^ | $', '') = 'a'",
				),
				readEnv(),
			),
		);
		expect(tree).toMatchObject({
			kind: "eq",
			left: { kind: "call", fn: "normalize-space" },
		});
	});
});

/** A survey whose `checked` validates against the entries of the repeat `r`,
 *  and whose `nova_constraint_checked_2` is a Hidden Value of the author's. */
function countsDoc() {
	return buildDoc({
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
								label: "Rounds",
								repeat_mode: "user_controlled",
								children: [f({ kind: "text", id: "k", label: "Kind" })],
							}),
							// The document a reading judges a slot against holds the
							// slot's tree, so the allocator plans the count's node.
							f({
								kind: "text",
								id: "checked",
								label: "Checked",
								validate: "count(#form/r/k[. = 'x']) > 0",
							}),
							f({
								kind: "hidden",
								id: "nova_constraint_checked_2",
								calculate: "1",
							}),
						],
					},
				],
			},
		],
	});
}

/** The env of a form whose reader set aside `values`, by absolute path. */
function setAside(
	doc: ReturnType<typeof countsDoc>,
	values: Record<string, string>,
) {
	return readEnv({
		generatedValues: new Map([
			[
				onlyForm(doc),
				new Map(
					Object.entries(values).map(([path, calculate]) => [
						path,
						{ purpose: "constraint-count" as const, calculate },
					]),
				),
			],
		]),
	});
}

describe("a read of a generated node the form reader set aside", () => {
	const count = "count(/data/r/k[. = 'x'])";

	it("binds the node's calculate in place of the read, under the source's own name", () => {
		const doc = countsDoc();
		const ref = {
			entity: "field",
			uuid: fieldNamed(doc, "checked"),
			slot: "validate",
		} as const;
		const tree = held(
			readExpression(
				doc,
				registration(doc, ref, "/data/nova_constraint_checked_0 > 0"),
				setAside(doc, { "/data/nova_constraint_checked_0": count }),
			),
		);
		expect(tree).toMatchObject({ kind: "gt", left: { kind: "count" } });
		// A source that named the node with another suffix binds the same
		// calculate: the reader keys it by the path the source wrote.
		const suffixed = readExpression(
			doc,
			registration(doc, ref, "/data/nova_constraint_checked_0_1 > 0"),
			setAside(doc, { "/data/nova_constraint_checked_0_1": count }),
		);
		expect(suffixed).toMatchObject({
			kind: "bound",
			candidate: { kind: "gt", left: { kind: "count" } },
		});
	});

	it("binds a node the document holds as the author's Hidden Value", () => {
		const doc = countsDoc();
		const ref = {
			entity: "field",
			uuid: fieldNamed(doc, "checked"),
			slot: "validate",
		} as const;
		const tree = held(
			readExpression(
				doc,
				registration(doc, ref, "/data/nova_constraint_checked_2 > 0"),
				setAside(doc, { "/data/nova_constraint_checked_2": count }),
			),
		);
		expect(tree).toMatchObject({
			kind: "gt",
			left: {
				kind: "term",
				term: {
					kind: "field",
					uuid: fieldNamed(doc, "nova_constraint_checked_2"),
				},
			},
		});
	});

	it("binds a calculate that reads its own node without expanding it again", () => {
		const doc = countsDoc();
		const ref = {
			entity: "field",
			uuid: fieldNamed(doc, "checked"),
			slot: "validate",
		} as const;
		const judgment = readExpression(
			doc,
			registration(doc, ref, "/data/nova_constraint_checked_0 > 0"),
			setAside(doc, {
				"/data/nova_constraint_checked_0":
					"/data/nova_constraint_checked_0 + 1",
			}),
		);
		expect(judgment.kind).toBe("refused");
	});
});

describe("a form whose query repeat takes the count placement", () => {
	it("reads back a read of the repeat's rows through the source's own names", async () => {
		const doc = buildDoc({
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Survey",
							type: "survey",
							fields: [
								f({ kind: "text", id: "pick", label: "Pick" }),
								f({
									kind: "repeat",
									id: "r",
									label: "Rounds",
									repeat_mode: "query_bound",
									data_source: { ids_query: "#form/pick" },
									children: [
										f({ kind: "text", id: "answer", label: "Answer" }),
									],
								} as FieldSpec),
								f({
									kind: "hidden",
									id: "answered",
									calculate: "count(#form/r/answer)",
								}),
							],
						},
					],
				},
			],
		});
		const reading = await readEmission(doc, () => undefined);
		const answered = fieldNamed(doc, "answered");
		const slot = reading.slots.find(
			(one) =>
				one.registration.ref.entity === "field" &&
				one.registration.ref.uuid === answered &&
				one.registration.ref.slot === "calculate",
		);
		expect(slot?.registration.text).toBe("count(/data/r/item/answer)");
		const judged = judgeReadBack(doc, reading).find(
			(one) => one.stored.ref.uuid === answered,
		);
		expect(judged?.verdict).toEqual({ kind: "same" });
	});
});

/** The case operation slots of a document's forms, and a form's own open
 *  and close conditions, which a Save to Case block can hold. */
function caseOperationSlot(ref: SlotContextRef): boolean {
	return (
		ref.entity === "form" &&
		(ref.slot.startsWith("case_operation_") ||
			ref.slot === "form_open_condition" ||
			ref.slot === "form_close_condition")
	);
}

describe("a Save to Case block's expressions, read where Nova writes them", () => {
	// Each block prints its values, conditions and targets with the bindings
	// of the node they stand in: the case read from the block's own case
	// (the form's chosen case through its own datum, which is
	// `case_id_<type>` in a child menu), an earlier create's id and an
	// answer of the block's repeat through `current()`. Printed at the
	// form's level they would differ. Every text binds, the reads through
	// `current()` and the presence tests of related cases included, and each
	// slot reads back as the canonical tree the document stores, unless the
	// read document cannot hold that tree (a fact of the case catalog no
	// export carries, such as a type's parent).
	for (const scenario of operationScenarios)
		it(`holds every case operation expression of the ${scenario} program`, async () => {
			const doc = caseOperationFixture(scenario);
			const reading = await readEmission(doc, recordDialectRoundTrip);
			const slots = reading.slots.filter((slot) =>
				caseOperationSlot(slot.registration.ref),
			);
			for (const slot of slots)
				expect(
					slot.outcome.claim?.detail.reason ?? "",
					`${slot.registration.ref.slot}: ${slot.registration.text}`,
				).not.toMatch(/^(parse|differs):/u);
			// The slots the export writes a text for; a stored tree whose
			// print is no text (an owner of the acting user, written as the
			// block's default) is a choice of the reading's assembly.
			const written = new Set(
				slots.map((slot) => expressionSlotKey(slot.registration.ref)),
			);
			const judged = judgeReadBack(doc, reading).filter(
				(one) =>
					caseOperationSlot(one.stored.ref) && written.has(one.stored.key),
			);
			for (const one of judged)
				expect(
					one.verdict.kind,
					`${JSON.stringify(one.stored.ref)}: ${JSON.stringify(one.verdict)}`,
				).not.toBe("differs");
			expect(
				reading.closed.findings.filter((finding) =>
					(finding.detail as { reason?: string }).reason?.startsWith("parse:"),
				),
			).toEqual([]);
		});

	it("reads a value of the child menu's chosen case through its own datum", async () => {
		const doc = caseOperationFixture("nested");
		const reading = await readEmission(doc, recordDialectRoundTrip);
		const own = reading.slots.find(
			(slot) =>
				caseOperationSlot(slot.registration.ref) &&
				slot.registration.text.endsWith("case_id_patient]/case_name"),
		);
		expect(own?.outcome.expression).toEqual({
			kind: "term",
			term: { kind: "prop", caseType: "patient", property: "case_name" },
		});
	});
});

describe("a stored date and time read in the device's own date and clock", () => {
	// Nova reads date-and-time text Core parses (a starting value cast into
	// a date and time, a `date()` or `format-date` operand) through
	// `instant.ts::deviceInstantText`; the form reads back to the same
	// document.
	it("reads back a starting value, a date() and a format-date over a stored moment", async () => {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "seen", label: "Seen", data_type: "datetime" }],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [
								f({
									kind: "datetime",
									id: "start",
									label: "Start",
									default_value: "#patient/seen",
									caseWrite: { caseType: "patient", property: "seen" },
								}),
								f({
									kind: "hidden",
									id: "day",
									calculate: "date(#patient/seen)",
								}),
								f({
									kind: "hidden",
									id: "shown",
									calculate: "format-date(#patient/seen, '%Y-%m-%d')",
								}),
							],
						},
					],
				},
			],
		});
		const reading = await readEmission(doc, recordDialectRoundTrip);
		const wrapped = (id: string, slot: string) => {
			const uuid = fieldNamed(doc, id);
			const one = reading.slots.find(
				(candidate) =>
					candidate.registration.ref.entity === "field" &&
					candidate.registration.ref.uuid === uuid &&
					candidate.registration.ref.slot === slot,
			);
			// The source holds the device's reading of the text, which the
			// fold reads back to the operand.
			expect(one?.registration.text, `${id} ${slot}`).toContain(", 10, 11)");
			expect(one?.outcome.expression, `${id} ${slot}`).toBeDefined();
			return uuid;
		};
		const slots = [
			wrapped("start", "default_value"),
			wrapped("day", "calculate"),
			wrapped("shown", "calculate"),
		];
		const judged = judgeReadBack(doc, reading).filter((one) =>
			slots.includes(one.stored.ref.uuid as (typeof slots)[number]),
		);
		expect(judged).toHaveLength(3);
		for (const one of judged)
			expect(one.verdict, `${one.stored.ref.slot}`).toEqual({ kind: "same" });
	});
});

describe("a form slot read by the whole expression stage", () => {
	const relevantOf = (doc: BlueprintDoc, id: string): SlotContextRef => ({
		entity: "field",
		uuid: fieldNamed(doc, id),
		slot: "relevant",
	});
	/** The entries a registration's claims name, its surface uses' among them. */
	const entriesOf = (reading: ReturnType<typeof readExpressions>, at = 0) =>
		reading.claims
			.filter((claim) => claim.source === at)
			.map((claim) => claim.entryId);
	/** The refusal a registration claims: the claim that gives a reason. */
	const refusalOf = (reading: ReturnType<typeof readExpressions>, at = 0) =>
		reading.claims.filter(
			(claim) => claim.source === at && claim.detail.reason !== undefined,
		);

	it("reads an own-case walk at depth 2 as the case two above the form's", () => {
		const doc = buildDoc({
			caseTypes: [
				{ name: "district", properties: [{ name: "region", label: "Region" }] },
				{ name: "household", parent_type: "district", properties: [] },
				{ name: "patient", parent_type: "household", properties: [] },
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "q1", label: "Q1" })],
						},
					],
				},
			],
		});
		const reading = readExpressions(
			doc,
			[
				registration(
					doc,
					relevantOf(doc, "q1"),
					`instance('casedb')/casedb/case[@case_id = instance('casedb')/casedb/case[@case_id = ${OWN}/index/parent]/index/parent]/region = 'x'`,
				),
			],
			readEnv(),
		);
		expect(reading.bound[0]).toMatchObject({
			kind: "eq",
			left: {
				kind: "term",
				term: { kind: "form-case", caseType: "district", property: "region" },
			},
		});
	});

	it("reads a walk keyed on a child menu's own datum as the form's case, and one keyed on the root's as no own-case read", () => {
		const doc = buildDoc(
			{
				caseTypes: [
					{ name: "household", properties: [] },
					{
						name: "patient",
						parent_type: "household",
						properties: [{ name: "age", label: "Age", data_type: "int" }],
					},
				],
				modules: [
					{
						uuid: "own-datum-root",
						name: "Households",
						caseType: "household",
						forms: [
							{
								name: "Household visit",
								type: "followup",
								fields: [f({ kind: "text", id: "h1", label: "H1" })],
							},
						],
					},
					{
						uuid: "own-datum-child",
						name: "Patients",
						caseType: "patient",
						parentCaseModuleUuid: "own-datum-root",
						forms: [
							{
								name: "Patient visit",
								type: "followup",
								fields: [f({ kind: "text", id: "q1", label: "Q1" })],
							},
						],
					},
				],
			},
			(draft) => {
				const [root, child] = draft.moduleOrder;
				const childModule =
					child === undefined ? undefined : draft.modules[child];
				if (root !== undefined && childModule !== undefined)
					childModule.parentModuleUuid = root;
			},
		);
		const walk = (datum: string) =>
			`instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/${datum}]/age > 5`;
		const reading = readExpressions(
			doc,
			[
				registration(doc, relevantOf(doc, "q1"), walk("case_id_patient")),
				registration(doc, relevantOf(doc, "q1"), walk("case_id")),
			],
			readEnv(),
		);
		const ownAge = {
			kind: "term",
			term: { kind: "form-case", caseType: "patient", property: "age" },
		};
		expect(reading.bound[0]).toMatchObject({ kind: "gt", left: ownAge });
		expect(reading.bound[1]).not.toMatchObject({ kind: "gt", left: ownAge });
	});

	it("claims the invalid-XPath entry for a hashtag left in a real attribute", () => {
		const doc = visitDoc();
		const reading = readExpressions(
			doc,
			[registration(doc, relevantOf(doc, "q1"), "#form/q1 = 'a'")],
			readEnv(),
		);
		expect(reading.bound[0]).toBeUndefined();
		expect(reading.circumstances).toEqual([]);
		expect(refusalOf(reading).map((claim) => claim.entryId)).toEqual([
			"expressions-and-data/an-invalid-xpath-in-a-bind-attribute",
		]);
	});

	it("leaves a datum read of a form whose entry facts differ to the form's own finding", () => {
		const doc = visitDoc();
		const pending = registration(
			doc,
			relevantOf(doc, "q1"),
			"instance('commcaresession')/session/data/case_id_new_patient_0 = 'x'",
		);
		const listed = readExpressions(
			doc,
			[pending],
			readEnv({ entryFactsRefused: new Set([onlyForm(doc)]) }),
		);
		expect(listed.ownerless).toEqual([0]);
		expect(listed.claims.filter((claim) => claim.source === 0)).toEqual([]);
		expect(listed.circumstances).toEqual([]);
		const unlisted = readExpressions(doc, [pending], readEnv());
		expect(unlisted.ownerless).toEqual([]);
		expect(refusalOf(unlisted).map((claim) => claim.entryId)).toEqual([
			"expressions-and-data/session-data-datum-the-entry-does-not-supply",
		]);
	});

	it("claims a required of true() as an always-required question", () => {
		const doc = visitDoc();
		const reading = readExpressions(
			doc,
			[
				registration(
					doc,
					{ entity: "field", uuid: fieldNamed(doc, "q1"), slot: "required" },
					"true()",
				),
			],
			readEnv(),
		);
		expect(reading.bound[0]).toEqual({ kind: "match-all" });
		expect(entriesOf(reading)).toContain("questions/bind-required-true");
		expect(entriesOf(reading)).not.toContain("questions/bind-required-expr");
	});

	it("reads an output of one answer as the reference part", () => {
		const doc = buildDoc({
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Survey",
							type: "survey",
							fields: [
								f({ kind: "text", id: "q1", label: "Q1" }),
								f({
									kind: "text",
									id: "q2",
									label: {
										parts: [
											{ kind: "text", text: "You said " },
											{
												kind: "value",
												expression: {
													kind: "term",
													term: { kind: "literal", value: "" },
												},
											},
										],
									},
								}),
							],
						},
					],
				},
			],
		});
		const q2 = fieldNamed(doc, "q2");
		const reading = readExpressions(
			doc,
			[
				registration(
					doc,
					{ entity: "field", uuid: q2, slot: "label" },
					"/data/q1",
				),
			],
			readEnv(),
		);
		expect(entriesOf(reading)).toContain(
			"questions/output-value-of-a-question-case-or-user-reference",
		);
		expect(entriesOf(reading)).not.toContain(
			"questions/output-value-any-other-expression",
		);
		const label = reading.doc.fields[q2] as { label?: ProseTemplate };
		expect(label.label?.parts[1]?.kind).not.toBe("value");
	});

	describe("a form's display condition that reads the case", () => {
		/** A menu that lists a registration beside a follow-up, so its screen
		 *  chooses no case before it lists them. */
		function formsFirstDoc() {
			return buildDoc({
				caseTypes: [
					{
						name: "patient",
						properties: [{ name: "age", label: "Age", data_type: "int" }],
					},
				],
				modules: [
					{
						name: "Patients",
						caseType: "patient",
						forms: [
							{
								name: "Register",
								type: "registration",
								fields: [
									f({
										kind: "text",
										id: "name",
										label: "Name",
										caseWrite: { caseType: "patient", property: "case_name" },
									}),
								],
							},
							{
								name: "Visit",
								type: "followup",
								fields: [f({ kind: "text", id: "q1", label: "Q1" })],
							},
						],
					},
				],
			});
		}
		const visitOf = (doc: BlueprintDoc): SlotContextRef => {
			const moduleUuid = doc.moduleOrder[0] as (typeof doc.moduleOrder)[number];
			const visit = (doc.formOrder[moduleUuid] ?? []).find(
				(form) => doc.forms[form]?.name === "Visit",
			);
			if (visit === undefined) throw new Error("No visit form.");
			return { entity: "form", uuid: visit, slot: "form_display_condition" };
		};

		for (const attribute of ["status", "case_id", "case_type", "owner_id"])
			it(`refuses #case/@${attribute}, which HQ's build cannot read, before it interpolates the text`, () => {
				const doc = visitDoc();
				const ref: SlotContextRef = {
					entity: "form",
					uuid: onlyForm(doc),
					slot: "form_display_condition",
				};
				const reading = readExpressions(
					doc,
					[registration(doc, ref, `#case/@${attribute} = 'x'`)],
					readEnv(),
				);
				expect(reading.bound[0]).toBeUndefined();
				expect(reading.circumstances).toEqual([]);
				expect(
					refusalOf(reading).map((claim) => [
						claim.entryId,
						claim.detail.reason,
					]),
				).toEqual([
					[
						"forms-and-case-writes/form-filter-reading-case-status-case-id-case-type-owner-id",
						"parse:case-attribute-hashtag",
					],
				]);
			});

		it("reads a case property through #case as no attribute read", () => {
			const doc = visitDoc();
			const ref: SlotContextRef = {
				entity: "form",
				uuid: onlyForm(doc),
				slot: "form_display_condition",
			};
			const reading = readExpressions(
				doc,
				[registration(doc, ref, "#case/age > 3")],
				readEnv(),
			);
			expect(entriesOf(reading)).not.toContain(
				"forms-and-case-writes/form-filter-reading-case-status-case-id-case-type-owner-id",
			);
			expect(reading.bound[0]).toBeDefined();
		});

		it("refuses a read of the case in a menu not every form of which requires a case under HQ's own build error", () => {
			// HQ's build refuses it (`suite_xml/sections/menus.py`,
			// `CaseXPathValidationError`), the form's own entry; the screen's
			// wider entry is for what HQ builds.
			const doc = formsFirstDoc();
			const reading = readExpressions(
				doc,
				[registration(doc, visitOf(doc), "#case/age > 3")],
				readEnv(),
			);
			expect(reading.bound[0]).toBeUndefined();
			expect(refusalOf(reading).map((claim) => claim.entryId)).toEqual([
				"forms-and-case-writes/form-filter-referencing-the-case-database-other-than-through",
			]);
		});
	});

	describe("a read of a Search field in a form that opens through no inline search", () => {
		/** A menu whose forms read its search, a child menu under it, and a
		 *  menu whose search runs before its list. */
		function searchesDoc() {
			const district = testUuid("form-reads-district");
			const inline = caseListConfig([{ field: "case_name", header: "Name" }]);
			inline.searchInputs = [
				simpleSearchInputDef(
					district,
					"district",
					"District",
					"text",
					"district",
				),
			];
			const remote = caseListConfig([{ field: "case_name", header: "Name" }]);
			remote.searchInputs = [
				simpleSearchInputDef(
					testUuid("form-reads-remote"),
					"district",
					"District",
					"text",
					"district",
				),
			];
			return buildDoc(
				{
					caseTypes: [
						{
							name: "patient",
							properties: [{ name: "district", label: "District" }],
						},
					],
					modules: [
						{
							uuid: "form-reads-find",
							name: "Find",
							caseType: "patient",
							caseListConfig: inline,
							caseSearchConfig: { formsReadSearch: true },
							forms: [
								{
									name: "Check in",
									type: "followup",
									fields: [f({ kind: "text", id: "seen", label: "Seen" })],
								},
							],
						},
						{
							uuid: "form-reads-child",
							name: "Follow up",
							caseType: "patient",
							parentCaseModuleUuid: "form-reads-find",
							forms: [
								{
									name: "Child visit",
									type: "followup",
									fields: [f({ kind: "text", id: "child_q", label: "Q" })],
								},
							],
						},
						{
							uuid: "form-reads-remote-menu",
							name: "Lookup",
							caseType: "patient",
							caseListConfig: remote,
							caseSearchConfig: {},
							forms: [
								{
									name: "Lookup visit",
									type: "followup",
									fields: [f({ kind: "text", id: "remote_q", label: "Q" })],
								},
							],
						},
					],
				},
				(draft) => {
					const [find, child] = draft.moduleOrder;
					const childModule =
						child === undefined ? undefined : draft.modules[child];
					if (find !== undefined && childModule !== undefined)
						childModule.parentModuleUuid = find;
				},
			);
		}
		const READ =
			"instance('search-input:results')/input/field[@name = 'district'] = 'north'";

		it("claims the child-menu entry in a child menu of an inline-search menu", () => {
			const doc = searchesDoc();
			const reading = readExpressions(
				doc,
				[registration(doc, relevantOf(doc, "child_q"), READ)],
				readEnv(),
			);
			expect(reading.bound[0]).toBeUndefined();
			expect(refusalOf(reading).map((claim) => claim.entryId)).toEqual([
				"expressions-and-data/search-input-read-in-the-forms-of-a-child-menu-of-an-inline-search-menu",
			]);
		});

		it("claims the reached-through-a-search entry in a form after a search that is not inline", () => {
			const doc = searchesDoc();
			const reading = readExpressions(
				doc,
				[registration(doc, relevantOf(doc, "remote_q"), READ)],
				readEnv(),
			);
			expect(reading.bound[0]).toBeUndefined();
			expect(refusalOf(reading).map((claim) => claim.entryId)).toEqual([
				"expressions-and-data/search-input-read-in-form-expressions-reached-through-a-search",
			]);
		});
	});
});
