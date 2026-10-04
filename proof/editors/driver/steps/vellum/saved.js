// The run is over. With a save: Vellum took HQ's answer (onFormSave), its
// Save button left "Saving" and jQuery has no request in flight (a re-sent
// full save included), or Vellum shows a refusal ("Try Again" after a failed
// request, or a modal: a conflict or a validation error). Without one (the
// form did not load, or Vellum would not save it): no request of Vellum's is
// in flight, so what the run reports does not depend on when a request
// Vellum made on its own (its data sources, its check for submissions)
// came back.
() => {
	const record = window.proofVellum;
	const $ = window.proofVellumHost.jQuery;
	if (!record.saving) return $.active === 0;
	const state = $("#formdesigner").vellum("get").data.core.saveButton.state;
	if (
		state === "retry" ||
		document.querySelectorAll(".modal.in, .modal.show").length > 0
	)
		return true;
	return (
		state === "saved" &&
		$.active === 0 &&
		record.events.some((e) => e.name === "onFormSave")
	);
};
