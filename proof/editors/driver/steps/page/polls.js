// The page's polls, held: installed before any of the page's own scripts on
// every document the driver opens, seeded or not (the driver adds it as a
// script every new document runs first, ahead of steps/page/seed.js).
//
// A repeating timer of POLL_MS or longer is registered and never runs. On
// an app-manager page that is HQ's check for a release behind the app
// (app_manager/js/menu.js::initPublishStatus asks current_app_version every
// 20 seconds of real time). Whether that check fires inside a run depends
// only on how long the run takes on the machine, so on a loaded runner a
// view's records gained a second check, and one landed while a section's
// save was in flight (pages.py::_check_writes_alone). The check the page
// makes as it loads still runs: a run is one pass through the page, quicker
// than any poll. Shorter repeating timers (HQ's download poll, every 2 s)
// and every one-off timer run as the browser runs them.
() => {
	const POLL_MS = 10000;
	const nativeSetInterval = window.setInterval;
	window.setInterval = function setInterval(handler, timeout, ...args) {
		if (Number(timeout) >= POLL_MS) {
			// A real timer, so its id is one clearInterval accepts, running nothing.
			return nativeSetInterval.call(window, () => {}, timeout);
		}
		return nativeSetInterval.call(window, handler, timeout, ...args);
	};
};
