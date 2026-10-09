// Whether the client has answered a click on a case's row: either its case
// detail dialog is open and done opening, or it took the case without one
// (it does where the detail has nothing to show,
// cloudcare/js/formplayer/menus/controller.js::showDetail) and has arrived
// at the screen after it (`selections`, as steps/webapps/arrived.js reads
// the route).
//
// Done opening is Bootstrap's own mark: the dialog takes the focus in the
// callback that ends its opening, the one that also lets it close
// (bootstrap modal.js::_showElement, transitionComplete). A Continue
// clicked before that is a close Bootstrap ignores, which leaves the dialog
// over every screen after it.
({ selections }) => {
	if (sessionStorage.getItem("formplayerQueryInProgress") === "true")
		return false;
	const dialog = document.querySelector("#case-detail-modal");
	if (
		dialog?.classList.contains("show") &&
		dialog.contains(document.activeElement)
	)
		return true;
	if (
		document.body.classList.contains("modal-open") ||
		document.querySelector(".modal-backdrop")
	)
		return false;
	let route;
	try {
		route = JSON.parse(decodeURIComponent(location.hash.replace(/^#/, "")));
	} catch {
		return false;
	}
	const held = route?.selections ?? [];
	return (
		held.length === selections.length &&
		selections.every(
			(wanted, index) => wanted === null || String(held[index]) === wanted,
		)
	);
};
