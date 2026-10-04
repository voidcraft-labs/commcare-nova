// A section is ready once its page has loaded and its Save button bar is on
// the page. The argument is the section: {bar: the bar's selector}.
({ bar }) =>
	document.readyState === "complete" && !!document.querySelector(bar);
