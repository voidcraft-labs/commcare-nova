// A shared entry runs the parent's one XForm. A load only used to choose a
// row for the parent's own entry need not be supplied by a second entry.
import { formExpressionSlotValues } from "@/lib/doc/fieldWalk";
import {
	type BlueprintDoc,
	type Form,
	moduleUuidOfForm,
	type Uuid,
} from "@/lib/domain";
import {
	formCaseSelections,
	ownFormSelectionIndex,
} from "@/lib/domain/advancedEntryDatums";
import { type DatumRef, datumRefKey } from "@/lib/domain/expression/types";
import { walkExpressionTerms } from "@/lib/domain/expression/walk";
import {
	entryDatumIds,
	type FormLinkProjectionContext,
} from "../../formLinkProjection";
import { emittedModuleKind } from "../../moduleKind";
import { planPlacements } from "../../placement";

export function sharedFormDependencies(
	doc: BlueprintDoc,
	entry: Form,
	menu: Uuid,
	context: FormLinkProjectionContext,
): string[] {
	const shared = entry.shadowOf;
	if (!shared) return [];
	const parent = doc.forms[shared.form];
	const parentMenu = moduleUuidOfForm(doc, shared.form);
	if (
		!parent ||
		parent.shadowOf ||
		!parentMenu ||
		emittedModuleKind(doc, menu) !== "advanced" ||
		emittedModuleKind(doc, parentMenu) !== "advanced"
	)
		return [];
	const parentRows = formCaseSelections(doc, parent.uuid);
	const plan = planPlacements(doc, parent.uuid);
	const needed = new Map<string, { ref: DatumRef; name: string }>();
	const note = (ref: DatumRef, name: string) =>
		needed.set(datumRefKey(ref), { ref, name });
	const needChoice = (index: number | undefined) => {
		const row = index === undefined ? undefined : parentRows[index];
		if (row) note({ kind: "form-selection", selection: row.uuid }, row.name);
	};
	const own = ownFormSelectionIndex(doc, parent.uuid);
	for (const { ref, path, expression } of formExpressionSlotValues(
		doc,
		parent.uuid,
	)) {
		if (
			ref.entity !== "field" &&
			![
				"openCondition",
				"closeCondition",
				"caseOperations",
				"connect",
			].includes(String(path[0]))
		)
			continue;
		walkExpressionTerms(expression, (term) => {
			if (term.kind === "session-datum")
				note(
					term.datum,
					ref.entity === "field" ? doc.fields[ref.uuid].id : parent.name,
				);
			if (term.kind === "form-case" && parent.type !== "registration")
				needChoice(own);
		});
	}
	for (const op of parent.caseOperations ?? []) {
		const place = plan.placements.get(op.uuid)?.placement;
		const loaded =
			place?.kind === "advanced"
				? parentRows.findIndex((row) => row.tag === place.tag)
				: -1;
		if (
			loaded >= 0 &&
			(op.writes?.length ||
				op.name ||
				op.rename ||
				op.owner ||
				op.action === "close" ||
				(op.action === "own" && parent.type === "close"))
		)
			needChoice(loaded);
		// Save to Case and open-action indices use the same physical case selected by the parent.
		if (
			(place?.kind === "save-to-case" &&
				(op.action === "own" || op.target?.kind === "session")) ||
			op.links?.some((link) => link.target?.kind === "session")
		)
			needChoice(own);
	}
	// A starting value reads its record's id when the form opens, so the
	// entry supplies the choice it reads as the parent's own entry does.
	for (const assignment of parent.openingAssignments ?? []) {
		const source = assignment.source;
		needChoice(
			source.kind === "own"
				? own
				: source.kind === "worker-record"
					? parentRows.findIndex((row) => row.source.kind === "worker-record")
					: parentRows.findIndex((row) => row.uuid === source.selection),
		);
	}
	const parentDatums = entryDatumIds(doc, context, parentMenu, parent.uuid);
	const entryDatums = entryDatumIds(doc, context, menu, entry.uuid);
	const messages = new Set<string>();
	for (const { ref, name } of needed.values()) {
		const key = datumRefKey(ref);
		const parentRow = parentDatums.find((row) =>
			row.refs.some((ref) => datumRefKey(ref) === key),
		);
		if (!parentRow) continue; // The parent's own validation owns an unsupplied read.
		// Content was printed once. A replacement may use a different list or
		// calculated value, but must supply the same physical leaf.
		const source = parentRow.refs.find((ref) => ref.kind === "form-selection");
		const compatible = entryDatums.find(
			(row) =>
				row.id === parentRow.id &&
				row.scalar === parentRow.scalar &&
				(source === undefined ||
					row.refs.some((ref) => datumRefKey(ref) === datumRefKey(source))),
		);
		if (!compatible) {
			const computed =
				ref.kind === "entry-value" &&
				parent.computedDatums?.find((row) => row.uuid === ref.datum);
			const repair = computed
				? `You can add an opening value named “${computed.key}” to this entry or change what the shared form reads.`
				: "You can restore that record choice or change what the shared form reads.";
			messages.add(
				`“${entry.name}” needs the opening value used by “${name}” in “${parent.name}”. ${repair}`,
			);
		}
	}
	return [...messages];
}
