// lib/domain/__tests__/expressionSource.test.ts
//
// Pins the expression-source read accessor against the reference-slot
// registry at the VALUE level (the audit test in
// `referenceSlots.test.ts` proves the registry against the Zod
// schemas at the TYPE level):
//
//   1. Every xpath/prose registry slot resolves on a schema-valid
//      fixture field of EVERY kind (and repeat mode) it claims —
//      nested paths (`data_source.ids_query`) and fan-out paths
//      (`options[].label`, with pairing indices) included.
//   2. The single-slot reads are TOTAL (they report whatever string is
//      stored, including the empty string, without applicability
//      gating) while `expressionSurfaceReads` IS gated by the per-kind
//      projection — the split the validator's scans and the emitters'
//      `readFieldString` delegation both rely on.
//   3. The form-level Connect slots resolve on a schema-valid form.

import { describe, expect, it } from "vitest";
import {
	CONNECT_XPATH_SLOT_IDS,
	expressionSource,
	expressionSourceEntries,
	expressionSurfaceReads,
	type FieldExpressionSlotId,
	formExpressionSource,
	isScalarFieldExpressionSlotId,
	type ScalarFieldExpressionSlotId,
} from "../expressionSource";
import type { Field, FieldKind, RepeatMode } from "../fields";
import { repeatModes } from "../fields";
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
import { type Form, formSchema } from "../forms";
import {
	FIELD_REFERENCE_SLOTS,
	type FieldReferenceSlot,
} from "../referenceSlots";
import { opaqueXPathExpression } from "../xpath";

// ── Fixtures ──────────────────────────────────────────────────────

/** Planted values are strings or opaque ASTs — nothing resolves, so an
 *  empty print surface suffices for every read in this file. */
const EMPTY_DOC = { forms: {}, fields: {}, fieldOrder: {} };

const KIND_SCHEMAS = {
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
} as const;

const REPEAT_SCHEMAS = {
	user_controlled: userControlledRepeatSchema,
	count_bound: countBoundRepeatSchema,
	query_bound: queryBoundRepeatSchema,
} as const;

/** Minimal schema-valid raw fixture for a kind (+ repeat mode). */
function rawFixture(
	kind: FieldKind,
	mode?: RepeatMode,
): Record<string, unknown> {
	const base = { uuid: crypto.randomUUID(), id: "fixture_field" };
	switch (kind) {
		case "hidden":
		case "group":
			return { ...base, kind };
		case "repeat": {
			const repeatMode = mode ?? "user_controlled";
			if (repeatMode === "count_bound") {
				return {
					...base,
					kind,
					repeat_mode: repeatMode,
					repeat_count: opaqueXPathExpression("3"),
				};
			}
			if (repeatMode === "query_bound") {
				return {
					...base,
					kind,
					repeat_mode: repeatMode,
					data_source: {
						ids_query: opaqueXPathExpression(
							"instance('casedb')/casedb/case/@case_id",
						),
					},
				};
			}
			return { ...base, kind, repeat_mode: repeatMode };
		}
		case "single_select":
		case "multi_select":
			return {
				...base,
				kind,
				label: "Pick one",
				options: [
					{ value: "a", label: "Option A" },
					{ value: "b", label: "Option B" },
				],
			};
		default:
			return { ...base, kind, label: "Fixture" };
	}
}

/** Parse a raw fixture through the kind's real Zod schema — the proof
 *  that the planted slot value is schema-legal on that kind. */
function parseFixture(
	raw: Record<string, unknown>,
	kind: FieldKind,
	mode?: RepeatMode,
): Field {
	const schema =
		kind === "repeat"
			? REPEAT_SCHEMAS[mode ?? "user_controlled"]
			: KIND_SCHEMAS[kind];
	return schema.parse(raw) as Field;
}

/** Set a value at a registry slot path on a raw fixture, fanning out
 *  over `[]` segments — the planting mirror of `readSlotStrings`. */
function plantAtPath(
	entity: Record<string, unknown>,
	path: string,
	make: (indices: readonly number[]) => unknown,
): void {
	const walk = (
		node: Record<string, unknown>,
		segments: readonly string[],
		indices: readonly number[],
	): void => {
		const head = segments[0];
		if (head === undefined) return;
		const fanOut = head.endsWith("[]");
		const key = fanOut ? head.slice(0, -2) : head;
		const rest = segments.slice(1);
		if (fanOut) {
			const elements = node[key] as Record<string, unknown>[];
			elements.forEach((element, index) => {
				walk(element, rest, [...indices, index]);
			});
			return;
		}
		if (rest.length === 0) {
			node[key] = make(indices);
			return;
		}
		if (node[key] === undefined) node[key] = {};
		walk(node[key] as Record<string, unknown>, rest, indices);
	};
	walk(entity, path.split("."), []);
}

function plantedText(slot: string, indices: readonly number[]): string {
	return indices.length === 0
		? `planted ${slot}`
		: `planted ${slot} [${indices.join(".")}]`;
}

// ── Every registry expression slot resolves on every claimed kind ──

const fieldSlots: readonly FieldReferenceSlot[] = FIELD_REFERENCE_SLOTS;
const expressionSlots = fieldSlots.filter(
	(slot) => slot.kind === "xpath-ast" || slot.kind === "prose",
);

describe("expressionSource resolves every registry xpath/prose slot", () => {
	for (const slot of expressionSlots) {
		for (const kind of slot.appliesTo) {
			const modes: readonly (RepeatMode | undefined)[] =
				kind === "repeat" ? (slot.repeatModes ?? repeatModes) : [undefined];
			for (const mode of modes) {
				it(`${slot.slot} on ${kind}${mode ? ` (${mode})` : ""}`, () => {
					const raw = rawFixture(kind, mode);
					// AST slots store the expression structurally; the planted
					// opaque run projects back to the same text on read.
					plantAtPath(raw, slot.path, (indices) =>
						slot.kind === "xpath-ast"
							? opaqueXPathExpression(plantedText(slot.slot, indices))
							: plantedText(slot.slot, indices),
					);
					const field = parseFixture(raw, kind, mode);

					const entries = expressionSourceEntries(
						field,
						slot.slot as FieldExpressionSlotId,
						EMPTY_DOC,
					);
					expect(entries.length).toBeGreaterThan(0);
					for (const entry of entries) {
						expect(entry.text).toBe(plantedText(slot.slot, entry.indices));
					}

					if (!slot.path.includes("[]")) {
						expect(entries).toHaveLength(1);
						expect(
							expressionSource(
								field,
								slot.slot as ScalarFieldExpressionSlotId,
								EMPTY_DOC,
							),
						).toBe(plantedText(slot.slot, []));
					}
				});
			}
		}
	}

	it("fans out option_label with pairing indices, one per option", () => {
		const raw = rawFixture("single_select");
		plantAtPath(raw, "options[].label", (indices) =>
			plantedText("option_label", indices),
		);
		const field = parseFixture(raw, "single_select");
		expect(expressionSourceEntries(field, "option_label", EMPTY_DOC)).toEqual([
			{ indices: [0], text: "planted option_label [0]" },
			{ indices: [1], text: "planted option_label [1]" },
		]);
	});
});

// ── Total-read contract ───────────────────────────────────────────

describe("single-slot reads are total", () => {
	it("absent slot reads as undefined / zero entries", () => {
		const field = parseFixture(rawFixture("text"), "text");
		expect(expressionSource(field, "relevant", EMPTY_DOC)).toBeUndefined();
		expect(expressionSourceEntries(field, "relevant", EMPTY_DOC)).toEqual([]);
		expect(expressionSource(field, "calculate", EMPTY_DOC)).toBeUndefined();
	});

	it("the empty expression is a stored value, projecting as the empty string", () => {
		const raw = rawFixture("text");
		plantAtPath(raw, "relevant", () => opaqueXPathExpression(""));
		const field = parseFixture(raw, "text");
		expect(expressionSource(field, "relevant", EMPTY_DOC)).toBe("");
	});

	it("reads whatever is stored even when the kind's schema lacks the slot", () => {
		// Off-schema docs (fixture builders, replay, recovery scripts)
		// behave exactly like the direct property reads this accessor
		// replaced: the value is visible to a single-slot read…
		const field = parseFixture(rawFixture("text"), "text");
		(field as Record<string, unknown>).calculate = "1 + 1";
		expect(expressionSource(field, "calculate", EMPTY_DOC)).toBe("1 + 1");
	});
});

// ── Registry-projection iteration (gated) ─────────────────────────

describe("expressionSurfaceReads", () => {
	it("walks xpath slots in registry order", () => {
		const raw = rawFixture("text");
		for (const path of ["relevant", "validate", "default_value"]) {
			plantAtPath(raw, path, () => opaqueXPathExpression(`expr ${path}`));
		}
		plantAtPath(raw, "required", () => opaqueXPathExpression("expr required"));
		const field = parseFixture(raw, "text");
		expect(
			expressionSurfaceReads(field, "xpath", EMPTY_DOC).map((r) => r.slot),
		).toEqual(["relevant", "validate", "default_value", "required"]);
	});

	it("walks prose slots in registry order, options fanned out last", () => {
		const raw = rawFixture("single_select");
		for (const path of ["hint", "help", "validate_msg"]) {
			plantAtPath(raw, path, () => `text ${path}`);
		}
		const field = parseFixture(raw, "single_select");
		expect(
			expressionSurfaceReads(field, "prose", EMPTY_DOC).map((r) => [
				r.slot,
				...r.indices,
			]),
		).toEqual([
			["label"],
			["hint"],
			["help"],
			["validate_msg"],
			["option_label", 0],
			["option_label", 1],
		]);
	});

	it("narrows the repeat projection by mode", () => {
		const countBound = parseFixture(
			rawFixture("repeat", "count_bound"),
			"repeat",
			"count_bound",
		);
		expect(
			expressionSurfaceReads(countBound, "xpath", EMPTY_DOC).map((r) => r.slot),
		).toEqual(["repeat_count"]);

		const queryBound = parseFixture(
			rawFixture("repeat", "query_bound"),
			"repeat",
			"query_bound",
		);
		expect(
			expressionSurfaceReads(queryBound, "xpath", EMPTY_DOC).map((r) => r.slot),
		).toEqual(["ids_query"]);

		const userControlled = parseFixture(
			rawFixture("repeat", "user_controlled"),
			"repeat",
			"user_controlled",
		);
		expect(expressionSurfaceReads(userControlled, "xpath", EMPTY_DOC)).toEqual(
			[],
		);
	});

	it("does not surface a value parked on a kind whose schema lacks the slot", () => {
		// …while the gated projection walk skips it (the per-kind
		// applicability the validator's scans rely on).
		const field = parseFixture(rawFixture("text"), "text");
		(field as Record<string, unknown>).calculate = "1 + 1";
		expect(
			expressionSurfaceReads(field, "xpath", EMPTY_DOC).map((r) => r.slot),
		).not.toContain("calculate");
	});
});

// ── Form-level slots ──────────────────────────────────────────────

describe("formExpressionSource", () => {
	it("resolves each Connect xpath slot on a schema-valid form", () => {
		const form: Form = formSchema.parse({
			uuid: crypto.randomUUID(),
			id: "fixture_form",
			name: "Fixture",
			type: "followup",
			connect: {
				assessment: { user_score: opaqueXPathExpression("#form/score") },
				deliver_unit: {
					name: "Unit",
					entity_id: opaqueXPathExpression("#form/entity"),
					entity_name: opaqueXPathExpression("#form/entity_name"),
				},
			},
		});
		expect(formExpressionSource(form, "assessment_user_score", EMPTY_DOC)).toBe(
			"#form/score",
		);
		expect(formExpressionSource(form, "deliver_entity_id", EMPTY_DOC)).toBe(
			"#form/entity",
		);
		expect(formExpressionSource(form, "deliver_entity_name", EMPTY_DOC)).toBe(
			"#form/entity_name",
		);
	});

	it("reads undefined when the connect block is absent", () => {
		const form: Form = formSchema.parse({
			uuid: crypto.randomUUID(),
			id: "fixture_form",
			name: "Fixture",
			type: "survey",
		});
		expect(
			formExpressionSource(form, "assessment_user_score", EMPTY_DOC),
		).toBeUndefined();
		expect(
			formExpressionSource(form, "deliver_entity_id", EMPTY_DOC),
		).toBeUndefined();
	});

	it("CONNECT_XPATH_SLOT_IDS is the registry's connect projection in order", () => {
		expect(CONNECT_XPATH_SLOT_IDS).toEqual([
			"assessment_user_score",
			"deliver_entity_id",
			"deliver_entity_name",
		]);
	});
});

// ── Slot-id narrowing for `readFieldString` delegation ────────────

describe("isScalarFieldExpressionSlotId", () => {
	it("admits every scalar expression slot id, including the nested ids_query", () => {
		for (const slot of expressionSlots) {
			if (slot.path.includes("[]")) continue;
			expect(isScalarFieldExpressionSlotId(slot.slot)).toBe(true);
		}
	});

	it("rejects fan-out slots and non-expression keys", () => {
		expect(isScalarFieldExpressionSlotId("option_label")).toBe(false);
		expect(isScalarFieldExpressionSlotId("case_property_on")).toBe(false);
		expect(isScalarFieldExpressionSlotId("id")).toBe(false);
		expect(isScalarFieldExpressionSlotId("options")).toBe(false);
	});
});
