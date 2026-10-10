// Answers one question of the open form as a worker does, through the widget
// the client drew for it (HQ's cloudcare/templates/cloudcare/partials/
// form_entry/entry_*.html, filled by cloudcare/js/form_entry/entries.js):
// the question is found by its index, which the client writes in each
// question's `.ix` (`ixInfo`: the relative index, then " :: " and the full
// one where they differ), and `value` is the answer in the encoding
// Formplayer's walk sent it (a select's 1-based option index, a
// multi-select's space-separated indices, a date YYYY-MM-DD, a time
// HH:MM:SS, any other value its text).
//
// - a text box (a text, a number, a phone number, a barcode, a secret):
//   the value typed in, through the element's own value setter, and the
//   input, keyup and change events a browser fires, which the client's
//   knockout bindings read;
// - option buttons and check boxes: a click on each chosen option, and on
//   each option chosen before that the value leaves out;
// - a drop-down: the chosen option selected, and its change event;
// - a date or a time: the value typed in the format the client's picker
//   reads, and its change event, which the picker parses: a date as the
//   picker's placeholder names its format (M/D/YYYY, cloudcare/js/utils.js::
//   dateFormat), a time as HH:mm, or h:mm A where the question asks for
//   twelve hours (`twelveHour`, from the question's style, which
//   entries.js::TimeEntry reads).
//
// It is a wait's predicate: false while the client has a request in flight
// or has drawn no question of the form yet; true once it has answered; and,
// "unchanged" where the widget already shows that answer (a default the
// question opened with: the client sends nothing for an answer that did
// not change), "refused" where the client itself refuses the typed value
// (its widget's own check shows its error at once and sends nothing:
// entries.js, `getErrorMessage`, which the question's first error line
// shows), and, once the client has drawn the form and is idle,
// "absent" where it draws
// no question at that index, and "unanswerable" where it draws no widget a
// worker can answer with this value (a map, an unsupported question). A file
// or signature question is answered through media.js, with the driver's
// "files" and "draw" steps. So what it answers is the client's, never a
// time's.
({ ix, value, twelveHour }) => {
	const ixOf = (question) => {
		const shown = question.querySelector(":scope > .ix")?.textContent ?? "";
		return shown.split(" :: ").pop().trim();
	};
	if (sessionStorage.getItem("formplayerQueryInProgress") === "true")
		return false;
	const drawn = [...document.querySelectorAll("#webforms .q")];
	if (!drawn.length) return false;
	const question = drawn.find((candidate) => ixOf(candidate) === ix);
	if (!question) return "absent";
	const widget = question.querySelector(".widget");
	// A question the client cannot take (entries.js, UnsupportedEntry) says so in its widget; the text box its
	// explanation holds shows what exports will hold, and answers nothing.
	if (!widget || widget.querySelector(".unsupported")) return "unanswerable";
	const type = (element, text) => {
		const setter = Object.getOwnPropertyDescriptor(
			Object.getPrototypeOf(element),
			"value",
		).set;
		element.focus();
		setter.call(element, text);
		for (const name of ["input", "keyup", "change"]) {
			element.dispatchEvent(new Event(name, { bubbles: true }));
		}
		element.blur();
	};
	// The question's own error line (question.html: the first error line is the widget's own check, the second
	// what Formplayer answered).
	const refusedHere = () => {
		const own = question.querySelector(".widget-container .error-message");
		return (
			own !== null &&
			own.getClientRects().length > 0 &&
			own.textContent.trim() !== ""
		);
	};
	const pad = (number) => String(number).padStart(2, "0");

	const picker = widget.querySelector("[data-td-target-input] input");
	if (picker) {
		const format = picker.getAttribute("placeholder");
		let typed;
		if (format === "M/D/YYYY") {
			const [year, month, day] = value.slice(0, 10).split("-");
			typed = `${Number(month)}/${Number(day)}/${year}`;
		} else if (!format) {
			const [hours, minutes] = value.split(":").map(Number);
			typed = twelveHour
				? `${hours % 12 || 12}:${pad(minutes)} ${hours < 12 ? "AM" : "PM"}`
				: `${pad(hours)}:${pad(minutes)}`;
		} else {
			return "unanswerable";
		}
		if (picker.value === typed) return "unchanged";
		type(picker, typed);
		return refusedHere() ? "refused" : true;
	}

	const options = [
		...widget.querySelectorAll(
			"input.form-check-input[type=radio], input.form-check-input[type=checkbox]",
		),
	];
	if (options.length) {
		const chosen = new Set(
			value
				.split(" ")
				.filter(Boolean)
				.map((index) => Number(index) - 1),
		);
		if (options.every((option, index) => option.checked === chosen.has(index)))
			return "unchanged";
		options.forEach((option, index) => {
			if (option.checked !== chosen.has(index)) option.click();
		});
		return true;
	}

	const dropdown = widget.querySelector("select.form-select");
	if (dropdown && !dropdown.multiple) {
		const index = Number(value) - 1;
		const option = [...dropdown.options].filter((each) => each.value !== "")[
			index
		];
		if (!option) return "unanswerable";
		if (dropdown.value === option.value) return "unchanged";
		dropdown.value = option.value;
		dropdown.dispatchEvent(new Event("change", { bubbles: true }));
		return true;
	}

	const box = widget.querySelector(
		"textarea.textfield, input.form-control[type=text], input.form-control[type=password]",
	);
	if (box && !widget.querySelector(".map")) {
		if (box.value === value) return "unchanged";
		type(box, value);
		return refusedHere() ? "refused" : true;
	}
	return "unanswerable";
};
