import {
	DEFAULT_ASSESSMENT_USER_SCORE,
	DEFAULT_DELIVER_ENTITY_ID,
	DEFAULT_DELIVER_ENTITY_NAME,
} from "@/lib/doc/connectConfig";
import { parseAuthoredFormExpression } from "@/lib/doc/expressionText";
import { prepareFormConnectExpressions } from "@/lib/doc/formExpressionStructure";
import type { BlueprintDoc, ConnectType, Uuid } from "@/lib/domain";
import type { LookupDefinitionIndex } from "@/lib/domain/expression/context";
import type { FormStructureConnect } from "@/lib/domain/expression/formStructure";
import type { Expression } from "@/lib/domain/expression/types";
import type {
	BlockDraft,
	ConnectDraftSlot,
	SubConfigKind,
} from "./connectDraft";

/** Final block identities and all pending sources share one prepared form. */
export function connectDraftDeclarations(
	draft: BlockDraft,
	mode: ConnectType,
	derivedId: (kind: SubConfigKind) => string,
) {
	const blocks: FormStructureConnect =
		mode === "learn"
			? {
					...(draft.learnOn
						? {
								learn_module: {
									id: draft.learnId || derivedId("learn_module"),
								},
							}
						: {}),
					...(draft.assessmentOn
						? {
								assessment: {
									id: draft.assessmentId || derivedId("assessment"),
								},
							}
						: {}),
				}
			: {
					...(draft.deliverOn
						? {
								deliver_unit: {
									id: draft.deliverId || derivedId("deliver_unit"),
								},
							}
						: {}),
					...(draft.taskOn
						? { task: { id: draft.taskId || derivedId("task") } }
						: {}),
				};
	const sources = new Map<ConnectDraftSlot, string>();
	const add = (
		slot: ConnectDraftSlot,
		active: boolean,
		source: string,
		defaultText: string,
	) => {
		const text = source.trim();
		if (active && text && text !== defaultText) sources.set(slot, text);
	};
	add(
		"assessment_user_score",
		mode === "learn" && draft.assessmentOn,
		draft.userScoreText,
		DEFAULT_ASSESSMENT_USER_SCORE,
	);
	add(
		"deliver_entity_id",
		mode === "deliver" && draft.deliverOn,
		draft.entityIdText,
		DEFAULT_DELIVER_ENTITY_ID,
	);
	add(
		"deliver_entity_name",
		mode === "deliver" && draft.deliverOn,
		draft.entityNameText,
		DEFAULT_DELIVER_ENTITY_NAME,
	);
	return { blocks, sources };
}

export function connectDraftParser(
	doc: BlueprintDoc,
	formUuid: Uuid,
	draft: BlockDraft,
	mode: ConnectType,
	derivedId: (kind: SubConfigKind) => string,
	lookup: LookupDefinitionIndex | "unavailable",
): (source: string, slot: ConnectDraftSlot) => Expression {
	const { blocks, sources } = connectDraftDeclarations(draft, mode, derivedId);
	const form = prepareFormConnectExpressions(
		doc,
		formUuid,
		mode,
		blocks,
		sources,
		lookup,
	);
	return (source, name) => {
		if (form === undefined)
			throw new Error(
				"This form is no longer in the app. Reopen Connect to use the latest version.",
			);
		const expression = parseAuthoredFormExpression(
			{
				doc,
				slot: { entity: "form", uuid: formUuid, slot: name },
				lookup,
				form,
			},
			source,
		);
		if (expression === undefined)
			throw new Error("Enter a Connect expression before saving.");
		return expression;
	};
}
