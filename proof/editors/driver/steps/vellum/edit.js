// The one edit a run makes between the form's open and its save: the label of
// the question at `path` set to `label` in the form's default language. The
// argument is {path, label, way}. `way` says how the edit is made:
// "builder-model" sets the label through the form builder's own object for the
// question (its label's itext item, `javaRosa/itext.js::ItextItem.set` with no
// language named), which sets the default language's text and every other
// language whose text is empty or equal to the default's before it, as
// `itextWidget.js`'s `defaultLanguage-itext-changed` listener does when a
// person types into the default language's field. The builder's own Save,
// pressed after this step (save.js), writes the form either way. Returns what
// the edit left: {edited, way, value}, or {edited: false, reason}.
({ path, label, way }) => {
	const $ = window.proofVellumHost.jQuery;
	const vellum = $("#formdesigner").vellum("get");
	const core = vellum.data.core;
	if (core.formLoadingFailed)
		return { edited: false, reason: "the form did not load" };
	if (way !== "builder-model")
		return { edited: false, reason: `no way to edit named ${way}` };
	const mug = core.form.getMugByPath(path);
	if (!mug) return { edited: false, reason: `no question at ${path}` };
	const item = mug.p.labelItext;
	if (!item) return { edited: false, reason: "the question has no label text" };
	item.set(label, "default");
	return { edited: true, way, value: item.get("default") };
};
