/**
 * Step `form-link-semantics` (part 09 §7.5; part 06 §14): the one map from
 * the after-submit links Nova stored when only the first destination whose
 * condition held ran, to the links it stores now
 * (`lib/doc/formLinkSemanticsMap.ts::mapFormLinkSemantics`, L1 to L6 with
 * L4's off-the-menu removal), each of its changes one notice entry on the
 * form:
 *
 * | Change               | Reason                              | `detail`                       |
 * |----------------------|-------------------------------------|--------------------------------|
 * | conditions-written   | form-links-conditions-written       | `links`                        |
 * | otherwise-set        | form-link-otherwise-set             | `to`, or `toDestination` with `from` (L6) |
 * | after-submit-dropped | after-submit-destination-dropped    | none                           |
 * | target-moved         | form-link-target-moved              | `from`, `to`                   |
 * | link-removed         | form-link-removed                   | `to`                           |
 * | datums-dropped       | form-link-datums-dropped            | `to`                           |
 *
 * Names come from the document the map leaves, which renames nothing. The
 * map is total, so this step has no blocker.
 */

import {
	type FormLinkSemanticsChange,
	mapFormLinkSemantics,
} from "@/lib/doc/formLinkSemanticsMap";
import {
	type BlueprintDoc,
	type FormLinkTarget,
	formLinkDestination,
	type Uuid,
} from "@/lib/domain";
import type { MigrationNoticeEntry } from "@/lib/notices/migrationNotice";
import {
	afterSubmitDestinationDropped,
	formLinkDatumsDropped,
	formLinkOtherwiseSet,
	formLinkRemoved,
	formLinksConditionsWritten,
	formLinkTargetMoved,
	type NamedEntity,
} from "../notice";
import type { PlannedChange } from "../types";
import type { StepResult } from "./apply";

/** The change kinds this step plans: the map's own, as the report's
 *  `steps` line counts them. */
export const FORM_LINK_SEMANTICS_CHANGES = [
	"conditions-written",
	"otherwise-set",
	"after-submit-dropped",
	"target-moved",
	"link-removed",
	"datums-dropped",
] as const satisfies readonly FormLinkSemanticsChange["kind"][];

const STEP = "form-link-semantics";

function named(
	doc: BlueprintDoc,
	collection: "forms" | "modules",
	uuid: Uuid,
): string {
	return doc[collection][uuid]?.name ?? "";
}

function targetName(
	doc: BlueprintDoc,
	formUuid: Uuid,
	target: FormLinkTarget,
): string {
	return formLinkDestination(doc, formUuid, target)?.name ?? "";
}

function noticeFor(
	doc: BlueprintDoc,
	change: FormLinkSemanticsChange,
): MigrationNoticeEntry {
	const form: NamedEntity = {
		uuid: change.formUuid,
		name: named(doc, "forms", change.formUuid),
	};
	switch (change.kind) {
		case "conditions-written":
			return formLinksConditionsWritten(form, change.linkUuids.length);
		case "otherwise-set":
			return formLinkOtherwiseSet(
				form,
				change.otherwise.kind === "link"
					? { to: targetName(doc, change.formUuid, change.otherwise.target) }
					: {
							toDestination: change.otherwise.destination,
							...(change.from !== undefined && { from: change.from }),
						},
			);
		case "after-submit-dropped":
			return afterSubmitDestinationDropped(form);
		case "target-moved":
			return formLinkTargetMoved(form, {
				from: named(doc, "modules", change.from),
				to: named(doc, "modules", change.to),
			});
		case "link-removed":
			return formLinkRemoved(form, named(doc, "modules", change.to));
		case "datums-dropped":
			return formLinkDatumsDropped(form, named(doc, "modules", change.to));
	}
}

function plannedChange(change: FormLinkSemanticsChange): PlannedChange {
	return {
		step: STEP,
		kind: change.kind,
		entityUuid: change.formUuid,
		detail:
			change.kind === "conditions-written"
				? { links: change.linkUuids.length }
				: {},
	};
}

/** Step `form-link-semantics` over the document `writes-into-operations`
 *  left. */
export function formLinkSemantics(input: BlueprintDoc): StepResult {
	const mapped = mapFormLinkSemantics(input);
	return {
		doc: mapped.doc,
		changes: mapped.changes.map(plannedChange),
		notice: mapped.changes.map((change) => noticeFor(mapped.doc, change)),
		blockers: [],
	};
}
