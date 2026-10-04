// What the run left: Vellum's events, its requests still in flight, its Save
// button, whether the XML it last saved is the XML it creates now, and any
// modal it shows.
() => {
	const $ = window.proofVellumHost.jQuery;
	const vellum = $("#formdesigner").vellum("get");
	const core = vellum.data.core;
	return {
		events: window.proofVellum.events,
		requestsInFlight: $.active,
		saveButton: core.saveButton ? core.saveButton.state : null,
		lastSavedIsCreated:
			!!core.form && core.lastSavedXForm === vellum.createXML(),
		modals: [...document.querySelectorAll(".modal.in, .modal.show")].map((m) =>
			m.textContent.trim().slice(0, 500),
		),
	};
};
