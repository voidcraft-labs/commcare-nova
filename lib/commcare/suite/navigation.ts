/**
 * The one derivation of "what steps get a worker to this screen".
 *
 * Every navigation frame CommCare pushes — the six end-of-form workflows
 * and every form link — is a sequence of commands and datums produced by
 * one algorithm, `commcare-hq
 * .../suite_xml/post_process/workflow.py::WorkflowHelper.get_frame_children`.
 * This module is that algorithm. It is shared rather than reimplemented
 * per caller because the failure mode of two implementations is invisible:
 * both emit a well-formed `<create>`, and only a worker discovers that one
 * of them dropped him on a case list to re-pick the case he had already
 * chosen.
 *
 * ## Why a frame needs datums at all
 *
 * A frame is replayed, not jumped to. The runtime walks its steps and
 * stops at the first screen whose datum it still needs, so a frame naming
 * only commands lands the worker on the target's case list. Carrying the
 * datum forward is what makes "submit this follow-up, go straight to that
 * follow-up on the same case" work, and it is what makes the flagship
 * register-then-route pattern work at all: the source registration form's
 * `case_id_new_<type>_0` matches the target's `case_id` on case type, so
 * the worker lands in the follow-up on the case he just created.
 *
 * Datum values are evaluated at PUSH time
 * (`commcare-core .../suite/model/StackFrameStep.java::defineStep`), so
 * what a frame carries is a concrete string, never a lazy reference.
 *
 * ## The common-prefix rule
 *
 * A module's own frame carries the datums EVERY form in it needs, and a
 * form's frame then carries its command plus whatever it needs beyond
 * that shared prefix. That is why a case-first module's frame reads
 * `m1, case_id, m1-f0` while a forms-first module's reads
 * `m1, m1-f0, case_id`: in the second, the forms disagree about their
 * first datum, so nothing is shared and the case selection belongs after
 * the form choice. Nova computes the plain common prefix where HQ takes
 * the prefix of the lexicographic min and max list; the two agree for
 * every datum shape Nova emits, and the plain reading is the one a
 * maintainer can check.
 */

import type { PostSubmitDestination } from "@/lib/domain";

const SESSION_DATA = "instance('commcaresession')/session/data";

/**
 * One session datum, with the two facts navigation needs that the wire
 * shape does not carry: what case type it selects, and whether the worker
 * has to pick.
 *
 * `requiresSelection` is HQ's `WorkflowDatumMeta.requires_selection`,
 * which is simply "does this datum have a nodeset". A function datum
 * (a case-create's `uuid()`) needs no worker, so a frame carries its
 * function verbatim and the runtime re-evaluates it at push time.
 */
export interface NavigationDatum {
	readonly id: string;
	/** Absent when nothing in the datum names a case type. */
	readonly caseType?: string;
	readonly requiresSelection: boolean;
	/** The wire function for a non-selection datum, e.g. `uuid()`. */
	readonly function?: string;
}

/** One step of a navigation frame. */
export type FrameChild =
	| { readonly kind: "command"; readonly commandId: string }
	| {
			readonly kind: "datum";
			readonly datum: NavigationDatum;
			/**
			 * The session variable this datum reads its value from. Equal to
			 * `datum.id` until source matching repoints it at the source form's
			 * differently-named variable — the register-then-route case, where a
			 * target `case_id` reads `case_id_new_<type>_0`.
			 */
			readonly sourceId: string;
	  };

/** A form as navigation sees it: its command and the datums its entry declares. */
export interface NavigationForm {
	readonly commandId: string;
	readonly datums: readonly NavigationDatum[];
}

/** A module as navigation sees it: its command and its forms, in emitted order. */
export interface NavigationModule {
	readonly commandId: string;
	readonly forms: readonly NavigationForm[];
}

function commandChild(commandId: string): FrameChild {
	return { kind: "command", commandId };
}

function datumChild(datum: NavigationDatum): FrameChild {
	return { kind: "datum", datum, sourceId: datum.id };
}

/**
 * The datums every form in the module needs, in order, before the forms
 * diverge. Empty for a module whose forms need different things —
 * including the common case of a registration form beside a follow-up.
 */
function commonDatumPrefix(
	forms: readonly NavigationForm[],
): readonly NavigationDatum[] {
	if (forms.length === 0) return [];
	const first = forms[0].datums;
	let shared = first.length;
	for (const form of forms.slice(1)) {
		shared = Math.min(shared, form.datums.length);
		for (let i = 0; i < shared; i++) {
			if (form.datums[i].id !== first[i].id) {
				shared = i;
				break;
			}
		}
	}
	return first.slice(0, shared);
}

/**
 * Steps that reach a module's own screen.
 *
 * `includeUserSelections` distinguishes HQ's two callers: navigating TO a
 * module deliberately drops its shared datums so the worker lands on the
 * selection screen (`_frame_children_for_module(…, include_user_selections=False)`),
 * while reconstructing an enclosing context keeps them.
 */
export function frameChildrenForModule(
	mod: NavigationModule,
	options: { readonly includeUserSelections: boolean },
): FrameChild[] {
	const children: FrameChild[] = [commandChild(mod.commandId)];
	if (options.includeUserSelections) {
		children.push(...commonDatumPrefix(mod.forms).map(datumChild));
	}
	return children;
}

/** Steps that reach one form inside its module. */
export function frameChildrenForForm(
	mod: NavigationModule,
	formIndex: number,
): FrameChild[] {
	const form = mod.forms[formIndex];
	if (form === undefined) return [commandChild(mod.commandId)];
	const shared = commonDatumPrefix(mod.forms);
	return [
		commandChild(mod.commandId),
		...shared.map(datumChild),
		commandChild(form.commandId),
		...form.datums.slice(shared.length).map(datumChild),
	];
}

/**
 * Repoint each selection-requiring target datum at the source form's
 * matching session variable.
 *
 * Mirrors `workflow.py::_get_datums_matched_to_source` including its two
 * quirks, because a faithful local `.ccz` has to land where HQ's
 * regenerated suite lands. A same-id match still requires equal case
 * types, so a `case_id` of a different type is not silently carried
 * across; and a consumed source is filtered by the TARGET's id, which
 * only ever removes anything when the two ids coincide.
 *
 * An unmatched selection datum keeps its own id, which reads an empty
 * session variable and leaves the worker on the target's selection
 * screen. That is HQ's behavior and the honest one: the alternative is
 * inventing a case id.
 */
export function matchFrameChildrenToSource(
	target: readonly FrameChild[],
	sourceDatums: readonly NavigationDatum[],
): FrameChild[] {
	let unused = [...sourceDatums];
	return target.map((child) => {
		if (child.kind === "command" || !child.datum.requiresSelection) {
			return child;
		}
		const match = findBestSourceMatch(child.datum, unused);
		if (match === undefined) return child;
		unused = unused.filter((datum) => datum.id !== child.datum.id);
		return { ...child, sourceId: match };
	});
}

/** The source session variable a target datum should read, if any. */
function findBestSourceMatch(
	target: NavigationDatum,
	sources: readonly NavigationDatum[],
): string | undefined {
	for (const source of sources) {
		if (source.caseType === undefined) continue;
		if (source.caseType !== target.caseType) continue;
		return source.id === target.id ? target.id : source.id;
	}
	return undefined;
}

/** An author-supplied datum override, already projected to wire text. */
export interface ManualFrameDatum {
	readonly name: string;
	readonly xpath: string;
}

export type ManualMatchResult =
	| { readonly ok: true; readonly children: readonly FrameChild[] }
	/** The target datum no supplied value covers — named for the author. */
	| { readonly ok: false; readonly missingDatumId: string };

/**
 * Apply author-supplied datum overrides to a target frame.
 *
 * `workflow.py::_get_datums_matched_to_manual_values` RAISES when a
 * selection-requiring target datum has no supplied value, which fails the
 * whole HQ suite build rather than the one link. So this returns the
 * missing name instead of guessing, the validator refuses the document,
 * and the emitter never has to represent the unrepresentable.
 */
export function matchFrameChildrenToManualValues(
	target: readonly FrameChild[],
	manualValues: readonly ManualFrameDatum[],
): ManualMatchResult {
	const supplied = new Map(manualValues.map((d) => [d.name, d.xpath]));
	const children: FrameChild[] = [];
	for (const child of target) {
		if (child.kind === "datum" && supplied.has(child.datum.id)) {
			children.push({
				...child,
				datum: {
					...child.datum,
					requiresSelection: false,
					function: supplied.get(child.datum.id) ?? "",
				},
			});
			continue;
		}
		if (child.kind === "command" || !child.datum.requiresSelection) {
			children.push(child);
			continue;
		}
		return { ok: false, missingDatumId: child.datum.id };
	}
	return { ok: true, children };
}

/**
 * The value a frame datum carries on the wire.
 *
 * A selection datum reads the session variable the source supplies; a
 * function datum carries its function, which the runtime evaluates once
 * as the frame is pushed.
 */
export function frameDatumValue(child: Extract<FrameChild, { kind: "datum" }>) {
	return child.datum.requiresSelection
		? `${SESSION_DATA}/${child.sourceId}`
		: (child.datum.function ?? `${SESSION_DATA}/${child.sourceId}`);
}

/** A frame the caller should emit: its steps, and whether an empty one is meaningful. */
export interface NavigationFrame {
	readonly children: readonly FrameChild[];
	/**
	 * Whether a childless frame is still worth emitting. Only the `root`
	 * workflow says yes — HQ's `allow_empty_frame` — because an empty
	 * `<create/>` pushes a frame with no command, which resolves to the app
	 * home. Everywhere else a childless frame means "emit nothing".
	 */
	readonly allowEmpty: boolean;
}

/**
 * The frame one of the six end-of-form workflows pushes, or `undefined`
 * when the workflow deliberately pushes nothing.
 *
 * `app_home` is that `undefined`: HQ's `_get_static_stack_frame` has no
 * `WORKFLOW_DEFAULT` arm, so it emits no `<stack>` at all and the
 * runtime's own end-of-form return takes over. Nova emitted an empty
 * `<create/>` in the fallback position instead, which is a second way of
 * saying the same thing on one path and a divergence from the other.
 *
 * `parent_module` deliberately resolves to the module's own frame while
 * nesting is unmodelled; `POST_SUBMIT_PARENT_MODULE_UNSUPPORTED` refuses
 * the state at the gate, so this arm is a total-function fallback rather
 * than a behavior anyone can reach.
 */
export function frameForPostSubmit(
	destination: PostSubmitDestination,
	mod: NavigationModule,
	formIndex: number,
): NavigationFrame | undefined {
	switch (destination) {
		case "app_home":
			return undefined;
		case "root":
			return { children: [], allowEmpty: true };
		case "module":
		case "parent_module":
			return {
				children: frameChildrenForModule(mod, { includeUserSelections: false }),
				allowEmpty: false,
			};
		case "previous":
			return {
				children: previousScreenChildren(mod, formIndex),
				allowEmpty: false,
			};
	}
}

/**
 * The form's own frame minus its final step — "the screen before this
 * one". HQ calls this the most fragile of the workflows in its own
 * docstring, and the shape is why: it drops the last step, then keeps
 * dropping while what it dropped was a datum nobody picks, so the frame
 * ends on a real screen instead of on a generated id.
 *
 * HQ pops without checking for an empty list. Nova stops instead, which
 * matters only for a module with no forms — a state the validator already
 * refuses, but not one an emitter may crash on.
 */
function previousScreenChildren(
	mod: NavigationModule,
	formIndex: number,
): FrameChild[] {
	const children = frameChildrenForForm(mod, formIndex);
	let last = children.pop();
	while (
		last !== undefined &&
		last.kind === "datum" &&
		!last.datum.requiresSelection
	) {
		last = children.pop();
	}
	return children;
}
