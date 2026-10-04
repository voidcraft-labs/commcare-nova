// A section's save is over on this page: its Save button bar is there and has
// left "Saving". hqwebapp's SaveButton sets the bar's state before it runs the
// page's success or error handler, in the same task, so by then the handler
// has run and started whatever it asks HQ for next (app_manager.js::updateDOM
// fetching the build errors); whether those requests are over is the
// driver's to see, from the page's requests in flight. While the page is
// between documents (a save whose answer HQ's page follows to another page,
// app_manager.js::_initSaveButtons) the bar is not there, and the save is not
// yet over. The argument is the bar's selector.
(bar) => {
	const element = document.querySelector(bar);
	return !!element && !element.classList.contains("savebtn-bar-saving");
};
