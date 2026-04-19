/**
 * FieldEditorPanel — registry-driven body of the field inspector.
 *
 * Reads `fieldEditorSchemas[field.kind]` to dispatch the three
 * sections (Data / Logic / Appearance). Each section is independently
 * visible — the panel gates the card chrome on whether any entry
 * would actually render (accounting for per-entry `visible()`
 * predicates + the `addable` flag), so empty labelled cards never
 * mount.
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
import { FieldEditorSection } from "./FieldEditorSection";
import { sectionHasContent } from "./partitionEditorEntries";
import { SECTION_CARD_CLASS, SectionLabel } from "./sectionChrome";
import type { EditorSectionName } from "./useEntryActivation";

interface FieldEditorPanelProps {
	field: Field;
}

export function FieldEditorPanel({ field }: FieldEditorPanelProps) {
	// `field.kind` is already narrowed to `FieldKind` by the Field
	// union discriminant — no cast needed to index the schema record.
	// At runtime the schema retrieved here is typed against
	// `Extract<Field, { kind: K }>` for the field's specific kind;
	// the `any` casts inside `Section` carry that invariant across
	// the component boundary.
	const schema = fieldEditorSchemas[field.kind];

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

interface SectionProps {
	title: string;
	section: EditorSectionName;
	entries: readonly unknown[];
	field: Field;
}

/**
 * Section wrapper — owns the card chrome + label. Skips the card
 * entirely when the partition says this section would render nothing
 * (no visible editors, no addable pills). This is the single guard
 * that keeps empty labelled cards off the screen even if a future
 * schema entry is declared `visible: () => false` without `addable`.
 *
 * The three `any` casts reconcile the discriminated-union narrowing.
 * `FieldEditorSection` and `sectionHasContent` are both generic on
 * the concrete kind variant; at the panel level we only hold
 * `field: Field`. The runtime invariant (schema keyed by field.kind
 * IS the correct schema for this field) makes the values structurally
 * compatible. The cast silences the compile-time disconnect without
 * a 19-way switch that would reintroduce the per-kind branching the
 * registry was built to eliminate.
 */
function Section({ title, section, entries, field }: SectionProps) {
	// biome-ignore lint/suspicious/noExplicitAny: registry narrowing — see JSDoc above
	if (!sectionHasContent(field as any, entries as any)) return null;
	return (
		<div className={SECTION_CARD_CLASS}>
			<SectionLabel label={title} />
			<div className="space-y-3">
				<FieldEditorSection
					// biome-ignore lint/suspicious/noExplicitAny: registry narrowing — see JSDoc above
					field={field as any}
					section={section}
					// biome-ignore lint/suspicious/noExplicitAny: registry narrowing — see JSDoc above
					entries={entries as any}
				/>
			</div>
		</div>
	);
}
