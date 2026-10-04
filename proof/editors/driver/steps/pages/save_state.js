// A section's Save button state (its bar's savebtn-bar-* class) and the alerts
// the page shows. The argument is the bar's selector.
//
// HQ's stylesheets are not loaded, so an alert counts as shown when it is laid
// out (Knockout's visible binding hides it inline) and neither it nor an
// ancestor carries a class Bootstrap hides with. A page holds alerts of its
// own that no save made (the app settings page's add-ons tab shows an upgrade
// notice for each add-on the project's plan lacks, partials/settings/
// add_ons.html), so a caller reads them before a save as well, and a save's
// alerts are the ones it added. The build errors banner is not a save's
// alert: a module or form page fetches HQ's validation into #build_errors
// when it loads and after every save (app_manager.js::setupValidation,
// updateDOM).
(bar) => {
	const hiddenByClass = (element) =>
		!!element.closest(".hide, .hidden, .d-none");
	const shown = (element) =>
		element.getClientRects().length > 0 &&
		!hiddenByClass(element) &&
		!element.closest("#build_errors");
	return {
		state:
			[...document.querySelector(bar).classList].find(
				(c) => c.startsWith("savebtn-bar-") && c !== "savebtn-bar-danger",
			) || "",
		alerts: [...document.querySelectorAll(".alert")]
			.filter(shown)
			.map((a) => a.textContent.trim())
			.filter(Boolean),
	};
};
