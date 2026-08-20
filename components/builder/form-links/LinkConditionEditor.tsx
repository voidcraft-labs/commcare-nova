// components/builder/form-links/LinkConditionEditor.tsx
//
// A link's condition, edited in SESSION scope.
//
// CommCare evaluates it after the form has closed, so the editor is
// mounted with `buildSessionLintContext`: the same readable case types as
// the form's own slots, no form paths, and a linter that explains a form
// read as "this runs after the form has closed" rather than as an unknown
// field, and `XPathField`'s save gate reads those same diagnostics. The
// save path here adds the two refusals the doc gate would make, in the
// author's words: an emptied condition (a link needs one; the otherwise
// link is a different kind of link) and a form read the parser resolved
// to a field.

"use client";

import { XPathField } from "@/components/builder/XPathField";
import { buildSessionLintContext } from "@/lib/codemirror/buildSessionLintContext";
import { SESSION_FORM_READ_MESSAGE } from "@/lib/codemirror/xpath-lint";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import {
	useParseXPathForForm,
	useXPathProjection,
} from "@/lib/doc/hooks/useXPathSlots";
import type { Uuid } from "@/lib/doc/types";
import type { CommitOutcome, FormLink, XPathExpression } from "@/lib/domain";
import { EMPTY_CONDITION_REFUSAL } from "./afterSubmitCopy";

/** Whether a parsed expression reads the form it would run after. */
export function readsForm(expression: XPathExpression): boolean {
	return expression.parts.some(
		(part) => part.kind === "field-ref" || part.kind === "path-ref",
	);
}

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
	const docApi = useBlueprintDocApi();
	const parse = useParseXPathForForm(formUuid);
	const projection = useXPathProjection(link.condition);

	const save = (text: string): CommitOutcome | undefined => {
		if (text.trim().length === 0) {
			return { ok: false, messages: [EMPTY_CONDITION_REFUSAL] };
		}
		const condition = parse(text);
		if (readsForm(condition)) {
			return { ok: false, messages: [SESSION_FORM_READ_MESSAGE] };
		}
		return onCommit({ ...link, condition });
	};

	return (
		<div className="space-y-2">
			<XPathField
				value={projection.text}
				onSave={canEdit ? save : undefined}
				getLintContext={() =>
					buildSessionLintContext(docApi.getState(), formUuid)
				}
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
