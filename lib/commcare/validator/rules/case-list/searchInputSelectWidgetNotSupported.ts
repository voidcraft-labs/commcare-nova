/**
 * Rule: simple-arm `SearchInputDef`s with `type: "select"` are
 * rejected at authoring time until Nova's wire emitters synthesize
 * the `<itemset>` child / `itemset` slot CCHQ needs to render the
 * widget as a select.
 *
 * CCHQ-core's `QueryPrompt::isSelect` (verified at
 * `~/code/commcare-core/.../suite/model/QueryPrompt.java::isSelect`)
 * returns `getItemsetBinding() != null`. Without an `<itemset>`
 * child on the wire prompt, the runtime treats `input="select1"` as
 * a text input. The CCHQ-side prompt-emitter at
 * `commcare-hq/.../suite_xml/post_process/remote_requests.py::build_query_prompts`
 * only writes the itemset when `prop.itemset.nodeset` is non-empty
 * — a slot Nova's `SimpleSearchInputDef` does not carry today.
 *
 * The wire-correct fix is structural — Nova's schema needs an
 * itemset slot threaded through the prompt emitters, sourced from
 * the targeted case property's declared `options`. Until that
 * lands, the rule rejects the combination at the validator so the
 * UI option doesn't ship a broken widget.
 *
 * Advanced-arm inputs are not gated by this rule — the advanced
 * arm's predicate composes the membership check explicitly and
 * does not rely on a CCHQ-side select widget.
 *
 * Short-circuits cleanly when `caseListConfig` is absent or carries
 * no search inputs.
 */

import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import { type ValidationError, validationError } from "../../errors";

export function searchInputSelectWidgetNotSupported(
	mod: Module,
	moduleUuid: Uuid,
	_doc: BlueprintDoc,
): ValidationError[] {
	const inputs = mod.caseListConfig?.searchInputs ?? [];
	if (inputs.length === 0) return [];

	const errors: ValidationError[] = [];
	for (let i = 0; i < inputs.length; i++) {
		const input = inputs[i];
		if (input.kind !== "simple") continue;
		if (input.type !== "select") continue;
		errors.push(
			validationError(
				"CASE_LIST_SEARCH_INPUT_SELECT_WIDGET_NOT_SUPPORTED",
				"module",
				`Search input "${input.label || input.name}" (input #${i + 1}, name "${input.name}") on module "${mod.name}" uses the \`select\` widget type. The wire emitter currently has no way to populate the runtime's option list — CCHQ's runtime needs an \`<itemset>\` child on the prompt (\`commcare-core\`'s \`QueryPrompt.isSelect()\` returns false without it, so the widget renders as a plain text input). Change the input's \`type\` to \`text\` for now, or move the membership check to an advanced-arm predicate (the advanced arm composes the value match explicitly and doesn't depend on a CCHQ-side select widget).`,
				{ moduleUuid, moduleName: mod.name },
				{
					inputName: input.name,
					inputUuid: input.uuid,
					inputType: input.type,
				},
			),
		);
	}

	return errors;
}
