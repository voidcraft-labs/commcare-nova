"use client";
import { InlineField } from "@/components/builder/detail/formSettings/InlineField";
import { RejectionInline } from "@/components/builder/RejectionNotice";
import { XPathField } from "@/components/builder/XPathField";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import {
	useExpressionProjection,
	useParseFormExpression,
} from "@/lib/doc/hooks/useXPathSlots";
import type { CommitOutcome, Uuid } from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression/types";
import type {
	ConnectActivity,
	ConnectActivityField,
} from "@/lib/domain/fields/connectActivity";
import type { FieldEditorComponentProps } from "@/lib/domain/kinds";
import { useFormLintContext } from "./useFormLintContext";

const deliveryValues = [
	["entityId", "deliver_entity_id", "Person or place ID"],
	["entityName", "deliver_entity_name", "Person or place name"],
	["workAreaId", "deliver_work_area_id", "Work area ID"],
] as const;

function ActivityExpression({
	uuid,
	slotName,
	label,
	value,
	save,
}: {
	uuid: Uuid;
	slotName: "assessment_user_score" | (typeof deliveryValues)[number][1];
	label: string;
	value: Expression | undefined;
	save: (value: Expression | undefined) => CommitOutcome;
}) {
	const slot = { entity: "field", uuid, slot: slotName } as const;
	const projection = useExpressionProjection(value, slot);
	const parse = useParseFormExpression(slot);
	const getEditorContext = useFormLintContext(slot);
	return (
		<div>
			<span className="mb-1.5 block text-xs font-medium text-nova-text-secondary">
				{label}
			</span>
			<XPathField
				value={projection.text}
				getEditorContext={getEditorContext}
				onSave={(text) => save(text === "" ? undefined : parse(text))}
			/>
			{!projection.ok && (
				<RejectionInline message="This expression has a reference we couldn’t resolve. You can edit it here." />
			)}
		</div>
	);
}

export function ConnectActivityEditor({
	field,
	value,
	onChange,
}: FieldEditorComponentProps<ConnectActivityField, "activity">) {
	const store = useBlueprintDocApi();
	function change(
		update: (current: ConnectActivity) => ConnectActivity | undefined,
	): CommitOutcome {
		const current = store.getState().fields[field.uuid];
		const next =
			current?.kind === "connect_activity" &&
			current.activity.kind === value.kind
				? update(current.activity)
				: undefined;
		return next === undefined
			? {
					ok: false,
					messages: [
						"This activity changed while you were editing. Reopen it to see its settings.",
					],
				}
			: onChange(next);
	}
	return (
		<div className="space-y-3">
			{"name" in value && (
				<InlineField
					label="Activity name"
					value={value.name}
					required
					onChange={(name) =>
						change((current) =>
							"name" in current ? { ...current, name } : undefined,
						)
					}
				/>
			)}
			{"description" in value && (
				<InlineField
					label="Description"
					value={value.description}
					multiline
					required={value.kind === "learning-module"}
					onChange={(description) =>
						change((current) =>
							"description" in current
								? { ...current, description }
								: undefined,
						)
					}
				/>
			)}
			{value.kind === "learning-module" && (
				<InlineField
					label="Estimated hours"
					value={String(value.estimatedHours)}
					type="number"
					required
					onChange={(text) => {
						if (!/^\d+$/.test(text) || Number(text) > 2147483647)
							return {
								ok: false,
								messages: [
									"Estimated hours can be a whole number from 0 to 2,147,483,647.",
								],
							};
						return change((current) =>
							current.kind === "learning-module"
								? { ...current, estimatedHours: Number(text) }
								: undefined,
						);
					}}
				/>
			)}
			{value.kind === "assessment" && (
				<ActivityExpression
					uuid={field.uuid}
					label="Assessment score"
					slotName="assessment_user_score"
					value={value.score}
					save={(score) =>
						score === undefined
							? {
									ok: false,
									messages: [
										"An assessment needs a score. Choose a question or enter a number.",
									],
								}
							: change((current) =>
									current.kind === "assessment"
										? { ...current, score }
										: undefined,
								)
					}
				/>
			)}
			{value.kind === "delivery" &&
				deliveryValues.map(([key, slot, label]) => (
					<ActivityExpression
						key={key}
						uuid={field.uuid}
						label={label}
						slotName={slot}
						value={value[key]}
						save={(answer) =>
							change((current) => {
								if (current.kind !== "delivery") return undefined;
								const next = { ...current };
								if (answer === undefined) delete next[key];
								else next[key] = answer;
								return next;
							})
						}
					/>
				))}
		</div>
	);
}
