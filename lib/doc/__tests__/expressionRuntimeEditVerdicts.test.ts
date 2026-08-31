import { describe, expect, it } from "vitest";
import {
	ancestorPath,
	anyRelationPath,
	dateAdd,
	double,
	eq,
	ifExpr,
	literal,
	matchAll,
	now,
	prop,
	relationStep,
	type TypeContext,
	term,
	today,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import {
	caseSearchCalculatedExpressionEditVerdict,
	predicateExpressionRuntimeEditVerdict,
	valueExpressionRuntimeEditVerdict,
} from "../commitVerdicts";

const TYPE_CONTEXT: TypeContext = {
	caseTypes: [
		{
			name: "patient",
			properties: [
				{ name: "dob", label: proseText("Date of birth"), data_type: "date" },
				{
					name: "last_seen",
					label: proseText("Last seen"),
					data_type: "datetime",
				},
			],
		},
	],
	knownInputs: [],
	currentCaseType: "patient",
};

const quantity = term(literal(1));

describe("expression runtime edit verdicts", () => {
	it("rejects calendar intervals and datetime bases for on-device carriers", () => {
		expect(
			predicateExpressionRuntimeEditVerdict(
				eq(prop("patient", "dob"), dateAdd(today(), "months", quantity)),
				"on-device",
				TYPE_CONTEXT,
			),
		).toMatchObject({ ok: false, reason: expect.stringContaining("Month") });
		expect(
			valueExpressionRuntimeEditVerdict(
				dateAdd(now(), "days", quantity),
				"on-device",
				TYPE_CONTEXT,
			),
		).toMatchObject({
			ok: false,
			reason: expect.stringContaining("time would be lost"),
		});
	});

	it("keeps direct native date arithmetic available in a server search", () => {
		expect(
			predicateExpressionRuntimeEditVerdict(
				eq(prop("patient", "dob"), dateAdd(today(), "months", quantity)),
				"case-search",
				TYPE_CONTEXT,
			),
		).toEqual({ ok: true });
		expect(
			predicateExpressionRuntimeEditVerdict(
				eq(prop("patient", "last_seen"), dateAdd(now(), "years", quantity)),
				"case-search",
				TYPE_CONTEXT,
			),
		).toEqual({ ok: true });
	});

	it("still rejects a server-search subtree that is interpolated on device", () => {
		const calculated = ifExpr(
			matchAll(),
			dateAdd(today(), "years", quantity),
			today(),
		);
		expect(
			predicateExpressionRuntimeEditVerdict(
				eq(prop("patient", "dob"), calculated),
				"case-search",
				TYPE_CONTEXT,
			),
		).toMatchObject({ ok: false, reason: expect.stringContaining("Month") });
	});

	it("uses the strict intersection when one rule runs in both runtimes", () => {
		expect(
			predicateExpressionRuntimeEditVerdict(
				eq(prop("patient", "dob"), dateAdd(today(), "months", quantity)),
				"on-device-and-case-search",
				TYPE_CONTEXT,
			),
		).toMatchObject({ ok: false, reason: expect.stringContaining("Month") });
	});
});

describe("Search calculated-expression edit verdict", () => {
	const context: TypeContext = {
		caseTypes: [
			{
				name: "household",
				properties: [
					{
						name: "score",
						label: proseText("Score"),
						data_type: "int",
					},
				],
			},
			{
				name: "patient",
				parent_type: "household",
				properties: [
					{ name: "age", label: proseText("Age"), data_type: "int" },
				],
			},
		],
		knownInputs: [],
		currentCaseType: "patient",
	};

	it("keeps current-case calculations and one whole ancestor property available", () => {
		expect(
			caseSearchCalculatedExpressionEditVerdict(
				double(term(prop("patient", "age"))),
				context,
			),
		).toEqual({ ok: true });
		expect(
			caseSearchCalculatedExpressionEditVerdict(
				term(
					prop(
						"patient",
						"score",
						ancestorPath(relationStep("parent", "household")),
					),
				),
				context,
			),
		).toEqual({ ok: true });
		expect(
			caseSearchCalculatedExpressionEditVerdict(
				term(prop("patient", "score", anyRelationPath("parent", "household"))),
				context,
			),
		).toEqual({ ok: true });
	});

	it("rejects wrapped and reserved parent reads with a concrete repair", () => {
		const directParent = term(
			prop(
				"patient",
				"score",
				ancestorPath(relationStep("parent", "household")),
			),
		);
		const wrapped = caseSearchCalculatedExpressionEditVerdict(
			double(directParent),
			context,
		);
		expect(wrapped).toMatchObject({
			ok: false,
			reason: expect.stringContaining("Choose the parent property by itself"),
		});
		expect(
			caseSearchCalculatedExpressionEditVerdict(
				term(
					prop(
						"patient",
						"score",
						ancestorPath(
							relationStep("parent", "household"),
							relationStep("parent", "organization"),
						),
					),
				),
				context,
			),
		).toEqual({ ok: true });
		expect(
			caseSearchCalculatedExpressionEditVerdict(
				term(
					prop(
						"patient",
						"score",
						ancestorPath(relationStep("user", "household")),
					),
				),
				context,
			),
		).toEqual({ ok: true });
	});
});
