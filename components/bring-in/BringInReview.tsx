/**
 * The review: what bringing an app in will create, before anything is
 * created. The app's name, where workers use it, the lookup tables, places
 * and files that come with it, what stays as it is in CommCare HQ, what
 * happens after it's in, and what the first publish changes, then one button.
 * Only a table that meets one the Project already has asks a choice; where
 * the app runs is chosen for the person and theirs to change.
 *
 * Every line and every rule is `bringInModel.ts`'s: this draws them,
 * dispatches the answers each control makes and, on Bring it in, what
 * `reviewPress` says the press does.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerInfoCircle from "@iconify-icons/tabler/info-circle";
import {
	type ReactElement,
	type ReactNode,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { keptDateText } from "@/components/builder/keptListModel";
import { Button } from "@/components/shadcn/button";
import { Field, FieldError, FieldLabel } from "@/components/shadcn/field";
import { Input } from "@/components/shadcn/input";
import type { ReadingKey } from "@/lib/deployment";
import {
	ANOTHER_SPACE_NEW_APP_LINE,
	BRING_IN_ACTIONS,
	REVIEW_AFTER_DRIFT_LINE,
	REVIEW_AFTER_SECTION,
	REVIEW_APP_NAME_LABEL,
	REVIEW_APP_SECTION,
	REVIEW_CASE_TYPES_LEAD,
	REVIEW_LEAD,
	REVIEW_MEDIA_SECTION,
	REVIEW_NAME_NONE_IN_HQ,
	REVIEW_PLACES_SECTION,
	REVIEW_STAYS_SECTION,
	REVIEW_TABLES_SECTION,
	reviewAfterPublishLine,
	reviewHeading,
	reviewProjectLine,
	reviewTablesProjectLine,
} from "@/lib/publish/bringInCopy";
import {
	type CircumstanceContext,
	circumstanceBlock,
} from "@/lib/publish/hqFindingCopy";
import { READING_REFUSAL_COPY } from "@/lib/publish/hqReadingCopy";
import {
	KEPT_FOLLOWS_LINE,
	KEPT_LABELS,
	keptLead,
} from "@/lib/publish/keptValues";
import { bringInHref } from "@/lib/routing/bringInLocation";
import { pushBuilderHistory } from "@/lib/routing/useClientPath";
import { useDeferredFocus } from "@/lib/ui/hooks/useDeferredFocus";
import { BringInScreenLayout } from "./BringInScreenLayout";
import {
	APP_NAME_MAX_LENGTH,
	type BringInEvent,
	type BringInModel,
	chosenDeclaration,
	knownAppName,
	type ReviewAnswer,
	type ReviewAnswers,
	recordedFeaturesLine,
	reviewCounts,
	reviewMediaLines,
	reviewPlacesLine,
	reviewPress,
	reviewRefusalAt,
	reviewTablesView,
	type SentencePart,
} from "./bringInModel";
import { FirstPublishLines } from "./FirstPublishLines";
import { ReviewRunsOn } from "./ReviewRunsOn";
import { ReviewTableChoice } from "./ReviewTableChoice";

/** The picker, where "Choose another app" and "Choose another Project" both lead. */
function chooseAgain(): void {
	pushBuilderHistory(bringInHref({ kind: "choose" }));
}

function ReviewSection({
	heading,
	children,
}: {
	readonly heading: string;
	readonly children: ReactNode;
}): ReactElement {
	const headingId = useId();
	return (
		<section aria-labelledby={headingId} className="flex flex-col gap-2">
			<h2 id={headingId} className="text-base font-semibold text-nova-text">
				{heading}
			</h2>
			{children}
		</section>
	);
}

/** A held stop's block: what to clear before pressing Bring it in again. */
function HeldBlock({
	block,
}: {
	readonly block: ReturnType<typeof circumstanceBlock>;
}): ReactElement {
	return (
		<div className="mb-3 rounded-xl border border-nova-amber/20 bg-nova-amber/[0.06] p-4">
			<div className="flex items-start gap-3">
				<Icon
					icon={tablerInfoCircle}
					className="mt-0.5 size-5 shrink-0 text-nova-amber"
					aria-hidden="true"
				/>
				<div className="min-w-0 text-sm leading-relaxed">
					<p className="font-semibold text-nova-text">{block.title}</p>
					<p className="mt-1 text-nova-text-secondary">{block.body}</p>
					<p className="mt-1 text-nova-text-secondary">{block.next}</p>
				</div>
			</div>
		</div>
	);
}

/** A sentence whose names are set in monospace, each part keyed by where it starts. */
function SentenceParts({
	parts,
}: {
	readonly parts: readonly SentencePart[];
}): ReactElement {
	let start = 0;
	return (
		<>
			{parts.map((part) => {
				const key = start;
				start += part.text.length;
				return part.mono ? (
					<span key={key} className="font-mono text-nova-text">
						{part.text}
					</span>
				) : (
					<span key={key}>{part.text}</span>
				);
			})}
		</>
	);
}

export function BringInReview({
	model,
	readingKey,
	answer,
	answers,
	project,
	context,
	dispatch,
}: {
	/** The flow's model: the lead, the held stop, the refusal and the choice Bring it in found unanswered. */
	readonly model: BringInModel;
	/** The app's address: the key the create is sent for. */
	readonly readingKey: ReadingKey;
	/** The `review` screen's answer and answers (`screenOf`). */
	readonly answer: ReviewAnswer;
	readonly answers: ReviewAnswers;
	/** The Project the address adds the app to (`reviewProjectOf`). */
	readonly project: { readonly name: string; readonly personal: boolean };
	/** What a held stop's block is filled from (`circumstanceContextOf`). */
	readonly context: CircumstanceContext;
	readonly dispatch: (event: BringInEvent) => void;
}): ReactElement {
	const { review } = answer;
	const { domain } = readingKey;
	const nameId = useId();
	const nameErrorId = useId();
	const nameRef = useRef<HTMLInputElement>(null);
	const focusLater = useDeferredFocus();
	const [namePressed, setNamePressed] = useState(false);

	const held =
		model.held === null ? null : circumstanceBlock(model.held, context);
	const refusalAt = reviewRefusalAt(model.refusal);
	const nameError =
		namePressed || refusalAt === "name"
			? review.appName.trim() === ""
				? REVIEW_NAME_NONE_IN_HQ
				: READING_REFUSAL_COPY.name_missing
			: null;
	const footerRefusal =
		refusalAt === "footer" && model.refusal !== null
			? READING_REFUSAL_COPY[model.refusal]
			: null;

	const tables = reviewTablesView(review, project.name, domain);
	const places = reviewPlacesLine(review, domain);
	const media = reviewMediaLines(review, project.name);
	const chosen = chosenDeclaration(review, answers);
	const recorded = recordedFeaturesLine(chosen, domain);
	const readOn = keptDateText(review.readAt, new Date());

	/* A create refused for the name sends focus to the field, as a press does. */
	useEffect(() => {
		if (refusalAt !== "name") return;
		return focusLater(() => nameRef.current?.focus());
	}, [refusalAt, focusLater]);

	const setAnswers = (next: ReviewAnswers) =>
		dispatch({ type: "answers", answers: next });

	const bringItIn = () => {
		const press = reviewPress(readingKey, answer, answers);
		switch (press.kind) {
			case "name":
				setNamePressed(true);
				focusLater(() => nameRef.current?.focus());
				return;
			case "choice":
				dispatch({ type: "choice-needed", tag: press.tag });
				return;
			case "create":
				dispatch({ type: "create-asked", input: press.input });
				return;
		}
	};

	return (
		<BringInScreenLayout
			title={reviewHeading(knownAppName(model))}
			lead={model.lead}
			status={held !== null ? <HeldBlock block={held} /> : undefined}
			description={REVIEW_LEAD}
			focusKey={`${answer.reviewDigest}|${model.lead?.kind ?? ""}|${model.held?.code ?? ""}`}
			footer={
				<>
					<Button onClick={bringItIn}>{BRING_IN_ACTIONS.bringItIn}</Button>
					<Button variant="outline" onClick={chooseAgain}>
						{BRING_IN_ACTIONS.chooseAnotherApp}
					</Button>
				</>
			}
			footerNote={
				footerRefusal !== null ? (
					<span role="alert" className="text-sm text-nova-text">
						{footerRefusal}
					</span>
				) : undefined
			}
		>
			<div className="mt-3 flex flex-col gap-7" data-bring-in-screen="review">
				<ReviewSection heading={REVIEW_APP_SECTION}>
					<Field>
						<FieldLabel htmlFor={nameId}>{REVIEW_APP_NAME_LABEL}</FieldLabel>
						<Input
							ref={nameRef}
							id={nameId}
							value={answers.appName}
							maxLength={APP_NAME_MAX_LENGTH}
							autoComplete="off"
							data-1p-ignore
							aria-invalid={nameError !== null || undefined}
							aria-describedby={nameError !== null ? nameErrorId : undefined}
							onChange={(event) => {
								setNamePressed(false);
								setAnswers({ ...answers, appName: event.target.value });
							}}
						/>
						{nameError !== null ? (
							<FieldError id={nameErrorId}>{nameError}</FieldError>
						) : null}
					</Field>
					<p className="text-sm text-nova-text-secondary">
						{reviewCounts(review)}
					</p>
					{review.creates.caseTypes.length > 0 ? (
						<p className="text-sm text-nova-text-secondary [overflow-wrap:anywhere]">
							{REVIEW_CASE_TYPES_LEAD}{" "}
							{review.creates.caseTypes.map((name, index) => (
								<span key={name}>
									{index > 0 ? ", " : null}
									<span className="font-mono text-nova-text">{name}</span>
								</span>
							))}
						</p>
					) : null}
					<p className="text-sm leading-relaxed text-nova-text-secondary">
						{reviewProjectLine(project)}
					</p>
					{tables !== null ? (
						<p className="text-sm leading-relaxed text-nova-text-secondary">
							{reviewTablesProjectLine(project.name)}
						</p>
					) : null}
				</ReviewSection>

				<ReviewRunsOn
					review={review}
					answers={answers}
					onAnswers={setAnswers}
				/>

				{tables !== null ? (
					<ReviewSection heading={REVIEW_TABLES_SECTION}>
						{tables.managed !== null ? (
							<p className="text-sm leading-relaxed text-nova-text-secondary [overflow-wrap:anywhere]">
								<SentenceParts parts={tables.managed} />
							</p>
						) : null}
						{tables.sameEqual.map((line) => (
							<p
								key={line}
								className="text-sm leading-relaxed text-nova-text-secondary [overflow-wrap:anywhere]"
							>
								{line}
							</p>
						))}
						{tables.choices.map((table) => (
							<ReviewTableChoice
								key={table.tag}
								table={table}
								project={project.name}
								domain={domain}
								value={answers.tableChoices[table.tag] ?? null}
								onValueChange={(choice) =>
									setAnswers({
										...answers,
										tableChoices: {
											...answers.tableChoices,
											[table.tag]: choice,
										},
									})
								}
								needsChoice={
									model.needsChoice?.tag === table.tag
										? model.needsChoice
										: null
								}
								onChooseAnotherProject={chooseAgain}
							/>
						))}
					</ReviewSection>
				) : null}

				{places !== null ? (
					<ReviewSection heading={REVIEW_PLACES_SECTION}>
						<p className="text-sm leading-relaxed text-nova-text-secondary">
							{places}
						</p>
					</ReviewSection>
				) : null}

				{media.length > 0 ? (
					<ReviewSection heading={REVIEW_MEDIA_SECTION}>
						{media.map((line) => (
							<p
								key={line}
								className="text-sm leading-relaxed text-nova-text-secondary"
							>
								{line}
							</p>
						))}
					</ReviewSection>
				) : null}

				<ReviewSection heading={REVIEW_STAYS_SECTION}>
					<p className="text-sm leading-relaxed text-nova-text-secondary">
						{keptLead(readOn, review.kept.length > 0)}
					</p>
					{review.kept.length > 0 ? (
						<ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-nova-text-secondary">
							{review.kept.map((id) => (
								<li key={id}>{KEPT_LABELS[id]}</li>
							))}
						</ul>
					) : null}
					<p className="text-sm leading-relaxed text-nova-text-secondary">
						{KEPT_FOLLOWS_LINE}
					</p>
				</ReviewSection>

				<ReviewSection heading={REVIEW_AFTER_SECTION}>
					<p className="text-sm leading-relaxed text-nova-text-secondary">
						{reviewAfterPublishLine(domain)}
					</p>
					<p className="text-sm leading-relaxed text-nova-text-secondary">
						{REVIEW_AFTER_DRIFT_LINE}
					</p>
					<p className="text-sm leading-relaxed text-nova-text-secondary">
						{ANOTHER_SPACE_NEW_APP_LINE}
					</p>
					{recorded !== null ? (
						<p className="text-sm leading-relaxed text-nova-text-secondary">
							{recorded}
						</p>
					) : null}
				</ReviewSection>

				<FirstPublishLines view={chosen.firstPublish} surface="review" />
				{chosen.removesFiles && (
					<ul className="list-disc space-y-1 pl-5 text-sm text-nova-text-secondary">
						{chosen.removesFiles.map((line) => (
							<li key={line}>{line}</li>
						))}
					</ul>
				)}
			</div>
		</BringInScreenLayout>
	);
}
