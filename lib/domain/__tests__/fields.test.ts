import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { proseText } from "@/lib/domain/prose";
import {
	fieldKinds,
	fieldSchema,
	isContainer,
	isContainerKindName,
	pickFieldKeysForKind,
} from "../fields";
import { opaqueXPathExpression } from "../xpath";

const identity = { uuid: testUuid("field"), id: "answer" };
const label = proseText("Answer");
const optionsSource = {
	kind: "inline",
	options: [
		{ uuid: testUuid("yes"), value: "yes", label: proseText("Yes") },
		{ uuid: testUuid("no"), value: "no", label: proseText("No") },
	],
};
const leafKinds = [
	"text",
	"int",
	"decimal",
	"date",
	"time",
	"datetime",
	"geopoint",
	"image",
	"audio",
	"video",
	"file",
	"barcode",
	"signature",
	"label",
	"secret",
];
const fixtures = [
	...leafKinds.map((kind) => ({ ...identity, kind, label })),
	...["single_select", "multi_select"].map((kind) => ({
		...identity,
		kind,
		label,
		optionsSource,
	})),
	{ ...identity, kind: "hidden" },
	{ ...identity, kind: "group" },
	{ ...identity, kind: "section" },
	{ ...identity, kind: "repeat", repeat_mode: "user_controlled" },
	{
		...identity,
		kind: "repeat",
		repeat_mode: "count_bound",
		repeat_count: opaqueXPathExpression("2"),
	},
	{
		...identity,
		kind: "repeat",
		repeat_mode: "query_bound",
		data_source: { ids_query: opaqueXPathExpression("''") },
	},
];

describe("field schema admission", () => {
	it("admits every field variant without changing its authored properties", () => {
		expect([...new Set(fixtures.map((value) => value.kind))].sort()).toEqual(
			[...fieldKinds].sort(),
		);
		for (const value of fixtures) {
			const field = fieldSchema.parse(value);
			expect(field).toEqual(value);
			expect(isContainer(field)).toBe(
				["group", "repeat", "section"].includes(value.kind),
			);
			expect(isContainerKindName(value.kind)).toBe(isContainer(field));
			expect(fieldSchema.safeParse({ ...value, obsolete: true }).success).toBe(
				false,
			);
		}
	});

	it("rejects missing or unknown discriminants on an otherwise admitted input", () => {
		const valid = { ...identity, kind: "text", label };
		expect(fieldSchema.parse(valid)).toEqual(valid);
		const { kind, ...missingKind } = valid;
		expect(kind).toBe("text");
		for (const value of [
			missingKind,
			{ ...valid, kind: "likert_scale" },
			{ ...valid, uuid: "not-a-uuid" },
		])
			expect(fieldSchema.safeParse(value).success).toBe(false);
	});

	it.each(["single_select", "multi_select"])(
		"requires at least two inline options for %s",
		(kind) => {
			const valid = { ...identity, kind, label, optionsSource };
			expect(fieldSchema.parse(valid)).toEqual(valid);
			for (const count of [0, 1])
				expect(
					fieldSchema.safeParse({
						...valid,
						optionsSource: {
							...optionsSource,
							options: optionsSource.options.slice(0, count),
						},
					}).success,
				).toBe(false);
		},
	);

	it("distinguishes required, optional and forbidden labels", () => {
		for (const kind of [...leafKinds, "single_select", "multi_select"]) {
			const value = {
				...identity,
				kind,
				label,
				...(kind.endsWith("select") ? { optionsSource } : {}),
			};
			expect(fieldSchema.parse(value)).toEqual(value);
			const { label: _label, ...withoutLabel } = value;
			expect(fieldSchema.safeParse(withoutLabel).success).toBe(false);
		}
		for (const kind of ["group", "section", "repeat"]) {
			const value = {
				...identity,
				kind,
				...(kind === "repeat" ? { repeat_mode: "user_controlled" } : {}),
			};
			expect(fieldSchema.parse(value)).toEqual(value);
			expect(fieldSchema.parse({ ...value, label: proseText("") })).toEqual({
				...value,
				label: proseText(""),
			});
		}
		const hidden = { ...identity, kind: "hidden" };
		expect(fieldSchema.parse(hidden)).toEqual(hidden);
		expect(fieldSchema.safeParse({ ...hidden, label }).success).toBe(false);
	});

	it("admits either hidden-value slot; requiring a value belongs to the document gate", () => {
		for (const value of [
			{ ...identity, kind: "hidden", calculate: opaqueXPathExpression("2") },
			{
				...identity,
				kind: "hidden",
				default_value: opaqueXPathExpression("2"),
			},
		])
			expect(fieldSchema.parse(value)).toEqual(value);
	});

	it.each([undefined, null, "missing", "constructor", "__proto__", "toString"])(
		"does not recognize %s as a container kind",
		(kind) => {
			expect(isContainerKindName(kind)).toBe(false);
		},
	);
});

describe("repeat candidate projection before schema admission", () => {
	it("selects each admitted mode's own keys and drops only stale sibling-mode slots", () => {
		for (const repeat_mode of [
			"user_controlled",
			"count_bound",
			"query_bound",
		]) {
			const repeat_count = opaqueXPathExpression("2");
			const data_source = { ids_query: opaqueXPathExpression("''") };
			const value = {
				...identity,
				kind: "repeat",
				repeat_mode,
				repeat_count,
				data_source,
				obsolete: true,
			};
			const before = structuredClone(value);
			const expected = {
				...identity,
				kind: "repeat",
				repeat_mode,
				...(repeat_mode === "count_bound" ? { repeat_count } : {}),
				...(repeat_mode === "query_bound" ? { data_source } : {}),
			};
			expect(pickFieldKeysForKind(value, "repeat")).toEqual(expected);
			expect(fieldSchema.parse(expected)).toEqual(expected);
			expect(value).toEqual(before);
		}
	});
	it.each([undefined, "missing", "constructor", "__proto__", "toString"])(
		"preserves invalid mode %s for a normal schema refusal",
		(repeat_mode) => {
			const value = {
				...identity,
				kind: "repeat",
				repeat_mode,
				repeat_count: opaqueXPathExpression("2"),
				obsolete: true,
			};
			const before = structuredClone(value);
			const projected = pickFieldKeysForKind(value, "repeat");
			expect(projected).toEqual({
				...identity,
				kind: "repeat",
				repeat_mode,
				repeat_count: opaqueXPathExpression("2"),
			});
			expect(fieldSchema.safeParse(projected).success).toBe(false);
			expect(value).toEqual(before);
		},
	);
});
