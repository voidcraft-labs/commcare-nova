import type { BlueprintDoc } from "./blueprint";
import type { Uuid } from "./uuid";

/**
 * Whether Web Apps submits a form as soon as it opens, from the label of one
 * of its leaf questions. These are the only forms CommCare HQ's Case List
 * editor offers a clickable icon: `views/modules.py::_form_endpoint_options`
 * keeps a form with an entry point whose `Form.is_auto_submitting_form` holds,
 * a form that requires a case and has a question whose `label_ref` is
 * `Pragma-Submit-Automatically`. An icon naming any other form is one HQ's
 * editors cannot produce.
 *
 * Nova has no automatic submission, so no form submits on open and no case
 * list icon has a destination.
 */
export function formSubmitsOnOpenFromAQuestionLabel(
	_doc: BlueprintDoc,
	_formUuid: Uuid,
): boolean {
	return false;
}
