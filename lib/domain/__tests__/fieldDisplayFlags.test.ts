/**
 * `fieldList` and `plainLabel` are stored `true`-or-absent slots. The
 * plausible failures: a kind that has no label (Hidden Value) or no
 * one-screen flag (section, repeat) accepting one, an `updateField` patch
 * unable to clear one, and a conversion that drops `plainLabel` between two
 * kinds that both declare it or keeps `fieldList` on a repeat.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	fieldPatchSchemaByKind,
	fieldSchema,
	reconcileFieldForKind,
	selectOptionSchema,
} from "../fields";
import { proseText } from "../prose";

const identity = { uuid: testUuid("field"), id: "answer" };
const label = proseText("Household");

describe("display flag slots", () => {
	it("admits plainLabel on questions, containers, sections and choices", () => {
		for (const field of [
			{ ...identity, kind: "text", label, plainLabel: true },
			{ ...identity, kind: "label", label, plainLabel: true },
			{ ...identity, kind: "group", label, plainLabel: true },
			{
				...identity,
				kind: "repeat",
				repeat_mode: "user_controlled",
				plainLabel: true,
			},
			{ ...identity, kind: "section", label, plainLabel: true },
		]) {
			expect(fieldSchema.safeParse(field).success, field.kind).toBe(true);
		}
		expect(
			selectOptionSchema.safeParse({
				uuid: testUuid("yes"),
				value: "yes",
				label: proseText("Yes"),
				plainLabel: true,
			}).success,
		).toBe(true);
	});

	it("refuses plainLabel on a hidden value and fieldList off a group", () => {
		expect(
			fieldSchema.safeParse({ ...identity, kind: "hidden", plainLabel: true })
				.success,
		).toBe(false);
		expect(
			fieldSchema.safeParse({ ...identity, kind: "section", fieldList: true })
				.success,
		).toBe(false);
		expect(
			fieldSchema.safeParse({
				...identity,
				kind: "repeat",
				repeat_mode: "user_controlled",
				fieldList: true,
			}).success,
		).toBe(false);
		expect(
			fieldSchema.safeParse({ ...identity, kind: "group", fieldList: false })
				.success,
		).toBe(false);
	});

	it("lets an updateField patch set and clear both flags", () => {
		const group = fieldPatchSchemaByKind.group;
		expect(group.safeParse({ fieldList: true, plainLabel: true }).success).toBe(
			true,
		);
		expect(group.safeParse({ fieldList: null, plainLabel: null }).success).toBe(
			true,
		);
		expect(group.safeParse({ fieldList: false }).success).toBe(false);
		expect(
			fieldPatchSchemaByKind.text.safeParse({ plainLabel: null }).success,
		).toBe(true);
		expect(
			fieldPatchSchemaByKind.hidden.safeParse({ plainLabel: null }).success,
		).toBe(false);
	});

	it("carries plainLabel across a conversion and drops fieldList on a repeat", () => {
		const repeat = reconcileFieldForKind(
			{
				...identity,
				kind: "group",
				label,
				plainLabel: true,
				fieldList: true,
			},
			"repeat",
		);
		expect(repeat).toMatchObject({ kind: "repeat", plainLabel: true });
		expect(repeat).not.toHaveProperty("fieldList");

		const secret = reconcileFieldForKind(
			{ ...identity, kind: "text", label, plainLabel: true },
			"secret",
		);
		expect(secret).toMatchObject({ kind: "secret", plainLabel: true });

		const hidden = reconcileFieldForKind(
			{ ...identity, kind: "text", label, plainLabel: true },
			"hidden",
		);
		expect(hidden).toMatchObject({ kind: "hidden" });
		expect(hidden).not.toHaveProperty("plainLabel");
	});
});
