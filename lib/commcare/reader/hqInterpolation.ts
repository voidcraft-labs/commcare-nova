/**
 * CommCare HQ's interpolation of the expression slots it does not parse,
 * ported as the procedure it is (`corehq/apps/app_manager/xpath.py`):
 * `interpolate_xpath` replaces five substrings wherever they occur, inside
 * string literals too, and `dot_interpolate` walks the characters, tracking
 * only whether it is inside a quoted string, and replaces a bare dot. The
 * device runs the result, so the text a runtime reads is a function of HQ's
 * text that only this exact procedure computes. The port recognizes no
 * expression structure and decides nothing about meaning: the grammar
 * (`xpath/formSyntax.ts`) reads what it returns.
 */
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import type { SlotContextRef } from "@/lib/domain/expression/types";
import { moduleUuidOfForm } from "@/lib/domain/postSubmit";
import {
	entrySessionDatums,
	formLinkProjectionContext,
} from "../formLinkProjection";
import type { HqInterpolation } from "../hqJson/xpath";
import { sessionDatumRequiresSelection } from "../session";
import { type FormSyntax, readFormSyntax } from "../xpath/formSyntax";

export interface HqInterpolationSlot {
	/** HQ's `case_xpath`; absent where HQ passes none. */
	readonly caseXPath?: string;
	/** False for a search field's validation test. */
	readonly interpolateDots: boolean;
}

export type HqInterpolated =
	| { readonly ok: true; readonly text: string }
	| { readonly ok: false; readonly reason: "case-reference" | "fixture-value" };

/** `UsercaseXPath().case()`, the text HQ writes for `#user`. */
export const HQ_USERCASE_XPATH =
	"instance('casedb')/casedb/case[@case_type='commcare-user']" +
	"[hq_user_id=instance('commcaresession')/session/context/userid]";

/** `session_var('', path='')`, the text HQ writes for `#session/`. */
const HQ_SESSION_PREFIX = "instance('commcaresession')/session/";

/** `CaseIDXPath(id).case()`: the case whose id is `id`. */
export function hqCaseByIdXPath(id: string): string {
	return `instance('casedb')/casedb/case[@case_id=${id}]`;
}

/** `interpolate_xpath(text, case_xpath, interpolate_dots=…)`, step for step,
 *  with `_ensure_no_case_references` where HQ passes no case path. */
export function interpolateHqXPath(
	text: string,
	slot: HqInterpolationSlot,
): HqInterpolated {
	// HQ replaces `$fixture_value` only for a menu that selects from a
	// fixture, which no app Nova reads holds.
	if (text.includes("$fixture_value"))
		return { ok: false, reason: "fixture-value" };
	const caseXPath = slot.caseXPath;
	if (caseXPath === undefined && hasCaseReference(text, slot.interpolateDots))
		return { ok: false, reason: "case-reference" };
	// The replacements in `interpolate_xpath`'s dictionary order, each a plain
	// substring replacement of every occurrence, as `str.replace` makes it.
	let result = text
		.replaceAll("#user", HQ_USERCASE_XPATH)
		.replaceAll("#session/", HQ_SESSION_PREFIX);
	if (caseXPath !== undefined && caseXPath !== "") {
		result = result
			.replaceAll("#case", caseXPath)
			.replaceAll("#parent", hqCaseByIdXPath(`${caseXPath}/index/parent`))
			.replaceAll("#host", hqCaseByIdXPath(`${caseXPath}/index/host`));
		result = dotInterpolate(result, caseXPath);
	}
	return { ok: true, text: result };
}

/** `_ensure_no_case_references`: a case shortcut, or (where dots are read)
 *  a bare dot `dot_interpolate` would replace. */
function hasCaseReference(text: string, interpolateDots: boolean): boolean {
	if (
		text.includes("#case") ||
		text.includes("#parent") ||
		text.includes("#host")
	)
		return true;
	return (
		interpolateDots &&
		hasBareDotNeighbors(text) &&
		dotInterpolate(text, "") !== text
	);
}

/** `re.search(r'(\D|^)\.(\D|$)', text)`: a dot whose neighbors, where it has
 *  them, are not decimal digits. */
function hasBareDotNeighbors(text: string): boolean {
	const points = Array.from(text);
	return points.some(
		(point, index) =>
			point === "." &&
			!isDecimalDigit(points[index - 1]) &&
			!isDecimalDigit(points[index + 1]),
	);
}

/** Python's `\d` on a string: one code point of Unicode category Nd. */
function isDecimalDigit(point: string | undefined): boolean {
	return point !== undefined && /^\p{Nd}$/u.test(point);
}

/** `dot_interpolate(text, replacement)`: every dot outside a quoted string
 *  whose neighbors are not decimal digits becomes `replacement`. Python
 *  indexes a string by code point, so the walk does too, and a backslash
 *  copies itself and the code point after it. */
export function dotInterpolate(text: string, replacement: string): string {
	const points = Array.from(text);
	let quote = "";
	let result = "";
	let index = 0;
	while (index < points.length) {
		const point = points[index];
		if (point === "\\") {
			result += points.slice(index, index + 2).join("");
			index += 2;
			continue;
		}
		if (quote !== "") {
			if (point === quote) quote = "";
			result += point;
		} else if (point === '"' || point === "'") {
			quote = point;
			result += point;
		} else if (
			point === "." &&
			!isDecimalDigit(points[index - 1]) &&
			!isDecimalDigit(points[index + 1])
		) {
			result += replacement;
		} else result += point;
		index += 1;
	}
	return result;
}

/** HQ's text as a runtime reads it: interpolated for the slot, then parsed.
 *  `text` is the interpolated text the tree's spans index. `slot` undefined:
 *  a slot HQ does not interpolate. */
export function syntaxOf(
	text: string,
	slot: HqInterpolationSlot | undefined,
):
	| { readonly ok: true; readonly syntax: FormSyntax; readonly text: string }
	| {
			readonly ok: false;
			readonly reason: "syntax" | "case-reference" | "fixture-value";
	  } {
	let interpolated = text;
	if (slot !== undefined) {
		const result = interpolateHqXPath(text, slot);
		if (!result.ok) return result;
		interpolated = result.text;
	}
	let read: ReturnType<typeof readFormSyntax>;
	try {
		read = readFormSyntax(interpolated);
	} catch {
		return { ok: false, reason: "syntax" };
	}
	if (!read.ok || read.node === undefined)
		return { ok: false, reason: "syntax" };
	return { ok: true, syntax: read.node, text: interpolated };
}

/**
 * The slot HQ's build interpolates a registration with, by the slot's mode
 * (`hqJson/xpath.ts::HqInterpolation`), read from every caller of the two
 * helpers:
 *
 * - `no-case`: a menu's display condition, a form's that opens on no case,
 *   a search field's required test: no case path, dots checked.
 * - `no-dots`: a search field's validation test: no case path, dots not read.
 * - `case`: a case list's filter (`EntriesHelper.get_filter_xpath`), whose
 *   case is `current()`; a form's display condition on a form that opens on
 *   a case (`MenuContributor._get_commands`), whose case is the one chosen
 *   last (`EntriesHelper.get_case_session_var_for_form`: the last datum that
 *   holds a case type and needs a selection). Undefined where Nova's
 *   projection gives such a form no case-selecting datum.
 */
export function hqInterpolationSlot(
	doc: BlueprintDoc,
	ref: SlotContextRef,
	interpolation: Exclude<HqInterpolation, "none" | "enum-key">,
): HqInterpolationSlot | undefined {
	switch (interpolation) {
		case "no-case":
			return { interpolateDots: true };
		case "no-dots":
			return { interpolateDots: false };
		case "case": {
			if (ref.entity === "module")
				return { caseXPath: "current()", interpolateDots: true };
			if (ref.entity !== "form") return undefined;
			const moduleUuid = moduleUuidOfForm(doc, ref.uuid);
			if (moduleUuid === undefined) return undefined;
			const datums = entrySessionDatums(
				doc,
				formLinkProjectionContext(doc, { entryMetadataOnly: true }),
				moduleUuid,
				ref.uuid,
			);
			const chosen = datums.findLast(
				(datum) =>
					datum.caseType !== undefined && sessionDatumRequiresSelection(datum),
			);
			return chosen === undefined
				? undefined
				: {
						caseXPath: hqCaseByIdXPath(
							`instance('commcaresession')/session/data/${chosen.id}`,
						),
						interpolateDots: true,
					};
		}
	}
}
