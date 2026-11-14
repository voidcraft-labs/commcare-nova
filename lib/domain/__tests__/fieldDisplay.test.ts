/**
 * The registry of question display settings against the real kind schemas,
 * both ways.
 *
 * `FIELD_DISPLAY_SETTINGS` names, for each setting, exactly the kinds whose
 * schema declares its key and every value the schema admits. The failures
 * this catches: a setting listed for a kind whose schema lacks the key (an
 * offer the commit would refuse), a kind whose schema declares the key but is
 * missing from the row (a setting the builder, the writer of `appearance` and
 * the platform detector never see), and a value the schema's enum holds with
 * no registry row, or a row the enum refuses. A `feature` naming no platform
 * row already fails `tsc`, through `PlatformFeatureId`.
 *
 * The registry's keys are also held to a second source: every field key the
 * reference audit classifies as configuration (`NON_REFERENCE_FIELD_PATHS`,
 * which must classify every schema key), less the named flags that are not a
 * question display setting. So a whole new display key added to a kind schema
 * with no registry row fails here, where the per-setting checks above, which
 * walk only the registry's own rows, cannot see it.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	FIELD_DISPLAY_SETTINGS,
	type Field,
	fieldDisplaySettingsFor,
	fieldDisplayValues,
	fieldKindDeclaresKey,
	fieldKinds,
	fieldPatchSchemaByKind,
	proseText,
} from "@/lib/domain";
import { NON_REFERENCE_FIELD_PATHS } from "@/lib/domain/referenceSlots";

/** The field configuration keys that are not a question display setting, each
 *  with why: what the registry holds is a closed choice about how a
 *  question's control is drawn, written as its `appearance`. */
const NOT_DISPLAY_SETTINGS: Readonly<Record<string, string>> = {
	placement: "a query repeat's held placement, an identity no author chooses",
	fieldList: "a group's screen layout, written on the group and not a control",
	plainLabel: "a label's text formatting, read by plainText.ts",
	plainHelp: "a help text's formatting, read by plainText.ts",
};

/** Every string an enum or constant inside a JSON Schema admits. */
function admittedStrings(schema: unknown): string[] {
	if (typeof schema !== "object" || schema === null) return [];
	const node = schema as Record<string, unknown>;
	const found: string[] = [];
	if (Array.isArray(node.enum))
		for (const value of node.enum)
			if (typeof value === "string") found.push(value);
	if (typeof node.const === "string") found.push(node.const);
	for (const key of ["anyOf", "oneOf", "allOf"])
		if (Array.isArray(node[key]))
			for (const branch of node[key] as unknown[])
				found.push(...admittedStrings(branch));
	return found;
}

describe("FIELD_DISPLAY_SETTINGS", () => {
	for (const setting of FIELD_DISPLAY_SETTINGS) {
		it(`lists exactly the kinds whose schema declares "${setting.key}"`, () => {
			const declaring = fieldKinds.filter((kind) =>
				fieldKindDeclaresKey(kind, setting.key),
			);
			expect([...setting.kinds].sort()).toEqual([...declaring].sort());
		});

		it(`holds a row for exactly the values each kind admits for "${setting.key}"`, () => {
			for (const kind of setting.kinds) {
				const json = z.toJSONSchema(fieldPatchSchemaByKind[kind], {
					unrepresentable: "any",
				}) as { properties?: Record<string, unknown> };
				const admitted = [
					...new Set(admittedStrings(json.properties?.[setting.key])),
				].sort();
				expect([kind, admitted]).toEqual([
					kind,
					Object.keys(setting.values).sort(),
				]);
			}
		});
	}

	it("holds a row for every field configuration key that is a display setting", () => {
		const configKeys = Object.entries(NON_REFERENCE_FIELD_PATHS)
			.filter(([path, reason]) => reason === "config" && !path.includes("."))
			.map(([path]) => path);
		for (const key of configKeys)
			expect([
				key,
				fieldKinds.some((kind) => fieldKindDeclaresKey(kind, key)),
			]).toEqual([key, true]);
		for (const key of Object.keys(NOT_DISPLAY_SETTINGS))
			expect(configKeys).toContain(key);
		expect(
			configKeys
				.filter((key) => !Object.hasOwn(NOT_DISPLAY_SETTINGS, key))
				.sort(),
		).toEqual(FIELD_DISPLAY_SETTINGS.map((setting) => setting.key).sort());
	});

	it("gives each kind its settings in registry order, and a kind with none an empty list", () => {
		expect(fieldDisplaySettingsFor("text").map((s) => s.key)).toEqual([
			"keypad",
		]);
		expect(fieldDisplaySettingsFor("int")).toEqual([]);
		expect(fieldDisplaySettingsFor("group")).toEqual([]);
	});
});

describe("fieldDisplayValues", () => {
	const text = (extra: Record<string, unknown>): Field =>
		({
			uuid: testUuid("phone"),
			kind: "text",
			id: "phone",
			label: proseText("Phone"),
			...extra,
		}) as Field;

	it("reads each setting a field holds, with its registry row", () => {
		expect(fieldDisplayValues(text({ keypad: "numbers" }))).toEqual([
			{
				key: "keypad",
				value: "numbers",
				row: { label: "Number keypad", feature: "number-keypad" },
			},
		]);
	});

	it("reads nothing from a field that holds no setting", () => {
		expect(fieldDisplayValues(text({}))).toEqual([]);
	});
});
