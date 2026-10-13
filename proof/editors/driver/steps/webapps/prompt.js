// Fills one prompt of the search screen the client shows as a worker fills
// it (HQ's cloudcare/templates/cloudcare/partials/query/item.html, read by
// cloudcare/js/formplayer/menus/views/query.js::QueryView): the prompt is the
// `index`-th field of the screen, from 0, in the order Formplayer hands the
// prompts (the order query.js itself pairs a field with a prompt in), and
// `value` is what Formplayer's walk typed, as the client sends it:
//
// - a text box: the value typed in, through the element's own value setter,
//   and the input and change events a browser fires, the second of which the
//   client reads (`changeQueryField`);
// - a drop-down of one choice: the option of that key selected, and its
//   change event;
// - a set of check boxes: a click on each box whose key the value names
//   (joined as Formplayer joins them) and is not checked, and on each
//   checked one it leaves out.
//
// The client then asks Formplayer whether the prompts hold (`query.js::
// _updateModelsForValidation`), which the step after this one waits for.
//
// It is a wait's predicate: false while the client has a request in flight
// or has drawn no search screen; true once it has filled the prompt;
// "unchanged" where the field already holds the value (the client sends
// nothing for a field that did not change); and, once the client is idle,
// "absent" where the screen holds no such field and "unanswerable" where the
// field is none of these (a date, a date range, an address).
({ index, value }) => {
	if (sessionStorage.getItem("formplayerQueryInProgress") === "true")
		return false;
	const screen = document.querySelector("#query-list-contents");
	if (!screen) return false;
	const field = [...screen.querySelectorAll(".query-field")][index];
	if (!field) return "absent";
	const changed = (element) =>
		element.dispatchEvent(new Event("change", { bubbles: true }));
	if (field.matches("fieldset")) {
		const wanted = new Set(value.split("#,#").filter(Boolean));
		const boxes = [...field.querySelectorAll("input[type=checkbox]")];
		const differing = boxes.filter(
			(box) => box.checked !== wanted.has(box.value),
		);
		if (!differing.length) return "unchanged";
		for (const box of differing) box.click();
		return true;
	}
	if (field.matches("select:not([multiple])")) {
		if (![...field.options].some((option) => option.value === value))
			return "unanswerable";
		if (field.value === value) return "unchanged";
		field.value = value;
		changed(field);
		return true;
	}
	if (field.matches("input[type=text]:not(.date):not(.daterange)")) {
		if (field.value === value) return "unchanged";
		const setter = Object.getOwnPropertyDescriptor(
			Object.getPrototypeOf(field),
			"value",
		).set;
		field.focus();
		setter.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
		changed(field);
		field.blur();
		return true;
	}
	return "unanswerable";
};
