// A person's save: Vellum's Save button turns to "Save" (Vellum's own change)
// and is clicked. Vellum refuses to serialize a form with serialization
// warnings (core.js::canSerializeXForm shows "There are errors in the form"
// and posts nothing), so such a form is not saved. Nor is one Vellum parsed
// without HQ's data sources: its save would not be the one HQ's form designer
// makes.
() => {
	const $ = window.proofVellumHost.jQuery;
	const vellum = $("#formdesigner").vellum("get");
	const core = vellum.data.core;
	const events = window.proofVellum.events;
	if (core.formLoadingFailed)
		return { saved: false, reason: "the form did not load" };
	if (events.some((e) => e.name === "datasources:error")) {
		return { saved: false, reason: "the data sources did not load" };
	}
	const sourcesChanged = events.findIndex(
		(e) => e.name === "datasources:change",
	);
	const loaded = events.findIndex((e) => e.name === "formLoadedCallback");
	if (
		!window.proofVellum.sourcesReadyAtStart &&
		(sourcesChanged === -1 || sourcesChanged > loaded)
	) {
		return {
			saved: false,
			reason: "the data sources arrived after the form was parsed",
		};
	}
	if (core.form.getSerializationWarnings().length)
		return { saved: false, reason: "serialization warnings" };
	core.saveButton.fire("change");
	const button = core.saveButton.ui
		.find(".btn")
		.filter((_i, e) => !$(e).hasClass("disabled"))
		.get(0);
	if (!button) return { saved: false, reason: "no Save button to click" };
	button.click();
	window.proofVellum.saving = true;
	return { saved: true };
};
