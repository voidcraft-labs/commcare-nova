// components/preview/form/newFieldDefaults.ts
//
// The starter shape a freshly-inserted question of each kind begins as,
// keyed by kind. Extracted from the insertion menu so it can be unit-tested
// against the domain schema without mounting the picker.
//
// Each builder is type-checked against ITS kind's schema
// (`Omit<Extract<Field, { kind: K }>, "uuid">`), so the compiler rejects a
// property the kind doesn't have: e.g. a `label` on `hidden` (which carries
// no label) fails to COMPILE here, rather than silently minting a field that
// the strict `blueprintDocSchema` later rejects on auto-save. The
// `[K in FieldKind]` mapped type also forces every kind to have an entry.
// This is what replaced the `as unknown as Field` double-cast at the
// insertion site, which had erased exactly this check.

import {
	asUuid,
	DEFAULT_SELECT_OPTIONS,
	type Field,
	type FieldKind,
	HIDDEN_INERT_DEFAULT_VALUE,
	proseText,
} from "@/lib/domain";

function defaultSelectOptions() {
	return DEFAULT_SELECT_OPTIONS.map((option) => ({
		...option,
		uuid: asUuid(crypto.randomUUID()),
	}));
}

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
	text: (id, label) => ({ kind: "text", id, label: proseText(label) }),
	// An untitled section is honest (the header shows its placeholder), so
	// the suggested label is not used.
	section: (id) => ({ kind: "section", id }),
	int: (id, label) => ({ kind: "int", id, label: proseText(label) }),
	decimal: (id, label) => ({ kind: "decimal", id, label: proseText(label) }),
	date: (id, label) => ({ kind: "date", id, label: proseText(label) }),
	datetime: (id, label) => ({ kind: "datetime", id, label: proseText(label) }),
	time: (id, label) => ({ kind: "time", id, label: proseText(label) }),
	geopoint: (id, label) => ({ kind: "geopoint", id, label: proseText(label) }),
	barcode: (id, label) => ({ kind: "barcode", id, label: proseText(label) }),
	secret: (id, label) => ({ kind: "secret", id, label: proseText(label) }),
	single_select: (id, label) => ({
		kind: "single_select",
		id,
		label: proseText(label),
		optionsSource: { kind: "inline", options: defaultSelectOptions() },
	}),
	multi_select: (id, label) => ({
		kind: "multi_select",
		id,
		label: proseText(label),
		optionsSource: { kind: "inline", options: defaultSelectOptions() },
	}),
	image: (id, label) => ({ kind: "image", id, label: proseText(label) }),
	audio: (id, label) => ({ kind: "audio", id, label: proseText(label) }),
	video: (id, label) => ({ kind: "video", id, label: proseText(label) }),
	file: (id, label) => ({ kind: "file", id, label: proseText(label) }),
	signature: (id, label) => ({
		kind: "signature",
		id,
		label: proseText(label),
	}),
	label: (id, label) => ({ kind: "label", id, label: proseText(label) }),
	group: (id, label) => ({ kind: "group", id, label: proseText(label) }),
	repeat: (id, label) => ({
		kind: "repeat",
		id,
		label: proseText(label),
		repeat_mode: "user_controlled",
	}),
	// Hidden carries NO label (it's never shown): passing one would not
	// compile, which is the whole point. It starts with `default_value:
	// "''"` (the empty-string literal: a one-shot <setvalue> seed) so the
	// fresh field is immediately valid: a hidden field must carry a value
	// source (`HIDDEN_NO_VALUE` is soundness, so the commit gate rejects a
	// bare one in every phase). `default_value`, not `calculate`, is the
	// seed because it stays inert if the user then adds a calculate (the
	// computed value simply wins), whereas a seeded calculate would
	// continuously clobber any default the user typed until removed.
	hidden: (id) => ({
		kind: "hidden",
		id,
		default_value: HIDDEN_INERT_DEFAULT_VALUE,
	}),
};
