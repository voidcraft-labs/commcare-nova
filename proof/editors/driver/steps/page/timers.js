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
//
// Nor are the timers of the progress bar the client shows while it waits on
// Formplayer (cloudcare/js/utils.js::showLoading and hideLoading, which call
// nprogress 0.2.0's NProgress.start and NProgress.done). While the bar shows
// it re-arms a one-off timer every 800 ms to creep forward (`start`'s
// `work`), a repeating timer made of timeouts that runs once more after the
// bar is done and then does nothing, and once done it fades out over two of
// 200 ms (`set`): a lifetime a worker watches, as a notification's fade is,
// and nothing but the bar changes. A timer is the bar's where its handler is
// the bar's own code, where the bar's own code sets it, or where it is set
// while one of the bar's timers runs. Counted, they held every step that
// asked Formplayer for up to 800 ms after the client had drawn its answer.
// `window.proofShortTimers()` is how many are set and not yet run.
() => {
	const SHORT_MS = 1000;
	// What the bar's code names itself by (nprogress.js keeps its functions on
	// the NProgress object), in a handler's source or a frame of the stack.
	const BAR = "NProgress.";
	const pending = new Set();
	const nativeSetTimeout = window.setTimeout;
	const nativeClearTimeout = window.clearTimeout;
	const nativeClearInterval = window.clearInterval;
	const sourceOf = Function.prototype.toString;
	// How many of the bar's timers are running their handlers now.
	let inBar = 0;
	const ofTheBar = (handler) =>
		inBar > 0 ||
		sourceOf.call(handler).includes(BAR) ||
		(new Error().stack ?? "").includes(` at ${BAR}`);
	window.setTimeout = function setTimeout(handler, timeout, ...args) {
		const delay = Number(timeout) || 0;
		if (typeof handler !== "function" || delay >= SHORT_MS) {
			return nativeSetTimeout.call(window, handler, timeout, ...args);
		}
		if (ofTheBar(handler)) {
			return nativeSetTimeout.call(
				window,
				(...given) => {
					inBar += 1;
					try {
						return handler.apply(window, given);
					} finally {
						inBar -= 1;
					}
				},
				timeout,
				...args,
			);
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
