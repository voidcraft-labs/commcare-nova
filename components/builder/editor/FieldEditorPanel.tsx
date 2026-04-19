/**
 * FieldEditorPanel — registry-driven body of the field inspector.
 *
 * Reads `fieldEditorSchemas[field.kind]` via the `schemaFor` helper
 * to dispatch the three sections (Data / Logic / Appearance). Each
 * section is independently visible — the panel gates the card chrome
 * on whether any entry would actually render (accounting for
 * per-entry `visible()` predicates + the `addable` flag), so empty
 * labelled cards never mount.
 *
 * No per-kind switching lives in this file. All kind-specific
 * behavior (visibility predicates, component choices, required keys)
 * is encoded in the schema entries themselves.
 *
 * Pairs with `FieldHeader` (rendered above by InlineSettingsPanel).
 */
"use client";
import { fieldEditorSchemas } from "@/components/builder/editor/fieldEditorSchemas";
import type { Field } from "@/lib/domain";
import type { FieldEditorEntry, FieldEditorSchema } from "@/lib/domain/kinds";
import { FieldEditorSection } from "./FieldEditorSection";
import { sectionHasContent } from "./partitionEditorEntries";
import { SECTION_CARD_CLASS, SectionLabel } from "./sectionChrome";
import type { EditorSectionName } from "./useEntryActivation";

/**
 * Look up the editor schema for a field's kind.
 *
 * The registry is typed as
 *   `{ [K in FieldKind]: FieldEditorSchema<Extract<Field, { kind: K }>> }`
 * but TypeScript cannot correlate `field` and `schema` across the
 * discriminant — indexing by `field.kind` widens the result to a union
 * of every possible schema variant, which is incompatible with the
 * concrete `F` the caller holds.
 *
 * The runtime guarantee is exact: `field.kind` is the discriminant and
 * `fieldEditorSchemas[field.kind]` is the matching schema for THIS
 * field's kind. This helper encodes that invariant in one place so
 * the rest of the panel is fully typed — downstream code sees a
 * `FieldEditorSchema<F>` that mates cleanly with `field: F`, no
 * `any` casts in sight.
 */
function schemaFor<F extends Field>(field: F): FieldEditorSchema<F> {
	// The two-step cast (`as unknown as FieldEditorSchema<F>`) is the
	// canonical shape TypeScript requires for a narrowing whose correctness
	// it can't prove structurally — the registry's union-of-variants return
	// type doesn't overlap with `F`'s specific variant until runtime picks
	// which entry to fetch. Going through `unknown` acknowledges that the
	// compiler is being deliberately bypassed here; the runtime invariant
	// (registry[field.kind] IS the schema for this field's kind) is what
	// makes the assertion safe.
	return fieldEditorSchemas[field.kind] as unknown as FieldEditorSchema<F>;
}

interface FieldEditorPanelProps {
	field: Field;
}

export function FieldEditorPanel({ field }: FieldEditorPanelProps) {
	const schema = schemaFor(field);
	return (
		<div className="p-2 space-y-2">
			<Section
				title="Data"
				section="data"
				entries={schema.data}
				field={field}
			/>
			<Section
				title="Logic"
				section="logic"
				entries={schema.logic}
				field={field}
			/>
			<Section
				title="Appearance"
				section="ui"
				entries={schema.ui}
				field={field}
			/>
		</div>
	);
}

interface SectionProps<F extends Field> {
	title: string;
	section: EditorSectionName;
	entries: readonly FieldEditorEntry<F>[];
	field: F;
}

/**
 * Section wrapper — owns the card chrome + label. Skips the card
 * entirely when the partition says this section would render nothing
 * (no visible editors, no addable pills). This is the single guard
 * that keeps empty labelled cards off the screen even if a future
 * schema entry is declared `visible: () => false` without `addable`.
 *
 * Generic on the concrete kind variant so `FieldEditorSection` and
 * `sectionHasContent` receive a matching `field` + `entries` pair
 * without any casts here. The narrowing invariant is carried by
 * `schemaFor` above — by the time `Section` receives its props, the
 * types already agree.
 */
function Section<F extends Field>({
	title,
	section,
	entries,
	field,
}: SectionProps<F>) {
	if (!sectionHasContent(field, entries)) return null;
	return (
		<div className={SECTION_CARD_CLASS}>
			<SectionLabel label={title} />
			<div className="space-y-3">
				<FieldEditorSection field={field} section={section} entries={entries} />
			</div>
		</div>
	);
}
