// Full-width editor for Search conditions. The inspector names and summarizes
// these settings, while this canvas is their only editing surface. Keeping the
// recursive workbench here gives deep rules enough room without duplicating a
// second editor in the right rail.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerArrowLeft from "@iconify-icons/tabler/arrow-left";
import { useEffect, useRef } from "react";
import { ContentFrame } from "@/components/builder/ContentFrame";
import { PredicateWorkbench } from "@/components/builder/shared/PredicateWorkbench";
import type { EditorPath } from "@/components/builder/shared/path";
import type { EditorSearchInputDecl } from "@/components/builder/shared/searchInputPresentation";
import { Button } from "@/components/shadcn/button";
import type { CaseType } from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate";

export interface SearchConditionCanvasProps {
	readonly context:
		| { readonly kind: "input"; readonly label: string }
		| { readonly kind: "search-button" };
	readonly value: Predicate;
	readonly onChange: (next: Predicate) => void;
	readonly onBack: () => void;
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly knownInputs?: readonly EditorSearchInputDecl[];
	readonly dependencyReview?: {
		readonly token: number;
		readonly path: EditorPath;
		readonly inputLabel: string;
	};
	/** First creation enters the new condition itself. Existing-condition
	 * navigation keeps Back as the predictable initial target. */
	readonly focusRequest?: {
		readonly token: number;
		readonly path: EditorPath;
		readonly focusTarget?: "heading" | "first-control";
	};
}

export function SearchConditionCanvas({
	context,
	value,
	onChange,
	onBack,
	caseTypes,
	currentCaseType,
	knownInputs = [],
	dependencyReview,
	focusRequest,
}: SearchConditionCanvasProps) {
	const backRef = useRef<HTMLButtonElement>(null);
	const focusBackOnMountRef = useRef(
		dependencyReview === undefined && focusRequest === undefined,
	);
	useEffect(() => {
		if (focusBackOnMountRef.current) backRef.current?.focus();
	}, []);
	const inputCondition = context.kind === "input";
	const title = inputCondition
		? `Match cases for ${context.label}`
		: "When Search is available";
	const description = inputCondition
		? "Use the answer to this search field to decide which cases match"
		: "Choose when the Search action can run";
	const sectionTitle = inputCondition
		? "Cases match when"
		: "Search is available when";

	return (
		<ContentFrame width="3xl" className="px-6 pb-24 pt-6">
			<Button
				ref={backRef}
				type="button"
				variant="ghost"
				size="xl"
				onClick={onBack}
				data-inspector-return-focus
				aria-label={
					dependencyReview === undefined
						? undefined
						: `Back to ${dependencyReview.inputLabel} search field`
				}
				className="-ml-2 mb-5 text-nova-text-secondary"
			>
				<Icon icon={tablerArrowLeft} width="16" height="16" />
				{dependencyReview === undefined ? "Back to Search" : "Back to field"}
			</Button>

			<header className="mb-7">
				<h1 className="font-display text-2xl font-semibold tracking-tight text-nova-text">
					{title}
				</h1>
				<p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-nova-text-muted">
					{description}
				</p>
			</header>

			<section
				aria-labelledby="search-condition-heading"
				className="rounded-2xl border border-white/[0.08] bg-nova-surface/25 p-4 @sm:p-5"
			>
				{dependencyReview !== undefined ? (
					<p className="mb-4 rounded-xl border border-nova-violet/20 bg-nova-violet/[0.05] px-3 py-2.5 text-[13px] leading-relaxed text-nova-text-secondary">
						This condition uses the {dependencyReview.inputLabel} answer. Update
						or remove that answer, then return to the field.
					</p>
				) : null}
				<div className="mb-4">
					<h2
						id="search-condition-heading"
						className="font-display text-[17px] font-semibold text-nova-text"
					>
						{sectionTitle}
					</h2>
				</div>

				<PredicateWorkbench
					value={value}
					onChange={onChange}
					caseTypes={caseTypes}
					currentCaseType={currentCaseType}
					knownInputs={knownInputs}
					evaluationTarget={inputCondition ? "case-search" : "on-device"}
					focusRequest={dependencyReview ?? focusRequest}
				/>
			</section>
		</ContentFrame>
	);
}
