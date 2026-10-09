// Submits the open form as a worker does: a click on its Submit button, which
// the client keeps disabled while an answer is still being saved or any
// question shows an error (cloudcare/js/form_entry/form_ui.js,
// enableSubmitButton). It is a wait's predicate: false while the client has
// drawn no Submit, true once it has clicked an enabled one, and "disabled"
// (for the record) where the button is drawn and a worker cannot press it.
(_arg) => {
	const found = [...document.querySelectorAll("#webforms button.submit")];
	if (found.length === 0) return false;
	if (found.length > 1) {
		throw new Error(
			`${found.length} Submit buttons are drawn; a Web Apps step submits exactly one form.`,
		);
	}
	if (found[0].disabled) return "disabled";
	found[0].click();
	return true;
};
