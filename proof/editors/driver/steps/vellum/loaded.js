// Vellum has finished loading the form, whether it parsed or failed
// (core.formLoadedCallback fires either way).
() =>
	!!window.proofVellum &&
	window.proofVellum.events.some((e) => e.name === "formLoadedCallback");
