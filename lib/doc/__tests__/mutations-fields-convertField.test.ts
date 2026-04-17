/**
 * Reducer tests for the `convertField` mutation.
 *
 * Covers the six conversion families declared in each kind's
 * `FieldKindMetadata.convertTargets` (the single source of truth, reachable
 * via `getConvertibleTypes`) plus invariants: uuid preserved, id/label
 * preserved, incompatible keys dropped, options transferred where both
 * kinds accept them, no-op when the kind is already the target, skip when
 * uuid is unknown, and rejection of cross-paradigm swaps not listed in
 * `convertTargets` (the reducer's authoritative convertibility gate).
 *
 * Test fixtures use `buildDoc` + `f` from `lib/__tests__/docHelpers.ts` to
 * produce normalized `BlueprintDoc` values without touching wire formats.
 * All field uuids are explicit strings to keep assertion code readable.
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { applyMutation } from "@/lib/doc/mutations";
import { asUuid } from "@/lib/domain";

// ---------------------------------------------------------------------------
// Shared fixture builder
// ---------------------------------------------------------------------------

/**
 * Build a doc with a single module, single form, and one field at the top
 * level. The field spec is passed through verbatim — callers set kind, id,
 * uuid, and any kind-specific properties.
 */
function docWithField(field: Parameters<typeof f>[0]) {
	return buildDoc({
		appId: "app-1",
		modules: [
			{
				uuid: "m-1",
				name: "M",
				forms: [
					{
						uuid: "form-1",
						name: "F",
						type: "registration",
						fields: [f(field)],
					},
				],
			},
		],
	});
}

// ---------------------------------------------------------------------------
// 1. Text ↔ Secret — text input family
// ---------------------------------------------------------------------------

describe("convertField — text / secret family", () => {
	it("text → secret preserves id, label, uuid, hint, required, validate", () => {
		const doc = docWithField({
			uuid: "q-1",
			kind: "text",
			id: "pin",
			label: "PIN",
			required: "true()",
			hint: "four digits",
			validate: "string-length(.) = 4",
		});
		const next = produce(doc, (d) => {
			applyMutation(d, {
				kind: "convertField",
				uuid: asUuid("q-1"),
				toKind: "secret",
			});
		});
		const converted = next.fields[asUuid("q-1")] as Record<string, unknown>;
		expect(converted.kind).toBe("secret");
		expect(converted.id).toBe("pin");
		expect(converted.label).toBe("PIN");
		expect(converted.uuid).toBe("q-1");
		expect(converted.hint).toBe("four digits");
		expect(converted.required).toBe("true()");
		expect(converted.validate).toBe("string-length(.) = 4");
		// `calculate` exists on text but not secret — must be stripped.
		expect(converted.calculate).toBeUndefined();
	});

	it("secret → text preserves id, label, hint, validate", () => {
		const doc = docWithField({
			uuid: "q-1",
			kind: "secret",
			id: "token",
			label: "Token",
			hint: "enter token",
			validate: "string-length(.) > 0",
		});
		const next = produce(doc, (d) => {
			applyMutation(d, {
				kind: "convertField",
				uuid: asUuid("q-1"),
				toKind: "text",
			});
		});
		const converted = next.fields[asUuid("q-1")] as Record<string, unknown>;
		expect(converted.kind).toBe("text");
		expect(converted.id).toBe("token");
		expect(converted.hint).toBe("enter token");
		expect(converted.validate).toBe("string-length(.) > 0");
	});
});

// ---------------------------------------------------------------------------
// 2. Int ↔ Decimal — numeric family
// ---------------------------------------------------------------------------

describe("convertField — int / decimal family", () => {
	it("int → decimal preserves id, label, uuid, and numeric validation", () => {
		const doc = docWithField({
			uuid: "q-1",
			kind: "int",
			id: "age",
			label: "Age",
			validate: ". > 0",
		});
		const next = produce(doc, (d) => {
			applyMutation(d, {
				kind: "convertField",
				uuid: asUuid("q-1"),
				toKind: "decimal",
			});
		});
		const converted = next.fields[asUuid("q-1")] as Record<string, unknown>;
		expect(converted.kind).toBe("decimal");
		expect(converted.id).toBe("age");
		expect(converted.uuid).toBe("q-1");
		expect(converted.validate).toBe(". > 0");
	});

	it("decimal → int preserves relevant and required", () => {
		const doc = docWithField({
			uuid: "q-1",
			kind: "decimal",
			id: "price",
			label: "Price",
			relevant: "/data/show_price = 'yes'",
			required: "true()",
		});
		const next = produce(doc, (d) => {
			applyMutation(d, {
				kind: "convertField",
				uuid: asUuid("q-1"),
				toKind: "int",
			});
		});
		const converted = next.fields[asUuid("q-1")] as Record<string, unknown>;
		expect(converted.kind).toBe("int");
		expect(converted.relevant).toBe("/data/show_price = 'yes'");
		expect(converted.required).toBe("true()");
	});
});

// ---------------------------------------------------------------------------
// 3. Temporal family — date / time / datetime
// ---------------------------------------------------------------------------

describe("convertField — temporal family", () => {
	it("date → time preserves id, label, uuid", () => {
		const doc = docWithField({
			uuid: "q-1",
			kind: "date",
			id: "visit_date",
			label: "Visit Date",
		});
		const next = produce(doc, (d) => {
			applyMutation(d, {
				kind: "convertField",
				uuid: asUuid("q-1"),
				toKind: "time",
			});
		});
		const converted = next.fields[asUuid("q-1")] as Record<string, unknown>;
		expect(converted.kind).toBe("time");
		expect(converted.id).toBe("visit_date");
		expect(converted.uuid).toBe("q-1");
	});

	it("datetime → date preserves relevant and case_property", () => {
		const doc = docWithField({
			uuid: "q-1",
			kind: "datetime",
			id: "appt_dt",
			label: "Appointment",
			relevant: ". != ''",
			case_property: "appointment_dt",
		});
		const next = produce(doc, (d) => {
			applyMutation(d, {
				kind: "convertField",
				uuid: asUuid("q-1"),
				toKind: "date",
			});
		});
		const converted = next.fields[asUuid("q-1")] as Record<string, unknown>;
		expect(converted.kind).toBe("date");
		expect(converted.relevant).toBe(". != ''");
		expect(converted.case_property).toBe("appointment_dt");
	});
});

// ---------------------------------------------------------------------------
// 4. Selection family — single_select ↔ multi_select
// ---------------------------------------------------------------------------

describe("convertField — selection family", () => {
	it("single_select → multi_select preserves options, id, label, uuid", () => {
		const doc = docWithField({
			uuid: "q-1",
			kind: "single_select",
			id: "color",
			label: "Color",
			options: [
				{ value: "r", label: "Red" },
				{ value: "b", label: "Blue" },
			],
		});
		const next = produce(doc, (d) => {
			applyMutation(d, {
				kind: "convertField",
				uuid: asUuid("q-1"),
				toKind: "multi_select",
			});
		});
		const converted = next.fields[asUuid("q-1")] as Record<string, unknown>;
		expect(converted.kind).toBe("multi_select");
		expect(converted.uuid).toBe("q-1");
		expect(converted.id).toBe("color");
		expect(converted.options as Array<{ value: string }>).toHaveLength(2);
		expect((converted.options as Array<{ value: string }>)[0].value).toBe("r");
	});

	it("multi_select → single_select transfers options", () => {
		const doc = docWithField({
			uuid: "q-1",
			kind: "multi_select",
			id: "symptoms",
			label: "Symptoms",
			options: [
				{ value: "fever", label: "Fever" },
				{ value: "cough", label: "Cough" },
				{ value: "headache", label: "Headache" },
			],
		});
		const next = produce(doc, (d) => {
			applyMutation(d, {
				kind: "convertField",
				uuid: asUuid("q-1"),
				toKind: "single_select",
			});
		});
		const converted = next.fields[asUuid("q-1")] as Record<string, unknown>;
		expect(converted.kind).toBe("single_select");
		expect(converted.options as Array<{ value: string }>).toHaveLength(3);
	});
});

// ---------------------------------------------------------------------------
// 5. Media family — image / audio / video / signature
// ---------------------------------------------------------------------------

describe("convertField — media family", () => {
	it("image → audio preserves id, label, uuid, hint, relevant", () => {
		const doc = docWithField({
			uuid: "q-1",
			kind: "image",
			id: "photo",
			label: "Photo",
			hint: "take a clear photo",
			relevant: "/data/needs_photo = 'yes'",
		});
		const next = produce(doc, (d) => {
			applyMutation(d, {
				kind: "convertField",
				uuid: asUuid("q-1"),
				toKind: "audio",
			});
		});
		const converted = next.fields[asUuid("q-1")] as Record<string, unknown>;
		expect(converted.kind).toBe("audio");
		expect(converted.id).toBe("photo");
		expect(converted.uuid).toBe("q-1");
		expect(converted.hint).toBe("take a clear photo");
		expect(converted.relevant).toBe("/data/needs_photo = 'yes'");
	});

	it("video → signature preserves id and label", () => {
		const doc = docWithField({
			uuid: "q-1",
			kind: "video",
			id: "consent_video",
			label: "Consent Video",
		});
		const next = produce(doc, (d) => {
			applyMutation(d, {
				kind: "convertField",
				uuid: asUuid("q-1"),
				toKind: "signature",
			});
		});
		const converted = next.fields[asUuid("q-1")] as Record<string, unknown>;
		expect(converted.kind).toBe("signature");
		expect(converted.id).toBe("consent_video");
		expect(converted.label).toBe("Consent Video");
	});
});

// ---------------------------------------------------------------------------
// 6. Structural family — group ↔ repeat
// ---------------------------------------------------------------------------

describe("convertField — structural family", () => {
	it("group → repeat preserves id, label, uuid, and children (fieldOrder untouched)", () => {
		const doc = buildDoc({
			appId: "app-1",
			modules: [
				{
					uuid: "m-1",
					name: "M",
					forms: [
						{
							uuid: "form-1",
							name: "F",
							type: "registration",
							fields: [
								f({
									uuid: "g-1",
									kind: "group",
									id: "demographics",
									label: "Demographics",
									children: [
										f({
											uuid: "c-1",
											kind: "text",
											id: "name",
											label: "Name",
										}),
									],
								}),
							],
						},
					],
				},
			],
		});
		const next = produce(doc, (d) => {
			applyMutation(d, {
				kind: "convertField",
				uuid: asUuid("g-1"),
				toKind: "repeat",
			});
		});
		const converted = next.fields[asUuid("g-1")] as Record<string, unknown>;
		expect(converted.kind).toBe("repeat");
		expect(converted.id).toBe("demographics");
		expect(converted.uuid).toBe("g-1");
		// Children must remain in fieldOrder under the same parent uuid.
		expect(next.fieldOrder[asUuid("g-1")]).toEqual([asUuid("c-1")]);
		expect(next.fields[asUuid("c-1")]).toBeDefined();
	});

	it("repeat → group preserves id, label, uuid, and relevant", () => {
		const doc = buildDoc({
			appId: "app-1",
			modules: [
				{
					uuid: "m-1",
					name: "M",
					forms: [
						{
							uuid: "form-1",
							name: "F",
							type: "registration",
							fields: [
								f({
									uuid: "r-1",
									kind: "repeat",
									id: "visits",
									label: "Visits",
									relevant: "/data/has_visits = 'yes'",
									children: [],
								}),
							],
						},
					],
				},
			],
		});
		const next = produce(doc, (d) => {
			applyMutation(d, {
				kind: "convertField",
				uuid: asUuid("r-1"),
				toKind: "group",
			});
		});
		const converted = next.fields[asUuid("r-1")] as Record<string, unknown>;
		expect(converted.kind).toBe("group");
		expect(converted.id).toBe("visits");
		expect(converted.relevant).toBe("/data/has_visits = 'yes'");
	});
});

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

describe("convertField — invariants", () => {
	it("no-op when the kind is already the target (same reference returned by immer)", () => {
		const doc = docWithField({
			uuid: "q-1",
			kind: "text",
			id: "pin",
			label: "PIN",
		});
		const next = produce(doc, (d) => {
			applyMutation(d, {
				kind: "convertField",
				uuid: asUuid("q-1"),
				toKind: "text",
			});
		});
		// Immer returns the original object unchanged when no mutation occurs.
		expect(next.fields[asUuid("q-1")]).toBe(doc.fields[asUuid("q-1")]);
	});

	it("skips entirely when the source uuid is unknown", () => {
		const doc = docWithField({
			uuid: "q-1",
			kind: "text",
			id: "pin",
			label: "PIN",
		});
		const next = produce(doc, (d) => {
			applyMutation(d, {
				kind: "convertField",
				uuid: asUuid("does-not-exist"),
				toKind: "secret",
			});
		});
		// The fields map must be unchanged.
		expect(next.fields).toEqual(doc.fields);
	});

	it("uuid is preserved end-to-end on the converted field", () => {
		// reconcileFieldForKind spreads the source (including uuid) into the
		// candidate, Zod's uuidSchema preserves it, and the Field return type
		// guarantees it — so the uuid survives the kind swap. This test pins
		// the end-state contract so any future refactor that breaks the
		// carry-through gets caught here.
		const doc = docWithField({
			uuid: "q-stable",
			kind: "int",
			id: "count",
			label: "Count",
		});
		const next = produce(doc, (d) => {
			applyMutation(d, {
				kind: "convertField",
				uuid: asUuid("q-stable"),
				toKind: "decimal",
			});
		});
		expect(next.fields[asUuid("q-stable")]?.uuid).toBe("q-stable");
	});

	it("no-ops when the target kind is not in the source's convertTargets", () => {
		// text's convertTargets is ["secret"] — group is a cross-paradigm
		// destination (leaf → container) that Zod's strip behavior would
		// happily accept structurally, but the resulting doc would have no
		// `fieldOrder` entry for the new "group" and break the "every
		// container has an order slot" invariant. The reducer's
		// convertibility gate rejects the swap before reconciliation runs.
		const doc = docWithField({
			uuid: "q-1",
			kind: "text",
			id: "name",
			label: "Name",
		});
		const next = produce(doc, (d) => {
			applyMutation(d, {
				kind: "convertField",
				uuid: asUuid("q-1"),
				toKind: "group",
			});
		});
		// Immer returns the original object unchanged when no mutation occurs.
		expect(next.fields[asUuid("q-1")]).toBe(doc.fields[asUuid("q-1")]);
	});

	it("no-ops on container → leaf (gate rejects; children stay intact)", () => {
		// Exercises the destructive-swap corruption path the gate exists to
		// prevent: a group with children becoming a text entity would strand
		// `fieldOrder[groupUuid]` with orphan descendants that walkers +
		// navigation still see. group's convertTargets is ["repeat"] only.
		const doc = buildDoc({
			appId: "app-1",
			modules: [
				{
					uuid: "m-1",
					name: "M",
					forms: [
						{
							uuid: "form-1",
							name: "F",
							type: "registration",
							fields: [
								f({
									uuid: "g-1",
									kind: "group",
									id: "demographics",
									label: "Demographics",
									children: [
										f({
											uuid: "c-1",
											kind: "text",
											id: "name",
											label: "Name",
										}),
									],
								}),
							],
						},
					],
				},
			],
		});
		const next = produce(doc, (d) => {
			applyMutation(d, {
				kind: "convertField",
				uuid: asUuid("g-1"),
				toKind: "text",
			});
		});
		// Group must remain a group — the entity, its fieldOrder entry, and
		// its child must all be unchanged.
		expect(next.fields[asUuid("g-1")]?.kind).toBe("group");
		expect(next.fieldOrder[asUuid("g-1")]).toEqual([asUuid("c-1")]);
		expect(next.fields[asUuid("c-1")]).toBeDefined();
	});
});
