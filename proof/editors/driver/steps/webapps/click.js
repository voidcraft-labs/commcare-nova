// Clicks what a worker clicks: the one element `selector` finds whose text
// is `text` (every element it finds, when no text is given, must be one), as
// a person's click (the element's own click()). It is a wait's predicate:
// while the client has not rendered the element it answers false and the
// driver looks again, and once the element is there it clicks it and
// answers true, so the click happens once. More than one match is an error:
// a step names exactly what is clicked.
({ selector, text }) => {
	const shown = (element) =>
		element.textContent.replace(/[ \t\r\n\f]+/g, " ").replace(/^ | $/g, "");
	const found = [...document.querySelectorAll(selector)].filter(
		(element) => text === undefined || text === null || shown(element) === text,
	);
	if (found.length === 0) return false;
	if (found.length > 1) {
		throw new Error(
			`${found.length} elements match ${selector}${text == null ? "" : ` with the text ${JSON.stringify(text)}`}; a Web Apps step clicks exactly one.`,
		);
	}
	found[0].click();
	return true;
};
