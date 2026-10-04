// Gives a section the change its page listens for, then says whether its Save
// button took it (its bar reads "Save"). The driver calls it until it does:
// the page binds its listeners a turn after its bindings apply (_.defer,
// setTimeout), so the first change can come too early.
//
// The argument is {action, selector, bar}:
// - "touch": the change event on the element `selector` finds, which bubbles
//   to the page's listeners; no control's value is set;
// - "revert": the first enabled, laid-out control `selector` finds, changed
//   and changed back with the events a person's edit raises, so the page's
//   model sees two changes and ends where it began.
({ action, selector, bar }) => {
	const fire = (element) =>
		element.dispatchEvent(new Event("change", { bubbles: true }));
	if (action === "touch") {
		const element = document.querySelector(selector);
		if (element) fire(element);
	} else if (action === "revert") {
		const control = [...document.querySelectorAll(selector)].find(
			(element) => !element.disabled && element.getClientRects().length > 0,
		);
		if (control && (control.type === "checkbox" || control.type === "radio")) {
			control.click();
			control.click();
		} else if (
			control &&
			control.tagName === "SELECT" &&
			control.options.length > 1
		) {
			// By position: Knockout's options binding keeps an option's value on
			// the element, not in its value attribute.
			const original = control.selectedIndex;
			control.selectedIndex = original === 0 ? 1 : 0;
			fire(control);
			control.selectedIndex = original;
			fire(control);
		}
	} else {
		throw new Error(`The driver has no arming action "${action}".`);
	}
	return document.querySelector(bar).classList.contains("savebtn-bar-save");
};
