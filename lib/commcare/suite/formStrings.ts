/**
 * The strings HQ's build gives every form, one constant each, so the HQ JSON
 * and the local archive cannot drift apart.
 *
 * HQ writes each form's submit label into every language's strings and the
 * default strings (`app_strings.py`, `forms.m<N>f<M>.submit_label` from
 * `models/forms.py::FormBase.get_submit_label`), "Submit" where none is set,
 * as Nova never sets one. Formplayer hands it to the client with each form's
 * translations (`services/MenuSessionRunnerService.java`).
 */

/** A form's submit button text. */
export const FORM_SUBMIT_LABEL = "Submit";

/** HQ's locale id for a form's submit label (`id_strings.py::form_submit_label_locale`). */
export function formSubmitLabelLocaleId(
	moduleIndex: number,
	formIndex: number,
): string {
	return `forms.m${moduleIndex}f${formIndex}.submit_label`;
}
