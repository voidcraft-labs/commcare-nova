// Which controls a page offers a person. The argument maps a name to a CSS
// selector; the answer maps each name to how many elements the loaded page
// holds for it and how many of those are laid out.
//
// A control HQ's template leaves out under a flag, a privilege or an add-on is
// not in the document at all, which is what "the page does not offer it"
// means here; one the page holds and hides (a tab not yet opened, a section a
// binding collapses) is offered and counts as held.
(selectors) =>
	Object.fromEntries(
		Object.entries(selectors).map(([name, selector]) => {
			const found = Array.from(document.querySelectorAll(selector));
			return [
				name,
				{
					held: found.length,
					laidOut: found.filter(
						(element) => element.getClientRects().length > 0,
					).length,
				},
			];
		}),
	);
