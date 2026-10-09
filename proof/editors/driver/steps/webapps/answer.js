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
// It is a wait's predicate: false while the client has not drawn the
// question; true once it has answered; and it answers "unanswerable" (for
// the record) where the client draws no widget a worker can answer with
// this value (a map, a file, a signature, an unsupported question).
({ ix, value, twelveHour }) => {
	const ixOf = (question) => {
		const shown = question.querySelector(":scope > .ix")?.textContent ?? "";
		return shown.split(" :: ").pop().trim();
	};
	const question = [...document.querySelectorAll("#webforms .q")].find(
		(candidate) => ixOf(candidate) === ix,
	);
	if (!question) return false;
	const widget = question.querySelector(".widget");
	if (!widget) return false;
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
		type(picker, typed);
		return true;
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
		dropdown.value = option.value;
		dropdown.dispatchEvent(new Event("change", { bubbles: true }));
		return true;
	}

	const box = widget.querySelector(
		"textarea.textfield, input.form-control[type=text], input.form-control[type=password]",
	);
	if (box && !widget.querySelector(".map")) {
		type(box, value);
		return true;
	}
	return "unanswerable";
};
