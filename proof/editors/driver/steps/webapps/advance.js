// Brings a question onto the screen of a form the client shows one question
// a screen (App Preview's way for a person who is not Dimagi's,
// cloudcare/js/preview_app/main.js, `oneQuestionPerScreen`), as a person
// brings it there: the form's own Next button pressed
// (cloudcare/templates/cloudcare/partials/form_entry/form_navigation.html)
// while every question the screen shows comes before `ix` in the form's
// order. With no `ix` it brings the form to its last screen, where the client
// shows Complete in place of Next.
//
// A question's index is the one the client writes in its `.ix` (`ixInfo`:
// the relative index, then " :: " and the full one where they differ), and
// the form's order is the order of those indices read as numbers, level by
// level ("2" before "2,0" before "2,1" before "3"; a repeat's instance,
// "2_0", is a level of its own).
//
// The driver's `advance` step calls it as a wait's predicate: false while the
// client has a request in flight or has drawn no form; "next" once it has
// pressed Next (the driver then waits for Formplayer's answer to the request
// the client sends for it and for the page to be quiet, and asks again);
// true once the question is on the screen (or, with no `ix`, once the form
// stands at its last screen); "absent" where the screen has gone past `ix`,
// or stands at the last screen without it (a question the form holds
// irrelevant there); and "held" where the client keeps Next from being
// pressed (a required question unanswered, an answer it holds invalid: the
// button it then shows is a disabled one, or the one that only shows the
// required notice), which no worker presses past either.
({ ix }) => {
	if (sessionStorage.getItem("formplayerQueryInProgress") === "true")
		return false;
	const navigation = document.querySelector("#webforms .formnav-container");
	if (!navigation) return false;
	const shown = (element) =>
		element !== null && element.getClientRects().length > 0;
	const order = (index) =>
		index
			.split(",")
			.flatMap((level) => level.split("_"))
			.map((part) => Number.parseInt(part, 10));
	const compare = (a, b) => {
		for (let i = 0; i < Math.min(a.length, b.length); i++) {
			if (a[i] !== b[i]) return a[i] - b[i];
		}
		return a.length - b.length;
	};
	const ixOf = (question) => {
		const written = question.querySelector(":scope > .ix")?.textContent ?? "";
		return written.split(" :: ").pop().trim();
	};
	// The navigation's buttons in the template's order: back, back disabled,
	// Complete, Next disabled, Next, and the Next that only shows the
	// required notice. Knockout's `visible` shows one of the last four.
	const button = (place) =>
		navigation.querySelector(`:scope > button:nth-child(${place})`);
	const complete = button(3);
	const next = button(5);
	const atEnd = shown(complete);
	if (ix !== undefined && ix !== null) {
		const target = order(ix);
		const onScreen = [...document.querySelectorAll("#webforms .q")]
			.filter(shown)
			.map((question) => order(ixOf(question)));
		if (onScreen.some((index) => compare(index, target) === 0)) return true;
		if (onScreen.some((index) => compare(index, target) > 0)) return "absent";
		if (atEnd) return "absent";
	} else if (atEnd) {
		return true;
	}
	if (!shown(next)) return "held";
	next.click();
	return "next";
};
