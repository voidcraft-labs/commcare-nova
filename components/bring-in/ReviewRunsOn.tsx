/**
 * Where workers use this app, in the review: one row for each declaration
 * the app's content really runs on, the preselected one chosen, and the lines
 * under the group that say why Nova chose it, what the first publish will
 * ask, which platform the app can't run on and that it can change later.
 *
 * Every row and every line is `bringInModel.ts`'s (`declarationRows`,
 * `declarationWhy`, `chosenDeclaration`): this draws them and dispatches the
 * answers a choice makes. Choosing asks nothing of the server.
 */
"use client";

import { type ReactElement, useId } from "react";
import { FieldLegend, FieldSet } from "@/components/shadcn/field";
import { RadioGroup, RadioGroupItem } from "@/components/shadcn/radio-group";
import type { ReadingReview } from "@/lib/deployment";
import { REVIEW_RUNS_ON_SECTION } from "@/lib/publish/bringInCopy";
import {
	chosenDeclaration,
	declarationRows,
	declarationWhy,
	type ReviewAnswers,
} from "./bringInModel";

export function ReviewRunsOn({
	review,
	answers,
	onAnswers,
}: {
	readonly review: ReadingReview;
	readonly answers: ReviewAnswers;
	/** The answers with the chosen row's declaration. */
	readonly onAnswers: (answers: ReviewAnswers) => void;
}): ReactElement {
	const rows = declarationRows(review);
	const declaration = chosenDeclaration(review, answers);
	const chosen = rows.findIndex((row) => row.choice === declaration);
	const why = declarationWhy(review, answers);
	const headingId = useId();

	return (
		<FieldSet className="gap-3" data-review-runs-on>
			<FieldLegend className="mb-0 text-base font-semibold text-nova-text">
				<h2 id={headingId}>{REVIEW_RUNS_ON_SECTION}</h2>
			</FieldLegend>
			<RadioGroup<number>
				aria-labelledby={headingId}
				value={chosen}
				onValueChange={(index) => {
					const row = rows[index];
					if (row === undefined) return;
					onAnswers({
						...answers,
						runsOnlyOn: row.choice.runsOnlyOn,
						splitDatetime: row.choice.splitDatetime,
					});
				}}
			>
				{rows.map((row, index) => (
					<RadioGroupItem<number>
						key={`${row.choice.runsOnlyOn ?? "both"}-${row.choice.splitDatetime}`}
						value={index}
						description={
							<>
								<span className="block">{row.line}</span>
								{row.splitLine !== null ? (
									<span className="mt-0.5 block">{row.splitLine}</span>
								) : null}
							</>
						}
					>
						{row.label}
					</RadioGroupItem>
				))}
			</RadioGroup>
			<div className="flex flex-col gap-2 text-[13px] leading-relaxed text-nova-text-secondary">
				<p>{why.why}</p>
				{why.firstPublishAsks !== null ? <p>{why.firstPublishAsks}</p> : null}
				{why.cannotRun.map((block) => (
					<div key={`${block.lead ?? ""}${block.files ?? ""}`}>
						{block.lead !== null ? <p>{block.lead}</p> : null}
						{block.features.length > 0 ? (
							<ul className="mt-1 flex list-disc flex-col gap-0.5 pl-5">
								{block.features.map((feature) => (
									<li key={feature}>{feature}</li>
								))}
							</ul>
						) : null}
						{block.files !== null ? (
							<p className={block.lead !== null ? "mt-1" : undefined}>
								{block.files}
							</p>
						) : null}
					</div>
				))}
				<p>{why.later}</p>
			</div>
		</FieldSet>
	);
}
