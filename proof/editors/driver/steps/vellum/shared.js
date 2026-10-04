// Keeps what every Vellum instance on the host shares, as the freshly loaded
// host holds it before any instance has started, and gives the reset a way to
// put it back (window.proofVellumShared.restore, steps/vellum/reset.js).
//
// Vellum's mugs module (src/mugs.js, kept as window.proofVellumMugs by
// driver.mjs::exposeVellumModules) holds the mug types and property specs
// every instance builds on, and each instance's plugins write into them in
// place: core.js::getMugTypes and getMugSpec return the module's own
// baseMugTypes and baseSpecs, the plugins' getMugTypes add their types to
// them (commcareConnect, commtrack, intentManager, ignoreButRetain, itemset,
// modeliteration, saveToCase) and their getMugSpec add properties
// (caseManagement, lock, javaRosa), and mugs.js::MugTypesManager gives each
// type its valid child types only where it has none yet ("do nothing if
// validChildTypes is already set"), from the types its own instance knows.
// HQ chooses the plugins per form (views/formdesigner.py::
// _get_vellum_plugins: commcareConnect only under COMMCARE_CONNECT), so on a
// kept host a form would get the types, specs and valid children of the
// instances before it: a Connect learn module or assessment that the root
// does not admit as a child is left out of the question tree, which leaves it
// unvalidated (core.js::_populateTree), where a fresh page shows its errors.
//
// What is kept is every plain object and array reachable from the module's
// exports, each with its own properties as they are now; the restore puts
// each object's own properties back as they were (removing those added since,
// in place, so every module that holds one of these objects sees it put
// back), and returns how many objects it found changed.
() => {
	const mugs = window.proofVellumMugs;
	if (!mugs)
		throw new Error(
			"The Vellum host has no window.proofVellumMugs: the driver keeps Vellum's mugs module there when it loads the host.",
		);
	const kept = new Map();
	const keep = (value) => {
		if (value === null || typeof value !== "object" || kept.has(value)) return;
		const prototype = Object.getPrototypeOf(value);
		if (
			!Array.isArray(value) &&
			prototype !== Object.prototype &&
			prototype !== null
		)
			return;
		const own = Object.getOwnPropertyDescriptors(value);
		kept.set(value, own);
		for (const key of Reflect.ownKeys(own)) keep(own[key].value);
	};
	keep(mugs);
	const same = (a, b) =>
		a !== undefined &&
		b !== undefined &&
		a.value === b.value &&
		a.get === b.get &&
		a.set === b.set &&
		a.writable === b.writable &&
		a.enumerable === b.enumerable &&
		a.configurable === b.configurable;
	const restore = () => {
		let changed = 0;
		for (const [object, own] of kept) {
			const now = Object.getOwnPropertyDescriptors(object);
			const keys = new Set([...Reflect.ownKeys(now), ...Reflect.ownKeys(own)]);
			if ([...keys].every((key) => same(now[key], own[key]))) continue;
			changed += 1;
			if (Array.isArray(object)) object.length = 0;
			for (const key of Reflect.ownKeys(now)) {
				if (!Object.hasOwn(own, key)) delete object[key];
			}
			Object.defineProperties(object, own);
		}
		return changed;
	};
	Object.defineProperty(window, "proofVellumShared", {
		value: { objects: kept.size, restore },
		configurable: true,
	});
	return { objects: kept.size };
};
