// Full-width editor for Search conditions. The inspector names and summarizes
// these settings, while this canvas is their only editing surface. Keeping the
// recursive workbench here gives deep rules enough room without duplicating a
// second editor in the right rail.
//
// Four conditions share the canvas and differ only in their words and scope:
//
//   - a field's custom MATCH runs on the server per case (case-search dialect,
//     per-case scope);
//   - a field's REQUIRED condition and CHECK rule run on the Search screen
//     itself, before any case exists: every sibling answer is readable, case
//     data is not, and the device evaluates them (on-device dialect, global
//     scope with the module's inputs in reach);
//   - the Search button's availability runs on the case list with no search
//     answers loaded at all (on-device, global, no inputs).

"use client";

import { Icon } from "@iconify/react/offline";
import tablerArrowLeft from "@iconify-icons/tabler/arrow-left";
import { useEffect, useRef } from "react";
import { ContentFrame } from "@/components/builder/ContentFrame";
import type { CaseDataScope } from "@/components/builder/shared/editorSchemas";
import { PredicateWorkbench } from "@/components/builder/shared/PredicateWorkbench";
import type { EditorPath } from "@/components/builder/shared/path";
import type { EditorSearchInputDecl } from "@/components/builder/shared/searchInputPresentation";
import { Button } from "@/components/shadcn/button";
import type { CaseType, UserProperty } from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate";
import type { SearchConditionSlot } from "../workspaceSelection";

export type SearchConditionCanvasContext =
	| {
			readonly kind: "input";
			readonly label: string;
			/** Which of the field's conditions this canvas edits. */
			readonly slot: SearchConditionSlot;
	  }
	| { readonly kind: "search-button" };

export interface SearchConditionCanvasProps {
	readonly context: SearchConditionCanvasContext;
	readonly value: Predicate;
	readonly onChange: (next: Predicate) => void;
	readonly onBack: () => void;
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly knownInputs?: readonly EditorSearchInputDecl[];
	readonly userProperties?: readonly UserProperty[];
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

interface CanvasCopy {
	readonly title: string;
	readonly description: string;
	readonly sectionTitle: string;
	readonly evaluationTarget: "case-search" | "on-device";
	readonly caseDataScope: CaseDataScope;
	/** Set for the two slots the device evaluates with its Pattern engine. */
	readonly patternMatching?: true;
}

/** Every word and scope axis the canvas shows, derived from the context alone
 *  so the explanation cannot drift from what the editor admits. */
export function searchConditionCanvasCopy(
	context: SearchConditionCanvasContext,
): CanvasCopy {
	if (context.kind === "search-button") {
		return {
			title: "When Search is available",
			description: "Choose when the Search action can run",
			sectionTitle: "Search is available when",
			evaluationTarget: "on-device",
			caseDataScope: "global",
		};
	}
	switch (context.slot) {
		case "match":
			return {
				title: `Match cases for ${context.label}`,
				description:
					"Use the answer to this search field to decide which cases match",
				sectionTitle: "Cases match when",
				evaluationTarget: "case-search",
				caseDataScope: "per-case",
			};
		case "required":
			return {
				title: `Require ${context.label}`,
				description:
					"Decide when people must answer this field before they search. Other answers on the Search screen are available here; case information isn't, because no case has been chosen yet",
				sectionTitle: "An answer is required when",
				evaluationTarget: "on-device",
				caseDataScope: "global",
				patternMatching: true,
			};
		case "validation":
			return {
				title: `Check ${context.label}`,
				description:
					"Decide what an answer must satisfy before the search runs. The rule is checked only when the field has an answer, and other answers on the Search screen are available here",
				sectionTitle: "The answer passes when",
				evaluationTarget: "on-device",
				caseDataScope: "global",
				patternMatching: true,
			};
	}
}

export function SearchConditionCanvas({
	context,
	value,
	onChange,
	onBack,
	caseTypes,
	currentCaseType,
	knownInputs = [],
	userProperties = [],
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
	const copy = searchConditionCanvasCopy(context);

	return (
		<ContentFrame width="3xl" className="px-6 pb-24 pt-6">
			<Button
				ref={backRef}
				type="button"
				variant="ghost"
				onClick={onBack}
				data-inspector-return-focus
				aria-label={
					dependencyReview === undefined
						? undefined
						: `Back to ${dependencyReview.inputLabel} search field`
				}
				className="-ml-2 mb-5"
			>
				<Icon icon={tablerArrowLeft} width="16" height="16" />
				{dependencyReview === undefined ? "Back to Search" : "Back to field"}
			</Button>

			<header className="mb-7">
				<h1 className="font-display text-2xl font-semibold tracking-tighter text-nova-text">
					{copy.title}
				</h1>
				<p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-nova-text-muted">
					{copy.description}
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
						className="font-display tracking-tighter text-[17px] font-semibold text-nova-text"
					>
						{copy.sectionTitle}
					</h2>
				</div>

				<PredicateWorkbench
					value={value}
					onChange={onChange}
					caseTypes={caseTypes}
					currentCaseType={currentCaseType}
					knownInputs={knownInputs}
					userProperties={userProperties}
					evaluationTarget={copy.evaluationTarget}
					caseDataScope={copy.caseDataScope}
					patternMatching={copy.patternMatching}
					focusRequest={dependencyReview ?? focusRequest}
				/>
			</section>
		</ContentFrame>
	);
}
