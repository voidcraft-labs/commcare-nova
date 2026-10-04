// What Vellum reports about the form it opened: its load failure, or its
// parse errors, every question's messages, the serialization warnings, the
// pre-save alerts, its case references and the XML it would save.
() => {
	const $ = window.proofVellumHost.jQuery;
	const vellum = $("#formdesigner").vellum("get");
	const core = vellum.data.core;
	const record = window.proofVellum;
	if (core.formLoadingFailed) {
		return {
			loaded: false,
			loadError: $(".modal-body").last().text(),
			failedLoadXML: core.failedLoadXML,
			events: record.events,
		};
	}
	const form = core.form;
	const text = (message) =>
		(typeof message === "string" ? message : message?.markdown) ||
		String(message);
	const questions = [];
	form.walkMugs((mug) => {
		const messages = [];
		mug.messages.each((message, attribute) => {
			messages.push({
				attribute,
				level: message.level,
				key: message.key,
				message: text(message.message),
			});
		});
		questions.push({ path: mug.absolutePath, type: mug.__className, messages });
	});
	const sourcesChanged = record.events.findIndex(
		(e) => e.name === "datasources:change",
	);
	const loaded = record.events.findIndex(
		(e) => e.name === "formLoadedCallback",
	);
	return {
		loaded: true,
		formErrors: form.errors.map((e) => ({
			level: e.level,
			message: text(e.message),
		})),
		questions,
		// Each warning is {mug, errors}: the question's messages that Vellum can
		// fix on save (form.js).
		serializationWarnings: form.getSerializationWarnings().flatMap((w) =>
			w.errors.map((m) => ({
				path: w.mug?.absolutePath,
				key: m.key,
				level: m.level,
				message: text(m.message),
			})),
		),
		preSaveAlerts: vellum.preSaveValidation().map(text),
		caseReferences: form._logicManager.caseReferences(),
		xml: vellum.createXML(),
		sourcesBeforeParse:
			record.sourcesReadyAtStart ||
			(sourcesChanged !== -1 && sourcesChanged < loaded),
	};
};
