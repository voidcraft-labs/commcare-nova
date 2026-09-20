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
import { formIconRefSchema } from "@/lib/domain/builtinIcons";
import { AuthoringScope } from "../bindings";
import { AuthoringInputError } from "../errors";
import { parseAuthoringIcon, printAuthoringIcon } from "../icons";
import { parseQueryPredicate, parseQueryValue } from "../queryExpressions";
import {
	type AuthoringValueDecoders,
	authoringJsonSchema,
	authoringSchema,
	decodeAuthoringValues,
	encodeAuthoringValues,
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
	moduleIcon: noDecoder,
	formIcon: noDecoder,
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

it("authors a menu icon by its catalog name while the slot's own catalog still decides admission", () => {
	const tile = z.strictObject({ icon: formIconRefSchema.nullable() });
	const grammar = JSON.stringify(authoringJsonSchema(tile));
	expect(grammar).toContain('"register"');
	expect(grammar).not.toContain("nova-icon:");

	const decoders = { ...unavailable, formIcon: parseAuthoringIcon };
	const decode = (icon: string | null) =>
		tile.safeParse(decodeAuthoringValues(tile, { icon }, decoders));
	expect(decode("register")).toMatchObject({
		success: true,
		data: { icon: "nova-icon:register" },
	});
	expect(decode(null)).toMatchObject({ success: true, data: { icon: null } });
	// A module topic icon is a real catalog name, and still not a form icon.
	expect(decode("household").success).toBe(false);

	const encoders = { ...unavailable, formIcon: printAuthoringIcon };
	const uploaded = "0198c0de-0000-7000-8000-000000000001";
	for (const [stored, authored] of [
		["nova-icon:register", "register"],
		[uploaded, uploaded],
	])
		expect(encodeAuthoringValues(tile, { icon: stored }, encoders)).toEqual({
			icon: authored,
		});
});

it("reads a tagged stored value by its tag, and refuses one that belongs to no variant as Nova's defect", () => {
	const shape = z.strictObject({
		step: z.discriminatedUnion("kind", [
			z.strictObject({
				kind: z.literal("wait"),
				// A refinement tightened after this value was stored must not stop
				// anyone from reading it.
				days: z.number().refine((days) => days > 10),
			}),
			z.strictObject({ kind: z.literal("send"), to: z.string() }),
		]),
	});
	const stored = { step: { kind: "wait", days: 3 } };
	expect(encodeAuthoringValues(shape, stored, unavailable)).toEqual(stored);

	const untagged = z.strictObject({ slot: z.union([z.number(), z.boolean()]) });
	let failure: unknown;
	try {
		encodeAuthoringValues(untagged, { slot: "already authored" }, unavailable);
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(Error);
	expect(failure).not.toBeInstanceOf(AuthoringInputError);
	expect(String(failure)).toContain("slot");
	// The same value on the way IN is the caller's to correct.
	expect(() =>
		decodeAuthoringValues(untagged, { slot: "neither" }, unavailable),
	).toThrow(AuthoringInputError);
});
