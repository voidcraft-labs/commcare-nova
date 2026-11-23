"use client";
import { useMemo } from "react";
import { v4 as uuidv4 } from "uuid";
import {
	formCaseSelections,
	newFormSelectionTag,
} from "@/lib/domain/advancedEntryDatums";
import { formStructure } from "@/lib/domain/expression/formStructure";
import { entityTargetKey } from "@/lib/domain/referenceIndex";
import { asUuid, type Uuid } from "@/lib/domain/uuid";
import type { FormEntryChange } from "../formEntryMutations";
import { referencingCarrierUuids } from "../referenceIndex";
import { useBlueprintDoc, useBlueprintDocApi } from "./useBlueprintDoc";
import { useBlueprintMutations } from "./useBlueprintMutations";

export function useFormEntryChoices(formUuid: Uuid) {
	const doc = useBlueprintDoc((state) => state);
	const api = useBlueprintDocApi();
	const { inline } = useBlueprintMutations();
	const choices = useMemo(
		() => formCaseSelections(doc, formUuid),
		[doc, formUuid],
	);
	const form = doc.forms[formUuid];
	const menus = doc.moduleOrder.flatMap((uuid) => {
		const menu = doc.modules[uuid];
		return menu?.caseType
			? [{ uuid, name: menu.name, caseType: menu.caseType }]
			: [];
	});
	const types = [
		...new Set([
			...(doc.caseTypes ?? []).map((row) => row.name),
			...menus.map((menu) => menu.caseType),
		]),
	];
	const dependents = (uuid: Uuid) =>
		referencingCarrierUuids(doc, entityTargetKey(uuid))
			.map(
				(id) =>
					doc.fields[id]?.id ?? doc.forms[id]?.name ?? doc.modules[id]?.name,
			)
			.filter((name): name is string => name !== undefined);
	const commit = (entryChange: FormEntryChange) =>
		inline.commitMany([
			{ kind: "updateForm", uuid: formUuid, patch: {}, entryChange },
		]);
	return {
		form,
		choices,
		connectionQuestions: [
			...(formStructure(doc, formUuid)?.fields.values() ?? []),
		]
			.filter((field) => field.kind !== "repeat" && field.kind !== "group")
			.map((field) => ({ value: field.uuid, label: field.id })),
		menus,
		types,
		dependents,
		commit,
		add(list: (typeof menus)[number] | undefined) {
			const current = api.getState();
			const name = list?.name ?? "Worker’s record";
			return commit({
				operation: "add-choice",
				value: {
					uuid: asUuid(uuidv4()),
					tag: newFormSelectionTag(current, formUuid, name),
					name,
					caseType: list?.caseType ?? "commcare-user",
					source: list
						? { kind: "choose", module: list.uuid }
						: { kind: "worker-record" },
				},
			});
		},
	};
}
