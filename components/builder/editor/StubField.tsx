// components/builder/editor/StubField.tsx
//
// Placeholder editor component used by Phase 1's declarative editor
// schemas. Phase 5 replaces it with real per-type editors
// (CasePropertySelect, XPathField, etc.). Until then, every registered
// editor entry renders this stub — the schema wiring is provable but the
// UI stays the legacy ContextualEditor* components.

import type { Field } from "@/lib/domain/fields";
import type { FieldEditorComponentProps } from "@/lib/domain/kinds";

export function StubField<F extends Field, K extends keyof F>({
	field,
	value,
	onChange,
}: FieldEditorComponentProps<F, K>) {
	return (
		<input
			type="text"
			disabled
			value={typeof value === "string" ? value : ""}
			data-phase-1-stub={String(field.kind)}
			data-field-key=""
			onChange={(e) => onChange(e.target.value as F[K])}
			className="text-xs opacity-50"
		/>
	);
}
