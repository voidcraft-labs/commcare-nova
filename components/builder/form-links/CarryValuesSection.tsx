// components/builder/form-links/CarryValuesSection.tsx
//
// What travels with the person when a link is followed.
//
// The destination decides what it needs (`formLinkRequiredDatums`, the
// same derivation the wire uses) and the projector decides whether this
// form can supply it automatically (`formLinkCarryVerdict`, HQ's
// source-matching question asked ahead of time). The section shows that
// answer and offers exactly the choices it admits:
//
//   - nothing needed: a sentence, no control;
//   - automatic: carry it automatically (the stored link says nothing,
//     `datums` absent), plus work it out here only when the manual-carry
//     admission verdict allows an explicit datum map;
//   - manual required: work it out here, because nothing else will do.
//
// "Work it out here" is all-or-nothing: a link either names every value
// the destination selects or none of them, so the editor never holds a
// half-filled list the gate would refuse.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerCheck from "@iconify-icons/tabler/check";
import { useState } from "react";
import { XPathField } from "@/components/builder/XPathField";
import { Button } from "@/components/shadcn/button";
import { buildSessionLintContext } from "@/lib/codemirror/buildSessionLintContext";
import { SESSION_FORM_READ_MESSAGE } from "@/lib/codemirror/xpath-lint";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import type { FormLinksView } from "@/lib/doc/hooks/useFormLinks";
import {
	useParseXPathForForm,
	useXPathProjection,
} from "@/lib/doc/hooks/useXPathSlots";
import type { Uuid } from "@/lib/doc/types";
import type { CommitOutcome, FormLink, FormLinkDatum } from "@/lib/domain";
import { useInlineConfirmFocus } from "@/lib/ui/hooks/useInlineConfirmFocus";
import {
	CARRIED_VALUE_HINT,
	COMPLETE_SELECTION_NEEDS_FORM_LIST,
	carriedAutomaticallyDetail,
	EMPTY_CARRIED_VALUE_REFUSAL,
	nothingNeededCopy,
	SEVERAL_CASES_CARRY_AUTOMATICALLY,
	SEVERAL_CASES_MANUAL_CARRY_NEEDS_REPAIR,
} from "./afterSubmitCopy";
import { readsForm } from "./LinkConditionEditor";
import { SEED_CARRIED_VALUE_TEXT, seedCarriedValues } from "./seeds";

export function CarryValuesSection({
	formUuid,
	link,
	view,
	canEdit,
	onCommit,
}: {
	readonly formUuid: Uuid;
	readonly link: FormLink;
	readonly view: FormLinksView;
	readonly canEdit: boolean;
	readonly onCommit: (next: FormLink) => CommitOutcome;
}) {
	const parse = useParseXPathForForm(formUuid);
	const carry = view.carryVerdict(link.target);
	const required = view.requiredDatums(link.target);
	const manual = link.datums !== undefined;
	const manualCarry = view.manualCarryVerdict(link);
	const manualCarryUnavailable = !manualCarry.ok;
	const invalidManual = manual && manualCarryUnavailable;
	const [confirmingAutomatic, setConfirmingAutomatic] = useState(false);
	const { triggerRef, panelRef } = useInlineConfirmFocus(confirmingAutomatic);

	const workItOutHere = () =>
		onCommit({ ...link, datums: seedCarriedValues(required, parse) });
	const carryAutomatically = () => {
		const { datums: _dropped, ...rest } = link;
		onCommit(rest);
	};

	if (carry.kind === "nothing-needed" && !manual) {
		return (
			<p className="text-[14px] leading-relaxed text-nova-text-secondary">
				{nothingNeededCopy(link.target.type)}
			</p>
		);
	}

	const missing = required.filter(
		(datum) => !(link.datums ?? []).some((held) => held.name === datum.id),
	);

	return (
		<div className="space-y-4">
			{invalidManual && carry.kind !== "automatic" ? (
				<p className="text-[14px] leading-relaxed text-nova-text-secondary">
					{COMPLETE_SELECTION_NEEDS_FORM_LIST}
				</p>
			) : carry.kind === "manual-required" ? (
				<p className="text-[14px] leading-relaxed text-nova-text-secondary">
					This destination needs values this form can't supply on its own, so
					they're worked out here.
				</p>
			) : carry.kind === "automatic" && manualCarryUnavailable && !manual ? (
				<p className="text-[14px] leading-relaxed text-nova-text-secondary">
					{SEVERAL_CASES_CARRY_AUTOMATICALLY}
				</p>
			) : carry.kind === "automatic" ? (
				<fieldset className="grid gap-2 @sm:grid-cols-2">
					<legend className="sr-only">How the values travel</legend>
					<ChoiceCard
						title="Carry it automatically"
						details={carry.carried.map((entry) =>
							carriedAutomaticallyDetail(entry.sourceDatumId),
						)}
						checked={!manual}
						disabled={!canEdit}
						ref={triggerRef}
						onChoose={() => {
							if (manual) setConfirmingAutomatic(true);
						}}
					/>
					<ChoiceCard
						title="Work it out here"
						details={[
							invalidManual
								? SEVERAL_CASES_MANUAL_CARRY_NEEDS_REPAIR
								: "Give each value the destination needs yourself.",
						]}
						checked={manual}
						disabled={!canEdit || manualCarryUnavailable}
						onChoose={() => {
							if (!manual) workItOutHere();
						}}
					/>
				</fieldset>
			) : null}

			{confirmingAutomatic && (
				<div
					ref={panelRef}
					tabIndex={-1}
					className="space-y-3 rounded-xl border border-nova-amber/30 bg-nova-amber/[0.05] p-3 outline-none"
				>
					<p className="text-[13px] leading-relaxed text-nova-text-secondary">
						Carry it automatically instead? The values worked out here will be
						removed. You can undo this.
					</p>
					<div className="flex flex-wrap gap-2">
						<Button
							type="button"
							variant="ghost"
							onClick={() => setConfirmingAutomatic(false)}
						>
							Cancel
						</Button>
						<Button
							type="button"
							variant="warning"
							onClick={() => {
								carryAutomatically();
								setConfirmingAutomatic(false);
							}}
						>
							Carry it automatically
						</Button>
					</div>
				</div>
			)}

			{manual && manualCarry.ok ? (
				<div className="space-y-3">
					{(link.datums ?? []).map((datum) => (
						<CarriedValueRow
							key={datum.name}
							formUuid={formUuid}
							datum={datum}
							canEdit={canEdit}
							onSave={(xpath) =>
								onCommit({
									...link,
									datums: (link.datums ?? []).map((held) =>
										held.name === datum.name ? { ...held, xpath } : held,
									),
								})
							}
						/>
					))}
					{missing.length > 0 && canEdit && (
						<div className="space-y-2 rounded-xl border border-nova-amber/30 bg-nova-amber/[0.05] p-3">
							<p className="text-[13px] leading-relaxed text-nova-text-secondary">
								The destination now also needs{" "}
								{missing.map((datum) => `“${datum.id}”`).join(", ")}.
							</p>
							<Button
								type="button"
								variant="outline"
								onClick={() =>
									onCommit({
										...link,
										datums: [
											...(link.datums ?? []),
											...seedCarriedValues(missing, parse),
										],
									})
								}
							>
								Add the missing values
							</Button>
						</div>
					)}
				</div>
			) : (
				carry.kind === "manual-required" &&
				manualCarry.ok &&
				canEdit && (
					<Button type="button" variant="outline" onClick={workItOutHere}>
						Work it out here
					</Button>
				)
			)}
		</div>
	);
}

function ChoiceCard({
	title,
	details,
	checked,
	disabled,
	onChoose,
	ref,
}: {
	readonly title: string;
	readonly details: readonly string[];
	readonly checked: boolean;
	readonly disabled: boolean;
	readonly onChoose: () => void;
	readonly ref?: React.Ref<HTMLButtonElement>;
}) {
	return (
		<button
			ref={ref}
			type="button"
			aria-pressed={checked}
			disabled={disabled}
			onClick={onChoose}
			className={`nova-focusable-inset flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-(--disabled-opacity) ${
				checked
					? "border-nova-violet/40 bg-nova-violet/[0.08]"
					: "border-white/[0.08] bg-nova-deep/30 not-disabled:hover:border-nova-border-bright"
			}`}
		>
			<span
				aria-hidden="true"
				className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border ${
					checked
						? "border-nova-violet bg-nova-violet text-nova-void"
						: "border-white/[0.2]"
				}`}
			>
				{checked && <Icon icon={tablerCheck} width="11" height="11" />}
			</span>
			<span className="min-w-0 flex-1">
				<span className="block text-[14px] font-semibold text-nova-text">
					{title}
				</span>
				{details.map((detail) => (
					<span
						key={detail}
						className="mt-0.5 block break-words text-[13px] leading-relaxed text-nova-text-muted"
					>
						{detail}
					</span>
				))}
			</span>
		</button>
	);
}

function CarriedValueRow({
	formUuid,
	datum,
	canEdit,
	onSave,
}: {
	readonly formUuid: Uuid;
	readonly datum: FormLinkDatum;
	readonly canEdit: boolean;
	readonly onSave: (xpath: FormLinkDatum["xpath"]) => CommitOutcome;
}) {
	const docApi = useBlueprintDocApi();
	const parse = useParseXPathForForm(formUuid);
	const projection = useXPathProjection(datum.xpath);
	const untouched = projection.text.trim() === SEED_CARRIED_VALUE_TEXT;

	return (
		<div className="rounded-xl border border-white/[0.07] bg-nova-deep/30 p-3 @sm:p-4">
			<p className="mb-2 font-mono text-[13px] font-semibold text-nova-text">
				{datum.name}
			</p>
			<XPathField
				value={projection.text}
				onSave={
					canEdit
						? (text) => {
								if (text.trim().length === 0) {
									return { ok: false, messages: [EMPTY_CARRIED_VALUE_REFUSAL] };
								}
								const xpath = parse(text);
								if (readsForm(xpath)) {
									return { ok: false, messages: [SESSION_FORM_READ_MESSAGE] };
								}
								return onSave(xpath);
							}
						: undefined
				}
				getLintContext={() =>
					buildSessionLintContext(docApi.getState(), formUuid)
				}
			/>
			<p className="mt-2 text-[13px] leading-relaxed text-nova-text-muted">
				{untouched
					? `${CARRIED_VALUE_HINT}. It can read case properties and worker information.`
					: "Read after the form has closed: case properties and worker information, not the form's answers."}
			</p>
		</div>
	);
}
