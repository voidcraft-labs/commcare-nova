// lib/domain/fields/repeat.ts
//
// Structural container that repeats its child fields N times at runtime —
// one iteration per household member, site visit, etc. The repeat count is
// determined by the user during form entry. Maps to CommCare <repeat> control.
//
// Like group, repeat does not write to the case directly. Only `relevant`
// is meaningful at the container level; individual child fields carry their
// own validation/logic as usual.

import tablerRepeat from "@iconify-icons/tabler/repeat";
import { z } from "zod";
import { StubField } from "@/components/builder/editor/StubField";
import type { FieldEditorSchema, FieldKindMetadata } from "../kinds";
import { fieldBaseSchema } from "./base";

export const repeatFieldSchema = fieldBaseSchema.extend({
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

// Editor schema is a Phase 1 placeholder — StubField renders a disabled input.
// Phase 5 replaces stubs with purpose-built components.
export const repeatFieldEditorSchema: FieldEditorSchema<RepeatField> = {
	data: [],
	logic: [{ key: "relevant", component: StubField }],
	ui: [],
};
