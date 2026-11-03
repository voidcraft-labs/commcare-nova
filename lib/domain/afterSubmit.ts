// lib/domain/afterSubmit.ts
//
// The domain statement of "may not run": which after-submit destinations
// can be skipped once a form is submitted, read by the validator, the
// planners, the projection, Preview, the platform detector and the builder.
// A destination may not run when it has a condition, or when it carries a
// case onto a single-case selection: the held-case guard conjoins one test
// per such value to its emitted condition, so a frame whose case is not on
// the device never opens. CommCare HQ's fallback frame conjoins the
// negation of every non-blank link `xpath`
// (`suite_xml/post_process/workflow.py::EndOfFormNavigationWorkflow._get_fallback_frame`),
// so the otherwise runs exactly when no destination that may not run runs.

import type { BlueprintDoc } from "./blueprint";
import { formLinkTargetSupplies } from "./entryDatumSupplies";
import { datumRefKey } from "./expression/types";
import { resolveFormLinkTarget } from "./formLinkTargets";
import type { FormLink, FormLinkDatum } from "./forms";
import { effectivePostSubmit } from "./postSubmit";
import type { Uuid } from "./uuid";

/** The link shape "may not run" reads: a destination, or the otherwise
 *  link, which has no condition. */
export type MayNotRunLink = Pick<FormLink, "target"> & {
	readonly datums?: readonly FormLinkDatum[];
	readonly condition?: FormLink["condition"];
};

/** The carried values of `link` that land on a single-case selection of its
 *  target: the ones the held-case guard covers. A value that lands on a
 *  several-case selection names a selection, not a case, and is not guarded.
 *  Automatic matching (`datums` absent) carries nothing to guard. Reads
 *  `formLinkTargetSupplies(doc, resolved target).refs[].scalar`. */
export function guardedLinkDatums(
	doc: BlueprintDoc,
	sourceFormUuid: Uuid,
	link: Pick<MayNotRunLink, "target" | "datums">,
): readonly FormLinkDatum[] {
	if (link.datums === undefined) return [];
	const target = resolveFormLinkTarget(doc, sourceFormUuid, link.target);
	if (target === undefined) return [];
	const scalar = new Set(
		formLinkTargetSupplies(doc, target)
			.refs.filter((row) => row.scalar)
			.map((row) => datumRefKey(row.ref)),
	);
	return link.datums.filter((datum) => scalar.has(datumRefKey(datum.name)));
}

/** A destination may not run when it has a condition or a guarded carried
 *  value. Exactly the destinations whose emitted `xpath` is not blank. */
export function formLinkMayNotRun(
	doc: BlueprintDoc,
	sourceFormUuid: Uuid,
	link: MayNotRunLink,
): boolean {
	return (
		link.condition !== undefined ||
		guardedLinkDatums(doc, sourceFormUuid, link).length > 0
	);
}

/** Whether `formUuid` may hold an otherwise: some destination may not run. */
export function formOtherwiseReachable(
	doc: BlueprintDoc,
	formUuid: Uuid,
): boolean {
	return (doc.forms[formUuid]?.formLinks ?? []).some((link) =>
		formLinkMayNotRun(doc, formUuid, link),
	);
}

/** Whether, after `formUuid`, the worker can be left with no frame and so
 *  reach the app home: no destinations and an effective `postSubmit` of
 *  `app_home`, or destinations none of which runs every time and no
 *  otherwise that always runs in their place (none, or a link whose own
 *  carried case may be missing). A destination that runs every time always
 *  pushes its frame, so the stack is never empty. */
export function afterSubmitCanGoHome(
	doc: BlueprintDoc,
	formUuid: Uuid,
): boolean {
	const form = doc.forms[formUuid];
	if (form === undefined) return false;
	if (form.formLinks === undefined)
		return effectivePostSubmit(doc, formUuid) === "app_home";
	if (form.formLinks.some((link) => !formLinkMayNotRun(doc, formUuid, link)))
		return false;
	const otherwise = form.otherwise;
	if (otherwise === undefined) return true;
	return (
		otherwise.kind === "link" && formLinkMayNotRun(doc, formUuid, otherwise)
	);
}
