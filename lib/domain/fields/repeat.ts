// lib/domain/fields/repeat.ts
//
// Structural container that repeats its child fields N times at runtime —
// one iteration per household member, site visit, etc. The repeat count is
// determined by the user during form entry. Maps to CommCare <repeat> control.
//
// Like group, repeat does not write to the case directly. Only `relevant`
// is meaningful at the container level; individual child fields carry their
// own validation/logic as usual.
//
// **Empty-label repeats are valid.** Repeats extend `containerFieldBase`
// (label optional) rather than `fieldBaseSchema` (label required). A
// non-empty label renders as the section-header title; an empty/absent
// label drops the title text but keeps the surrounding chrome (border,
// chevron, "Repeat" badge) and the iteration UI (instance dividers,
// Add/Remove for user-controlled mode) — that chrome is functional, not
// decorative. The wire emitter (`lib/commcare/xform/builder.ts`) skips
// the `<label>` element for empty-label containers so the XForm doesn't
// carry a dangling itext reference.

import tablerRepeat from "@iconify-icons/tabler/repeat";
import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import { containerFieldBase } from "./base";

export const repeatFieldSchema = containerFieldBase.extend({
	kind: z.literal("repeat"),
	relevant: z.string().optional(),
});

export type RepeatField = z.infer<typeof repeatFieldSchema>;

export const repeatFieldMetadata: FieldKindMetadata<"repeat"> = {
	kind: "repeat",
	xformKind: "repeat",
	dataType: "",
	icon: tablerRepeat,
	label: "Repeat",
	isStructural: true,
	isContainer: true,
	saDocs:
		"Repeats its child fields N times (e.g. one set per household member).",
	convertTargets: ["group"],
};
