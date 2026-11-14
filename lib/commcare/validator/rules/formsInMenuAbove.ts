/**
 * A menu that shows its forms in the menu above (`Module.formsInMenuAbove`)
 * has no entry and no screen of its own: its forms list on its parent's
 * screen, or on the app's first menu (`lib/domain/menuScreens.ts`). Four
 * rules follow from that.
 *
 * `FORMS_IN_MENU_ABOVE_NOT_A_DESTINATION`: nothing may open the menu itself,
 * since there is no screen to land on. HQ's build refuses an endpoint on
 * such a menu (`validators.py::validate_display_only_forms`), builds a case
 * list endpoint with no command (`endpoints.py::_make_session_endpoint`), and
 * its link editor never lists such a menu as a target
 * (`views/forms.py::_get_linkable_forms_context`). So three things are
 * refused:
 *
 *   - an after-submit link whose target is the menu, a destination or the
 *     otherwise link (located at the link);
 *   - the menu's own entry point (located at the module);
 *   - the menu's case list entry point (located at the module).
 *
 * `FORMS_IN_MENU_ABOVE_WITH_SEARCH`: such a menu takes no search. HQ's build
 * writes no Search action on its case list (`details.py::build_detail`,
 * `not module.put_in_root`) and refuses inline search on it
 * (`validate_display_only_forms`).
 *
 * `FORM_LINK_TARGET_SHARES_FIRST_MENU_CASE` and the entry point's
 * `first-menu-shared-case` reason: where every form of every menu that shows
 * its forms above opens one chosen case, HQ builds every frame through the
 * first menu with that case ahead of its first command
 * (`workflow.py::WorkflowHelper.get_frame_children`, `_root_module_datums`),
 * and CommCare keeps that case on the first menu when a worker steps back
 * (`CommCareSession.syncState`, `getFirstMissingDatum`), for the next form
 * that asks for a case under that datum id to open on. Nova writes no such
 * frame, so the link and the entry point whose frame would open that way are
 * refused at their source, judged on the frames the wire builds. The built-in
 * `module` destination of a submenu that keeps its screen under a top-level
 * menu above is judged by the reason the offered set withholds it for
 * (`menu-opens-with-first-menu-case`, `lib/domain/postSubmit.ts`), so the
 * pickers, the default and this rule read one answer.
 */

import {
	afterEmptySearchRegistrationFormOf,
	alwaysOfferedRegistrationOf,
	type BlueprintDoc,
	caseListRegistrationReturnOf,
	type EntryPointTarget,
	effectiveCaseSearchConfig,
	effectivePostSubmit,
	type Form,
	type FormLinkEntry,
	formLinkEntries,
	type Module,
	menuScreenOf,
	moduleFormsReadSearch,
	moduleShowsFormsInMenuAbove,
	postSubmitNotOfferedReason,
	projectedModulePreorder,
	type ResolvedFormLinkTarget,
	resolveFormLinkTarget,
	type Uuid,
} from "@/lib/domain";
import {
	caseListFormReturnFrames,
	entryNewCaseDatumId,
	entrySessionDatums,
	type FormLinkProjectionContext,
	type FrameChild,
	firstMenuSharedCase,
	formFrameChildren,
	formLinkActionsBuildable,
	formLinkProjectionContext,
	frameLeadsWithSelection,
	moduleFrameActionsBuildable,
	moduleFrameChildren,
	owningModuleOf,
} from "../../formLinkProjection";
import { identityLookupWireNaming } from "../../lookup/naming";
import { type ValidationError, validationError } from "../errors";

/** `the app's first menu`, or the parent's name in quotes: the screen the
 *  module's forms list on. */
function aboveText(doc: BlueprintDoc, moduleUuid: Uuid): string {
	const screen = menuScreenOf(doc, moduleUuid);
	return screen.kind === "first-menu"
		? "the app's first menu"
		: `"${doc.modules[screen.moduleUuid]?.name ?? ""}"`;
}

/** A menu that shows its forms above, holding an entry point or a case list
 *  entry point. A module rule, after `hiddenMenuEntryPoints`. */
export function menuAboveEntryPoints(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	if (!moduleShowsFormsInMenuAbove(mod)) return [];
	const errors: ValidationError[] = [];
	const location = { moduleUuid, moduleName: mod.name };
	if (mod.entryPoint !== undefined)
		errors.push(
			validationError(
				"FORMS_IN_MENU_ABOVE_NOT_A_DESTINATION",
				"module",
				`"${mod.name}" shows its forms in the menu above, so it has no screen of its own for its entry point to open. You can give one of its forms an entry point, or give "${mod.name}" its own screen again (forms_in_menu_above null).`,
				location,
				{ arm: "entry-point" },
			),
		);
	if (mod.caseListEntryPoint !== undefined) {
		const above = aboveText(doc, moduleUuid);
		errors.push(
			validationError(
				"FORMS_IN_MENU_ABOVE_NOT_A_DESTINATION",
				"module",
				`"${mod.name}" shows its forms in the menu above, so its case list entry point would open ${above} and never the list. You can remove that entry point, or give "${mod.name}" its own screen again (forms_in_menu_above null).`,
				location,
				{ arm: "case-list-entry-point", above },
			),
		);
	}
	return errors;
}

/** A menu that shows its forms above and searches: one finding, the first
 *  reason that holds. The owner-only availability arm is no search. */
export function menuAboveSearch(
	mod: Module,
	moduleUuid: Uuid,
	_doc: BlueprintDoc,
): ValidationError[] {
	if (!moduleShowsFormsInMenuAbove(mod)) return [];
	const location = { moduleUuid, moduleName: mod.name };
	if (moduleFormsReadSearch(mod))
		return [
			validationError(
				"FORMS_IN_MENU_ABOVE_WITH_SEARCH",
				"module",
				`"${mod.name}" shows its forms in the menu above and has its forms read the search, and CommCare HQ can't build a menu that does both. You can turn off Forms read the search (formsReadSearch null), or give "${mod.name}" its own screen again (forms_in_menu_above null).`,
				location,
				{ reason: "forms-read-search" },
			),
		];
	if (effectiveCaseSearchConfig(mod) !== undefined)
		return [
			validationError(
				"FORMS_IN_MENU_ABOVE_WITH_SEARCH",
				"module",
				`"${mod.name}" shows its forms in the menu above, and CommCare offers no Search on the case list of such a menu, so a worker could never open its search. You can remove the search from "${mod.name}", or give it its own screen again (forms_in_menu_above null).`,
				location,
				{ reason: "search" },
			),
		];
	return [];
}

/** A form's after-submit links, destinations and the otherwise link, whose
 *  target is a menu that shows its forms above. Called from
 *  `form.ts::runFormRules` after `hiddenMenuLinkTargets`. */
export function menuAboveLinkTargets(
	doc: BlueprintDoc,
	form: Form,
	location: {
		readonly moduleUuid: Uuid;
		readonly moduleName: string;
		readonly formUuid: Uuid;
		readonly formName: string;
	},
): ValidationError[] {
	const errors: ValidationError[] = [];
	for (const { role, link } of formLinkEntries(form)) {
		const resolved = resolveFormLinkTarget(doc, location.formUuid, link.target);
		if (resolved?.type !== "module") continue;
		const target = doc.modules[resolved.moduleUuid];
		if (target === undefined || !moduleShowsFormsInMenuAbove(target)) continue;
		errors.push(
			validationError(
				"FORMS_IN_MENU_ABOVE_NOT_A_DESTINATION",
				"form",
				`"${target.name}" shows its forms in the menu above, so it has no screen of its own for the link from "${form.name}" to open. You can point the link at one of its forms, or give "${target.name}" its own screen again (forms_in_menu_above null).`,
				location,
				{
					arm: "link",
					linkUuid: link.uuid,
					role,
					targetModuleUuid: resolved.moduleUuid,
					targetModuleName: target.name,
				},
			),
		);
	}
	return errors;
}

// ── The first menu's shared case ────────────────────────────────────────

interface SharedCaseProjection {
	readonly ctx: FormLinkProjectionContext;
}

const sharedCaseProjections = new WeakMap<
	BlueprintDoc,
	SharedCaseProjection | null
>();

/**
 * The projection to judge frames by, where the first menu holds a shared
 * case (`formLinkProjection.ts::firstMenuSharedCase`); `undefined` where no
 * menu shows its forms above, where some form listed that way has entries
 * the wire cannot build yet (a finding another rule owns), or where the root
 * lists share no chosen case. Built once per document. Datum ids are all a
 * frame's lead reads, so every data table prints under its own id.
 */
function sharedCaseProjection(
	doc: BlueprintDoc,
): SharedCaseProjection | undefined {
	const held = sharedCaseProjections.get(doc);
	if (held !== undefined) return held ?? undefined;
	const above = projectedModulePreorder(doc).filter((moduleUuid) =>
		moduleShowsFormsInMenuAbove(doc.modules[moduleUuid]),
	);
	let result: SharedCaseProjection | null = null;
	if (above.length > 0 && moduleFrameActionsBuildable(doc, above)) {
		const ctx = formLinkProjectionContext(doc, {
			lookupNaming: identityLookupWireNaming(),
		});
		if (firstMenuSharedCase(doc, ctx) !== undefined) result = { ctx };
	}
	sharedCaseProjections.set(doc, result);
	return result ?? undefined;
}

/** The menu to give its own screen again: the target's own menu where it
 *  shows its forms above, else its parent. */
function aboveModuleOf(doc: BlueprintDoc, moduleUuid: Uuid): Uuid {
	if (moduleShowsFormsInMenuAbove(doc.modules[moduleUuid])) return moduleUuid;
	return doc.modules[moduleUuid]?.parentModuleUuid ?? moduleUuid;
}

/** A frame's destination as the frame algorithm reads it: a form in its
 *  menu, or a menu's own screen. */
type FrameTarget =
	| {
			readonly kind: "form";
			readonly moduleUuid: Uuid;
			readonly formUuid: Uuid;
	  }
	| { readonly kind: "module"; readonly moduleUuid: Uuid };

/**
 * The menu to give its own screen again, where the frame toward `target`
 * would open with the first menu's shared case ahead of its first command;
 * `undefined` where it would not, and where the frame is not one Nova writes
 * (a missing target, or a menu with no screen, which
 * `FORMS_IN_MENU_ABOVE_NOT_A_DESTINATION` refuses).
 */
function frameSharesFirstMenuCase(
	doc: BlueprintDoc,
	target: FrameTarget,
): { readonly aboveModuleUuid: Uuid } | undefined {
	const projection = sharedCaseProjection(doc);
	if (projection === undefined) return undefined;
	const mod = doc.modules[target.moduleUuid];
	if (mod === undefined) return undefined;
	if (target.kind === "module" && moduleShowsFormsInMenuAbove(mod))
		return undefined;
	if (
		target.kind === "form" &&
		(doc.forms[target.formUuid] === undefined ||
			!(doc.formOrder[target.moduleUuid] ?? []).includes(target.formUuid))
	)
		return undefined;
	if (!moduleFrameActionsBuildable(doc, [target.moduleUuid])) return undefined;
	const children: FrameChild[] =
		target.kind === "form"
			? formFrameChildren(
					doc,
					projection.ctx,
					target.moduleUuid,
					target.formUuid,
				)
			: moduleFrameChildren(doc, projection.ctx, target.moduleUuid);
	return frameLeadsWithSelection(children)
		? { aboveModuleUuid: aboveModuleOf(doc, target.moduleUuid) }
		: undefined;
}

/** A link target whose frame would open with the first menu's shared case:
 *  the menu to give its own screen again, else `undefined`. The link target
 *  picker and the gate read this one answer. */
export function linkTargetSharesFirstMenuCase(
	doc: BlueprintDoc,
	target: ResolvedFormLinkTarget,
): { readonly aboveModuleUuid: Uuid } | undefined {
	return frameSharesFirstMenuCase(
		doc,
		target.type === "form"
			? {
					kind: "form",
					moduleUuid: target.moduleUuid,
					formUuid: target.formUuid,
				}
			: { kind: "module", moduleUuid: target.moduleUuid },
	);
}

/** An entry point whose frame would open with the first menu's shared case:
 *  the menu to give its own screen again, else `undefined`. An entry point
 *  on a module or its case list opens through that module's own frame. */
export function entryPointSharesFirstMenuCase(
	doc: BlueprintDoc,
	target: EntryPointTarget,
): { readonly aboveModuleUuid: Uuid } | undefined {
	return frameSharesFirstMenuCase(
		doc,
		target.kind === "form"
			? {
					kind: "form",
					moduleUuid: target.moduleUuid,
					formUuid: target.formUuid,
				}
			: { kind: "module", moduleUuid: target.moduleUuid },
	);
}

/**
 * Where an `always` host's Register return would open with the first menu's
 * shared case ahead of its first command: the menu to give its own screen
 * again (the host's parent), else `undefined`. The frames are the ones the
 * suite writes (`formLinkProjection.ts::caseListFormReturnFrames`, HQ's
 * `workflow.py::CaseListFormWorkflow`), built from the offered form's own
 * new-case datum as the compiler builds them. Where the form's own
 * after-submit is in force no return frame is written
 * (`caseListRegistrationReturnOf` gives `own`), and an entry that gives the
 * form no new case of the host's type writes none either.
 */
export function caseListReturnSharesFirstMenuCase(
	doc: BlueprintDoc,
	hostModuleUuid: Uuid,
): { readonly aboveModuleUuid: Uuid } | undefined {
	const returnTo = caseListRegistrationReturnOf(doc, hostModuleUuid);
	if (returnTo === undefined || returnTo.kind === "own") return undefined;
	const projection = sharedCaseProjection(doc);
	if (projection === undefined) return undefined;
	const host = doc.modules[hostModuleUuid];
	if (host === undefined || !host.caseType || moduleShowsFormsInMenuAbove(host))
		return undefined;
	const offered = alwaysOfferedRegistrationOf(doc, hostModuleUuid);
	if (offered === undefined) return undefined;
	const { ctx } = projection;
	const formModuleUuid = owningModuleOf(ctx, offered.formUuid);
	if (
		formModuleUuid === undefined ||
		!moduleFrameActionsBuildable(doc, [hostModuleUuid, formModuleUuid])
	)
		return undefined;
	const newCaseId = entryNewCaseDatumId(
		entrySessionDatums(doc, ctx, formModuleUuid, offered.formUuid),
		host.caseType,
	);
	if (newCaseId === undefined) return undefined;
	const frames = caseListFormReturnFrames(
		doc,
		ctx,
		hostModuleUuid,
		newCaseId,
		host.caseType,
		returnTo.kind,
	);
	return frames.some((frame) => frameLeadsWithSelection(frame.target))
		? { aboveModuleUuid: aboveModuleOf(doc, hostModuleUuid) }
		: undefined;
}

/** The links of `formUuid` whose frames open with the first menu's shared
 *  case, each with the menu to give its own screen again. The datum rules of
 *  `form.ts::formLinkValidation` skip these links. */
export function linksSharingFirstMenuCase(
	doc: BlueprintDoc,
	formUuid: Uuid,
): readonly {
	readonly entry: FormLinkEntry;
	readonly target: ResolvedFormLinkTarget;
	readonly aboveModuleUuid: Uuid;
}[] {
	if (sharedCaseProjection(doc) === undefined) return [];
	const form = doc.forms[formUuid];
	if (form === undefined) return [];
	return formLinkEntries(form).flatMap((entry) => {
		const target = resolveFormLinkTarget(doc, formUuid, entry.link.target);
		if (
			target === undefined ||
			!formLinkActionsBuildable(doc, formUuid, [entry.link])
		)
			return [];
		const shared = linkTargetSharesFirstMenuCase(doc, target);
		return shared === undefined ? [] : [{ entry, target, ...shared }];
	});
}

/** The name a link's target is read by: the form, the menu, or the source
 *  form for `this-form`. */
function targetName(doc: BlueprintDoc, target: ResolvedFormLinkTarget): string {
	return target.type === "form"
		? (doc.forms[target.formUuid]?.name ?? "")
		: (doc.modules[target.moduleUuid]?.name ?? "");
}

/**
 * Every after-submit link whose frame would open through the first menu with
 * its shared case ahead of the first command, and every built-in `module`
 * destination, stored, default or the otherwise, that the offered set
 * withholds first because its module opens with that case
 * (`menu-opens-with-first-menu-case`). An app rule, because both read every
 * menu that shows its forms above.
 */
export function firstMenuSharedCaseFrames(
	doc: BlueprintDoc,
): ValidationError[] {
	const errors: ValidationError[] = [];
	const linksJudged = sharedCaseProjection(doc) !== undefined;
	for (const moduleUuid of projectedModulePreorder(doc)) {
		const mod = doc.modules[moduleUuid];
		if (mod === undefined) continue;
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const form = doc.forms[formUuid];
			if (form === undefined) continue;
			const location = {
				moduleUuid,
				moduleName: mod.name,
				formUuid,
				formName: form.name,
			};
			if (linksJudged)
				for (const {
					entry,
					target,
					aboveModuleUuid,
				} of linksSharingFirstMenuCase(doc, formUuid)) {
					const aboveName = doc.modules[aboveModuleUuid]?.name ?? "";
					const name = targetName(doc, target);
					errors.push(
						validationError(
							"FORM_LINK_TARGET_SHARES_FIRST_MENU_CASE",
							"form",
							`The link from "${form.name}" to "${name}" opens through the app's first menu, where every form listed from a menu that shows its forms above opens one chosen case. CommCare HQ puts that case ahead of "${name}" in the link, and on Android CommCare keeps it on the first menu when a worker steps back, for the next form to open on. You can give "${aboveName}" its own screen again (forms_in_menu_above null), or remove the link.`,
							location,
							{
								linkUuid: entry.link.uuid,
								role: entry.role,
								targetName: name,
								aboveModuleUuid,
								aboveModuleName: aboveName,
							},
						),
					);
				}
			const moduleFinding = moduleDestinationSharesFirstMenuCase(
				doc,
				form,
				location,
			);
			if (moduleFinding !== undefined) errors.push(moduleFinding);
		}
	}
	return errors;
}

/**
 * The finding of a form's built-in `module` destination, after submit
 * (stored or default) or as the otherwise, where the offered set withholds
 * it first because the module opens through the first menu with its shared
 * case. An `after-empty-search` registration form's navigation is the case
 * list registration rules' to judge.
 */
function moduleDestinationSharesFirstMenuCase(
	doc: BlueprintDoc,
	form: Form,
	location: {
		readonly moduleUuid: Uuid;
		readonly moduleName: string;
		readonly formUuid: Uuid;
		readonly formName: string;
	},
): ValidationError | undefined {
	const { moduleUuid, formUuid } = location;
	if (afterEmptySearchRegistrationFormOf(doc, moduleUuid) === formUuid)
		return undefined;
	const slot =
		form.otherwise?.kind === "destination" &&
		form.otherwise.destination === "module"
			? ("otherwise" as const)
			: effectivePostSubmit(doc, formUuid) === "module"
				? ("post-submit" as const)
				: undefined;
	if (
		slot === undefined ||
		postSubmitNotOfferedReason(doc, formUuid, "module") !==
			"menu-opens-with-first-menu-case"
	)
		return undefined;
	const aboveModuleUuid = aboveModuleOf(doc, moduleUuid);
	const aboveName = doc.modules[aboveModuleUuid]?.name ?? "";
	const menuName = location.moduleName;
	const when =
		slot === "otherwise" ? "when no destination runs" : "after submit";
	return validationError(
		"FORM_LINK_TARGET_SHARES_FIRST_MENU_CASE",
		"form",
		`"${form.name}" goes to its module ${when}, and "${menuName}" opens through the app's first menu, where every form listed from a menu that shows its forms above opens one chosen case. CommCare HQ puts that case ahead of "${menuName}", and on Android CommCare keeps it on the first menu when a worker steps back, for the next form to open on. You can give "${aboveName}" its own screen again (forms_in_menu_above null), or send "${form.name}" somewhere else ${when}.`,
		location,
		{
			slot,
			destination: "module",
			targetName: menuName,
			aboveModuleUuid,
			aboveModuleName: aboveName,
		},
	);
}
