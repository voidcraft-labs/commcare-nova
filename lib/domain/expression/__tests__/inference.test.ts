// Hidden Value and case-property inference (`inference.ts`): the fixpoint's
// data types, what Core holds for each Hidden Value, clock loss, and the
// writer opinions the agreement rule reads. Each refusal-shaped fact sits
// beside the neighbour that differs from it in one fact.

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	type FieldSpec,
	f,
} from "@/lib/__tests__/docHelpers";
import { runValidation } from "@/lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutation } from "@/lib/doc/mutations";
import type { BlueprintDoc, CaseOperation } from "@/lib/domain";
import { fieldValueType } from "../../fieldValueType";
import {
	hiddenWriterVerdicts,
	inferExpressionTypes,
	inferenceFingerprint,
	shareInferenceAcrossMove,
} from "../inference";

const REGISTER = testUuid("inference-register");
const FOLLOW_UP = testUuid("inference-follow-up");

function doc(args: {
	readonly register?: FieldSpec[];
	readonly followUp?: FieldSpec[];
	readonly properties?: NonNullable<
		NonNullable<Parameters<typeof buildDoc>[0]>["caseTypes"]
	>[number]["properties"];
}): BlueprintDoc {
	return buildDoc({
		appName: "Inference",
		caseTypes: [{ name: "patient", properties: args.properties ?? [] }],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: REGISTER,
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "name",
								label: "Name",
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							f({ kind: "text", id: "flag", label: "Flag" }),
							...(args.register ?? []),
						],
					},
					{
						uuid: FOLLOW_UP,
						name: "Visit",
						type: "followup",
						fields: [
							f({ kind: "text", id: "note", label: "Note" }),
							...(args.followUp ?? []),
						],
					},
				],
			},
		],
	});
}
const uuid = (name: string) => testUuid(`inference-${name}`);
const hidden = (
	name: string,
	value: { calculate: string } | { default_value: string },
	property?: string,
): FieldSpec =>
	f({
		uuid: uuid(name),
		kind: "hidden",
		id: name,
		...value,
		...(property === undefined
			? {}
			: { caseWrite: { caseType: "patient", property } }),
	});
/** The follow-up form's one update operation, with these writes. */
function withFollowUpWrites(
	built: BlueprintDoc,
	writes: CaseOperation["writes"],
): BlueprintDoc {
	built.forms[FOLLOW_UP].caseOperations = [
		{
			uuid: uuid("operation"),
			id: "update_patient",
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
			writes,
		},
	];
	return built;
}
const literalValue = (value: string | number) =>
	({ kind: "term", term: { kind: "literal", value } }) as const;
const fieldValue = (name: string) =>
	({ kind: "term", term: { kind: "field", uuid: uuid(name) } }) as const;
const validate = (built: BlueprintDoc) =>
	runValidation(built, LOOKUP_CONTEXT_UNAVAILABLE);
function propertyType(built: BlueprintDoc, property: string) {
	return inferExpressionTypes(built)
		.caseTypes.find((type) => type.name === "patient")
		?.properties.find((entry) => entry.name === property)?.data_type;
}

describe("Hidden Value data types", () => {
	it("types a Hidden Value from its expression in its own slot", () => {
		const built = doc({
			register: [
				hidden("sum", { calculate: "#form/count + 1" }),
				f({ kind: "int", id: "count", label: "Count" }),
				hidden("label", { calculate: "concat('a', #form/name)" }),
				hidden("day", { default_value: "today()" }),
				hidden("rounded", { calculate: "round(#form/count div 2)" }),
				hidden("ratio", { calculate: "#form/count * 1.5" }),
			],
		});
		const types = inferExpressionTypes(built).hiddenTypes;
		expect(types.get(uuid("sum"))).toBe("int");
		expect(types.get(uuid("label"))).toBe("text");
		expect(types.get(uuid("day"))).toBe("date");
		// An integral function stores IntegerData (Recalculate.wrapData).
		expect(types.get(uuid("rounded"))).toBe("int");
		expect(types.get(uuid("ratio"))).toBe("decimal");
	});

	it("resolves a chain through a property its question types", () => {
		const built = doc({
			register: [
				f({
					kind: "date",
					id: "visit",
					label: "Visit",
					caseWrite: { caseType: "patient", property: "visit_date" },
				}),
			],
			followUp: [
				hidden("copy", { calculate: "#patient/visit_date" }, "last_seen"),
				hidden("again", { calculate: "#patient/last_seen" }, "seen_again"),
				// Reads only an answer, so it is typed again once "again" is.
				hidden("after", { calculate: "#form/again" }),
			],
		});
		expect(propertyType(built, "last_seen")).toBe("date");
		expect(propertyType(built, "seen_again")).toBe("date");
		expect(inferExpressionTypes(built).hiddenTypes.get(uuid("again"))).toBe(
			"date",
		);
		expect(inferExpressionTypes(built).hiddenTypes.get(uuid("after"))).toBe(
			"date",
		);
	});

	it("settles a long chain of operations and Hidden Values that each copy the one before", () => {
		// Each link needs its own pass, and an operation's write reaches a
		// Hidden Value's read one pass later, so the chain takes about two
		// passes per link before it settles.
		const links = 24;
		const hiddenLinks: FieldSpec[] = [];
		const writes: NonNullable<CaseOperation["writes"]> = [
			{ property: "step_0", value: literalValue(1) },
		];
		for (let index = 1; index <= links; index += 1) {
			hiddenLinks.push(
				hidden(`link_${index}`, {
					calculate: `#patient/step_${index - 1}`,
				}),
			);
			writes.push({
				property: `step_${index}`,
				value: fieldValue(`link_${index}`),
			});
		}
		const built = withFollowUpWrites(doc({ followUp: hiddenLinks }), writes);
		const inference = inferExpressionTypes(built);
		expect(propertyType(built, `step_${links}`)).toBe("int");
		expect(inference.hiddenTypes.get(uuid(`link_${links}`))).toBe("int");
	});

	it("leaves a self-copying writer and a copy cycle unknown", () => {
		const built = doc({
			followUp: [
				hidden("total", { calculate: "#patient/total + 1" }, "total"),
				hidden("left", { calculate: "#patient/right" }, "left"),
				hidden("right", { calculate: "#patient/left" }, "right"),
			],
		});
		expect(propertyType(built, "total")).toBeUndefined();
		expect(propertyType(built, "left")).toBeUndefined();
		expect(propertyType(built, "right")).toBeUndefined();
		expect(inferExpressionTypes(built).hiddenTypes.has(uuid("total"))).toBe(
			false,
		);
	});

	it("gives a writer its destination's type where its expression agrees or is unknown", () => {
		const built = doc({
			register: [
				f({ kind: "datetime", id: "seen", label: "Seen" }),
				hidden(
					"maybe",
					{ calculate: "if(#form/flag = 'yes', #form/seen, '')" },
					"seen_at",
				),
				hidden("count_copy", { calculate: "1" }, "amount"),
				f({
					kind: "decimal",
					id: "amount",
					label: "Amount",
					caseWrite: { caseType: "patient", property: "amount" },
				}),
			],
		});
		const inference = inferExpressionTypes(built);
		// The branches disagree as a whole (date and time against text), so
		// the expression is unknown; the destination decides.
		expect(propertyType(built, "seen_at")).toBe("datetime");
		expect(inference.hiddenTypes.get(uuid("maybe"))).toBe("datetime");
		// An integer is storage-assignable to the decimal its question saves.
		expect(inference.hiddenTypes.get(uuid("count_copy"))).toBe("decimal");
	});

	it("keeps a Hidden Value that writes nothing on a string bind whatever it infers", () => {
		const built = doc({
			register: [hidden("stamp", { calculate: "now()" })],
		});
		const inference = inferExpressionTypes(built);
		expect(inference.hiddenTypes.get(uuid("stamp"))).toBe("datetime");
		expect(
			fieldValueType(built.fields[uuid("stamp")], inference.caseTypes),
		).toBeUndefined();
	});
});

describe("Hidden Value writer opinions", () => {
	it("leaves a Hidden-only disagreement unknown and reports each writer", () => {
		const built = doc({
			register: [hidden("number", { calculate: "1" }, "score")],
			followUp: [hidden("words", { calculate: "'high'" }, "score")],
		});
		expect(propertyType(built, "score")).toBeUndefined();
		const verdicts = hiddenWriterVerdicts(built);
		expect(
			verdicts.map((verdict) => [
				verdict.writer.field,
				verdict.findings.map((finding) => finding.reason),
			]),
		).toEqual([
			[uuid("number"), ["hidden-disagreement"]],
			[uuid("words"), ["hidden-disagreement"]],
		]);
	});

	it("agrees on decimal for a Hidden-only integer and decimal pair", () => {
		const built = doc({
			register: [hidden("whole", { calculate: "2" }, "weight")],
			followUp: [hidden("part", { calculate: "2.5" }, "weight")],
		});
		expect(propertyType(built, "weight")).toBe("decimal");
		expect(
			inferExpressionTypes(built).propertyTypes.get("patient")?.get("weight"),
		).toEqual({
			type: "decimal",
			origin: { kind: "hidden", fields: [uuid("whole"), uuid("part")] },
		});
		expect(hiddenWriterVerdicts(built)).toEqual([]);
	});

	it("holds a Hidden writer to the type its question sets", () => {
		const date = f({
			uuid: uuid("visit"),
			kind: "date",
			id: "visit",
			label: "Visit",
			caseWrite: { caseType: "patient", property: "visit_date" },
		});
		const refused = doc({
			register: [
				hidden("text", { calculate: "concat('not', '-a-date')" }, "visit_date"),
			],
			followUp: [date],
		});
		const verdicts = hiddenWriterVerdicts(refused);
		expect(verdicts).toHaveLength(1);
		expect(verdicts[0].writer.field).toBe(uuid("text"));
		expect(verdicts[0].property).toEqual({
			type: "date",
			origin: { kind: "field", field: uuid("visit") },
		});
		expect(verdicts[0].findings).toEqual([
			{ reason: "type", path: [], type: "text" },
		]);
		// Writer agreement does not move the property's type.
		expect(propertyType(refused, "visit_date")).toBe("date");
		const accepted = doc({
			register: [hidden("day", { calculate: "today()" }, "visit_date")],
			followUp: [date],
		});
		expect(hiddenWriterVerdicts(accepted)).toEqual([]);
		const blank = doc({
			register: [
				f({ kind: "date", id: "seen", label: "Seen" }),
				hidden(
					"blank",
					{ calculate: "if(#form/flag = 'yes', '', #form/seen)" },
					"visit_date",
				),
			],
			followUp: [date],
		});
		expect(hiddenWriterVerdicts(blank)).toEqual([]);
	});

	it("gives a preloaded starting value no opinion, since the preload overwrites it", () => {
		const date = f({
			kind: "date",
			id: "visit",
			label: "Visit",
			caseWrite: { caseType: "patient", property: "visit_date" },
		});
		const preloaded = doc({
			register: [date],
			followUp: [
				hidden("start", { default_value: "'not-a-date'" }, "visit_date"),
			],
		});
		const inference = inferExpressionTypes(preloaded);
		expect(inference.hiddenOpinions.get(uuid("start"))).toMatchObject({
			preloadedDefault: true,
			opinion: undefined,
		});
		expect(inference.writerOpinions.get("patient")?.get("visit_date")).toEqual(
			new Set(["date"]),
		);
		expect(hiddenWriterVerdicts(preloaded)).toEqual([]);
		const calculated = doc({
			register: [date],
			followUp: [hidden("start", { calculate: "'not-a-date'" }, "visit_date")],
		});
		expect(hiddenWriterVerdicts(calculated)[0]?.findings).toEqual([
			{ reason: "type", path: [], type: "text" },
		]);
	});
});

describe("writer opinions beside a case operation's write", () => {
	const status = f({
		kind: "single_select",
		id: "stage",
		label: "Stage",
		caseWrite: { caseType: "patient", property: "stage" },
		options: [
			{ value: "open", label: "Open" },
			{ value: "closed", label: "Closed" },
		],
	});
	const amount = f({
		kind: "decimal",
		id: "amount",
		label: "Amount",
		caseWrite: { caseType: "patient", property: "amount" },
	});
	const properties = [
		{ name: "stage", label: "Stage" },
		{ name: "amount", label: "Amount" },
	];
	const conflicts = (built: BlueprintDoc) =>
		validate(built).filter(
			(error) => error.code === "CASE_OPERATION_EXPRESSION_TYPE",
		);
	const mismatches = (built: BlueprintDoc) =>
		validate(built)
			.filter((error) => error.code === "HIDDEN_VALUE_WRITER_TYPE_MISMATCH")
			.map((error) => error.location.fieldUuid);

	it("counts a Hidden Value's text that a choice property stores as that choice type", () => {
		const agreeing = withFollowUpWrites(
			doc({
				register: [status],
				properties,
				followUp: [hidden("closing", { calculate: "'closed'" }, "stage")],
			}),
			[{ property: "stage", value: literalValue("open") }],
		);
		expect(
			inferExpressionTypes(agreeing)
				.writerOpinions.get("patient")
				?.get("stage"),
		).toEqual(new Set(["single_select"]));
		expect(validate(agreeing)).toEqual([]);
		const disagreeing = withFollowUpWrites(
			doc({
				register: [status],
				properties,
				followUp: [hidden("closing", { calculate: "today()" }, "stage")],
			}),
			[{ property: "stage", value: literalValue("open") }],
		);
		// The Hidden Value that does not fit is its own finding; the operation
		// beside it writes a fitting value and stays admitted.
		expect(conflicts(disagreeing)).toEqual([]);
		expect(mismatches(disagreeing)).toEqual([uuid("closing")]);
	});

	it("counts a Hidden Value's integer that a decimal property stores as decimal", () => {
		const agreeing = withFollowUpWrites(
			doc({
				register: [amount],
				properties,
				followUp: [hidden("rounded", { calculate: "round(2.5)" }, "amount")],
			}),
			[{ property: "amount", value: literalValue(1.5) }],
		);
		expect(
			inferExpressionTypes(agreeing)
				.writerOpinions.get("patient")
				?.get("amount"),
		).toEqual(new Set(["decimal"]));
		expect(validate(agreeing)).toEqual([]);
		const disagreeing = withFollowUpWrites(
			doc({
				register: [amount],
				properties,
				followUp: [hidden("rounded", { calculate: "'many'" }, "amount")],
			}),
			[{ property: "amount", value: literalValue(1.5) }],
		);
		expect(conflicts(disagreeing)).toEqual([]);
		expect(mismatches(disagreeing)).toEqual([uuid("rounded")]);
	});

	it("refuses only the Hidden Value whose value a declared type does not store", () => {
		const ageProperties = [
			{ name: "age", label: "Age", data_type: "int" as const },
		];
		const withHidden = withFollowUpWrites(
			doc({
				properties: ageProperties,
				followUp: [hidden("age_text", { calculate: "'abc'" }, "age")],
			}),
			[{ property: "age", value: literalValue(5) }],
		);
		expect(
			inferExpressionTypes(withHidden)
				.writerOpinions.get("patient")
				?.get("age"),
		).toEqual(new Set(["int"]));
		expect(validate(withHidden).map((error) => error.code)).toEqual([
			"HIDDEN_VALUE_WRITER_TYPE_MISMATCH",
		]);
		const operationAlone = withFollowUpWrites(
			doc({ properties: ageProperties }),
			[{ property: "age", value: literalValue(5) }],
		);
		expect(validate(operationAlone)).toEqual([]);
	});

	it("keeps a Hidden Value's own type where no fact types the property", () => {
		const raw = doc({
			followUp: [
				hidden("first", { calculate: "'abc'" }, "untyped"),
				hidden("second", { calculate: "today()" }, "untyped"),
			],
		});
		expect(
			inferExpressionTypes(raw).writerOpinions.get("patient")?.get("untyped"),
		).toEqual(new Set(["text", "date"]));
	});
});

describe("what Core holds for a Hidden Value", () => {
	it("follows the source slot: a calculate keeps its result's class, a default the bind's", () => {
		const built = doc({
			register: [
				hidden("calculated", { calculate: "1" }),
				hidden("started", { default_value: "1" }),
				hidden("text", { calculate: "'x'" }),
				hidden("now", { calculate: "now()" }),
				hidden("stamped", { default_value: "now()" }, "stamped_at"),
				f({
					kind: "datetime",
					id: "stamp_question",
					label: "Stamp",
					caseWrite: { caseType: "patient", property: "stamped_at" },
				}),
			],
		});
		const held = inferExpressionTypes(built).hiddenHeld;
		// Recalculate.wrapData stores a number as IntegerData whatever the bind.
		expect(held.get(uuid("calculated"))).toBe("number");
		// SetValueAction casts a default through the bind's StringData.
		expect(held.get(uuid("started"))).toBe("string");
		expect(held.get(uuid("text"))).toBe("string");
		expect(held.get(uuid("now"))).toBe("date");
		// An xsd:dateTime bind casts the default to DateTimeData.
		expect(held.get(uuid("stamped"))).toBe("date");
	});
});

describe("clock loss", () => {
	it("follows now() through two Hidden Values into a date-and-time write", () => {
		const built = doc({
			register: [
				hidden("first", { calculate: "now()" }),
				hidden("second", { calculate: "#form/first" }),
				hidden("saved", { calculate: "#form/second" }, "seen_at"),
				hidden("direct", { calculate: "now()" }, "seen_at"),
			],
			properties: [
				{
					name: "seen_at",
					label: "Seen",
					data_type: "datetime",
				},
			],
		});
		const inference = inferExpressionTypes(built);
		expect([...inference.clockLost].sort()).toEqual(
			[uuid("first"), uuid("second"), uuid("saved")].sort(),
		);
		// A date-and-time bind keeps the clock of now() itself.
		expect(inference.clockLost.has(uuid("direct"))).toBe(false);
		expect(
			hiddenWriterVerdicts(built).map((verdict) => [
				verdict.writer.field,
				verdict.findings,
			]),
		).toEqual([
			[uuid("saved"), [{ reason: "clock-lost", path: [], type: "datetime" }]],
		]);
	});

	it("carries a lost clock through one branch of an if", () => {
		const built = doc({
			register: [
				hidden("first", { calculate: "now()" }),
				hidden(
					"branch",
					{ calculate: "if(#form/flag = 'yes', #form/first, '')" },
					"seen_at",
				),
			],
			properties: [
				{
					name: "seen_at",
					label: "Seen",
					data_type: "datetime",
				},
			],
		});
		expect(inferExpressionTypes(built).clockLost.has(uuid("branch"))).toBe(
			true,
		);
		expect(hiddenWriterVerdicts(built)[0]?.findings).toEqual([
			{ reason: "clock-lost", path: ["if", "then"], type: "datetime" },
		]);
	});

	it("settles a copy cycle with both members' clocks lost", () => {
		const built = doc({
			register: [
				hidden("a", {
					calculate: "if(#form/flag = 'yes', now(), #form/b)",
				}),
				hidden("b", { calculate: "#form/a" }),
			],
		});
		const lost = inferExpressionTypes(built).clockLost;
		expect(lost.has(uuid("a"))).toBe(true);
		expect(lost.has(uuid("b"))).toBe(true);
	});

	it("keeps a copy of date-and-time text and a date its clock or day", () => {
		const built = doc({
			register: [
				f({
					kind: "datetime",
					id: "seen",
					label: "Seen",
					caseWrite: { caseType: "patient", property: "seen" },
				}),
			],
			followUp: [
				// A case property reads as StringData, which never loses a clock.
				hidden("text_copy", { calculate: "#patient/seen" }),
				hidden("day", { calculate: "today()" }),
				hidden("explicit_day", { calculate: "date(now())" }),
			],
		});
		const inference = inferExpressionTypes(built);
		expect(inference.hiddenTypes.get(uuid("text_copy"))).toBe("datetime");
		expect(inference.hiddenHeld.get(uuid("text_copy"))).toBe("string");
		expect(inference.clockLost.size).toBe(0);
	});
	it("holds a preloaded date and time as a date, so a copy under a text bind loses its clock", () => {
		const chain: FieldSpec[] = [
			// No value: the form fills it from the case's date and time.
			f({
				uuid: uuid("carried"),
				kind: "hidden",
				id: "carried",
				caseWrite: { caseType: "patient", property: "seen_at" },
			}),
			hidden("text_copy", { calculate: "#form/carried" }),
			hidden("saved", { calculate: "#form/text_copy" }, "checked_at"),
		];
		const properties = [
			{ name: "seen_at", label: "Seen", data_type: "datetime" as const },
			{ name: "checked_at", label: "Checked", data_type: "datetime" as const },
		];
		const preloaded = doc({ followUp: chain, properties });
		const inference = inferExpressionTypes(preloaded);
		// SetValueAction casts the preload through DateTimeData.
		expect(inference.hiddenHeld.get(uuid("carried"))).toBe("date");
		expect(inference.clockLost.has(uuid("carried"))).toBe(false);
		expect(inference.clockLost.has(uuid("text_copy"))).toBe(true);
		expect(
			hiddenWriterVerdicts(preloaded).map((verdict) => [
				verdict.writer.field,
				verdict.findings,
			]),
		).toEqual([
			[uuid("saved"), [{ reason: "clock-lost", path: [], type: "datetime" }]],
		]);
		// A registration form preloads nothing, so the field stays blank text.
		const blank = doc({ register: chain, properties });
		expect(inferExpressionTypes(blank).hiddenHeld.get(uuid("carried"))).toBe(
			"string",
		);
		expect(inferExpressionTypes(blank).clockLost.size).toBe(0);
		expect(hiddenWriterVerdicts(blank)).toEqual([]);
	});
});

describe("the inference fingerprint", () => {
	it("moves with an inferred fact and stays with an unrelated edit", () => {
		const base = doc({
			register: [hidden("score", { calculate: "1" }, "score")],
		});
		const retyped = doc({
			register: [hidden("score", { calculate: "'high'" }, "score")],
		});
		const relabelled = doc({
			register: [
				hidden("score", { calculate: "1" }, "score"),
				f({ kind: "text", id: "other", label: "Other" }),
			],
		});
		expect(inferenceFingerprint(retyped)).not.toBe(inferenceFingerprint(base));
		expect(inferenceFingerprint(relabelled)).toBe(inferenceFingerprint(base));
	});
});

describe("sharing inference across a move within a form", () => {
	const built = () =>
		doc({
			register: [
				f({ uuid: uuid("count"), kind: "int", id: "count", label: "Count" }),
				hidden("copy", { calculate: "#form/count" }),
				f({ uuid: uuid("plain"), kind: "text", id: "plain", label: "Plain" }),
				f({
					uuid: uuid("saved"),
					kind: "text",
					id: "saved",
					label: "Saved",
					caseWrite: { caseType: "patient", property: "saved" },
				}),
				f({
					uuid: uuid("entries"),
					kind: "repeat",
					id: "entries",
					children: [f({ kind: "text", id: "inside", label: "Inside" })],
				}),
			],
		});
	const moved = (before: BlueprintDoc, name: string) =>
		produce(before, (draft) => {
			applyMutation(draft, {
				kind: "moveField",
				uuid: uuid(name),
				toParentUuid: uuid("entries"),
				after: null,
			});
		});

	it("shares it for a question nothing inference reads, and the shared facts are the candidate's own", () => {
		const before = built();
		const shared = moved(before, "plain");
		expect(
			shareInferenceAcrossMove(before, shared, new Set([uuid("plain")])),
		).toBe(true);
		expect(inferExpressionTypes(shared)).toBe(inferExpressionTypes(before));
		expect(inferenceFingerprint(shared)).toBe(
			inferenceFingerprint(moved(before, "plain")),
		);
	});

	it.each([
		["a question a Hidden Value reads", "count"],
		["a Hidden Value", "copy"],
		["a case writer", "saved"],
	])("derives it again for %s", (_, name) => {
		const before = built();
		const candidate = moved(before, name);
		expect(
			shareInferenceAcrossMove(before, candidate, new Set([uuid(name)])),
		).toBe(false);
		expect(inferExpressionTypes(candidate)).not.toBe(
			inferExpressionTypes(before),
		);
	});
});
