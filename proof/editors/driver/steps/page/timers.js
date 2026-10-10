// The page's own short one-off timers, counted: installed before any of the
// page's own scripts on every document of a run that asks for it (the driver
// adds it as a script every new document runs first, after
// steps/page/polls.js), so a step can wait until the page has finished what
// it set itself to do (`settle` with `timers`).
//
// The Web Apps client answers a question a moment after its widget changes,
// from a throttle (form_entry/form_ui.js, Question.triggerAnswer's
// publishAnswerEvent, `_.throttle` of 200 ms). Formplayer hands back what it
// stored, and where that is not what the client holds (Formplayer reads a
// stored form again on every request, which trims a text answer's
// whitespace), the client's knockout mapping takes Formplayer's value and
// sends it as that question's answer: from the throttle's trailing timer
// when the question was answered less than 200 ms before. A step that read
// only the page's requests went on while that timer was still set, so how
// many answers the client sent before Submit, and which value it then
// submitted, depended on how fast the runner was (a hosted run's client
// submitted a key Formplayer's later request would have trimmed, and its
// list showed a case more). A worker acts once the page has finished
// reacting, so a step waits for these timers to run, and for the requests
// they start, as it waits for the client's own flags.
//
// A one-off timer shorter than SHORT_MS is counted from the moment the page
// sets it until it runs or is cleared: the client finishing what it was just
// told (a throttled answer, a debounced handler, a dialog's transition, a
// jQuery handler that runs on the next task). A longer one is a lifetime a
// worker watches run out (a notification's fade, HQ's own `.delay(5000)`
// before it, cloudcare/js/utils.js::_show) and is not waited for. A
// repeating timer is not counted (polls.js holds the long ones).
// `window.proofShortTimers()` is how many are set and not yet run.
() => {
	const SHORT_MS = 1000;
	const pending = new Set();
	const nativeSetTimeout = window.setTimeout;
	const nativeClearTimeout = window.clearTimeout;
	const nativeClearInterval = window.clearInterval;
	window.setTimeout = function setTimeout(handler, timeout, ...args) {
		const delay = Number(timeout) || 0;
		if (typeof handler !== "function" || delay >= SHORT_MS) {
			return nativeSetTimeout.call(window, handler, timeout, ...args);
		}
		const id = nativeSetTimeout.call(
			window,
			(...given) => {
				pending.delete(id);
				return handler.apply(window, given);
			},
			timeout,
			...args,
		);
		pending.add(id);
		return id;
	};
	window.clearTimeout = function clearTimeout(id) {
		pending.delete(id);
		return nativeClearTimeout.call(window, id);
	};
	// A timeout's id is one clearInterval also clears.
	window.clearInterval = function clearInterval(id) {
		pending.delete(id);
		return nativeClearInterval.call(window, id);
	};
	Object.defineProperty(window, "proofShortTimers", {
		value: () => pending.size,
		configurable: false,
		enumerable: false,
		writable: false,
	});
};
