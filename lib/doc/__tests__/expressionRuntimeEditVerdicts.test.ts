import { describe, expect, it } from "vitest";
import {
	and,
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
	predicateRuntimeDateAddRepair,
	valueExpressionRuntimeEditVerdict,
	valueRuntimeDateAddRepair,
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

	it("atomically removes both incompatibility axes from one imported calculation", () => {
		const repair = valueRuntimeDateAddRepair(
			dateAdd(now(), "months", quantity),
			"on-device",
			TYPE_CONTEXT,
		);

		expect(repair).toEqual({
			value: now(),
			removedAdjustments: 1,
		});
		expect(
			valueExpressionRuntimeEditVerdict(
				repair.value,
				"on-device",
				TYPE_CONTEXT,
			),
		).toEqual({ ok: true });
	});

	it("builds one valid repair for every imported issue in a predicate", () => {
		const predicate = and(
			eq(prop("patient", "dob"), dateAdd(today(), "years", quantity)),
			eq(prop("patient", "last_seen"), dateAdd(now(), "days", quantity)),
		);
		const repair = predicateRuntimeDateAddRepair(
			predicate,
			"on-device",
			TYPE_CONTEXT,
		);

		expect(repair.removedAdjustments).toBe(2);
		expect(
			predicateExpressionRuntimeEditVerdict(
				repair.value,
				"on-device",
				TYPE_CONTEXT,
			),
		).toEqual({ ok: true });
		expect(repair.value).toEqual(
			and(
				eq(prop("patient", "dob"), today()),
				eq(prop("patient", "last_seen"), now()),
			),
		);
	});

	it("does not remove native server-search date arithmetic", () => {
		const predicate = eq(
			prop("patient", "last_seen"),
			dateAdd(now(), "years", quantity),
		);
		expect(
			predicateRuntimeDateAddRepair(predicate, "case-search", TYPE_CONTEXT),
		).toEqual({ value: predicate, removedAdjustments: 0 });
	});

	it("repairs only the JavaRosa-interpolated part of a server search", () => {
		const predicate = eq(
			prop("patient", "dob"),
			ifExpr(matchAll(), dateAdd(today(), "years", quantity), today()),
		);
		const repair = predicateRuntimeDateAddRepair(
			predicate,
			"case-search",
			TYPE_CONTEXT,
		);

		expect(repair.removedAdjustments).toBe(1);
		expect(
			predicateExpressionRuntimeEditVerdict(
				repair.value,
				"case-search",
				TYPE_CONTEXT,
			),
		).toEqual({ ok: true });
	});

	it("keeps an identical native server calculation while repairing interpolation", () => {
		const native = dateAdd(today(), "years", quantity);
		const interpolated = dateAdd(today(), "years", quantity);
		const predicate = and(
			eq(prop("patient", "dob"), native),
			eq(prop("patient", "dob"), ifExpr(matchAll(), interpolated, today())),
		);
		const repair = predicateRuntimeDateAddRepair(
			predicate,
			"case-search",
			TYPE_CONTEXT,
		);

		expect(repair.removedAdjustments).toBe(1);
		expect(repair.value.kind).toBe("and");
		if (repair.value.kind !== "and") throw new Error("Expected and");
		expect(repair.value.clauses[0]).toBe(predicate.clauses[0]);
		expect(repair.value.clauses[1]).toEqual(
			eq(prop("patient", "dob"), ifExpr(matchAll(), today(), today())),
		);
	});
});
