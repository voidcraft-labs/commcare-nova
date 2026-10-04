// Ends a clean run on the warm host as a fresh page's context closing would
// end it: nothing the run started may run on after it. Two things a run
// leaves acting on their own:
//
// - Vellum's check for form submissions (src/util.js::
//   checkForFormSubmissions, a module-level _.throttle with a 10 s wait that
//   every mug's validate calls, mugs.js): a run's later calls leave a
//   trailing call scheduled, which would send the form's
//   `form_has_submissions` request after the run. It is cancelled, which also
//   puts the throttle back as a fresh page starts it (underscore's `cancel`:
//   no call pending, none made yet). The driver keeps Vellum's util as
//   window.proofVellumUtil (driver.mjs::exposeVellumModules).
// - The host's jQuery animations. Under the run's fixed clock
//   (steps/page/seed.js) an animation never reaches its end, so one a run
//   starts (Vellum fades its messages in, core.js::_resetMessages, whenever a
//   form it loads has errors) would tick on every animation frame for as
//   long as the host lives, and each later run would add its own. They are
//   ended as a closing context ends them: taken off jQuery's list of running
//   animations (jQuery.timers) with jQuery's frame loop stopped
//   (jQuery.fx.stop), their callbacks never called. jQuery starts its loop
//   afresh for the next animation, as on a new page.
//
// Returns how many animations were running: {animations}.
() => {
	const util = window.proofVellumUtil;
	if (!util)
		throw new Error(
			"The Vellum host has no window.proofVellumUtil: the driver keeps Vellum's util there when it loads the host.",
		);
	util.checkForFormSubmissions.cancel();
	const $ = window.proofVellumHost.jQuery;
	const animations = $.timers.length;
	$.timers.length = 0;
	$.fx.stop();
	return { animations };
};
