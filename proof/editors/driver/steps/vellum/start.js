// Starts Vellum on the host page with HQ's options, the driver observing the
// callbacks HQ's form designer page sets on `core` (the image build checks
// that HQ's page sets exactly these). The argument is {options, loadDelay,
// seed}: `options` is HQ's options as the page's template serializes them, a
// `loadDelay` that is not null replaces the options' `core.loadDelay`, and
// `seed` is the run's seed (32 hex digits) or null for a page whose clock and
// randomness are the browser's own.
//
// With a seed, the generator behind Math.random restarts from it as Vellum
// starts (page/seed.js's window.proofReseed), on a host loaded for this form
// and on a warm host alike, so Vellum draws the same values whichever host it
// runs on, whatever the host's own scripts drew as they loaded. Returns what
// the page reads as Vellum starts, {clock: Date.now(), draw: the first value
// Math.random gives}: the run's evidence that its clock and randomness are
// the ones its seed fixes. The draw is read, then the generator restarted
// again, so Vellum's own first draw is that same value.
//
// Vellum schedules the form's parse with window.setTimeout right after it
// calls formLoadingCallback (core.js::loadXFormOrError). The first such timer
// is held until the data sources have arrived or failed, so the parse always
// follows them, as on HQ's page. A held parse runs in a task of its own, as
// the timer would run it: run from inside the sources' change handler, a
// parse that throws (a form Vellum cannot load) would throw into jQuery's
// handling of the sources' answer and leave that request counted in flight.
//
// What the run records is the same whichever comes first, the timer or HQ's
// answer to the sources (a race the run's spec does not fix): the timer is
// noted as scheduled, the sources' arrival as their change, and the parse as
// it runs, after both; whether the parse had to wait is not noted.
({ options: optionsJson, loadDelay, seed }) => {
	if (seed !== null && typeof window.proofReseed !== "function") {
		throw new Error(
			"The run is seeded and the host page has no window.proofReseed: the driver adds page/seed.js to a seeded host before its own scripts.",
		);
	}
	if (seed !== null) window.proofReseed(seed);
	const page = { clock: Date.now(), draw: Math.random() };
	if (seed !== null) window.proofReseed(seed);
	const host = window.proofVellumHost;
	const $ = host.jQuery;
	const _ = host.underscore;
	window.proofVellum = { events: [], started: performance.now() };
	const record = window.proofVellum;
	const note = (name, detail) =>
		record.events.push(
			detail === undefined
				? { name, at: performance.now() - record.started }
				: { name, detail, at: performance.now() - record.started },
		);
	const options = _.extend({}, JSON.parse(optionsJson), host.pageOptions());
	if (loadDelay !== null) {
		options.core = _.extend({}, options.core, { loadDelay });
	}
	let parseHeld = false;
	const holdParse = () => {
		if (parseHeld) return;
		parseHeld = true;
		const schedule = window.setTimeout;
		window.setTimeout = (callback, delay, ...rest) => {
			window.setTimeout = schedule;
			note("parse:scheduled", delay);
			return schedule(() => {
				const sources = $("#formdesigner").vellum("get").datasources;
				const failed = () =>
					record.events.some((e) => e.name === "datasources:error");
				if (sources.isReady() || failed()) {
					note("parse:run");
					callback(...rest);
					return;
				}
				let ran = false;
				const run = () => {
					if (ran) return;
					ran = true;
					schedule(() => {
						note("parse:run");
						callback(...rest);
					}, 0);
				};
				sources.on("change", run);
				sources.on("error", run);
			}, delay);
		};
	};
	const observers = {
		formLoadingCallback: () => {
			note("formLoadingCallback");
			holdParse();
		},
		formLoadedCallback: () => note("formLoadedCallback"),
		onReady: () => note("onReady"),
		onFormSave: (data) => note("onFormSave", data),
	};
	if (
		JSON.stringify(Object.keys(observers).sort()) !==
		JSON.stringify([...host.coreCallbacks].sort())
	) {
		throw new Error(
			`HQ's form designer page sets core callbacks ${host.coreCallbacks}, not the ones the driver observes.`,
		);
	}
	options.core = _.extend(options.core, observers);
	$("#formdesigner").vellum(options);
	const vellum = $("#formdesigner").vellum("get");
	record.sourcesReadyAtStart = vellum.datasources.isReady();
	vellum.datasources.on("change", () => note("datasources:change"));
	vellum.datasources.on("error", (event) =>
		note("datasources:error", String(event?.xhr?.status)),
	);
	vellum.data.core.saveButton.on("state:change", () =>
		note(`saveButton:${vellum.data.core.saveButton.state}`),
	);
	return page;
};
