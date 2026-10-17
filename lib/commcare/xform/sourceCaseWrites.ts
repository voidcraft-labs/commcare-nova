/**
 * Which case property writes stand in a form's own source.
 *
 * A form writes a case property in one of two places. A basic action (HQ's
 * Case Management tab) is written by HQ's build, so the form's source never
 * holds it. A Save to Case block is written into the source, where HQ's form
 * builder reads every element by name. Three writers land in the source:
 *
 *   - every case operation's `writes`;
 *   - the form's own case update when its case selection takes several
 *     cases (HQ builds no primary block in a multi-select menu, so Nova
 *     writes one per selected case);
 *   - a subcase in such a form, or one whose relationship is `extension`,
 *     with a condition other than `never` (HQ's basic subcase action drops
 *     the relationship).
 *
 * The emitter (`expander.ts`, `caseOps.ts`) asks the two predicates below
 * where it decides what to write, and `sourceBlockCaseWrites` is built from
 * the same two plus the operations' writes, so the emitter and the validator
 * cannot disagree about which writes the source holds.
 */

import { buildPrimaryCaseUpdateMap } from "@/lib/commcare/formActions";
import {
	type FormLinkProjectionContext,
	moduleCaseTypeForActions,
	moduleFrameActionsBuildableIn,
	selectedCaseSessionDatum,
} from "@/lib/commcare/formLinkProjection";
import type { SessionDatum } from "@/lib/commcare/session";
import type { OpenSubCaseAction } from "@/lib/commcare/types";
import {
	type BlueprintDoc,
	deriveCaseWriteInventory,
	orderedCaseOperations,
	type Uuid,
} from "@/lib/domain";

/** One case property a block in the form's source writes, with its author. */
export interface SourceBlockCaseWrite {
	readonly property: string;
	readonly origin:
		| { readonly kind: "operation"; readonly operationUuid: Uuid }
		| { readonly kind: "field"; readonly fieldUuid: Uuid };
}

/** Whether the form's own case update is written in its source: its entry
 * selects several cases, so HQ's basic update action has no one case to
 * write and the source writes each selected case. */
export function formUpdatesSelectedCasesInSource(
	ownCaseDatum: SessionDatum | undefined,
): boolean {
	return ownCaseDatum?.maxSelectValue !== undefined;
}

/** Whether a derived subcase is written as a Save to Case block in the
 * source: one per selected case in a several-case form, and an extension
 * everywhere, since HQ's basic subcase action does not keep the
 * relationship. A subcase that never opens writes nothing. */
export function subcaseIsWrittenInSource(
	subcase: OpenSubCaseAction,
	severalCases: boolean,
): boolean {
	return (
		subcase.condition.type !== "never" &&
		(severalCases || subcase.relationship === "extension")
	);
}

/** Every case property the form's source writes, each located at the case
 * operation or the field that authored it. A form whose menu cannot be
 * projected (its case writes or case types fail rules of their own) is
 * answered with its operations' writes alone, so the function stays total
 * over every document the validator sees. */
export function sourceBlockCaseWrites(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	formUuid: Uuid,
	linkContext: FormLinkProjectionContext,
): readonly SourceBlockCaseWrite[] {
	const form = doc.forms[formUuid];
	const mod = doc.modules[moduleUuid];
	if (form === undefined || mod === undefined) return [];
	const writes: SourceBlockCaseWrite[] = [];

	for (const operation of orderedCaseOperations(form)) {
		for (const write of operation.writes ?? []) {
			writes.push({
				property: write.property,
				origin: { kind: "operation", operationUuid: operation.uuid },
			});
		}
	}

	if (!moduleFrameActionsBuildableIn(doc, linkContext, moduleUuid))
		return writes;
	const severalCases = formUpdatesSelectedCasesInSource(
		selectedCaseSessionDatum(doc, linkContext, moduleUuid, formUuid),
	);
	const subcases = linkContext.formActions(formUuid).subcases;
	if (
		!severalCases &&
		!subcases.some((s) => subcaseIsWrittenInSource(s, false))
	)
		return writes;

	const inventory = deriveCaseWriteInventory(
		doc,
		formUuid,
		{ caseType: moduleCaseTypeForActions(doc, moduleUuid) },
		form.type,
	);
	if (severalCases) {
		const primary = inventory.buckets.find(
			(bucket) => bucket.kind === "primary",
		);
		const update = buildPrimaryCaseUpdateMap(doc, formUuid, mod.caseType);
		for (const property of Object.keys(update)) {
			const writer = primary?.writers.find(
				(candidate) => candidate.property === property,
			);
			if (writer === undefined) continue;
			writes.push({
				property,
				origin: { kind: "field", fieldUuid: writer.fieldUuid },
			});
		}
	}

	/* `buildFormActions` derives one subcase per child bucket, in the
	 * inventory's order, so the two lists pair by position. */
	const children = inventory.buckets.filter(
		(bucket) => bucket.kind === "child",
	);
	subcases.forEach((subcase, index) => {
		if (!subcaseIsWrittenInSource(subcase, severalCases)) return;
		const bucket = children[index];
		for (const property of Object.keys(subcase.case_properties)) {
			const writer = bucket?.writers.find(
				(candidate) => candidate.property === property,
			);
			if (writer === undefined) continue;
			writes.push({
				property,
				origin: { kind: "field", fieldUuid: writer.fieldUuid },
			});
		}
	});

	return writes;
}
