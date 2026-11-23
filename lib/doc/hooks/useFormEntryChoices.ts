"use client";
import { useMemo } from "react";
import { v4 as uuidv4 } from "uuid";
import {
	formCaseSelections,
	newFormSelectionTag,
	ownFormSelectionIndex,
	shareableForms,
} from "@/lib/domain/advancedEntryDatums";
import { formStructure } from "@/lib/domain/expression/formStructure";
import { formContentUuid } from "@/lib/domain/formEntryCases";
import {
	openingAssignmentPropertyType,
	openingAssignmentSource,
} from "@/lib/domain/formOpeningAssignments";
import type { FormOpeningAssignment } from "@/lib/domain/forms";
import { moduleUuidOfForm } from "@/lib/domain/postSubmit";
import { proseTemplateText } from "@/lib/domain/prose";
import { entityTargetKey } from "@/lib/domain/referenceIndex";
import { asUuid, type Uuid } from "@/lib/domain/uuid";
import type { FormEntryChange } from "../formEntryMutations";
import { referencingCarrierUuids } from "../referenceIndex";
import {
	useBlueprintDoc,
	useBlueprintDocApi,
	useBlueprintDocEq,
	useBlueprintDocShallow,
} from "./useBlueprintDoc";
import { useBlueprintMutations } from "./useBlueprintMutations";

export function useShareableForms(moduleUuid: Uuid, open: boolean) {
	return useBlueprintDocEq(
		(doc) => (open ? shareableForms(doc, moduleUuid) : []),
		(a, b) =>
			a.length === b.length &&
			a.every(
				(row, i) =>
					row.uuid === b[i].uuid &&
					row.name === b[i].name &&
					row.menu === b[i].menu,
			),
	);
}

export function useSharedFormOrigin(formUuid: Uuid) {
	return useBlueprintDocShallow((doc) => {
		const uuid = doc.forms[formUuid]?.shadowOf?.form;
		return {
			sharedParent: uuid ? doc.forms[uuid] : undefined,
			parentMenu: uuid && moduleUuidOfForm(doc, uuid),
		};
	});
}

export function useFormEntryChoices(formUuid: Uuid) {
	const doc = useBlueprintDoc((state) => state);
	const api = useBlueprintDocApi();
	const { inline } = useBlueprintMutations();
	const choices = useMemo(
		() => formCaseSelections(doc, formUuid),
		[doc, formUuid],
	);
	const form = doc.forms[formUuid];
	const sharedParent = form?.shadowOf && doc.forms[form.shadowOf.form];
	const owner = sharedParent && moduleUuidOfForm(doc, formUuid);
	const possibleParents = useMemo(
		() => (owner ? shareableForms(doc, owner) : []),
		[doc, owner],
	);
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
		ownIndex: ownFormSelectionIndex(doc, formUuid),
		assignmentSource(source: FormOpeningAssignment["source"]) {
			return openingAssignmentSource(doc, formUuid, source);
		},
		assignmentProperties(
			assignment: Pick<FormOpeningAssignment, "source" | "via" | "property">,
		) {
			const type = openingAssignmentPropertyType(doc, formUuid, assignment);
			const catalog =
				doc.caseTypes?.find((row) => row.name === type)?.properties ?? [];
			const options = new Map([
				["case_name", "Record name"],
				["owner_id", "Record owner"],
				["external_id", "External ID"],
			]);
			for (const property of catalog)
				options.set(
					property.name,
					proseTemplateText(property.label) || property.name,
				);
			if (!options.has(assignment.property))
				options.set(assignment.property, assignment.property);
			return [...options].map(([value, label]) => ({ value, label }));
		},
		assignmentQuestions: [
			...(formStructure(doc, formUuid)?.fields.values() ?? []),
		]
			.filter((field) => !["group", "section", "repeat"].includes(field.kind))
			.map((field) => {
				const question = doc.fields[field.uuid];
				const label =
					question && "label" in question && question.label
						? proseTemplateText(question.label)
						: "";
				return { value: field.uuid, label: label || field.id };
			}),
		sharedParent,
		possibleParents,
		omitted: sharedParent
			? formCaseSelections(doc, sharedParent.uuid).filter(
					(row) => !choices.some((choice) => choice.uuid === row.uuid),
				)
			: [],
		connectionQuestions: [
			...(formStructure(doc, formContentUuid(doc, formUuid))?.fields.values() ??
				[]),
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
