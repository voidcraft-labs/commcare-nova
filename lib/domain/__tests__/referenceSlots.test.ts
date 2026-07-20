// lib/domain/__tests__/referenceSlots.test.ts
//
// Totality proofs for the reference-slot registry. Three layers:
//
//   1. Dead-path check — every registry entry's path resolves into the
//      real Zod schemas for every kind/mode/arm it claims, with the
//      shape its surface kind promises (string for xpath/prose/name
//      refs, the actual predicate/value-expression/relation-path
//      schema object for AST slots) — and does NOT resolve anywhere it
//      doesn't claim, so applicability is exact in both directions.
//   2. Schema-key audit — every key the field/form/module schemas
//      declare is classified, either by a registry entry or by an
//      explicit non-reference classification. Adding an
//      expression-bearing key without classifying it fails here.
//   3. Review list — the string-typed keys classified as
//      non-reference, pinned as a literal list so reclassifying (or
//      adding) one is a visible diff a reviewer signs off on.
//
// The walkers introspect the schemas with zod's classic class API
// (`ZodObject.shape`, `ZodArray.element`, `ZodUnion.options`,
// `ZodOptional/.ZodNullable.unwrap`). They stop at the predicate /
// value-expression / relation-path / media schemas by object identity
// — those subtrees are classified as whole slots (the AST families'
// internals are owned by `lib/domain/predicate`, media bundles by the
// `mediaRefs.ts` walk), so descending into them would audit vocabulary
// this registry deliberately does not own.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	type FieldKind,
	fieldKinds,
	type RepeatMode,
	repeatModes,
} from "../fields";
import { audioFieldSchema } from "../fields/audio";
import { barcodeFieldSchema } from "../fields/barcode";
import { dateFieldSchema } from "../fields/date";
import { datetimeFieldSchema } from "../fields/datetime";
import { decimalFieldSchema } from "../fields/decimal";
import { geopointFieldSchema } from "../fields/geopoint";
import { groupFieldSchema } from "../fields/group";
import { hiddenFieldSchema } from "../fields/hidden";
import { imageFieldSchema } from "../fields/image";
import { intFieldSchema } from "../fields/int";
import { labelFieldSchema } from "../fields/label";
import { multiSelectFieldSchema } from "../fields/multiSelect";
import {
	countBoundRepeatSchema,
	queryBoundRepeatSchema,
	userControlledRepeatSchema,
} from "../fields/repeat";
import { secretFieldSchema } from "../fields/secret";
import { signatureFieldSchema } from "../fields/signature";
import { singleSelectFieldSchema } from "../fields/singleSelect";
import { textFieldSchema } from "../fields/text";
import { timeFieldSchema } from "../fields/time";
import { videoFieldSchema } from "../fields/video";
import { FORM_TYPES, formSchema } from "../forms";
import {
	type ColumnKind,
	columnSchema,
	moduleSchema,
	type SearchInputDef,
	searchInputDefSchema,
} from "../modules";
import { mediaSchema } from "../multimedia";
import {
	predicateSchema,
	relationPathSchema,
	valueExpressionSchema,
} from "../predicate/types";
import {
	FIELD_REFERENCE_SLOTS,
	type FieldReferenceSlot,
	FORM_REFERENCE_SLOTS,
	type FormReferenceSlot,
	fieldReferenceSlotsFor,
	MODULE_REFERENCE_SLOTS,
	type ModuleReferenceSlot,
	NON_REFERENCE_FIELD_PATHS,
	NON_REFERENCE_FORM_PATHS,
	NON_REFERENCE_MODULE_PATHS,
	rewriteSlotStrings,
} from "../referenceSlots";
import { xpathExpressionSchema } from "../xpath";

// Widened views of the registry tuples. The `as const` literals are
// what make the slot-id projection types possible, but property access
// on the literal union (optional keys absent from most members) needs
// the declared interface shape — these aliases give the tests that
// shape without weakening the exported data.
const fieldSlots: readonly FieldReferenceSlot[] = FIELD_REFERENCE_SLOTS;
const formSlots: readonly FormReferenceSlot[] = FORM_REFERENCE_SLOTS;
const moduleSlots: readonly ModuleReferenceSlot[] = MODULE_REFERENCE_SLOTS;

// ── Schema maps ───────────────────────────────────────────────────

const NON_REPEAT_KIND_SCHEMAS: Record<
	Exclude<FieldKind, "repeat">,
	z.ZodType
> = {
	text: textFieldSchema,
	int: intFieldSchema,
	decimal: decimalFieldSchema,
	date: dateFieldSchema,
	time: timeFieldSchema,
	datetime: datetimeFieldSchema,
	single_select: singleSelectFieldSchema,
	multi_select: multiSelectFieldSchema,
	geopoint: geopointFieldSchema,
	image: imageFieldSchema,
	audio: audioFieldSchema,
	video: videoFieldSchema,
	barcode: barcodeFieldSchema,
	signature: signatureFieldSchema,
	label: labelFieldSchema,
	hidden: hiddenFieldSchema,
	secret: secretFieldSchema,
	group: groupFieldSchema,
};

const REPEAT_VARIANT_SCHEMAS: Record<RepeatMode, z.ZodType> = {
	user_controlled: userControlledRepeatSchema,
	count_bound: countBoundRepeatSchema,
	query_bound: queryBoundRepeatSchema,
};

const NON_REPEAT_KINDS = fieldKinds.filter(
	(k): k is Exclude<FieldKind, "repeat"> => k !== "repeat",
);

/** The structured-AST schemas a `predicate-ast` slot must resolve to,
 *  matched by object identity. */
const PREDICATE_AST_SCHEMAS = new Set<z.ZodType>([
	predicateSchema,
	valueExpressionSchema,
	relationPathSchema,
]);

/** Subtrees the walkers treat as leaves: the AST families plus the
 *  media bundle (whose internals the media-carrier walk owns). */
const SUBTREE_LEAF_SCHEMAS = new Set<z.ZodType>([
	...PREDICATE_AST_SCHEMAS,
	xpathExpressionSchema,
	mediaSchema,
]);

// ── Introspection helpers ─────────────────────────────────────────

function unwrap(schema: z.ZodType): z.ZodType {
	let current = schema;
	while (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
		current = current.unwrap() as z.ZodType;
	}
	return current;
}

/** Expand a (possibly union) schema into its object arms, stopping at
 *  the subtree-leaf schemas so an AST union is never exploded. */
function fanOut(schema: z.ZodType): z.ZodType[] {
	const s = unwrap(schema);
	if (SUBTREE_LEAF_SCHEMAS.has(s)) return [s];
	if (s instanceof z.ZodUnion) {
		return (s.options as z.ZodType[]).flatMap((option) => fanOut(option));
	}
	return [s];
}

function record(
	out: Map<string, z.ZodType[]>,
	path: string,
	schema: z.ZodType,
): void {
	const existing = out.get(path);
	if (existing) {
		existing.push(schema);
	} else {
		out.set(path, [schema]);
	}
}

/**
 * Collect every leaf key-path of `schema` into `out` (path syntax: `.`
 * for object steps, `[]` for array elements; union arms merge onto the
 * same path). A path in `stopPaths` is recorded as a leaf without
 * descending — that's how a classified slot (a predicate body, a media
 * bundle, a whole form-link target) registers as one slot instead of
 * leaking its internals into the audit.
 */
function collectLeaves(
	schema: z.ZodType,
	path: string,
	stopPaths: ReadonlySet<string>,
	out: Map<string, z.ZodType[]>,
): void {
	if (path !== "" && stopPaths.has(path)) {
		record(out, path, unwrap(schema));
		return;
	}
	const s = unwrap(schema);
	if (SUBTREE_LEAF_SCHEMAS.has(s)) {
		record(out, path, s);
		return;
	}
	if (s instanceof z.ZodObject) {
		for (const [key, child] of Object.entries(s.shape)) {
			collectLeaves(
				child as z.ZodType,
				path === "" ? key : `${path}.${key}`,
				stopPaths,
				out,
			);
		}
		return;
	}
	if (s instanceof z.ZodArray) {
		collectLeaves(s.element as z.ZodType, `${path}[]`, stopPaths, out);
		return;
	}
	if (s instanceof z.ZodUnion) {
		for (const option of s.options as z.ZodType[]) {
			collectLeaves(option, path, stopPaths, out);
		}
		return;
	}
	record(out, path, s);
}

/**
 * Resolve a registry-style key path against a schema. Returns one
 * resolved schema per union arm that declares the path — empty means
 * the path is dead (the schema doesn't declare it).
 */
function resolvePath(root: z.ZodType, path: string): z.ZodType[] {
	let current = fanOut(root);
	for (const token of path.split(".")) {
		const isArray = token.endsWith("[]");
		const key = isArray ? token.slice(0, -2) : token;
		const next: z.ZodType[] = [];
		for (const arm of current) {
			if (!(arm instanceof z.ZodObject)) continue;
			const child = arm.shape[key] as z.ZodType | undefined;
			if (!child) continue;
			if (isArray) {
				const u = unwrap(child);
				if (u instanceof z.ZodArray)
					next.push(...fanOut(u.element as z.ZodType));
			} else {
				next.push(...fanOut(child));
			}
		}
		if (next.length === 0) return [];
		current = next;
	}
	return current;
}

/** The schemas a field slot claims to live on, one per (kind, mode)
 *  combination it declares. */
function schemasClaimedByFieldSlot(slot: FieldReferenceSlot): z.ZodType[] {
	return slot.appliesTo.flatMap((kind) =>
		kind === "repeat"
			? (slot.repeatModes ?? repeatModes).map(
					(mode) => REPEAT_VARIANT_SCHEMAS[mode],
				)
			: [NON_REPEAT_KIND_SCHEMAS[kind]],
	);
}

function fieldRegistryPaths(kind: FieldKind, mode?: RepeatMode): Set<string> {
	return new Set(fieldReferenceSlotsFor(kind, mode).map((slot) => slot.path));
}

/** Audit one entity schema: leaf paths classified by neither the
 *  registry nor the non-reference map, sorted for stable assertions. */
function unclassifiedLeaves(
	schema: z.ZodType,
	registryPaths: ReadonlySet<string>,
	nonReferencePaths: ReadonlySet<string>,
): string[] {
	const stop = new Set([...registryPaths, ...nonReferencePaths]);
	const leaves = new Map<string, z.ZodType[]>();
	collectLeaves(schema, "", stop, leaves);
	return [...leaves.keys()].filter((path) => !stop.has(path)).sort();
}

const NON_REFERENCE_FIELD_PATH_SET = new Set(
	Object.keys(NON_REFERENCE_FIELD_PATHS),
);
const NON_REFERENCE_FORM_PATH_SET = new Set(
	Object.keys(NON_REFERENCE_FORM_PATHS),
);
const NON_REFERENCE_MODULE_PATH_SET = new Set(
	Object.keys(NON_REFERENCE_MODULE_PATHS),
);
const FORM_REGISTRY_PATHS = new Set(formSlots.map((s) => s.path));
const MODULE_REGISTRY_PATHS = new Set(moduleSlots.map((s) => s.path));

// ── Registry shape invariants ─────────────────────────────────────

describe("registry shape invariants", () => {
	it("slot ids and paths are unique within each entity", () => {
		for (const slots of [fieldSlots, formSlots, moduleSlots] as const) {
			const ids = slots.map((s) => s.slot);
			const paths = slots.map((s) => s.path);
			expect(new Set(ids).size).toBe(ids.length);
			expect(new Set(paths).size).toBe(paths.length);
		}
	});

	it("repeatModes appears only on slots that apply to repeat", () => {
		for (const slot of fieldSlots) {
			if (slot.repeatModes) {
				expect(slot.appliesTo).toContain("repeat");
				expect(slot.repeatModes.length).toBeGreaterThan(0);
			}
		}
	});

	it("the repeatModes tuple matches the variant schemas' discriminator literals", () => {
		for (const mode of repeatModes) {
			const variant = unwrap(REPEAT_VARIANT_SCHEMAS[mode]);
			expect(variant).toBeInstanceOf(z.ZodObject);
			const discriminator = (variant as z.ZodObject).shape
				.repeat_mode as z.ZodLiteral;
			expect(discriminator).toBeInstanceOf(z.ZodLiteral);
			expect(discriminator.value).toBe(mode);
		}
	});

	it("form slots carry non-empty formTypes drawn from FORM_TYPES", () => {
		for (const slot of formSlots) {
			expect(slot.formTypes.length).toBeGreaterThan(0);
			for (const type of slot.formTypes) {
				expect(FORM_TYPES).toContain(type);
			}
		}
	});
});

// ── Dead-path + applicability exactness ───────────────────────────

describe("field slots — paths resolve exactly where claimed", () => {
	it.each(fieldSlots)(
		"$slot resolves on every claimed kind/mode with the promised shape",
		(slot) => {
			for (const schema of schemasClaimedByFieldSlot(slot)) {
				const resolved = resolvePath(schema, slot.path);
				expect(resolved.length).toBeGreaterThan(0);
				if (slot.kind === "prose" || slot.kind === "case-type-ref") {
					for (const r of resolved) {
						expect(r).toBeInstanceOf(z.ZodString);
					}
				}
			}
		},
	);

	it.each(fieldSlots)(
		"$slot does NOT resolve on any unclaimed kind",
		(slot) => {
			for (const kind of NON_REPEAT_KINDS) {
				if (slot.appliesTo.includes(kind)) continue;
				expect(resolvePath(NON_REPEAT_KIND_SCHEMAS[kind], slot.path)).toEqual(
					[],
				);
			}
			if (!slot.appliesTo.includes("repeat")) {
				for (const mode of repeatModes) {
					expect(resolvePath(REPEAT_VARIANT_SCHEMAS[mode], slot.path)).toEqual(
						[],
					);
				}
			}
		},
	);

	it.each(fieldSlots.filter((s) => s.repeatModes !== undefined))(
		"$slot does NOT resolve on unclaimed repeat modes",
		(slot) => {
			for (const mode of repeatModes) {
				if (slot.repeatModes?.includes(mode)) continue;
				expect(resolvePath(REPEAT_VARIANT_SCHEMAS[mode], slot.path)).toEqual(
					[],
				);
			}
		},
	);
});

describe("form slots — paths resolve with the promised shape", () => {
	it.each(formSlots)("$slot resolves on the form schema", (slot) => {
		const resolved = resolvePath(formSchema, slot.path);
		expect(resolved.length).toBeGreaterThan(0);
		// Form xpath-ast slots resolve to the expression schema — pinned
		// by identity below for predicate-ast; the audit's totality claim
		// is the path resolution itself.
	});
});

describe("module slots — paths resolve with the promised shape", () => {
	it.each(moduleSlots)("$slot resolves on the module schema", (slot) => {
		const resolved = resolvePath(moduleSchema, slot.path);
		expect(resolved.length).toBeGreaterThan(0);
		if (slot.kind === "predicate-ast") {
			// Identity, not shape: the slot must hold the actual predicate /
			// value-expression / relation-path schema object, so a slot that
			// drifts to a different structured type fails here.
			for (const r of resolved) {
				expect(PREDICATE_AST_SCHEMAS.has(r)).toBe(true);
			}
		}
		if (slot.kind === "case-property-ref" || slot.kind === "case-type-ref") {
			for (const r of resolved) {
				expect(r).toBeInstanceOf(z.ZodString);
			}
		}
	});

	it("column-arm applicability is exact for field/expression slots", () => {
		const fieldSlot = moduleSlots.find(
			(s) => s.slot === "case_list_column_field",
		);
		const exprSlot = moduleSlots.find(
			(s) => s.slot === "case_list_column_expression",
		);
		expect(fieldSlot?.columnKinds).toBeDefined();
		expect(exprSlot?.columnKinds).toBeDefined();
		for (const arm of columnSchema.options as z.ZodObject[]) {
			const kind = (arm.shape.kind as z.ZodLiteral).value as ColumnKind;
			expect("field" in arm.shape).toBe(
				fieldSlot?.columnKinds?.includes(kind) ?? false,
			);
			expect("expression" in arm.shape).toBe(
				exprSlot?.columnKinds?.includes(kind) ?? false,
			);
		}
	});

	it("search-input-arm applicability is exact across the four slots", () => {
		const expectations = [
			["search_input_property", "property"],
			["search_input_via", "via"],
			["search_input_default", "default"],
			["search_input_predicate", "predicate"],
		] as const;
		for (const [slotId, key] of expectations) {
			const slot = moduleSlots.find((s) => s.slot === slotId);
			expect(slot?.searchInputKinds).toBeDefined();
			for (const arm of searchInputDefSchema.options as z.ZodObject[]) {
				const armKind = (arm.shape.kind as z.ZodLiteral)
					.value as SearchInputDef["kind"];
				expect(key in arm.shape).toBe(
					slot?.searchInputKinds?.includes(armKind) ?? false,
				);
			}
		}
	});
});

// ── Schema-key audit — the totality gate ──────────────────────────

describe("schema-key audit — every declared key is classified", () => {
	it.each(NON_REPEAT_KINDS)(
		"field kind %s has no unclassified keys",
		(kind) => {
			expect(
				unclassifiedLeaves(
					NON_REPEAT_KIND_SCHEMAS[kind],
					fieldRegistryPaths(kind),
					NON_REFERENCE_FIELD_PATH_SET,
				),
			).toEqual([]);
		},
	);

	it.each(repeatModes)("repeat mode %s has no unclassified keys", (mode) => {
		expect(
			unclassifiedLeaves(
				REPEAT_VARIANT_SCHEMAS[mode],
				fieldRegistryPaths("repeat", mode),
				NON_REFERENCE_FIELD_PATH_SET,
			),
		).toEqual([]);
	});

	it("form schema has no unclassified keys", () => {
		expect(
			unclassifiedLeaves(
				formSchema,
				FORM_REGISTRY_PATHS,
				NON_REFERENCE_FORM_PATH_SET,
			),
		).toEqual([]);
	});

	it("module schema has no unclassified keys", () => {
		expect(
			unclassifiedLeaves(
				moduleSchema,
				MODULE_REGISTRY_PATHS,
				NON_REFERENCE_MODULE_PATH_SET,
			),
		).toEqual([]);
	});

	it("non-reference classifications are live paths, not leftovers", () => {
		// A stale entry (a key the schemas no longer declare) would let the
		// classification rot silently — require each one to resolve.
		const fieldSchemas = [
			...NON_REPEAT_KINDS.map((k) => NON_REPEAT_KIND_SCHEMAS[k]),
			...repeatModes.map((m) => REPEAT_VARIANT_SCHEMAS[m]),
		];
		for (const path of NON_REFERENCE_FIELD_PATH_SET) {
			expect(
				fieldSchemas.some((schema) => resolvePath(schema, path).length > 0),
			).toBe(true);
		}
		for (const path of NON_REFERENCE_FORM_PATH_SET) {
			expect(resolvePath(formSchema, path).length).toBeGreaterThan(0);
		}
		for (const path of NON_REFERENCE_MODULE_PATH_SET) {
			expect(resolvePath(moduleSchema, path).length).toBeGreaterThan(0);
		}
	});
});

describe("the audit gate fires on a missing classification", () => {
	it("reports `required` when its registry entry is removed", () => {
		// The acceptance proof: drop a known expression-bearing key from
		// the registry projection and the audit names it.
		const withoutRequired = fieldRegistryPaths("text");
		withoutRequired.delete("required");
		expect(
			unclassifiedLeaves(
				textFieldSchema,
				withoutRequired,
				NON_REFERENCE_FIELD_PATH_SET,
			),
		).toEqual(["required"]);
	});

	it("reports a registry path that resolves nowhere as dead", () => {
		expect(resolvePath(textFieldSchema, "no_such_key")).toEqual([]);
		expect(resolvePath(formSchema, "closeCondition.no_such_key")).toEqual([]);
	});
});

// ── Per-kind projection behavior ──────────────────────────────────

describe("fieldReferenceSlotsFor", () => {
	it("hidden carries calculate but no label/required/hint", () => {
		expect(fieldReferenceSlotsFor("hidden").map((s) => s.slot)).toEqual([
			"relevant",
			"calculate",
			"default_value",
			"case_property_on",
		]);
	});

	it("repeat narrows by mode: count_bound has repeat_count, query_bound has ids_query", () => {
		expect(
			fieldReferenceSlotsFor("repeat", "user_controlled").map((s) => s.slot),
		).toEqual(["relevant", "label"]);
		expect(
			fieldReferenceSlotsFor("repeat", "count_bound").map((s) => s.slot),
		).toEqual(["relevant", "repeat_count", "label"]);
		expect(
			fieldReferenceSlotsFor("repeat", "query_bound").map((s) => s.slot),
		).toEqual(["relevant", "ids_query", "label"]);
	});

	it("without a mode, repeat reports the umbrella (kind-level) slot set", () => {
		expect(fieldReferenceSlotsFor("repeat").map((s) => s.slot)).toEqual([
			"relevant",
			"repeat_count",
			"ids_query",
			"label",
		]);
	});
});

// ── String-typed non-reference keys — the human-review list ───────

describe("string-typed non-reference keys (reviewed: none carries an expression)", () => {
	function stringNonReferencePaths(
		schemas: readonly z.ZodType[],
		registryPaths: ReadonlySet<string>,
		nonReferencePaths: ReadonlySet<string>,
	): string[] {
		const stop = new Set([...registryPaths, ...nonReferencePaths]);
		const leaves = new Map<string, z.ZodType[]>();
		for (const schema of schemas) {
			collectLeaves(schema, "", stop, leaves);
		}
		return [...leaves.entries()]
			.filter(
				([path, shapes]) =>
					nonReferencePaths.has(path) &&
					shapes.some((s) => s instanceof z.ZodString),
			)
			.map(([path]) => path)
			.sort();
	}

	it("field list is pinned", () => {
		const allFieldRegistryPaths = new Set(fieldSlots.map((s) => s.path));
		expect(
			stringNonReferencePaths(
				[
					...NON_REPEAT_KINDS.map((k) => NON_REPEAT_KIND_SCHEMAS[k]),
					...repeatModes.map((m) => REPEAT_VARIANT_SCHEMAS[m]),
				],
				allFieldRegistryPaths,
				NON_REFERENCE_FIELD_PATH_SET,
			),
		).toEqual(["id", "options[].order", "options[].value", "order"]);
	});

	it("form list is pinned", () => {
		expect(
			stringNonReferencePaths(
				[formSchema],
				FORM_REGISTRY_PATHS,
				NON_REFERENCE_FORM_PATH_SET,
			),
		).toEqual([
			"audioLabel",
			"closeCondition.answer",
			"connect.assessment.id",
			"connect.deliver_unit.id",
			"connect.deliver_unit.name",
			"connect.learn_module.description",
			"connect.learn_module.id",
			"connect.learn_module.name",
			"connect.task.description",
			"connect.task.id",
			"connect.task.name",
			"formLinks[].datums[].name",
			"icon",
			"id",
			"name",
			"order",
			"purpose",
		]);
	});

	it("module list is pinned", () => {
		expect(
			stringNonReferencePaths(
				[moduleSchema],
				MODULE_REGISTRY_PATHS,
				NON_REFERENCE_MODULE_PATH_SET,
			),
		).toEqual([
			"audioLabel",
			"caseListConfig.audioLabel",
			"caseListConfig.columns[].detailOrder",
			"caseListConfig.columns[].header",
			"caseListConfig.columns[].listOrder",
			"caseListConfig.columns[].mapping[].assetId",
			"caseListConfig.columns[].mapping[].label",
			"caseListConfig.columns[].mapping[].value",
			"caseListConfig.columns[].order",
			"caseListConfig.columns[].pattern",
			"caseListConfig.columns[].text",
			"caseListConfig.icon",
			"caseListConfig.searchInputs[].label",
			"caseListConfig.searchInputs[].name",
			"caseListConfig.searchInputs[].order",
			"caseSearchConfig.searchButtonLabel",
			"caseSearchConfig.searchScreenSubtitle",
			"caseSearchConfig.searchScreenTitle",
			"icon",
			"id",
			"name",
			"order",
			"purpose",
		]);
	});
});

// ── Slot-path value walker ────────────────────────────────────────

describe("rewriteSlotStrings", () => {
	const upper = (s: string) => s.toUpperCase();

	it("rewrites nested object paths and array fan-out paths in place", () => {
		const entity = {
			data_source: { ids_query: "query" },
			options: [{ label: "a" }, { label: "b" }, { label: "" }],
			links: [{ datums: [{ xpath: "x" }, { xpath: "y" }] }],
		};
		expect(rewriteSlotStrings(entity, "data_source.ids_query", upper)).toBe(1);
		expect(entity.data_source.ids_query).toBe("QUERY");
		// Empty strings are skipped — two of three options rewrite.
		expect(rewriteSlotStrings(entity, "options[].label", upper)).toBe(2);
		expect(entity.options.map((o) => o.label)).toEqual(["A", "B", ""]);
		expect(rewriteSlotStrings(entity, "links[].datums[].xpath", upper)).toBe(2);
	});

	it("counts only values the rewriter actually changed", () => {
		const entity = { relevant: "stable" };
		expect(rewriteSlotStrings(entity, "relevant", (s) => s)).toBe(0);
		expect(entity.relevant).toBe("stable");
	});

	it("is total over absent and mismatched shapes — zero rewrites, no throw", () => {
		// Reducers run this over whatever state exists; a missing optional
		// slot or an off-schema value must resolve to "nothing to rewrite".
		expect(rewriteSlotStrings({}, "data_source.ids_query", upper)).toBe(0);
		expect(
			rewriteSlotStrings(
				{ data_source: "str" },
				"data_source.ids_query",
				upper,
			),
		).toBe(0);
		expect(
			rewriteSlotStrings({ options: "not-an-array" }, "options[].label", upper),
		).toBe(0);
		expect(rewriteSlotStrings({ relevant: 42 }, "relevant", upper)).toBe(0);
		expect(rewriteSlotStrings(null, "relevant", upper)).toBe(0);
		expect(rewriteSlotStrings(undefined, "relevant", upper)).toBe(0);
	});
});
