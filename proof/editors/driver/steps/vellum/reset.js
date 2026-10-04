// Readies a host page that already ran Vellum for the next form, as Vellum's
// own tests reset their instance (tests/utils.js::init): the instance's
// destroy (core.js's fn.destroy, which plugins may extend), the modals and
// backdrops Bootstrap appended to the body, the container emptied. The
// location's hash is removed without a hashchange event (Vellum selects the
// question the hash names when it loads a form, core.js::loadXML, and writes
// it when a question is selected), the page's storage is emptied (Vellum keeps
// section and nudge state in localStorage), and what every instance shares is
// put back as a fresh page starts it: Vellum's check for form submissions
// and the host's jQuery animations (steps/vellum/end.js; the run before
// already ended both, so none is found running unless something of that run
// outlived it), and the mug types and property specs every instance's
// plugins write into (steps/vellum/shared.js, kept as the host first held
// them). The generator behind Math.random restarts as Vellum starts
// (vellum/start.js). Returns whether an instance was there, how many jQuery
// animations were still running and how many of the shared objects the
// instances before had changed: {instance, animations, shared}.
() => {
	const $ = window.proofVellumHost.jQuery;
	const util = window.proofVellumUtil;
	if (!util)
		throw new Error(
			"The Vellum host has no window.proofVellumUtil: the driver keeps Vellum's util there when it loads the host.",
		);
	if (!window.proofVellumShared)
		throw new Error(
			"The Vellum host has no window.proofVellumShared: the driver keeps what Vellum's instances share there when it loads the host (steps/vellum/shared.js).",
		);
	const animations = $.timers.length;
	$.timers.length = 0;
	$.fx.stop();
	const container = $("#formdesigner");
	const old = container.vellum("get");
	if (old) {
		old.destroy();
		$("body > div.modal, body > div.modal-backdrop").remove();
	}
	container.empty();
	if (window.location.hash) {
		window.history.replaceState(
			null,
			"",
			window.location.pathname + window.location.search,
		);
	}
	window.localStorage.clear();
	window.sessionStorage.clear();
	util.checkForFormSubmissions.cancel();
	const shared = window.proofVellumShared.restore();
	window.proofVellum = undefined;
	return { instance: !!old, animations, shared };
};
