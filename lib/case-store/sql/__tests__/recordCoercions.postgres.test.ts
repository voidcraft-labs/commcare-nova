// The case store held to Core on the two record-rule widenings: the
// comparisons Core coerces, over the checked-in control
// `proof/native/core/resources/numeric-coercion/comparisons.json` that
// `NumericCoercionRuntimeTest` holds Core to, and a form answer read where a
// condition belongs, decided as Core's `toBoolean` reads the value it holds.
//
// Plausible failures: a text that Core reads as a number (`01`, ` 1 `, `1.`,
// a `year-month-day` date) missed, a text Core reads as no number (`+1`,
// `1e0`, a no-break space) matched, a missing property kept by `=` or
// dropped by `!=`, a malformed text failing the whole query, and a yes or no
// answer's text `false` read as true.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	eq,
	formField,
	literal,
	neq,
	not,
	prop,
	term,
} from "@/lib/domain/expression/builders";
import type { CaseReading } from "@/lib/domain/expression/temporalType";
import type { ScalarHeld } from "@/lib/domain/expression/typeChecker";
import type { Expression } from "@/lib/domain/expression/types";
import { proseText } from "@/lib/domain/prose";
import {
	compilePredicate,
	type PredicateCompileContext,
} from "../compilePredicate";
import { expect, makeCaseRow, test } from "./setup";

interface Control {
	readonly texts: readonly { readonly case: string; readonly value?: string }[];
	readonly numbers: readonly {
		readonly number: number;
		readonly equal: readonly string[];
	}[];
	readonly wholeNumbers: readonly {
		readonly case: string;
		readonly value?: number;
	}[];
	readonly wholeNumberTexts: readonly {
		readonly text: string;
		readonly equal: readonly string[];
	}[];
}

const CONTROL = JSON.parse(
	readFileSync(
		join(
			process.cwd(),
			"proof/native/core/resources/numeric-coercion/comparisons.json",
		),
		"utf8",
	),
) as Control;

// A tenant the harness seeds a parent row for (`setup.ts`).
const APP_ID = "app-pred-compiler";
const PROJECT_ID = "owner-pred-compiler";

const SITE: CaseType = {
	name: "site",
	properties: [
		{ name: "value", label: proseText("Value"), data_type: "text" },
		{
			name: "choice",
			label: proseText("Choice"),
			data_type: "single_select",
			options: [{ value: "1", label: proseText("One") }],
		},
		{ name: "count", label: proseText("Count"), data_type: "int" },
	],
};

function context(
	db: PredicateCompileContext["db"],
	reading: CaseReading,
	overrides: Partial<PredicateCompileContext> = {},
): PredicateCompileContext {
	return {
		reading,
		db,
		appId: APP_ID,
		projectId: PROJECT_ID,
		anchorAlias: "c",
		currentCaseType: "site",
		caseTypeSchemas: new Map([["site", SITE]]),
		bindings: {},
		...overrides,
	};
}

/** The case ids `predicate` keeps, sorted. */
async function kept(
	db: PredicateCompileContext["db"],
	predicate: Expression,
	ctx: PredicateCompileContext,
): Promise<string[]> {
	const rows = await db
		.selectFrom("cases as c")
		.select(["c.case_id"])
		.where("c.app_id", "=", APP_ID)
		.where("c.project_id", "=", PROJECT_ID)
		.where(compilePredicate(predicate, ctx))
		.execute();
	return rows.map((row) => row.case_id).sort();
}

async function seedTexts(
	db: PredicateCompileContext["db"],
	property: "value" | "choice",
): Promise<void> {
	await db
		.insertInto("cases")
		.values(
			CONTROL.texts.map((row) =>
				makeCaseRow({
					case_id: row.case,
					case_type: "site",
					app_id: APP_ID,
					project_id: PROJECT_ID,
					properties: JSON.stringify(
						row.value === undefined ? {} : { [property]: row.value },
					),
				}),
			),
		)
		.execute();
}

const ALL_TEXTS = CONTROL.texts.map((row) => row.case).sort();

describe("text compared with a number, as Core's toNumeric reads it", () => {
	for (const reading of ["casedb", "results"] as const)
		for (const property of ["value", "choice"] as const)
			test(`a ${property === "value" ? "text" : "single choice"} property under the ${reading} reading`, async ({
				db,
			}) => {
				await seedTexts(db, property);
				const ctx = context(db, reading);
				const read = term(prop("site", property));
				for (const row of CONTROL.numbers) {
					const equal = [...row.equal].sort();
					expect(
						await kept(db, eq(read, term(literal(row.number))), ctx),
						`${property} = ${row.number}`,
					).toEqual(equal);
					// The literal on the left reads the same.
					expect(
						await kept(db, eq(term(literal(row.number)), read), ctx),
						`${row.number} = ${property}`,
					).toEqual(equal);
					expect(
						await kept(db, neq(read, term(literal(row.number))), ctx),
						`${property} != ${row.number}`,
					).toEqual(ALL_TEXTS.filter((name) => !equal.includes(name)));
				}
			});

	test("a day number in a zone far from UTC is the day the viewer's device counts", async ({
		db,
	}) => {
		await seedTexts(db, "value");
		const read = term(prop("site", "value"));
		const ctx = context(db, "casedb", {
			bindings: { viewerTimeZone: "Pacific/Auckland" },
		});
		expect(await kept(db, eq(read, term(literal(1))), ctx)).toEqual(
			[
				...(CONTROL.numbers.find((row) => row.number === 1)?.equal ?? []),
			].sort(),
		);
	});
});

describe("a whole number compared with the text CommCare writes for one", () => {
	test("compares the two numbers, as Core compares a property's text", async ({
		db,
	}) => {
		await db
			.insertInto("cases")
			.values(
				CONTROL.wholeNumbers.map((row) =>
					makeCaseRow({
						case_id: row.case,
						case_type: "site",
						app_id: APP_ID,
						project_id: PROJECT_ID,
						properties: JSON.stringify(
							row.value === undefined ? {} : { count: row.value },
						),
					}),
				),
			)
			.execute();
		const ctx = context(db, "casedb");
		const all = CONTROL.wholeNumbers.map((row) => row.case).sort();
		for (const row of CONTROL.wholeNumberTexts) {
			const equal = [...row.equal].sort();
			const read = term(prop("site", "count"));
			expect(
				await kept(db, eq(read, term(literal(row.text))), ctx),
				`count = '${row.text}'`,
			).toEqual(equal);
			expect(
				await kept(db, neq(term(literal(row.text)), read), ctx),
				`'${row.text}' != count`,
			).toEqual(all.filter((name) => !equal.includes(name)));
		}
	});
});

describe("a form answer read where a condition belongs", () => {
	const FLAG = "00000000-0000-4000-8000-00000000f1a9";

	/** Whether the condition holds for a form whose answer is `value`, held as `held`. */
	async function holds(
		db: PredicateCompileContext["db"],
		value: string,
		held: ScalarHeld | undefined,
		type?: "int" | "text",
		negated = false,
	): Promise<boolean> {
		await db
			.insertInto("cases")
			.values(
				makeCaseRow({
					case_id: "anchor",
					case_type: "site",
					app_id: APP_ID,
					project_id: PROJECT_ID,
				}),
			)
			.onConflict((conflict) => conflict.doNothing())
			.execute();
		const read = term(formField(FLAG as never));
		const ctx = context(db, "casedb", {
			bindings: { formFields: new Map([[FLAG, value]]) },
			formFieldTypes: new Map([[FLAG as never, type]]),
			...(held === undefined
				? {}
				: { formFieldHeld: new Map([[FLAG as never, held]]) }),
		});
		return (await kept(db, negated ? not(read) : read, ctx)).length > 0;
	}

	test("a yes or no is its own truth, and blank, as an answer left out reads, is false", async ({
		db,
	}) => {
		expect(await holds(db, "true", "boolean")).toBe(true);
		expect(await holds(db, "false", "boolean")).toBe(false);
		expect(await holds(db, "1", "boolean")).toBe(true);
		expect(await holds(db, "0", "boolean")).toBe(false);
		expect(await holds(db, "", "boolean")).toBe(false);
		expect(await holds(db, "false", "boolean", undefined, true)).toBe(true);
		expect(await holds(db, "", "boolean", undefined, true)).toBe(true);
	});

	test("text holds where it is not empty, and a number where it is not zero", async ({
		db,
	}) => {
		expect(await holds(db, "false", undefined, "text")).toBe(true);
		expect(await holds(db, "0", "string")).toBe(true);
		expect(await holds(db, "", "string")).toBe(false);
		expect(await holds(db, "0", undefined, "int")).toBe(false);
		expect(await holds(db, "2", "number")).toBe(true);
	});
});
