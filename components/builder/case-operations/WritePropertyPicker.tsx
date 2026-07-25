// components/builder/case-operations/WritePropertyPicker.tsx
//
// Which case property a change saves onto.
//
// Chooser-first, like every other add affordance in the builder: pick
// the property, and the row lands already holding a value of that
// property's own type. A brand-new property is allowed here — the
// commit batch declares it in the catalog alongside the write
// (`caseOperationCatalogMutations`) — but the name is adjudicated
// inline, so an illegal or already-saved one is refused before the
// gesture rather than after it.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerDatabase from "@iconify-icons/tabler/database";
import tablerPlus from "@iconify-icons/tabler/plus";
import { useId, useMemo, useState } from "react";
import { Button } from "@/components/shadcn/button";
import { FieldError } from "@/components/shadcn/field";
import { Input } from "@/components/shadcn/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/shadcn/popover";
import { useEffectiveCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import {
	caseOperationWritePropertyVerdict,
	isReservedCaseOperationProperty,
} from "@/lib/doc/identifierVerdicts";
import { humanizeId, slugifyId } from "@/lib/domain";

export function WritePropertyPicker({
	caseTypeName,
	alreadyWritten,
	onChoose,
}: {
	readonly caseTypeName: string;
	readonly alreadyWritten: ReadonlySet<string>;
	readonly onChoose: (property: string) => void;
}) {
	const caseTypes = useEffectiveCaseTypes();
	const [open, setOpen] = useState(false);
	const [draft, setDraft] = useState("");
	const inputId = useId();
	const errorId = `${inputId}-error`;

	const available = useMemo(() => {
		const caseType = caseTypes.find(
			(candidate) => candidate.name === caseTypeName,
		);
		return (caseType?.properties ?? []).filter(
			(property) =>
				!alreadyWritten.has(property.name) &&
				!isReservedCaseOperationProperty(property.name),
		);
	}, [caseTypes, caseTypeName, alreadyWritten]);

	const candidate = slugifyId(draft, "");
	const verdict = caseOperationWritePropertyVerdict(candidate, alreadyWritten);
	const showError = draft.trim().length > 0 && !verdict.ok;

	const choose = (property: string) => {
		setOpen(false);
		setDraft("");
		onChoose(property);
	};

	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) setDraft("");
			}}
		>
			<PopoverTrigger
				render={
					<Button
						type="button"
						variant="outline"
						size="xl"
						data-case-operation-add-write
						className="min-h-11 w-full gap-2 rounded-lg border-dashed border-nova-border-bright bg-transparent px-4 text-sm text-nova-violet-bright not-disabled:hover:bg-nova-violet/[0.06] dark:bg-transparent dark:not-disabled:hover:bg-nova-violet/[0.06]"
					/>
				}
			>
				<Icon icon={tablerPlus} width="14" height="14" />
				<span className="flex-1 text-left">Save a value</span>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-[22rem] p-2">
				<p className="px-1 pt-1 pb-2 text-[13px] leading-relaxed text-nova-text-secondary">
					Which property on the {caseTypeName} case?
				</p>
				<div className="max-h-64 space-y-1 overflow-y-auto">
					{available.map((property) => (
						<Button
							key={property.name}
							type="button"
							variant="ghost"
							size="xl"
							onClick={() => choose(property.name)}
							className="h-auto min-h-11 w-full justify-start gap-2 rounded-lg px-3 py-2.5 text-left whitespace-normal"
						>
							<Icon
								icon={tablerDatabase}
								width="14"
								height="14"
								className="shrink-0 text-nova-text-muted"
							/>
							<span className="min-w-0 flex-1 break-words text-sm text-nova-text">
								{humanizeId(property.name)}
							</span>
						</Button>
					))}
					{available.length === 0 && (
						<p className="px-3 py-2 text-[13px] leading-relaxed text-nova-text-muted">
							This change already saves every property on {caseTypeName}. Add a
							new one below.
						</p>
					)}
				</div>
				<div className="mt-2 space-y-2 border-t border-white/[0.06] px-1 pt-3">
					<label
						htmlFor={inputId}
						className="block text-[13px] font-medium text-nova-text-secondary"
					>
						Or save something new
					</label>
					<Input
						id={inputId}
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
						placeholder="visit_outcome"
						autoComplete="off"
						data-1p-ignore
						aria-invalid={showError || undefined}
						aria-describedby={showError ? errorId : undefined}
					/>
					{showError && !verdict.ok && (
						<FieldError id={errorId} className="text-[13px] text-nova-rose">
							{verdict.userMessage}
						</FieldError>
					)}
					<Button
						type="button"
						variant="outline"
						size="xl"
						disabled={!verdict.ok}
						onClick={() => choose(candidate)}
						className="w-full"
					>
						Save this property
					</Button>
				</div>
			</PopoverContent>
		</Popover>
	);
}
