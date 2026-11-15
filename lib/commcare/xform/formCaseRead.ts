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
 * The read of `property` on the case `hops` reaches from the case whose id
 * is `id`: one `index/<identifier>` step per hop, then the property, each
 * case found in `casedb` by its id.
 */
export function formCaseWalk(
	id: WireExpr,
	hops: readonly string[],
	property: string,
): WireExpr {
	let reached = id;
	for (const identifier of hops)
		reached = w.append(caseById(reached, "casedb"), [
			w.step("index"),
			w.step(identifier),
		]);
	return w.append(caseById(reached, "casedb"), [casePropertyStep(property)]);
}

/**
 * The read of `#<type>/<property>` in one form, for `toWire`'s
 * `formCaseProperty` binding.
 *
 * The module's own case is `instance('casedb')/casedb/case[@case_id = <id>]`
 * where `<id>` is the selected case's session datum (`session/data/case_id`
 * unless root alignment renamed it); each ancestor is one index hop further
 * up, under the index the app links each type to its parent by
 * (`caseTypeDepths.ts::caseTypeHopMap`), so an advanced form reads the case
 * its chained load was chosen through. A registration form's own `case_id`
 * is the id its entry allocated, `session/data/case_id_new_<type>_0`.
 */
export function formCasePropertyRead(args: {
	readonly formType: FormType;
	/** Each readable type's index walk from the own case
	 *  (`caseTypeDepths.ts::caseTypeHopMap`). */
	readonly caseTypeHops: ReadonlyMap<string, readonly string[]>;
	readonly moduleCaseType: string | undefined;
	/** The own case's session read; `session/data/case_id` when absent. */
	readonly selectedCaseId?: WireExpr;
}): (caseType: string, property: string) => WireExpr {
	return (caseType, property) => {
		const hops = args.caseTypeHops.get(caseType);
		if (hops === undefined)
			throw new Error("The form cannot read this record type.");
		if (
			args.formType === "registration" &&
			hops.length === 0 &&
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
		return formCaseWalk(
			args.selectedCaseId ??
				w.instance(sessionInstance(), [
					w.step("session"),
					w.step("data"),
					w.step("case_id"),
				]),
			hops,
			property,
		);
	};
}
