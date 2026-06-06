// components/preview/form/newFieldDefaults.ts
//
// The starter shape a freshly-inserted question of each kind begins as,
// keyed by kind. Extracted from the insertion menu so it can be unit-tested
// against the domain schema without mounting the picker.
//
// Each builder is type-checked against ITS kind's schema
// (`Omit<Extract<Field, { kind: K }>, "uuid">`), so the compiler rejects a
// property the kind doesn't have — e.g. a `label` on `hidden` (which carries
// no label) fails to COMPILE here, rather than silently minting a field that
// the strict `blueprintDocSchema` later rejects on auto-save. The
// `[K in FieldKind]` mapped type also forces every kind to have an entry.
// This is what replaced the `as unknown as Field` double-cast at the
// insertion site, which had erased exactly this check.

import type { Field, FieldKind } from "@/lib/domain";

/** A fresh select's two starter options, so the new field is immediately valid
 *  (`options` is `.min(2)`) and the user just renames them. */
const DEFAULT_SELECT_OPTIONS = [
	{ value: "option_1", label: "Option 1" },
	{ value: "option_2", label: "Option 2" },
] as const;

/**
 * Per-kind builder for a new field's default shape. `label` is the suggested
 * display text (the kind's human name, e.g. "New Single Select"); kinds with
 * no label slot ignore it.
 */
export const NEW_FIELD_BUILDERS: {
	[K in FieldKind]: (
		id: string,
		label: string,
	) => Omit<Extract<Field, { kind: K }>, "uuid">;
} = {
	text: (id, label) => ({ kind: "text", id, label }),
	int: (id, label) => ({ kind: "int", id, label }),
	decimal: (id, label) => ({ kind: "decimal", id, label }),
	date: (id, label) => ({ kind: "date", id, label }),
	datetime: (id, label) => ({ kind: "datetime", id, label }),
	time: (id, label) => ({ kind: "time", id, label }),
	geopoint: (id, label) => ({ kind: "geopoint", id, label }),
	barcode: (id, label) => ({ kind: "barcode", id, label }),
	secret: (id, label) => ({ kind: "secret", id, label }),
	single_select: (id, label) => ({
		kind: "single_select",
		id,
		label,
		options: [...DEFAULT_SELECT_OPTIONS],
	}),
	multi_select: (id, label) => ({
		kind: "multi_select",
		id,
		label,
		options: [...DEFAULT_SELECT_OPTIONS],
	}),
	image: (id, label) => ({ kind: "image", id, label }),
	audio: (id, label) => ({ kind: "audio", id, label }),
	video: (id, label) => ({ kind: "video", id, label }),
	signature: (id, label) => ({ kind: "signature", id, label }),
	label: (id, label) => ({ kind: "label", id, label }),
	group: (id, label) => ({ kind: "group", id, label }),
	repeat: (id, label) => ({
		kind: "repeat",
		id,
		label,
		repeat_mode: "user_controlled",
	}),
	// Hidden carries NO label (it's never shown) — passing one would not
	// compile, which is the whole point.
	hidden: (id) => ({ kind: "hidden", id }),
};
