// These checkboxes are the columns the worker can show in Web Apps' open column preferences.
() => {
	const popover = document.querySelector(".popover .popover-content");
	if (!popover)
		throw new Error("The case list's column preferences did not open.");
	return [...popover.querySelectorAll("input.column-checkbox")].map((box) =>
		Number(box.dataset.index),
	);
};
