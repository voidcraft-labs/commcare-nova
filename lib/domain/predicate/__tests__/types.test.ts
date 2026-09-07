// Stored AST grammar: raw payloads, exact preservation, and isolated malformed
// neighbours. Schema admission is not type checking, carrier compatibility, or
// provider acceptance. Those are exercised at their owning boundaries.
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	formFieldRefSchema,
	idOfSchema,
	predicateSchema,
	relationPathSchema,
	termSchema,
	valueExpressionSchema,
} from "../types";

const inputUuid = testUuid("search-name");
const property = { kind: "prop", caseType: "patient", property: "case_name" };
const input = { kind: "input", searchInputUuid: inputUuid };
const literal = { kind: "literal", value: "Alice" };
const value = (term: unknown) => ({ kind: "term", term });
const comparison = { kind: "eq", left: value(property), right: value(literal) };
const path = {
	kind: "ancestor",
	via: [
		{ identifier: "parent", throughCaseType: "household" },
		{ identifier: "host" },
	],
};
const tableId = "018f3e8a-7b2c-7def-8abc-1234567890ab";
const columnId = "018f3e8a-7b2c-7def-8abc-1234567890ad";

// Each table contains concrete public payloads rather than a generated list of
// the schema's kinds. The values retain different operands and nested identity.
const terms = [
	property,
	input,
	literal,
	{ kind: "literal", value: null },
	{ kind: "literal", value: true },
	{ kind: "literal", value: 1.25 },
	{ kind: "literal", value: "2024-02-29", data_type: "date" },
	{ kind: "session-user", field: "assigned-region" },
	...["userid", "username", "deviceid", "appversion"].map((field) => ({
		kind: "session-context",
		field,
	})),
	{
		kind: "session-user-property",
		userPropertyUuid: testUuid("worker-region"),
	},
	{ kind: "field", uuid: testUuid("answer") },
	{ kind: "table-column", tableId, columnId },
	{ kind: "fixed-location", locationUuid: testUuid("clinic") },
	{
		kind: "owner-location-at-level",
		levelUuid: testUuid("district"),
		ownerCaseType: "patient",
	},
	{ ...property, via: path },
];
const relations = [
	{ kind: "self" },
	path,
	{ kind: "subcase", identifier: "parent" },
	{ kind: "subcase", identifier: "parent", ofCaseType: "visit" },
	{ kind: "any-relation", identifier: "linked", ofCaseType: "referral" },
	{ kind: "any-relation", identifier: "linked" },
];
const predicates = [
	...["eq", "neq", "gt", "gte", "lt", "lte"].map((kind) => ({
		...comparison,
		kind,
	})),
	{ kind: "and", clauses: [comparison, { kind: "not", clause: comparison }] },
	{ kind: "or", clauses: [comparison] },
	{ kind: "not", clause: comparison },
	{ kind: "when-input-present", input, clause: comparison },
	{
		kind: "in",
		left: value(property),
		values: [{ kind: "literal", value: null }, literal],
	},
	{
		kind: "within-distance",
		property,
		center: value(input),
		distance: 50,
		unit: "miles",
	},
	...["fuzzy", "phonetic", "fuzzy-date", "starts-with"].map((mode) => ({
		kind: "match",
		property,
		value: value(literal),
		mode,
	})),
	...["any", "all"].map((quantifier) => ({
		kind: "multi-select-contains",
		property,
		values: [literal, { kind: "literal", value: null }],
		quantifier,
	})),
	{ kind: "match-all" },
	{ kind: "match-none" },
	{ kind: "is-blank", left: value(input) },
	{ kind: "matches-pattern", left: value(input), pattern: "^[A-Z]\\d+$" },
	{
		kind: "between",
		left: value(property),
		lower: value(input),
		lowerInclusive: true,
		upperInclusive: false,
	},
	{
		kind: "between",
		left: value(property),
		upper: value(literal),
		lowerInclusive: false,
		upperInclusive: true,
	},
	{
		kind: "between",
		left: value(property),
		lower: value(input),
		upper: value(literal),
		lowerInclusive: false,
		upperInclusive: true,
	},
	...["exists", "missing"].flatMap((kind) =>
		relations.flatMap((via) => [
			{ kind, via },
			{ kind, via, where: comparison },
		]),
	),
];
const expressions = [
	value(property),
	{ kind: "today" },
	{ kind: "now" },
	{ kind: "id-of", opUuid: testUuid("create") },
	{ kind: "acting-user" },
	{ kind: "unowned" },
	{
		kind: "table-lookup",
		tableId,
		resultColumnId: columnId,
		where: comparison,
	},
	...["seconds", "minutes", "hours", "days", "weeks", "months", "years"].map(
		(interval) => ({
			kind: "date-add",
			date: { kind: "today" },
			interval,
			quantity: value({ kind: "literal", value: 2 }),
		}),
	),
	...["date-coerce", "datetime-coerce", "double"].map((kind) => ({
		kind,
		value: value(literal),
	})),
	...["+", "-", "*", "div", "mod"].map((op) => ({
		kind: "arith",
		op,
		left: value(property),
		right: value(literal),
	})),
	{ kind: "concat", parts: [value(literal)] },
	{
		kind: "concat",
		parts: [
			value(literal),
			value(input),
			{ kind: "concat", parts: [value(property)] },
		],
	},
	{
		kind: "coalesce",
		values: [value({ kind: "literal", value: null }), value(literal)],
	},
	{
		kind: "if",
		cond: comparison,
		// biome-ignore lint/suspicious/noThenProperty: Stored AST branch is an object, never a callable thenable.
		then: value(literal),
		else: {
			kind: "if",
			cond: { kind: "match-none" },
			// biome-ignore lint/suspicious/noThenProperty: Stored AST branch is an object, never a callable thenable.
			then: value(input),
			else: value(property),
		},
	},
	{
		kind: "switch",
		on: value(input),
		cases: [
			// biome-ignore lint/suspicious/noThenProperty: Stored AST branch is an object, never a callable thenable.
			{ when: literal, then: value(property) },
			// biome-ignore lint/suspicious/noThenProperty: Stored AST branch is an object, never a callable thenable.
			{ when: { kind: "literal", value: "Bob" }, then: value(input) },
		],
		fallback: value(literal),
	},
	{ kind: "count", via: path },
	{ kind: "count", via: path, where: comparison },
	...["short", "long", "iso", "%Y-%m-%d %H:%M:%S"].map((pattern) => ({
		kind: "format-date",
		date: { kind: "today" },
		pattern,
	})),
];

for (const [name, schema, samples] of [
	["term", termSchema, terms],
	["relation", relationPathSchema, relations],
	["predicate", predicateSchema, predicates],
	["expression", valueExpressionSchema, expressions],
] as const) {
	describe(`${name} payload preservation`, () => {
		it.each(samples)("preserves $kind", (payload) => {
			expect(schema.parse(payload)).toStrictEqual(payload);
			expect(
				schema.safeParse({ ...payload, unrecognized: "must not disappear" })
					.success,
			).toBe(false);
		});
		it("refuses unknown and absent discriminators", () => {
			expect(schema.safeParse({ kind: "unrecognized" }).success).toBe(false);
			expect(schema.safeParse({}).success).toBe(false);
		});
	});
}

describe("isolated predicate slot failures", () => {
	const match = {
		kind: "match",
		property,
		value: value(literal),
		mode: "fuzzy",
	};
	it.each([
		[comparison, "right", undefined],
		[{ kind: "not", clause: comparison }, "clause", undefined],
		[
			{ kind: "when-input-present", input, clause: comparison },
			"clause",
			undefined,
		],
		[
			{ kind: "when-input-present", input, clause: comparison },
			"input",
			property,
		],
		[match, "property", input],
		[match, "mode", "regex"],
		[match, "mode", undefined],
		[match, "value", "Alice"],
		[
			{
				kind: "within-distance",
				property,
				center: value(input),
				distance: 50,
				unit: "miles",
			},
			"property",
			literal,
		],
		[
			{
				kind: "within-distance",
				property,
				center: value(input),
				distance: 50,
				unit: "miles",
			},
			"unit",
			"meters",
		],
		[
			{
				kind: "multi-select-contains",
				property,
				values: [literal],
				quantifier: "any",
			},
			"property",
			input,
		],
		[
			{
				kind: "multi-select-contains",
				property,
				values: [literal],
				quantifier: "any",
			},
			"quantifier",
			"majority",
		],
		[{ kind: "exists", via: path }, "via", undefined],
		[{ kind: "missing", via: path }, "via", { kind: "cousin" }],
		[{ kind: "is-blank", left: value(input) }, "left", undefined],
	] as const)("refuses %j with malformed %s", (valid, key, invalid) => {
		expect(predicateSchema.parse(valid)).toStrictEqual(valid);
		expect(
			predicateSchema.safeParse({ ...valid, [key]: invalid }).success,
		).toBe(false);
	});
	it("keeps empty literal match values structural, for the checker to refuse", () => {
		const payload = { ...match, value: value({ kind: "literal", value: "" }) };
		expect(predicateSchema.parse(payload)).toStrictEqual(payload);
	});
	it("keeps literal absence and self relations structural", () => {
		for (const payload of [
			{ kind: "is-blank", left: value(literal) },
			{ kind: "exists", via: { kind: "self" } },
		]) {
			expect(predicateSchema.parse(payload)).toStrictEqual(payload);
		}
	});
	it.each(["lowerInclusive", "upperInclusive"])(
		"requires %s independently",
		(flag) => {
			const payload = {
				kind: "between",
				left: value(property),
				lower: value(literal),
				lowerInclusive: true,
				upperInclusive: false,
			};
			expect(predicateSchema.parse(payload)).toStrictEqual(payload);
			expect(
				predicateSchema.safeParse({ ...payload, [flag]: undefined }).success,
			).toBe(false);
		},
	);
	it("requires a bound and preserves both mixed inclusivity flags", () => {
		expect(
			predicateSchema.safeParse({
				kind: "between",
				left: value(property),
				lowerInclusive: false,
				upperInclusive: true,
			}).success,
		).toBe(false);
	});
	it.each([
		0,
		-1,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
	])("refuses nonpositive/nonfinite radius %s", (distance) => {
		expect(
			predicateSchema.safeParse({
				kind: "within-distance",
				property,
				center: value(input),
				distance,
				unit: "miles",
			}).success,
		).toBe(false);
	});
	it.each(["miles", "kilometers"])(
		"refuses meter conversion overflow for %s",
		(unit) => {
			const payload = {
				kind: "within-distance",
				property,
				center: value(input),
				distance: 1,
				unit,
			};
			expect(predicateSchema.parse(payload)).toStrictEqual(payload);
			const result = predicateSchema.safeParse({
				...payload,
				distance: Number.MAX_VALUE,
			});
			expect(result.success).toBe(false);
			if (!result.success)
				expect(result.error.issues).toContainEqual(
					expect.objectContaining({
						path: ["distance"],
						message: "Distance is too large to convert to meters.",
					}),
				);
		},
	);
	it.each(["in", "multi-select-contains"])(
		"requires a non-null value in %s",
		(kind) => {
			const base =
				kind === "in"
					? { kind, left: value(property) }
					: { kind, property, quantifier: "any" };
			for (const values of [
				[],
				[{ kind: "literal", value: null }],
				[
					{ kind: "literal", value: null },
					{ kind: "literal", value: null },
				],
			]) {
				expect(predicateSchema.safeParse({ ...base, values }).success).toBe(
					false,
				);
			}
			expect(
				predicateSchema.parse({
					...base,
					values: [{ kind: "literal", value: null }, literal],
				}),
			).toStrictEqual({
				...base,
				values: [{ kind: "literal", value: null }, literal],
			});
		},
	);
	it.each(["and", "or"])("refuses an empty %s", (kind) => {
		expect(predicateSchema.safeParse({ kind, clauses: [] }).success).toBe(
			false,
		);
	});
	it.each(["", "x".repeat(1001)])(
		"bounds stored regular-expression text",
		(pattern) => {
			expect(
				predicateSchema.safeParse({
					kind: "matches-pattern",
					left: value(input),
					pattern,
				}).success,
			).toBe(false);
		},
	);
	it("stores Java pattern text without pretending to compile it", () => {
		const payload = {
			kind: "matches-pattern",
			left: value(input),
			pattern: "[",
		};
		expect(predicateSchema.parse(payload)).toStrictEqual(payload);
	});
});

describe("isolated expression slot failures", () => {
	it.each([
		[value(literal), "term", undefined],
		[
			{
				kind: "date-add",
				date: { kind: "today" },
				interval: "days",
				quantity: value(literal),
			},
			"interval",
			"fortnights",
		],
		[
			{ kind: "arith", op: "+", left: value(property), right: value(literal) },
			"op",
			"**",
		],
		[
			{ kind: "arith", op: "+", left: value(property), right: value(literal) },
			"right",
			undefined,
		],
		[{ kind: "concat", parts: [value(literal)] }, "parts", []],
		[{ kind: "coalesce", values: [value(literal)] }, "values", []],
		[
			{
				kind: "switch",
				on: value(input),
				// biome-ignore lint/suspicious/noThenProperty: Stored AST branch is an object, never a callable thenable.
				cases: [{ when: literal, then: value(property) }],
				fallback: value(literal),
			},
			"cases",
			[],
		],
		[
			{
				kind: "switch",
				on: value(input),
				// biome-ignore lint/suspicious/noThenProperty: Stored AST branch is an object, never a callable thenable.
				cases: [{ when: literal, then: value(property) }],
				fallback: value(literal),
			},
			"fallback",
			undefined,
		],
		[
			{
				kind: "if",
				cond: comparison,
				// biome-ignore lint/suspicious/noThenProperty: Stored AST branch is an object, never a callable thenable.
				then: value(property),
				else: value(input),
			},
			"cond",
			value(literal),
		],
		[
			{
				kind: "if",
				cond: comparison,
				// biome-ignore lint/suspicious/noThenProperty: Stored AST branch is an object, never a callable thenable.
				then: value(property),
				else: value(input),
			},
			"else",
			undefined,
		],
	] as const)("refuses %j with malformed %s", (valid, key, invalid) => {
		expect(valueExpressionSchema.parse(valid)).toStrictEqual(valid);
		expect(
			valueExpressionSchema.safeParse({ ...valid, [key]: invalid }).success,
		).toBe(false);
	});
	it.each(["", "%Q", "Date %"])("refuses unsupported format %s", (pattern) => {
		expect(
			valueExpressionSchema.safeParse({
				kind: "format-date",
				date: { kind: "today" },
				pattern,
			}).success,
		).toBe(false);
	});
	it("refuses removed stored discriminators", () => {
		expect(
			predicateSchema.safeParse({ kind: "is-null", left: value(property) })
				.success,
		).toBe(false);
		expect(
			valueExpressionSchema.safeParse({
				kind: "unwrap-list",
				value: value(property),
			}).success,
		).toBe(false);
	});
	it("validates both recursive families down to the nested leaf", () => {
		const payload = {
			kind: "eq",
			left: {
				kind: "if",
				cond: {
					kind: "exists",
					via: path,
					where: { kind: "when-input-present", input, clause: comparison },
				},
				// biome-ignore lint/suspicious/noThenProperty: Stored AST branch is an object, never a callable thenable.
				then: {
					kind: "count",
					via: path,
					where: { kind: "not", clause: comparison },
				},
				else: {
					kind: "switch",
					on: value(input),
					// biome-ignore lint/suspicious/noThenProperty: Stored AST branch is an object, never a callable thenable.
					cases: [{ when: literal, then: value(property) }],
					fallback: value(literal),
				},
			},
			right: value(literal),
		};
		expect(predicateSchema.parse(payload)).toStrictEqual(payload);
		const malformed = structuredClone(payload);
		malformed.left.else.cases[0].when.kind = "prop";
		expect(predicateSchema.safeParse(malformed).success).toBe(false);
	});
});

describe("identity and identifier boundaries", () => {
	it.each([
		"",
		"bad name",
		"name/slash",
		"name'); injected",
		"9name",
		"_name",
		"name",
		"date-opened",
		"external-id",
	])("refuses authored property %s", (propertyName) => {
		expect(
			termSchema.safeParse({ ...property, property: propertyName }).success,
		).toBe(false);
	});
	it.each(["case_name", "A", "a-b", "a_b9"])(
		"admits authored property %s",
		(propertyName) => {
			expect(
				termSchema.parse({ ...property, property: propertyName }),
			).toStrictEqual({ ...property, property: propertyName });
		},
	);
	it.each(["", "patient' or 1=1", "with whitespace", "9patient", "_patient"])(
		"refuses case-type identifier %s",
		(caseType) => {
			expect(termSchema.safeParse({ ...property, caseType }).success).toBe(
				false,
			);
		},
	);
	it.each(["parent", "_custom", "host9"])(
		"admits relation identifier %s",
		(identifier) => {
			const payload = { kind: "ancestor", via: [{ identifier }] };
			expect(relationPathSchema.parse(payload)).toStrictEqual(payload);
		},
	);
	it.each(["parent') or 1=1", "with whitespace", "parent-link", "9parent"])(
		"refuses relation identifier %s",
		(identifier) => {
			expect(
				relationPathSchema.safeParse({
					kind: "ancestor",
					via: [{ identifier }],
				}).success,
			).toBe(false);
		},
	);
	it("rejects empty paths and malformed destination qualifiers independently", () => {
		expect(
			relationPathSchema.safeParse({ kind: "ancestor", via: [] }).success,
		).toBe(false);
		expect(
			relationPathSchema.safeParse({
				kind: "ancestor",
				via: [{ identifier: "parent", throughCaseType: "with whitespace" }],
			}).success,
		).toBe(false);
		expect(
			relationPathSchema.safeParse({
				kind: "subcase",
				identifier: "parent",
				ofCaseType: "ref/erral",
			}).success,
		).toBe(false);
	});
	it.each(["assigned-region", "_district", "district9"])(
		"admits external worker field %s",
		(field) => {
			expect(termSchema.parse({ kind: "session-user", field })).toStrictEqual({
				kind: "session-user",
				field,
			});
		},
	);
	it.each(["field/with/slashes", "field space", "9field"])(
		"refuses external worker field %s",
		(field) => {
			expect(
				termSchema.safeParse({ kind: "session-user", field }).success,
			).toBe(false);
		},
	);
	it.each(["drift", "window_width", "applanguage", "not_a_metadata_key"])(
		"refuses unexposed context field %s",
		(field) => {
			expect(
				termSchema.safeParse({ kind: "session-context", field }).success,
			).toBe(false);
		},
	);
	it("requires search identity and refuses a second mutable name beside it", () => {
		expect(termSchema.parse(input)).toStrictEqual(input);
		expect(
			termSchema.safeParse({ ...input, name: "name_search" }).success,
		).toBe(false);
		expect(
			termSchema.safeParse({ kind: "input", name: "name_search" }).success,
		).toBe(false);
		expect(
			termSchema.safeParse({ ...input, searchInputUuid: "name_search" })
				.success,
		).toBe(false);
	});
	it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
		"refuses nonfinite literal %s",
		(number) => {
			expect(
				termSchema.safeParse({ kind: "literal", value: number }).success,
			).toBe(false);
		},
	);
});

describe("operation identity JSON Schema", () => {
	it.each([
		[
			formFieldRefSchema,
			{ kind: "field", uuid: testUuid("form-answer") },
			"uuid",
		],
		[
			idOfSchema,
			{ kind: "id-of", opUuid: testUuid("create-operation") },
			"opUuid",
		],
	] as const)(
		"preserves admission after schema conversion",
		(schema, valid, key) => {
			const ajv = new Ajv2020({ strict: false });
			addFormats(ajv);
			const validate = ajv.compile(z.toJSONSchema(schema));
			expect(validate(valid)).toBe(true);
			for (const invalid of [
				{ ...valid, [key]: "" },
				{ ...valid, [key]: "mutable-name" },
				{ ...valid, extra: true },
			]) {
				expect(schema.safeParse(invalid).success).toBe(false);
				expect(validate(invalid)).toBe(false);
			}
		},
	);
});
