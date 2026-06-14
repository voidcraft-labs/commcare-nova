"use client";
import { useState } from "react";
import { SaveShortcutHint } from "@/components/builder/SaveShortcutHint";
import { XPathField } from "@/components/builder/XPathField";
import type { XPathLintContext } from "@/lib/codemirror/xpath-lint";
import type { CommitOutcome } from "@/lib/domain";

/**
 * Compact labeled wrapper around `XPathField` for use inside the form
 * settings panel. Renders the label (with optional required marker) and
 * shows the keyboard save-shortcut hint alongside it only while the
 * underlying CodeMirror editor is actively focused — keeps the resting
 * state visually quiet while still teaching the shortcut on demand.
 */
export function LabeledXPathField({
	label,
	required,
	value,
	onSave,
	getLintContext,
}: {
	label: string;
	required?: boolean;
	value: string;
	/** Commit the value. Forward the gated outcome so a refused edit
	 *  keeps the draft + finding in the inline editor; void reads as
	 *  committed. */
	onSave: (value: string) => CommitOutcome | undefined;
	getLintContext: () => XPathLintContext | undefined;
}) {
	const [editing, setEditing] = useState(false);

	return (
		<div>
			<span className="text-[10px] text-nova-text-muted uppercase tracking-wider mb-0.5 flex items-center gap-0.5">
				{label}
				{required && <span className="text-nova-rose">*</span>}
				{editing && <SaveShortcutHint />}
			</span>
			<XPathField
				value={value}
				onSave={onSave}
				getLintContext={getLintContext}
				onEditingChange={setEditing}
			/>
		</div>
	);
}
