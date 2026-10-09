// Whether the client has arrived where a worker's choice leads, by the
// client's own account of it, never by a time:
//
// - its route (the address it keeps a worker's session in, HQ's
//   cloudcare/js/formplayer/utils/utils.js CloudcareUrl, which the router
//   sets before it asks Formplayer for the screen) holds what the choice
//   adds: `selections` (each a string, or null where Formplayer draws the
//   value, as it does for a multi-select list's chosen cases), each key of
//   `queryData` with its `execute`, and a form's `sessionId` where `form`
//   says one opens (true) or none is open (false);
// - none of its requests to Formplayer is in flight by its own flag
//   (`formplayerQueryInProgress`, which the client sets at jQuery's
//   ajaxStart and clears at ajaxStop, once every answer has been handled
//   and its screen drawn: cloudcare/js/formplayer/app.js, cloudcare/js/
//   utils.js::formplayerLoading);
// - no Bootstrap dialog is open or moving: the case detail's dialog closes
//   with an animation, and Bootstrap ignores a close asked for while it is
//   still opening, so the body's `modal-open` and the backdrop stay until
//   it is gone;
// - no notification is fading: the client fades its "Form successfully
//   saved!" out once the worker moves on (cloudcare/js/formplayer/app.js,
//   `clearSuccess`, jQuery's fadeOut, which sets the element's opacity as it
//   goes and removes it at the end).
//
// With `any` the route is not looked at: where Formplayer refused the step,
// the client shows the error and goes back on its own. With `explain`, what
// has not happened yet is answered in words in place of false (for a wait
// that ran out, so its failure says what the client was still doing).
({ selections, queryData, form, any, explain }) => {
	const not = (why) => (explain ? why : false);
	if (sessionStorage.getItem("formplayerQueryInProgress") === "true")
		return not("the client's own flag says a request is in flight");
	if (
		document.body.classList.contains("modal-open") ||
		document.querySelector(".modal-backdrop")
	)
		return not("a dialog is open or moving");
	if (
		[...document.querySelectorAll("#cloudcare-notifications > *")].some(
			(element) => element.style.opacity !== "",
		)
	)
		return not("a notification is fading");
	if (any) return true;
	let route;
	try {
		route = JSON.parse(decodeURIComponent(location.hash.replace(/^#/, "")));
	} catch {
		return not(`the route is not the client's session: ${location.hash}`);
	}
	if (!route || typeof route !== "object")
		return not(`the route is not the client's session: ${location.hash}`);
	const shown = JSON.stringify(route);
	if (selections !== undefined && selections !== null) {
		const held = route.selections ?? [];
		if (held.length !== selections.length)
			return not(`the route's selections are not yet the choice's: ${shown}`);
		for (const [index, wanted] of selections.entries()) {
			if (wanted !== null && String(held[index]) !== wanted)
				return not(`the route's selections are not yet the choice's: ${shown}`);
		}
	}
	for (const [key, wanted] of Object.entries(queryData ?? {})) {
		const held = route.queryData?.[key];
		if (!held || Boolean(held.execute) !== Boolean(wanted.execute))
			return not(`the route's search is not yet the choice's: ${shown}`);
	}
	if (form === true && !route.sessionId)
		return not(`the route holds no form yet: ${shown}`);
	if (form === false && route.sessionId)
		return not(`the route still holds a form: ${shown}`);
	return true;
};
