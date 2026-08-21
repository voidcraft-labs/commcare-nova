/**
 * SectionStepper: where the worker is in a sectioned form, and the way to a
 * page that is not the next one.
 *
 * A `nav` of one step per visible page, the current one marked
 * `aria-current="step"`; choosing a later step validates every page on the
 * way (`goTo`), choosing an earlier one just goes. Beside it a polite status
 * region says "Section k of n: title" after every user-driven page turn, so
 * a screen-reader user hears where they landed without the heading having
 * to be re-read. The strip never wraps and never truncates a title: a form
 * with more pages than fit scrolls sideways.
 */
"use client";
import { useLocalizedField } from "@/components/builder/localization/BuilderLocalizationProvider";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import type { Uuid } from "@/lib/domain";
import { proseTemplateIsEmpty } from "@/lib/domain/prose";
import { selectableSegmentCls } from "@/lib/styles";
import { sectionKicker } from "./SectionHeading";
import type { SectionPaging } from "./useSectionPaging";

/** The page's title as the worker sees it, or `undefined` when untitled. */
function useSectionTitle(uuid: Uuid): string | undefined {
	const field = useLocalizedField(uuid);
	const projectProse = useProseProjection();
	if (field?.kind !== "section" || field.label === undefined) return undefined;
	if (proseTemplateIsEmpty(field.label)) return undefined;
	const text = projectProse(field.label).trim();
	return text === "" ? undefined : text;
}

function SectionStep({
	uuid,
	index,
	count,
	selected,
	disabled,
	onSelect,
}: {
	readonly uuid: Uuid;
	readonly index: number;
	readonly count: number;
	readonly selected: boolean;
	readonly disabled: boolean;
	readonly onSelect: () => void;
}) {
	const title = useSectionTitle(uuid);
	return (
		<button
			type="button"
			aria-current={selected ? "step" : undefined}
			disabled={disabled}
			onClick={onSelect}
			className={selectableSegmentCls(selected)}
		>
			<span
				aria-hidden="true"
				className="flex size-6 shrink-0 items-center justify-center rounded-full border border-current text-xs tabular-nums"
			>
				{index + 1}
			</span>
			<span className="sr-only">{sectionKicker(index, count)}</span>
			{title !== undefined ? <span>{title}</span> : null}
		</button>
	);
}

function TurnAnnouncement({
	uuid,
	index,
	count,
}: {
	readonly uuid: Uuid;
	readonly index: number;
	readonly count: number;
}) {
	const title = useSectionTitle(uuid);
	const kicker = sectionKicker(index, count);
	return <>{title === undefined ? kicker : `${kicker}: ${title}`}</>;
}

export function SectionStepper({
	paging,
	disabled = false,
}: {
	readonly paging: SectionPaging;
	/** True while a submission or a clear is running: the pages stay where
	 *  they are until the answer surface is live again. */
	readonly disabled?: boolean;
}) {
	const announcedIndex =
		paging.announced === null
			? -1
			: paging.pages.findIndex((page) => page.uuid === paging.announced?.uuid);
	return (
		<nav aria-label="Sections" className="px-6 pt-3">
			<ol className="flex gap-1 overflow-x-auto">
				{paging.pages.map((page, index) => (
					<li key={page.uuid} className="shrink-0">
						<SectionStep
							uuid={page.uuid}
							index={index}
							count={paging.count}
							selected={index === paging.index}
							disabled={disabled}
							onSelect={() => paging.goTo(page.uuid)}
						/>
					</li>
				))}
			</ol>
			<p role="status" className="sr-only">
				{paging.announced !== null && announcedIndex !== -1 ? (
					<TurnAnnouncement
						key={paging.announced.nonce}
						uuid={paging.announced.uuid}
						index={announcedIndex}
						count={paging.count}
					/>
				) : null}
			</p>
		</nav>
	);
}
