/**
 * The SESSION-scoped `XPathLintContext`: what an after-submit link's
 * condition or carried value may read.
 *
 * CommCare evaluates a form link after the form has closed, against the
 * session rather than the form instance. So the editor for those slots
 * offers and accepts exactly what the deep validator's form-link pass
 * accepts (`lib/commcare/validator/index.ts`, the `FORM_LINK_XPATH_SLOT_IDS`
 * loop): the owning module's readable case types, narrowed by form type
 * through `caseRefAcceptMap` (read here via `caseTypePropsForValidation`,
 * the same one call the linter and the save gate make), and NO form
 * paths. `validPaths` and `formEntries` are empty on purpose — not "unknown",
 * empty — so a `/data/…` path lints as unknown and `#form/` is never
 * offered, and `scope: "session"` lets the linter say WHY in the author's
 * terms rather than as a missing field.
 */

import type { BlueprintDocState } from "@/lib/doc/store";
import type { Form, Uuid } from "@/lib/domain";
import { formReachableCaseTypes } from "./buildLintContext";
import type { XPathLintContext } from "./xpath-lint";

/**
 * Build the session-scoped context for `formUuid`'s after-submit slots.
 * `undefined` if the form no longer exists (caller decides what to render).
 */
export function buildSessionLintContext(
	state: BlueprintDocState,
	formUuid: Uuid,
): XPathLintContext | undefined {
	const form = state.forms[formUuid] as Form | undefined;
	if (!form) return undefined;
	return {
		formUuid,
		validPaths: new Set<string>(),
		reachableCaseTypes: formReachableCaseTypes(state, formUuid),
		formEntries: [],
		userProperties: Object.values(state.userProperties ?? {}),
		formType: form.type,
		scope: "session",
	};
}
