import { expect, it } from "vitest";
import { z } from "zod";
import { makeCanonicalGenesisDoc } from "@/lib/agent/__tests__/fixtures";
import { SHARED_TOOL_REGISTRY } from "@/lib/agent/sharedToolRegistry";
import {
	setCaseSearchAdvancedBodySchema,
	setCaseSearchDisplayBodySchema,
} from "@/lib/agent/tools/case-search-config/shared";
import { updateTranslationsInputSchema } from "@/lib/agent/tools/localization";
import { proseText } from "@/lib/domain";
import { AuthoringScope } from "../bindings";
import { parseQueryPredicate, parseQueryValue } from "../queryExpressions";
import {
	type AuthoringValueDecoders,
	authoringJsonSchema,
	authoringSchema,
	decodeAuthoringValues,
} from "../schema";

function noDecoder(): never {
	throw new Error("Unexpected content family.");
}
const unavailable: AuthoringValueDecoders = {
	text: noDecoder,
	message: noDecoder,
	localized: noDecoder,
	xpath: noDecoder,
	condition: noDecoder,
	value: noDecoder,
	reference: noDecoder,
	relationship: noDecoder,
};

it("removes storage expression families from every registered tool while retaining unrelated objects", () => {
	for (const entry of SHARED_TOOL_REGISTRY) {
		const json = JSON.stringify(authoringJsonSchema(entry.tool.inputSchema));
		expect(json, entry.saName).not.toContain('"parts":');
		expect(
			() => authoringSchema(entry.tool.inputSchema),
			entry.saName,
		).not.toThrow();
	}
	const unrelated = z.object({
		parts: z.array(z.string()),
		label: z.object({ text: z.string() }),
	});
	const input = { parts: ["ordinary data"], label: { text: "untouched" } };
	expect(authoringSchema(unrelated).parse(input)).toEqual(input);
	expect(decodeAuthoringValues(unrelated, input, unavailable)).toEqual(input);
});

it("binds refined Search expression families, then enforces the canonical slot restrictions", () => {
	const scope = new AuthoringScope({ doc: makeCanonicalGenesisDoc() });
	const decoders: AuthoringValueDecoders = {
		...unavailable,
		condition: (value) =>
			parseQueryPredicate(
				z.union([z.string(), z.boolean()]).parse(value),
				scope,
			),
		value: (value) =>
			parseQueryValue(
				z.union([z.string(), z.boolean(), z.number()]).parse(value),
				scope,
			),
	};
	const display = {
		searchScreenTitle: null,
		searchScreenSubtitle: null,
		searchButtonLabel: null,
		searchButtonDisplayCondition: "session('username') = 'ada@example.org'",
	};
	expect(
		authoringSchema(setCaseSearchDisplayBodySchema).safeParse(display).success,
	).toBe(true);
	const bound = decodeAuthoringValues(
		setCaseSearchDisplayBodySchema,
		display,
		decoders,
	);
	expect(setCaseSearchDisplayBodySchema.safeParse(bound).success).toBe(true);
	const advanced = { excludedOwnerIds: "session('userid')", searchFirst: null };
	expect(
		authoringSchema(setCaseSearchAdvancedBodySchema).safeParse(advanced)
			.success,
	).toBe(true);
	expect(
		setCaseSearchAdvancedBodySchema.safeParse(
			decodeAuthoringValues(
				setCaseSearchAdvancedBodySchema,
				advanced,
				decoders,
			),
		).success,
	).toBe(true);
	const cleared = { ...display, searchButtonDisplayCondition: null };
	expect(
		decodeAuthoringValues(setCaseSearchDisplayBodySchema, cleared, unavailable),
	).toEqual(cleared);
});

it("gives translation values to a contextual decoder without changing plain tool strings", () => {
	const plain = "tu1:plain",
		prose = "tu1:prose";
	const input = {
		language: { language: "fra" },
		updates: [
			{
				operation: "set",
				unitId: plain,
				expectedSourceFingerprint: "plain-source",
				value: "Nom",
			},
			{
				operation: "set",
				unitId: prose,
				expectedSourceFingerprint: "prose-source",
				value: "Bonjour",
			},
			{
				operation: "review",
				unitId: "tu1:prose-review",
				expectedSourceFingerprint: "prose-source",
				expectedCurrentSourceFingerprint: "prose-current",
				expectedValue: "Bonjour",
			},
		],
	};
	const visited: (string | number)[][] = [];
	const result = decodeAuthoringValues(updateTranslationsInputSchema, input, {
		...unavailable,
		localized(value, path) {
			visited.push([...path]);
			const update = input.updates[Number(path[1])];
			return update.unitId === plain
				? value
				: proseText(z.string().parse(value));
		},
	});
	expect(result).toMatchObject({
		updates: [
			{ value: "Nom" },
			{ value: proseText("Bonjour") },
			{ expectedValue: proseText("Bonjour") },
		],
	});
	expect(visited).toEqual([
		["updates", 0, "value"],
		["updates", 1, "value"],
		["updates", 2, "expectedValue"],
	]);
	// The whole canonical shape still owns language and operation validation.
	expect(() => updateTranslationsInputSchema.parse(result)).not.toThrow();
});
