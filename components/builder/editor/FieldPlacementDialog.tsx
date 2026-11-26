"use client";

import { useId, useState } from "react";
import { Button } from "@/components/shadcn/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/shadcn/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/shadcn/field";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { fieldPlacementVerdict } from "@/lib/doc/formSectionVerdicts";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useFieldsAndOrder } from "@/lib/doc/hooks/useFieldsAndOrder";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import { type Field as FormField, isContainer, type Uuid } from "@/lib/domain";
import { submissionLayout } from "@/lib/domain/submissionLayout";

export function FieldPlacementDialog({
	form,
	field,
	where,
	close,
}: {
	form: Uuid;
	field: FormField;
	where: "screen" | "submission";
	close(): void;
}) {
	const api = useBlueprintDocApi();
	const project = useProseProjection();
	const { fields, fieldOrder: order } = useFieldsAndOrder();
	const layout = submissionLayout(form, fields, order);
	const screenParent = layout.controlParents.get(field.uuid) ?? form;
	const submittedParent = layout.parents.get(field.uuid) ?? screenParent;
	const current = where === "screen" ? screenParent : submittedParent;
	const siblings = order[current] ?? [];
	const [parent, setParent] = useState(current);
	const [after, setAfter] = useState<Uuid | "first">(
		siblings[siblings.indexOf(field.uuid) - 1] ?? "first",
	);
	const groupLabel = useId();
	const positionLabel = useId();
	const { moveField } = useBlueprintMutations();
	const repeat = (at: Uuid): Uuid | undefined => {
		for (
			let uuid: Uuid | undefined = at;
			uuid !== undefined;
			uuid = layout.controlParents.get(uuid)
		)
			if (fields[uuid]?.kind === "repeat") return uuid;
		return undefined;
	};
	const ownerRepeat = repeat(
		where === "screen" ? submittedParent : screenParent,
	);
	const canUse = (uuid: Uuid): boolean => {
		if (uuid !== form && !isContainer(fields[uuid])) return false;
		if (repeat(uuid) !== ownerRepeat) return false;
		if (where === "screen") {
			// An answer submitted at the top level of the form stays with a
			// question shown at the top level: the form designer refuses that
			// answer under a question inside a group.
			if (submittedParent === form && uuid !== form) return false;
			if (
				!fieldPlacementVerdict(api.getState(), {
					uuid: field.uuid,
					kind: field.kind,
					toParentUuid: uuid,
				}).ok
			)
				return false;
		} else if (uuid === form && screenParent !== form) return false;
		for (
			let at: Uuid | undefined = uuid;
			at !== undefined;
			at = layout.controlParents.get(at)
		)
			if (at === field.uuid) return false;
		return true;
	};
	const groups = [form, ...layout.controlParents.keys()].filter(canUse);
	const destinations = (order[parent] ?? []).filter(
		(uuid) => uuid !== field.uuid,
	);
	const fieldName = (uuid: Uuid) => {
		const selected = fields[uuid];
		return selected && "label" in selected && selected.label
			? project(selected.label).trim() || selected.id
			: (selected?.id ?? "");
	};
	const groupText = (uuid: Uuid) => {
		const steps: string[] = [];
		for (
			let at: Uuid | undefined = uuid;
			at !== undefined && at !== form;
			at = layout.controlParents.get(at)
		)
			steps.unshift(fieldName(at));
		const text = steps.join(" / ") || "Top level";
		return where === "submission" && uuid === screenParent
			? `${text} (with its question)`
			: text;
	};
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) close();
			}}
		>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>
						{where === "screen"
							? "Place the question on screen"
							: "Place the submitted answer"}
					</DialogTitle>
				</DialogHeader>
				<DialogBody>
					<FieldGroup>
						<p className="text-sm text-nova-text-secondary">
							{where === "screen"
								? "Choose where people see this question. Its answer will keep its current place in submitted forms."
								: "Choose the group that holds this answer in submitted forms. People still see the question on the same screen. In that group the answer comes after the group's own answers, in the order CommCare HQ's form designer keeps."}
						</p>
						<Field>
							<FieldLabel htmlFor={groupLabel}>Group</FieldLabel>
							<Select
								value={parent}
								onValueChange={(value) => {
									const target = groups.find((uuid) => uuid === value);
									if (target === undefined) return;
									setParent(target);
									setAfter(
										(order[target] ?? [])
											.filter((uuid) => uuid !== field.uuid)
											.at(-1) ?? "first",
									);
								}}
							>
								<SelectTrigger id={groupLabel} wrapValue>
									<SelectValue>{groupText(parent)}</SelectValue>
								</SelectTrigger>
								<SelectContent>
									{groups.map((uuid) => (
										<SelectItem key={uuid} value={uuid}>
											{groupText(uuid)}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</Field>
						{where === "screen" && (
							<Field>
								<FieldLabel htmlFor={positionLabel}>Position</FieldLabel>
								<Select<string>
									value={after}
									onValueChange={(value) => {
										if (value === "first") setAfter("first");
										else {
											const anchor = destinations.find(
												(uuid) => uuid === value,
											);
											if (anchor !== undefined) setAfter(anchor);
										}
									}}
								>
									<SelectTrigger id={positionLabel} wrapValue>
										<SelectValue>
											{after === "first"
												? "First"
												: `After ${fieldName(after)}`}
										</SelectValue>
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="first">First</SelectItem>
										{destinations.map((uuid) => (
											<SelectItem key={uuid} value={uuid}>
												After {fieldName(uuid)}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</Field>
						)}
					</FieldGroup>
				</DialogBody>
				<DialogFooter>
					<Button variant="outline" onClick={close}>
						Cancel
					</Button>
					<Button
						onClick={() => {
							const result = moveField(field.uuid, {
								where,
								toParentUuid: parent,
								...(where === "submission"
									? {}
									: after === "first"
										? { toIndex: 0 }
										: { afterUuid: after }),
							});
							if (
								result.ok ||
								("deferred" in result && result.deferred === true)
							)
								close();
						}}
					>
						{where === "screen" ? "Save position" : "Save group"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
