/**
 * Rule: simple-arm `SearchInputDef`s with `type: "select"` are
 * rejected because the wire prompt has no itemset slot to render
 * the runtime widget as a select.
 *
 * CCHQ-core's `QueryPrompt::isSelect`
 * (`commcare-core/.../suite/model/QueryPrompt.java::isSelect`)
 * returns `getItemsetBinding() != null`. Without an `<itemset>`
 * child on the prompt, the runtime treats `input="select1"` as a
 * plain text input — the author picked the select widget but the
 * user gets a free-text field. The CCHQ-side prompt emitter at
 * `commcare-hq/.../suite_xml/post_process/remote_requests.py::build_query_prompts`
 * mirrors the contract: it writes the itemset only when
 * `prop.itemset.nodeset` is non-empty.
 *
 * Authors composing a value-membership check use an advanced-arm
 * `selected(...)` predicate — the advanced arm composes the
 * comparison explicitly and does not depend on a CCHQ-side select
 * widget. This rule is silent on advanced-arm inputs.
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
				`Search input "${input.label || input.name}" (input #${i + 1}, name "${input.name}") on module "${mod.name}" uses the \`select\` widget type. The wire prompt has no itemset slot to populate, so the runtime would render this as a plain text input instead of a select (CCHQ-core's \`QueryPrompt.isSelect()\` returns false without an \`<itemset>\` child). Change the input's \`type\` to \`text\`, or move the value-membership check to an advanced-arm \`selected(...)\` predicate — the advanced arm composes the comparison explicitly and does not depend on a CCHQ-side select widget.`,
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
