// The run is over. With a save: Vellum took HQ's answer (onFormSave), its
// Save button left "Saving" and jQuery has no request in flight (a re-sent
// full save included), or Vellum shows a refusal ("Try Again" after a failed
// request, or a modal: a conflict or a validation error). Without one (the
// form did not load, or Vellum would not save it): no request of Vellum's is
// in flight, so what the run reports does not depend on when a request
// Vellum made on its own (its data sources, its check for submissions)
// came back; and where the form did not load, the modal Vellum shows its
// error in is shown. Bootstrap shows a modal only once its backdrop's
// transition has run, so a run that went on at once read no modal on a warm
// host and the modal on a host loaded for it: two observations of one form
// that Vellum refuses (a second unnamed instance) once recorded each.
() => {
	const record = window.proofVellum;
	const $ = window.proofVellumHost.jQuery;
	const core = $("#formdesigner").vellum("get").data.core;
	const modalShown =
		document.querySelectorAll(".modal.in, .modal.show").length > 0;
	if (!record.saving)
		return $.active === 0 && (!core.formLoadingFailed || modalShown);
	const state = core.saveButton.state;
	if (state === "retry" || modalShown) return true;
	return (
		state === "saved" &&
		$.active === 0 &&
		record.events.some((e) => e.name === "onFormSave")
	);
};
