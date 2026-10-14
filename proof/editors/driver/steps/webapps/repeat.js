// Adds a repetition to a repeat of the open form as a worker does: a click on
// the repeat's own Add button (HQ's cloudcare/templates/cloudcare/partials/
// form_entry/sub_group.html, `newRepeat`; the button the client draws where
// Formplayer hands it a repeat's next, not yet existing, repetition), found
// by its place among the form's Add buttons, `index` from 0 in the form's
// order, which is the order Formplayer's walk met them in.
//
// It is a wait's predicate: false while the client has a request in flight
// or has drawn no form yet; true once it has clicked; and, once the client
// is idle, "absent" where the form shows no such button (a form shown one
// question a screen never shows one).
({ index }) => {
	if (sessionStorage.getItem("formplayerQueryInProgress") === "true")
		return false;
	const form = document.querySelector("#webforms");
	if (!form?.children.length) return false;
	const shown = [...document.querySelectorAll("#webforms button.add")].filter(
		(button) => button.getClientRects().length > 0,
	);
	const button = shown[index];
	if (!button) return "absent";
	button.click();
	return true;
};
