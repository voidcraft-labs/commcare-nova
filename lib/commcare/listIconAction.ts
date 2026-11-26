/**
 * A case list icon that submits a form (CommCare's clickable icon): which
 * entry points an icon may name, the case its tap passes, and the id the wire
 * prints for it.
 *
 * Web Apps binds the tap in the case list only (`menus/views.js::CaseView`,
 * `iconClick`): it reads the endpoint from the field's `endpoint_action`
 * (`detail_screen.py::EnumImage.action`, `background="true"`), passes the
 * tapped row's id as the endpoint's one argument, and in a grouped tile passes
 * the group's index target for a header cell and the group's first case for a
 * body cell, since the grouped view keeps only the first case of each group
 * (`CaseTileGroupedListView.initialize`).
 */
import {
	type BlueprintDoc,
	CASE_LOADING_FORM_TYPES,
	type Column,
	type EntryPointInventoryItem,
	type EntryPointTarget,
	effectiveCaseTypes,
	entryPointByUuid,
	entryPointInventory,
	type Module,
	moduleEntriesOffTheMenu,
	tileCellFor,
	type Uuid,
} from "@/lib/domain";
import { formSubmitsOnOpenFromAQuestionLabel } from "@/lib/domain/automaticSubmission";
import { relationDestinationCaseType } from "@/lib/domain/expression/rewrite";
import { declaredPlatforms } from "@/lib/domain/platforms";
import { type FormCaseWirePlan, planFormCaseWire } from "./casePlacementPlan";
import {
	createEntryPointProjector,
	type EntryPointRequiredSelection,
} from "./entryPointProjection";

type ImageMapColumn = Extract<Column, { kind: "image-map" }>;

/** The case type a tap on this column's icon passes, or `undefined` where no
 * one case is passed: a body cell of a grouped tile, which passes the group's
 * first case whichever member it is drawn beside, or a header cell whose
 * group's index names no case type. */
export function listIconCaseType(
	doc: BlueprintDoc,
	module: Module,
	column: Column,
): string | undefined {
	const layout = module.caseListConfig?.tile;
	const grouping = layout?.grouping;
	if (!grouping) return module.caseType;
	const cell = tileCellFor(column, layout);
	if (!cell || cell.y >= grouping.headerRows) return undefined;
	return relationDestinationCaseType(
		{ kind: "ancestor", via: [{ identifier: grouping.identifier }] },
		module.caseType,
		effectiveCaseTypes(doc),
	);
}

/** HQ's `Form.requires_case` and `AdvancedForm.requires_case`: whether the
 * form's entry asks for a chosen case. A load the worker's own case supplies
 * asks for none. */
function formRequiresSelectedCase(
	type: BlueprintDoc["forms"][string]["type"],
	plan: FormCaseWirePlan,
): boolean {
	return plan.kind === "basic"
		? CASE_LOADING_FORM_TYPES.has(type)
		: plan.loads.some((load) => !load.worker);
}

/** An entry point an icon may name: what it opens and the one case selection
 * the tapped row fills. */
export interface ListIconDestination {
	readonly target: Extract<EntryPointTarget, { kind: "form" }>;
	readonly entryPointUuid: Uuid;
	/** The external ID the deep link prints. */
	readonly entryPointId: string;
	readonly selection: EntryPointRequiredSelection;
}

/**
 * Resolves whether an entry point can be an icon's destination for a list
 * whose tap passes one case of `caseType`: a form's entry point, on a form
 * that submits on open from a question label and asks for a chosen case,
 * reached from the menu (or ignoring display conditions), whose one argument
 * is a single case of that type. One resolver shares one projection of the
 * document; make a fresh one per document read.
 */
export function createListIconDestination(doc: BlueprintDoc) {
	const project = createEntryPointProjector(doc);
	return (
		caseType: string | undefined,
		item: EntryPointInventoryItem,
	): ListIconDestination | undefined => {
		const { target, entryPoint } = item;
		if (caseType === undefined || target.kind !== "form") return undefined;
		const form = doc.forms[target.formUuid];
		if (!form) return undefined;
		if (!formSubmitsOnOpenFromAQuestionLabel(doc, form.uuid)) return undefined;
		if (
			(form.hiddenFromMenu === true ||
				moduleEntriesOffTheMenu(doc, target.moduleUuid)) &&
			entryPoint.ignoreDisplayConditions !== true
		)
			return undefined;
		let selections: readonly EntryPointRequiredSelection[];
		try {
			if (
				!formRequiresSelectedCase(form.type, planFormCaseWire(doc, form.uuid))
			)
				return undefined;
			selections = project(target).requiredSelections;
		} catch {
			// The entry point rule reports a destination that does not project.
			return undefined;
		}
		const [selection] = selections;
		if (
			selections.length !== 1 ||
			selection === undefined ||
			selection.cardinality !== "one" ||
			selection.caseType !== caseType
		)
			return undefined;
		return {
			target,
			entryPointUuid: entryPoint.uuid,
			entryPointId: entryPoint.id,
			selection,
		};
	};
}

/** Every destination an icon on this column may name, in entry point order:
 * none in an app that runs on Android. */
export function listIconDestinations(
	doc: BlueprintDoc,
	module: Module,
	column: Column,
): readonly ListIconDestination[] {
	if (declaredPlatforms(doc).includes("android")) return [];
	const caseType = listIconCaseType(doc, module, column);
	if (caseType === undefined) return [];
	const resolve = createListIconDestination(doc);
	return entryPointInventory(doc).flatMap((item) => {
		const destination = resolve(caseType, item);
		return destination ? [destination] : [];
	});
}

/** Why an icon's action is not one a worker can run. */
export type ListIconActionReason =
	| "android"
	| "not-on-results"
	| "grouped-body"
	| "no-destination";

/** The sentence each reason reads as, about the column `label` names (when
 * known) and the case type its tap passes. Shared by the validator's message
 * and the Builder's copy (`lib/doc/userFacingErrors.ts`). A missing
 * destination offers another form only where `anotherForm` says the column
 * has one to choose (`listIconDestinations`); otherwise removing the action
 * is the one remedy there is. */
export function listIconActionSentence(
	reason: ListIconActionReason,
	label: string | undefined,
	caseType: string | undefined,
	anotherForm = false,
): string {
	const subject = label ? `"${label}"` : "An image on Results";
	switch (reason) {
		case "android":
			return `${subject} has an icon that submits a form, which only Web Apps runs: Android shows the image's file path, and a worker there can't tap it. You can set the app to run only in Web Apps in App settings, or remove the icon's action.`;
		case "not-on-results":
			return `${subject} needs to show on Results for a worker to tap its icon. You can show it on Results or remove the icon's action.`;
		case "grouped-body":
			return `${subject} is in the body of a grouped tile, where Web Apps passes the group's first case whichever icon a worker taps. You can move the icon to the group's header, remove the grouping, or remove the icon's action.`;
		case "no-destination":
			return anotherForm
				? `${subject} needs a form that opens with one ${caseType ?? "chosen"} case and submits as soon as it opens. You can choose another form for the icon or remove its action.`
				: `${subject} needs a form that opens with one ${caseType ?? "chosen"} case and submits as soon as it opens, and no form in this app does. You can remove the icon's action.`;
	}
}

/** Why an icon's action is not one a worker can run, or `undefined` when it
 * is. A declaration that includes Android refuses it, since Android shows
 * the image's path in its place (`menus-and-case-lists/16-clickable-icon-…`). */
export function listIconActionIssue(
	doc: BlueprintDoc,
	module: Module,
	column: ImageMapColumn,
):
	| {
			readonly reason: ListIconActionReason;
			readonly caseType?: string;
			/** For `no-destination`: whether the column has a form to choose. */
			readonly anotherForm?: boolean;
	  }
	| undefined {
	if (column.entryPointUuid === undefined) return undefined;
	if (declaredPlatforms(doc).includes("android")) return { reason: "android" };
	if (column.visibleInList === false) return { reason: "not-on-results" };
	const caseType = listIconCaseType(doc, module, column);
	if (caseType === undefined) return { reason: "grouped-body" };
	const item = entryPointByUuid(doc, column.entryPointUuid);
	if (item === undefined || !createListIconDestination(doc)(caseType, item))
		return {
			reason: "no-destination",
			caseType,
			anotherForm: listIconDestinations(doc, module, column).length > 0,
		};
	return undefined;
}

/** The entry point id the wire prints for an icon's destination. The gate
 * admits only icons whose destination resolves. */
export function listIconEndpointId(doc: BlueprintDoc, uuid: Uuid): string {
	const item = entryPointByUuid(doc, uuid);
	if (item === undefined || item.target.kind !== "form")
		throw new Error(
			"A case list icon names a deep link that isn't a form's. The validator refuses such an icon before export, so this is a bug in Nova.",
		);
	return item.entryPoint.id;
}
