// lib/commcare/xform/formCaseRead.ts
//
// How a form reads its own case: the casedb walk keyed on the session datum
// that holds the case. One function serves the XForm emitter and Preview, so
// Preview evaluates the bytes a device reads.

import type { FormType } from "@/lib/domain";
import { newCaseIdDatumId } from "../session";
import { w } from "../xpath/wire/builders";
import { sessionInstance } from "../xpath/wire/instances";
import { caseById, casePropertyStep } from "../xpath/wire/rowScope";
import type { WireExpr } from "../xpath/wire/tree";

/**
 * The read of `#<type>/<property>` in one form, for `toWire`'s
 * `formCaseProperty` binding.
 *
 * The module's own case is `instance('casedb')/casedb/case[@case_id = <id>]`
 * where `<id>` is the selected case's session datum (`session/data/case_id`
 * unless root alignment renamed it); each ancestor is one `index/parent` hop
 * further up. A registration form's own `case_id` is the id its entry
 * allocated, `session/data/case_id_new_<type>_0`.
 */
export function formCasePropertyRead(args: {
	readonly formType: FormType;
	readonly caseTypeDepths: ReadonlyMap<string, number>;
	readonly moduleCaseType: string | undefined;
	/** The own case's session read; `session/data/case_id` when absent. */
	readonly selectedCaseId?: WireExpr;
}): (caseType: string, property: string) => WireExpr {
	return (caseType, property) => {
		const depth = args.caseTypeDepths.get(caseType);
		if (depth === undefined)
			throw new Error("The form cannot read this record type.");
		if (
			args.formType === "registration" &&
			depth === 0 &&
			property === "case_id"
		) {
			if (args.moduleCaseType === undefined)
				throw new Error(
					"A registration form needs its record type to read its allocated id.",
				);
			return w.instance(sessionInstance(), [
				w.step("session"),
				w.step("data"),
				w.step(newCaseIdDatumId(args.moduleCaseType)),
			]);
		}
		let id: WireExpr =
			args.selectedCaseId ??
			w.instance(sessionInstance(), [
				w.step("session"),
				w.step("data"),
				w.step("case_id"),
			]);
		for (let hop = 0; hop < depth; hop++)
			id = w.append(caseById(id, "casedb"), [
				w.step("index"),
				w.step("parent"),
			]);
		return w.append(caseById(id, "casedb"), [casePropertyStep(property)]);
	};
}
