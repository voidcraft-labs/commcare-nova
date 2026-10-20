// components/builder/form-links/LinkConditionEditor.tsx
//
// A link's condition, edited in SESSION scope.
//
// The actual link member supplies the after-submit profile and parser.
// Shared lint and admission findings explain why closed-form answers cannot
// be read; an empty condition stays a separate local refusal.

"use client";

import { XPathField } from "@/components/builder/XPathField";
import {
	useExpressionEditorContext,
	useExpressionProjection,
	useParseFormExpression,
} from "@/lib/doc/hooks/useXPathSlots";
import type { Uuid } from "@/lib/doc/types";
import type { CommitOutcome, FormLink } from "@/lib/domain";
import { EMPTY_CONDITION_REFUSAL } from "./afterSubmitCopy";

export function LinkConditionEditor({
	formUuid,
	link,
	canEdit,
	autoEdit,
	onCommit,
}: {
	readonly formUuid: Uuid;
	readonly link: FormLink;
	readonly canEdit: boolean;
	/** Open the editor on mount: a freshly added link arrives here to have
	 *  its `false()` replaced. */
	readonly autoEdit?: boolean;
	readonly onCommit: (next: FormLink) => CommitOutcome;
}) {
	const slot = {
		entity: "form" as const,
		uuid: formUuid,
		slot: "form_link_condition" as const,
		member: { linkUuid: link.uuid },
	};
	const parse = useParseFormExpression(slot);
	const projection = useExpressionProjection(link.condition, slot);
	const getEditorContext = useExpressionEditorContext(slot);

	const save = (text: string): CommitOutcome | undefined => {
		if (text.trim().length === 0) {
			return { ok: false, messages: [EMPTY_CONDITION_REFUSAL] };
		}
		const condition = parse(text);
		return onCommit({ ...link, condition });
	};

	return (
		<div className="space-y-2">
			<XPathField
				value={projection.text}
				onSave={canEdit ? save : undefined}
				getEditorContext={getEditorContext}
				autoEdit={autoEdit === true && canEdit}
			/>
			{!projection.ok && (
				<p className="text-[13px] leading-relaxed text-nova-rose">
					Part of this condition points at something that is no longer in the
					app. Rewrite it to fix the link.
				</p>
			)}
			<p className="text-[13px] leading-relaxed text-nova-text-muted">
				This is checked after the form has closed, so it can read case
				properties and worker information, not the form's answers.
			</p>
		</div>
	);
}
