// Finds the widget a worker answers one question of the open form with by
// a gesture no page function can make (HQ's cloudcare/templates/cloudcare/
// partials/form_entry/entry_file.html, entry_signature.html and
// entry_geo.html, filled by cloudcare/js/form_entry/entries.js::FileEntry,
// SignatureEntry and GeoPointEntry): the question is found by its index, as
// answer.js finds one, and `widget` names what the worker gives it: "file",
// a file chosen through the widget's own file input (an image, audio, video
// or document question); "signature", a stroke drawn on its signature pad's
// canvas; "map", the map dragged until its centre is the place.
//
// Called with `find`, it returns that element (the file input, the canvas or
// the map), or null, for the driver's "files" and "draw" steps to give it the
// worker's input. Otherwise it is a wait's predicate: false while the client
// has a request in flight or has drawn no question of the form yet; true once
// the widget is there to answer (a signature pad once signature_pad holds
// its canvas); and, once the client has drawn the form and
// is idle, "absent" where it draws no question at that index, and
// "unanswerable" where the question's widget is not the one named (a
// question the client does not support, a file input where a pad was named,
// or a map the client could not draw, which it says in the question's error).
({ ix, widget, find }) => {
	const ixOf = (question) => {
		const shown = question.querySelector(":scope > .ix")?.textContent ?? "";
		return shown.split(" :: ").pop().trim();
	};
	const target = (question) => {
		const drawn = question.querySelector(".widget");
		if (!drawn || drawn.querySelector(".unsupported")) return null;
		const canvas = drawn.querySelector("canvas");
		// A pad takes a stroke once signature_pad holds the canvas, which
		// it marks as it starts listening (SignaturePad.on: touch-action none).
		if (widget === "signature")
			return canvas?.style.touchAction === "none" ? canvas : null;
		if (widget === "map") return drawn.querySelector(".map.leaflet-container");
		return canvas ? null : drawn.querySelector("input[type=file]");
	};
	if (find) {
		const question = [...document.querySelectorAll("#webforms .q")].find(
			(candidate) => ixOf(candidate) === ix,
		);
		return question ? target(question) : null;
	}
	if (
		sessionStorage.getItem("formplayerQueryInProgress") === "true" ||
		sessionStorage.getItem("answerQuestionInProgress") === "true"
	)
		return false;
	const drawn = [...document.querySelectorAll("#webforms .q")];
	if (!drawn.length) return false;
	const question = drawn.find((candidate) => ixOf(candidate) === ix);
	if (!question) return "absent";
	const pad = question.querySelector(".widget canvas");
	if (widget === "signature" && pad && pad.style.touchAction !== "none")
		return false;
	return target(question) ? true : "unanswerable";
};
