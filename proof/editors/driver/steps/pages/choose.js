// Chooses the option whose value is `value` in the one select `selector`
// finds, as a browser hears a person choose it: the select's value set and
// the `input` and `change` events a browser fires dispatched, so the page's
// own bindings (knockout's, a select2 over it) hear the choice. It is a
// wait's predicate: false while the page has not drawn the select or the
// option, true once it has chosen.
({ selector, value }) => {
	const found = [...document.querySelectorAll(selector)];
	if (found.length === 0) return false;
	if (found.length > 1) {
		throw new Error(
			`${found.length} elements match ${selector}; a step chooses in exactly one.`,
		);
	}
	const [select] = found;
	if (!(select instanceof HTMLSelectElement)) {
		throw new Error(`${selector} is no select: there is no option to choose.`);
	}
	if (![...select.options].some((option) => option.value === value))
		return false;
	select.focus();
	select.value = value;
	select.dispatchEvent(new Event("input", { bubbles: true }));
	select.dispatchEvent(new Event("change", { bubbles: true }));
	return true;
};
