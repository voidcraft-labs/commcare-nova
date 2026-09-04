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

"use client";

import { Icon } from "@iconify/react/offline";
import tablerEyeOff from "@iconify-icons/tabler/eye-off";
import { useMemo } from "react";
import { ExpressionCardEditor } from "@/components/builder/shared/ExpressionCardEditor";
import {
	buildValidityIndex,
	PredicateEditProvider,
} from "@/components/builder/shared/editorContext";
import { BlurCommitTextInput } from "@/components/builder/shared/primitives/BlurCommitTextInput";
import { InlineError } from "@/components/builder/shared/primitives/CardShell";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import {
	type CaseType,
	type HiddenSearchInputDef,
	hiddenSearchInputDef,
	type SearchInputDef,
	type UserProperty,
} from "@/lib/domain";
import type { ValueExpression } from "@/lib/domain/predicate";
import {
	NO_SEARCH_INPUTS,
	type ResolvedRow,
	resolveRows,
} from "../searchInputResolution";
import { FieldRow } from "./searchInputFieldRow";

export interface HiddenSearchValueEditorProps {
	readonly value: HiddenSearchInputDef;
	readonly index: number;
	readonly siblings: readonly SearchInputDef[];
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly userProperties?: readonly UserProperty[];
	readonly onChange: (next: SearchInputDef) => void;
}

export function HiddenSearchValueEditor({
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
		readonly value?: ValueExpression;
	}) =>
		onChange(
			hiddenSearchInputDef(
				value.uuid,
				patch.name ?? value.name,
				patch.label ?? value.label,
				patch.value ?? value.value,
			),
		);

	return (
		<PredicateEditProvider
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
						People never see this value and it never narrows the results. Nova
						works it out when the Search screen opens and keeps it with the
						search, so a form that opens afterwards can save it.
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
						<ExpressionCardEditor
							value={value.value}
							onChange={(next) => rebuild({ value: next })}
							caseTypes={caseTypes}
							currentCaseType={currentCaseType}
							knownInputs={NO_SEARCH_INPUTS}
							userProperties={userProperties}
							caseDataScope="global"
							constraint={{ accepts: "any" }}
						/>
					</div>
				</FieldRow>

				<FieldRow
					label="Name used in other conditions"
					hint="A unique name a later form can read this value by"
				>
					<BlurCommitTextInput
						value={value.name}
						onCommit={(name) => rebuild({ name })}
						ariaLabel={`Hidden search value ${index + 1} name used in other conditions`}
					/>
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
		</PredicateEditProvider>
	);
}
