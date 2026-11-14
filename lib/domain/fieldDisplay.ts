// lib/domain/fieldDisplay.ts
//
// The one registry of question display settings: each thing an author can
// choose about how a question is drawn, held as its own typed key on the
// schema of exactly the kinds whose control reads it. A setting is named for
// what the worker sees, takes a value from a closed set, and is absent for
// the platform's own behavior. No slot holds free text for a runtime to
// interpret.
//
// `__tests__/fieldDisplay.test.ts` holds this table to the kind schemas both
// ways. The XForm writer of `appearance`
// (`lib/commcare/xform/appearance.ts::fieldAppearance`) keys its tokens by
// this table, and `platformUses.ts` finds every use of a value that names a
// platform row through `fieldDisplayValues`, so a new setting needs no
// detector of its own.

import type { Field, FieldKind } from "./fields";
import type { PlatformFeatureId } from "./platforms";

export interface FieldDisplayValue {
	/** The value's name where the builder offers it. */
	readonly label: string;
	/** The platform row that states how each platform reads it, where they differ. */
	readonly feature?: PlatformFeatureId;
}

export interface FieldDisplaySetting {
	/** The schema key. */
	readonly key: string;
	/** Exactly the kinds whose schema declares the key. */
	readonly kinds: readonly FieldKind[];
	readonly values: Readonly<Record<string, FieldDisplayValue>>;
}

export const FIELD_DISPLAY_SETTINGS = [
	{
		key: "keypad",
		kinds: ["text"],
		values: { numbers: { label: "Number keypad", feature: "number-keypad" } },
	},
] as const satisfies readonly FieldDisplaySetting[];

export type FieldDisplaySettingKey =
	(typeof FIELD_DISPLAY_SETTINGS)[number]["key"];

/** The settings a kind's schema declares, in registry order. */
export function fieldDisplaySettingsFor(
	kind: FieldKind,
): readonly FieldDisplaySetting[] {
	return FIELD_DISPLAY_SETTINGS.filter((setting) =>
		(setting.kinds as readonly FieldKind[]).includes(kind),
	);
}

/** Each setting a field holds, with its value's registry row, in registry order. */
export function fieldDisplayValues(field: Field): readonly {
	key: FieldDisplaySettingKey;
	value: string;
	row: FieldDisplayValue;
}[] {
	const held: {
		key: FieldDisplaySettingKey;
		value: string;
		row: FieldDisplayValue;
	}[] = [];
	for (const setting of fieldDisplaySettingsFor(field.kind)) {
		const value: unknown = (field as Readonly<Record<string, unknown>>)[
			setting.key
		];
		if (typeof value !== "string") continue;
		const row = Object.hasOwn(setting.values, value)
			? setting.values[value]
			: undefined;
		if (row === undefined) continue;
		held.push({ key: setting.key as FieldDisplaySettingKey, value, row });
	}
	return held;
}
