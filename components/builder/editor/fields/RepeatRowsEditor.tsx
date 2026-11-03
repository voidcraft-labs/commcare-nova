/**
 * RepeatRowsEditor: a repeat's **Rows** control, how its rows come.
 *
 * Three choices (`Workers add rows`, `A set number of rows`, `One row per case
 * found`), each one `updateField` carrying the new mode and only that mode's
 * slot, seeded as an `Expression` tree (`repeatRowsModel.ts` builds every
 * write); the reducer drops the previous mode's slot in the same step, so a
 * mode change is one undo entry. A choice the repeat's place can't take is
 * disabled with the sentence that says why, never hidden.
 *
 * Under `A set number of rows`, **How many rows** is the form-logic editor
 * over `repeat_count`. A count that isn't a whole number is the checker's
 * finding at the editor's lint, and **Use a whole number** commits the draft's
 * tree inside an `int(...)` call node through the same gate, never a text
 * edit. Under `One row per case found`, **Cases to show** edits `ids_query`
 * and the placement lines say how the rows follow the cases found
 * (`queryRepeatPlacementLines`), with the held suffix where a publish keeps
 * the placement.
 *
 * The choices and lines are derived from the whole document (the repeat's
 * parent, its menu's case type, what its query reads), so they recompute on
 * every document or lookup revision, the same signal the expression editors
 * beside them follow.
 *
 * `data-field-id` conventions: the choices are `repeat_mode`, the editors the
 * slot keys `repeat_count` and `ids_query`. Each choice carries
 * `data-repeat-rows-mode`, and the fix's button `data-repeat-count-fix`.
 */
"use client";

import { useCallback, useId, useMemo, useState } from "react";
import { useFormLintContext } from "@/components/builder/editor/fields/useFormLintContext";
import {
	INSPECTOR_LABEL_CLS,
	InspectorHint,
} from "@/components/builder/inspector/inspectorChrome";
import { RejectionInline } from "@/components/builder/RejectionNotice";
import { SaveShortcutHint } from "@/components/builder/SaveShortcutHint";
import {
	XPathField,
	type XPathFieldLintActions,
} from "@/components/builder/XPathField";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import {
	useExpressionProjection,
	useExpressionScopeRevision,
	useParseFormExpression,
} from "@/lib/doc/hooks/useXPathSlots";
import type { CommitOutcome, RepeatField } from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression/types";
import type { RepeatMode } from "@/lib/domain/fields/repeat";
import type { FieldEditorComponentProps } from "@/lib/domain/kinds";
import { useSessionFocusHint } from "@/lib/session/hooks";
import { selectableSegmentCls } from "@/lib/styles";
import { cn } from "@/lib/utils";
import {
	isWholeNumberCountRefusal,
	queryRepeatPlacementLines,
	REPEAT_COUNT_EDITOR_LABEL,
	REPEAT_COUNT_LINE,
	REPEAT_QUERY_EDITOR_LABEL,
	type RepeatRowsMutation,
	repeatRowsModeOptions,
	repeatRowsModeSwitch,
	WHOLE_NUMBER_FIX_LABEL,
	wholeNumberCountFixMutation,
} from "./repeatRowsModel";

const PROJECTION_FAILED =
	"This expression contains a reference that no longer resolves. Re-enter the intended field or worker-information reference.";
const COUNT_REQUIRED =
	"A set number of rows needs a number. Type one, or choose another way the rows come.";
const QUERY_REQUIRED =
	"One row per case found needs the cases to show. Type a query, or choose another way the rows come.";

/* The editor reads only the field and the entry's label: it writes through
 * the gate itself, since a mode change carries a second slot that a one-key
 * `onChange` can't. Taking only these props lets one component serve every
 * repeat variant's entry. */
export function RepeatRowsEditor({
	field,
	label,
}: Pick<
	FieldEditorComponentProps<RepeatField, "repeat_mode">,
	"field" | "label"
>) {
	const docApi = useBlueprintDocApi();
	const revision = useExpressionScopeRevision();
	// biome-ignore lint/correctness/useExhaustiveDependencies: the revision is what a change to the repeat's place, its menu or its query moves; the read is the store's current document.
	const view = useMemo(() => {
		const doc = docApi.getState();
		return {
			options: repeatRowsModeOptions(doc, field),
			placement: queryRepeatPlacementLines(doc, field.uuid),
		};
	}, [docApi, field, revision]);
	const {
		inline: { commitMany },
	} = useBlueprintMutations();
	const [rejection, setRejection] = useState<string | null>(null);
	/* The slot a mode choice just seeded, opened for editing so the person
	 * types straight over the seed. Remembered per field: the instance is
	 * reused across selections. */
	const [opened, setOpened] = useState<{
		readonly uuid: string;
		readonly mode: RepeatMode;
	} | null>(null);
	const groupName = useId();

	const commit = useCallback(
		(mutation: RepeatRowsMutation): CommitOutcome => {
			const outcome = commitMany([mutation]);
			setRejection(outcome.ok ? null : (outcome.messages[0] ?? null));
			return outcome;
		},
		[commitMany],
	);

	const choose = useCallback(
		(next: RepeatMode) => {
			const verdict = repeatRowsModeSwitch(docApi.getState(), field, next);
			if (verdict.kind === "unchanged") return;
			if (verdict.kind === "refused") {
				setRejection(verdict.reason);
				return;
			}
			if (commit(verdict.mutation).ok && next !== "user_controlled")
				setOpened({ uuid: field.uuid, mode: next });
		},
		[docApi, field, commit],
	);

	const openedHere =
		opened?.uuid === field.uuid && opened.mode === field.repeat_mode;
	const closeOpened = useCallback(() => setOpened(null), []);

	return (
		<div className="space-y-2">
			<span
				id={`${groupName}-label`}
				className={`${INSPECTOR_LABEL_CLS} flex min-h-11 items-center`}
			>
				{label}
			</span>
			<fieldset
				aria-labelledby={`${groupName}-label`}
				data-field-id="repeat_mode"
				className="m-0 grid gap-1 rounded-2xl border-0 bg-nova-deep/50 p-1"
			>
				<legend className="sr-only">{label}</legend>
				{view.options.map((option) => {
					const selected = option.value === field.repeat_mode;
					const disabled = option.disabled !== undefined;
					return (
						<label
							key={option.value}
							data-repeat-rows-mode={option.value}
							className={cn(
								selectableSegmentCls(selected),
								"h-auto flex-col items-start justify-start gap-0.5 py-2 text-left whitespace-normal has-[input:focus-visible]:border-nova-ring has-[input:focus-visible]:shadow-(--focus-ring)",
								disabled && "cursor-not-allowed opacity-(--disabled-opacity)",
							)}
						>
							<input
								type="radio"
								name={groupName}
								value={option.value}
								checked={selected}
								disabled={disabled}
								onChange={() => choose(option.value)}
								className="sr-only"
							/>
							<span className="text-[13px] font-medium">{option.label}</span>
							{option.disabled !== undefined && (
								<span className="text-xs leading-snug text-nova-text-muted">
									{option.disabled}
								</span>
							)}
						</label>
					);
				})}
			</fieldset>
			<RejectionInline message={rejection} />
			{field.repeat_mode === "count_bound" && (
				<RepeatCountEditor
					field={field}
					count={field.repeat_count}
					autoEdit={openedHere}
					onClosed={closeOpened}
					commit={commit}
				/>
			)}
			{field.repeat_mode === "query_bound" && (
				<>
					<RepeatQueryEditor
						field={field}
						query={field.data_source.ids_query}
						autoEdit={openedHere}
						onClosed={closeOpened}
						commit={commit}
					/>
					{view.placement !== undefined && (
						<div className="space-y-1" data-repeat-rows-placement="">
							<InspectorHint>{view.placement.line}</InspectorHint>
							{view.placement.because !== undefined && (
								<InspectorHint>{view.placement.because}</InspectorHint>
							)}
							{view.placement.pastTheEnd !== undefined && (
								<InspectorHint>{view.placement.pastTheEnd}</InspectorHint>
							)}
						</div>
					)}
				</>
			)}
		</div>
	);
}

/** **How many rows**: the count editor, its whole-number fix and the line
 *  that says what a changing count does. */
function RepeatCountEditor({
	field,
	count,
	autoEdit,
	onClosed,
	commit,
}: {
	readonly field: RepeatField;
	readonly count: Expression;
	readonly autoEdit: boolean;
	/** The editor closed: a slot a mode choice opened is opened no longer. */
	readonly onClosed: () => void;
	readonly commit: (mutation: RepeatRowsMutation) => CommitOutcome;
}) {
	const slot = {
		entity: "field" as const,
		uuid: field.uuid,
		slot: "repeat_count" as const,
	};
	const projection = useExpressionProjection(count, slot);
	const parse = useParseFormExpression(slot);
	const getEditorContext = useFormLintContext(slot);
	const focusHint = useSessionFocusHint();
	const [editing, setEditing] = useState(false);
	const editingChanged = useCallback(
		(next: boolean) => {
			setEditing(next);
			if (!next) onClosed();
		},
		[onClosed],
	);

	const save = useCallback(
		(next: string): CommitOutcome => {
			if (next.trim() === "") return { ok: false, messages: [COUNT_REQUIRED] };
			return commit({
				kind: "updateField",
				uuid: field.uuid,
				targetKind: "repeat",
				patch: { repeat_count: parse(next) },
			});
		},
		[commit, parse, field.uuid],
	);

	/* The checker's whole-number refusal offers the fix: the draft's own
	 * tree inside `int(...)`, committed as the count. A draft that doesn't
	 * parse has no checker finding, so the fix is never offered on one. */
	const lintActions = useCallback<XPathFieldLintActions>(
		(finding) =>
			finding.checkError !== undefined &&
			isWholeNumberCountRefusal(finding.checkError)
				? [
						{
							name: WHOLE_NUMBER_FIX_LABEL,
							attributes: { "data-repeat-count-fix": "" },
							run: (draft) =>
								commit(wholeNumberCountFixMutation(field.uuid, parse(draft))),
						},
					]
				: [],
		[commit, parse, field.uuid],
	);

	return (
		<div className="space-y-2 pt-1">
			<span
				className={`${INSPECTOR_LABEL_CLS} flex min-h-11 items-center gap-1.5`}
			>
				{REPEAT_COUNT_EDITOR_LABEL}
				{editing && <SaveShortcutHint />}
			</span>
			<div data-field-id="repeat_count">
				<XPathField
					key={autoEdit ? "repeat_count:opened" : "repeat_count"}
					value={projection.text}
					onSave={save}
					getEditorContext={getEditorContext}
					autoEdit={autoEdit || focusHint === "repeat_count"}
					onEditingChange={editingChanged}
					lintActions={lintActions}
				/>
			</div>
			{!projection.ok && <RejectionInline message={PROJECTION_FAILED} />}
			<InspectorHint>{REPEAT_COUNT_LINE}</InspectorHint>
		</div>
	);
}

/** **Cases to show**: the query editor over `ids_query`. */
function RepeatQueryEditor({
	field,
	query,
	autoEdit,
	onClosed,
	commit,
}: {
	readonly field: RepeatField;
	readonly query: Expression;
	readonly autoEdit: boolean;
	/** The editor closed: a slot a mode choice opened is opened no longer. */
	readonly onClosed: () => void;
	readonly commit: (mutation: RepeatRowsMutation) => CommitOutcome;
}) {
	const slot = {
		entity: "field" as const,
		uuid: field.uuid,
		slot: "ids_query" as const,
	};
	const projection = useExpressionProjection(query, slot);
	const parse = useParseFormExpression(slot);
	const getEditorContext = useFormLintContext(slot);
	const focusHint = useSessionFocusHint();
	const [editing, setEditing] = useState(false);
	const editingChanged = useCallback(
		(next: boolean) => {
			setEditing(next);
			if (!next) onClosed();
		},
		[onClosed],
	);

	const save = useCallback(
		(next: string): CommitOutcome => {
			if (next.trim() === "") return { ok: false, messages: [QUERY_REQUIRED] };
			return commit({
				kind: "updateField",
				uuid: field.uuid,
				targetKind: "repeat",
				patch: { data_source: { ids_query: parse(next) } },
			});
		},
		[commit, parse, field.uuid],
	);

	return (
		<div className="space-y-2 pt-1">
			<span
				className={`${INSPECTOR_LABEL_CLS} flex min-h-11 items-center gap-1.5`}
			>
				{REPEAT_QUERY_EDITOR_LABEL}
				{editing && <SaveShortcutHint />}
			</span>
			<div data-field-id="ids_query">
				<XPathField
					key={autoEdit ? "ids_query:opened" : "ids_query"}
					value={projection.text}
					onSave={save}
					getEditorContext={getEditorContext}
					autoEdit={autoEdit || focusHint === "ids_query"}
					onEditingChange={editingChanged}
				/>
			</div>
			{!projection.ok && <RejectionInline message={PROJECTION_FAILED} />}
		</div>
	);
}
