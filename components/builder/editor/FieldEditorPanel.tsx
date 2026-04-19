/**
 * FieldEditorPanel — registry-driven body of the field inspector.
 *
 * Reads `fieldEditorSchemas[field.kind]` to dispatch the three
 * sections (Data / Logic / Appearance). Each section is independently
 * visible — the inner FieldEditorSection returns null when its
 * entries contribute no editors and no pills, and the wrapper here
 * skips the section's card chrome in that case so empty labels don't
 * appear for structural kinds.
 *
 * No per-kind switching lives in this file. All kind-specific
 * behavior (visibility predicates, component choices, required keys)
 * is encoded in the schema entries themselves.
 *
 * Pairs with `FieldHeader` (rendered above by InlineSettingsPanel).
 */
"use client";
import { fieldEditorSchemas } from "@/components/builder/editor/fieldEditorSchemas";
import type { Field, FieldKind } from "@/lib/domain";
import { FieldEditorSection } from "./FieldEditorSection";
import type { EditorSectionName } from "./useEntryActivation";

/** Shared card styling for each section wrapper inside the panel. */
const SECTION_CARD_CLASS =
	"rounded-md bg-nova-surface/40 border border-white/[0.04] px-3 py-2.5";

/** Uppercase micro-label with a violet accent bar — section header. */
function SectionLabel({ label }: { label: string }) {
	return (
		<div className="flex items-center gap-2 mb-2">
			<div className="w-0.5 h-3 rounded-full bg-nova-violet/40" />
			<span className="text-[10px] font-semibold uppercase tracking-widest text-nova-text-muted/70">
				{label}
			</span>
		</div>
	);
}

interface FieldEditorPanelProps {
	field: Field;
}

export function FieldEditorPanel({ field }: FieldEditorPanelProps) {
	// Narrowed schema lookup: each entry in `fieldEditorSchemas` is
	// typed against `Extract<Field, { kind: K }>`, so at runtime the
	// schema retrieved via `field.kind` is guaranteed to match the
	// field variant. The cast inside `Section` below carries that
	// invariant to the compiler — see the comment there.
	const schema = fieldEditorSchemas[field.kind as FieldKind];

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
 * when the schema has no entries for this section (early return
 * before mounting FieldEditorSection). A trailing null from the
 * section itself (entries exist but every one is hidden + non-addable)
 * would still mount the card; that edge case can't happen with the
 * current schemas because `addable: true` is the default for every
 * hideable key, so an entry that contributes nothing would have been
 * filtered out of the schema by construction.
 *
 * The two `any` casts reconcile the discriminated-union narrowing.
 * `FieldEditorSection` is generic on the concrete kind variant, but
 * at the panel level we only hold `field: Field`. The runtime
 * invariant (schema keyed by field.kind is the correct schema for
 * this field) guarantees the mounted component is the right one;
 * the cast silences the compile-time disconnect without a 19-way
 * switch that would reintroduce the per-kind branching the
 * registry was built to eliminate.
 */
function Section({ title, section, entries, field }: SectionProps) {
	if (entries.length === 0) return null;
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
