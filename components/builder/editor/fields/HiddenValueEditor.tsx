"use client";

import { InspectorHint } from "@/components/builder/inspector/inspectorChrome";
import { useHiddenWriterBlankNote } from "@/lib/doc/hooks/useHiddenWriterBlankNote";
import type { HiddenField } from "@/lib/domain";
import type { FieldEditorComponentProps } from "@/lib/domain/kinds";
import { XPathEditor } from "./XPathEditor";

export function HiddenValueEditor(
	props: FieldEditorComponentProps<HiddenField, "calculate">,
) {
	const blankNote = useHiddenWriterBlankNote(props.field.uuid);
	return (
		<div className="space-y-2">
			<XPathEditor {...props} />
			<InspectorHint>
				{blankNote ??
					"Updates when an answer it uses changes and when a worker resumes the form."}
			</InspectorHint>
		</div>
	);
}
