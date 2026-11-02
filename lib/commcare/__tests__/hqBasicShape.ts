/**
 * Narrowing reads of an emitted HQ application for tests that inspect a basic
 * menu or a basic form's `FormActions`. An app's modules are basic or
 * advanced, so a test that reads a basic-only key reaches it through these,
 * which fail the test with a readable message where the emitter wrote the
 * other kind.
 */

import type {
	HqAnyForm,
	HqAnyModule,
	HqApplication,
	HqForm,
	HqModule,
} from "@/lib/commcare";

export function asBasicModule<XPath, LinkXPath>(
	module: HqAnyModule<XPath, LinkXPath> | undefined,
): HqModule<XPath, LinkXPath> {
	if (module === undefined) throw new Error("The app has no such menu.");
	if (module.doc_type === "Module") return module;
	throw new Error(
		`Menu "${module.name.en ?? module.unique_id}" was emitted as an ${module.doc_type}, where this test reads a basic menu.`,
	);
}

export function asBasicForm<XPath, LinkXPath>(
	form: HqAnyForm<XPath, LinkXPath> | undefined,
): HqForm<XPath, LinkXPath> {
	if (form === undefined) throw new Error("The menu has no such form.");
	if (form.doc_type === "Form") return form;
	throw new Error(
		`Form "${form.name.en ?? form.unique_id}" was emitted as an ${form.doc_type}, where this test reads a basic form.`,
	);
}

/** The basic menu at `moduleIndex`. */
export function basicModule(
	app: Pick<HqApplication, "modules">,
	moduleIndex: number,
): HqModule {
	return asBasicModule(app.modules[moduleIndex]);
}

/** The basic form at `formIndex` of the menu at `moduleIndex`. */
export function basicForm(
	app: Pick<HqApplication, "modules">,
	moduleIndex: number,
	formIndex: number,
): HqForm {
	const forms: readonly HqAnyForm[] | undefined =
		app.modules[moduleIndex]?.forms;
	return asBasicForm(forms?.[formIndex]);
}

/** Every form of the app, of either kind, in menu order. */
export function allForms(app: Pick<HqApplication, "modules">): HqAnyForm[] {
	return app.modules.flatMap((module): readonly HqAnyForm[] => module.forms);
}
