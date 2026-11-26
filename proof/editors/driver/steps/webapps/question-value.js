/** A text entry's visible answer after Web Apps has delivered a form message.
 * A missing question cannot satisfy the check, even for a cleared answer. */
({ ix, value, explain }) => {
	const question = [...document.querySelectorAll("#webforms .q")].find(
		(node) =>
			node
				.querySelector(":scope > .ix")
				?.textContent.trim()
				.split(" :: ")
				.pop() === ix,
	);
	const input = question?.querySelector(
		".widget textarea, .widget input:not([type=hidden])",
	);
	return explain
		? { ix, expected: value, shown: input?.value }
		: input?.value === value;
};
