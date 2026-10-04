// The page's clock and randomness, fixed for a run: installed before any of
// the page's own scripts (the driver adds it as a script every new document
// runs first). The argument is {seed, epoch}: `seed` is 32 hex digits drawn
// from the run's spec, `epoch` milliseconds since 1970.
//
// - Date: `new Date()` and `Date.now()` read `epoch`; a Date made from a
//   value is an ordinary Date, and subclasses construct as they do natively.
//   Timers, animation frames and `performance` are the browser's own. So no
//   time passes for code that measures elapsed time with Date: a jQuery
//   animation (jQuery.fx reads Date.now) stays where it began, so an element
//   HQ's page fades out stays shown (app_manager.js's `.appmanager-loading`)
//   and its frames keep ticking until the document goes (the warm Vellum
//   host, whose document stays, ends a run's animations with the run:
//   steps/vellum/end.js); underscore's
//   `_.debounce` reschedules itself every wait and never calls its function;
//   `_.throttle` calls at once only the first time, and every later call
//   waits for its trailing timer, a full wait of real time; diff-match-patch's
//   `Diff_Timeout` never expires, so a diff runs to its end. Every page the
//   driver compares runs under the same clock (a held view, a warm Vellum
//   run, a fresh page), and test_seeding.py shows that fixing the clock and
//   randomness changes nothing a run records.
// - Math.random and crypto.getRandomValues draw from one sfc32 generator
//   seeded with `seed`. getRandomValues still runs the browser's own (so it
//   refuses what the browser refuses, and returns the same array), then
//   overwrites the bytes. The origin is not a secure context, so the page has
//   no crypto.randomUUID, and none is added.
// - `window.proofReseed(seed)` restarts the generator, for a run that reuses
//   the document.
({ seed, epoch }) => {
	const state = new Uint32Array(4);
	const reseed = (hex) => {
		for (let i = 0; i < 4; i++)
			state[i] = Number.parseInt(hex.slice(i * 8, i * 8 + 8), 16) >>> 0;
		// sfc32's own warm-up: its first outputs still echo the seed.
		for (let i = 0; i < 12; i++) next();
	};
	const next = () => {
		const t = (((state[0] + state[1]) >>> 0) + state[3]) >>> 0;
		state[3] = (state[3] + 1) >>> 0;
		state[0] = state[1] ^ (state[1] >>> 9);
		state[1] = (state[2] + (state[2] << 3)) >>> 0;
		state[2] = ((state[2] << 21) | (state[2] >>> 11)) >>> 0;
		state[2] = (state[2] + t) >>> 0;
		return t;
	};
	reseed(seed);
	Object.defineProperty(window, "proofReseed", {
		value: reseed,
		configurable: false,
		enumerable: false,
		writable: false,
	});

	Math.random = function random() {
		return next() / 4294967296;
	};
	const nativeGetRandomValues = Crypto.prototype.getRandomValues;
	Crypto.prototype.getRandomValues = function getRandomValues(array) {
		const filled = nativeGetRandomValues.call(this, array);
		const bytes = new Uint8Array(
			filled.buffer,
			filled.byteOffset,
			filled.byteLength,
		);
		for (let i = 0; i < bytes.length; i += 4) {
			const word = next();
			for (let j = 0; j < 4 && i + j < bytes.length; j++)
				bytes[i + j] = (word >>> (8 * j)) & 0xff;
		}
		return filled;
	};

	const NativeDate = Date;
	function FixedDate(...args) {
		if (!new.target) return new NativeDate(epoch).toString();
		return Reflect.construct(
			NativeDate,
			args.length ? args : [epoch],
			new.target,
		);
	}
	Object.setPrototypeOf(FixedDate, NativeDate);
	FixedDate.prototype = NativeDate.prototype;
	FixedDate.now = function now() {
		return epoch;
	};
	Object.defineProperty(FixedDate, "name", { value: "Date" });
	Object.defineProperty(FixedDate, "length", { value: 7 });
	window.Date = FixedDate;
};
