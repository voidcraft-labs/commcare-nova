import { describe, expect, it } from "vitest";
import {
	dateAdd,
	eq,
	ifExpr,
	literal,
	matchAll,
	now,
	prop,
	type TypeContext,
	term,
	today,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import {
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
