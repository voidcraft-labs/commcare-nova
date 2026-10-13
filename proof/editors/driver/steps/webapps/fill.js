// Types `value` into the one text input `selector` finds, as the client
// hears typing: the input's value is set through the element's own setter
// and the `input` and `change` events a browser fires are dispatched. Like
// the click step it is a wait's predicate: false while the client has not
// rendered the input, true once it has typed.
({ selector, value }) => {
	const found = [...document.querySelectorAll(selector)];
	if (found.length === 0) return false;
	if (found.length > 1) {
		throw new Error(
			`${found.length} elements match ${selector}; a Web Apps step types into exactly one.`,
		);
	}
	const [input] = found;
	const setter = Object.getOwnPropertyDescriptor(
		Object.getPrototypeOf(input),
		"value",
	)?.set;
	if (!setter) {
		throw new Error(`${selector} is no text input: it has no value to set.`);
	}
	input.focus();
	setter.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
	input.dispatchEvent(new Event("change", { bubbles: true }));
	return true;
};
