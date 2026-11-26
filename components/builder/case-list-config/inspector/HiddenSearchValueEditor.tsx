// components/builder/case-list-config/inspector/HiddenSearchValueEditor.tsx
//
// Inspector body for a hidden search value: a name, a label the app strings
// still carry, and the expression Nova works out when the Search screen
// opens. Nothing here is a widget, a match, or a starting value, because a
// hidden value is none of those things: it never shows, never filters, and
// travels with the completed search so a form offered afterwards can read it.
//
// The expression resolves before anyone has typed, in the same global scope a
// visible field's starting value uses: session and current-user values,
// literals, the date and time. Case data and other search answers are not
// offered, matching the commit gate's forbids-input-ref rule for this slot.
// The value is optional: a hidden field with none starts blank, which Web
// Apps keeps and Android shows for the worker to fill in.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerEyeOff from "@iconify-icons/tabler/eye-off";
import tablerPlus from "@iconify-icons/tabler/plus";
import { useMemo, useState } from "react";
import { ExpressionSlotEditor } from "@/components/builder/shared/ExpressionSlotEditors";
import {
	buildValidityIndex,
	EditorVocabularyProvider,
} from "@/components/builder/shared/editorContext";
import { BlurCommitTextInput } from "@/components/builder/shared/primitives/BlurCommitTextInput";
import { InlineError } from "@/components/builder/shared/primitives/CardShell";
import { Button } from "@/components/shadcn/button";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import {
	type CaseType,
	type HiddenSearchInputDef,
	hiddenSearchInputDef,
	type SearchInputDef,
	searchInputNameRefusal,
	type UserProperty,
	type Uuid,
} from "@/lib/domain";
import { type Expression, literal, term } from "@/lib/domain/expression";
import {
	NO_SEARCH_INPUTS,
	type ResolvedRow,
	resolveRows,
} from "../searchInputResolution";
import { FieldRow } from "./searchInputFieldRow";

export interface HiddenSearchValueEditorProps {
	readonly moduleUuid: Uuid | undefined;
	readonly value: HiddenSearchInputDef;
	readonly index: number;
	readonly siblings: readonly SearchInputDef[];
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly userProperties?: readonly UserProperty[];
	readonly onChange: (next: SearchInputDef) => void;
}

export function HiddenSearchValueEditor({
	moduleUuid,
	value,
	index,
	siblings,
	caseTypes,
	currentCaseType,
	userProperties = [],
	onChange,
}: HiddenSearchValueEditorProps) {
	const projectProse = useProseProjection();
	const resolved: ResolvedRow = useMemo(() => {
		const rows = resolveRows(
			siblings,
			caseTypes,
			currentCaseType,
			projectProse,
		);
		return (
			rows[index] ?? {
				nameState: { kind: "ok" } as const,
				labelEmpty: value.label === "",
				propertyState: { kind: "ok" } as const,
				typeCouplingErrors: [] as readonly string[],
			}
		);
	}, [siblings, index, caseTypes, currentCaseType, projectProse, value.label]);
	const emptyValidityIndex = useMemo(() => buildValidityIndex([]), []);
	const duplicateOf =
		resolved.nameState.kind === "duplicate"
			? siblings[resolved.nameState.firstIndex]
			: undefined;

	const rebuild = (patch: {
		readonly name?: string;
		readonly label?: string;
		readonly value?: Expression | undefined;
	}) =>
		onChange(
			hiddenSearchInputDef(
				value.uuid,
				patch.name ?? value.name,
				patch.label ?? value.label,
				"value" in patch ? patch.value : value.value,
			),
		);

	/* A name outside the Search field grammar is held with the schema's
	 * sentence instead of bouncing off the gate. */
	const [nameRefusal, setNameRefusal] = useState<string | null>(null);
	const setName = (name: string) => {
		// An empty name is the row's own empty state, which the row says below.
		const grammarRefusal =
			name.length === 0 ? undefined : searchInputNameRefusal(name);
		if (grammarRefusal !== undefined) {
			setNameRefusal(grammarRefusal);
			return;
		}
		setNameRefusal(null);
		rebuild({ name });
	};

	return (
		<EditorVocabularyProvider
			caseTypes={caseTypes}
			currentCaseType={currentCaseType}
			knownInputs={NO_SEARCH_INPUTS}
			userProperties={userProperties}
			validityIndex={emptyValidityIndex}
		>
			<div className="space-y-5">
				<p className="flex items-start gap-2 rounded-xl border border-white/[0.07] bg-nova-deep/30 p-3 text-[13px] leading-relaxed text-nova-text-secondary">
					<Icon
						icon={tablerEyeOff}
						width="16"
						height="16"
						className="mt-0.5 shrink-0 text-nova-text-muted"
						aria-hidden="true"
					/>
					<span>
						People never see this value in Web Apps and it never narrows the
						results. Nova works it out when the Search screen opens and keeps it
						with the search, so a form that opens afterwards can save it.
						Android shows it on the Search screen, where people can change it.
					</span>
				</p>

				<FieldRow label="Label" hint="Names the value for you and the app">
					<BlurCommitTextInput
						value={value.label}
						onCommit={(label) => rebuild({ label })}
						ariaLabel={`Hidden search value ${index + 1} label`}
					/>
					{resolved.labelEmpty && <InlineError errors={["Enter a label"]} />}
				</FieldRow>

				<FieldRow
					label="Value"
					hint="Worked out once when the Search screen opens"
				>
					<div className="rounded-xl border border-white/[0.06] bg-nova-deep/30 p-3">
						{moduleUuid === undefined ? (
							<p role="status">This value's owner is no longer available.</p>
						) : value.value === undefined ? (
							<Button
								type="button"
								onClick={() => rebuild({ value: term(literal("")) })}
								variant="ghost"
								className="nova-add-slot w-full"
								aria-label={`Add a value for hidden search value ${index + 1}`}
							>
								<Icon icon={tablerPlus} width="13" height="13" />
								<span>Add value</span>
							</Button>
						) : (
							<ExpressionSlotEditor
								slot={{
									entity: "module",
									uuid: moduleUuid,
									slot: "search_input_hidden_value",
									member: { searchInputUuid: value.uuid },
								}}
								candidate={{ entity: "search-input", value }}
								value={value.value}
								onChange={(next) => rebuild({ value: next })}
								caseTypes={caseTypes}
								currentCaseType={currentCaseType}
								knownInputs={NO_SEARCH_INPUTS}
								userProperties={userProperties}
								constraint={{ accepts: "any" }}
							/>
						)}
						{moduleUuid !== undefined && value.value !== undefined && (
							<Button
								type="button"
								onClick={() => rebuild({ value: undefined })}
								variant="destructive"
								className="mt-3 w-full px-3 text-[14px]"
								aria-label={`Remove the value of hidden search value ${index + 1}`}
							>
								Remove value
							</Button>
						)}
					</div>
				</FieldRow>

				<FieldRow
					label="Name used in other conditions"
					hint="A unique name a later form can read this value by"
				>
					<BlurCommitTextInput
						value={value.name}
						onCommit={setName}
						ariaLabel={`Hidden search value ${index + 1} name used in other conditions`}
					/>
					{nameRefusal !== null && <InlineError errors={[nameRefusal]} />}
					{resolved.nameState.kind === "empty" && (
						<InlineError errors={["Enter a name used in other conditions"]} />
					)}
					{duplicateOf !== undefined && (
						<InlineError
							errors={[
								`That name is already used by “${duplicateOf.label || duplicateOf.name}”. Choose another name`,
							]}
						/>
					)}
				</FieldRow>
			</div>
		</EditorVocabularyProvider>
	);
}
