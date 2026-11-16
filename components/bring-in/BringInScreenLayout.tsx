/**
 * The frame every screen of the bring-in flow stands in: a heading region, a
 * scrolling middle, and a footer that does not scroll. The flow takes the
 * chat card's place on `/build/new`, so the card's bounded height is the
 * frame's: only the middle scrolls, and the actions stay in reach however
 * long an account or a review runs.
 *
 * The screen is a `section` labelled by its heading, which is the one `h1` of
 * the centred column and takes focus when the screen appears (a deferred
 * handoff: a control the person already chose keeps focus). Above the heading
 * stands one `role="status"` region, so progress, a create's lead and a
 * confirmation are each said once. Where the card is under 560px
 * wide the footer's buttons stack, primary first, each at its one 44px
 * height.
 *
 * A live region announces only what changes inside it after it is in the
 * document, and a create's lead arrives together with a new screen. So inside
 * the flow the region is the flow's own, mounted once above every screen
 * (`BringInStatusRegion`), and each screen renders what it says into it: the
 * lead of a screen that has just appeared is then a change to a region that
 * was already there. Outside the flow, the frame holds a region of its own.
 *
 * It holds no decision: what each region says is its screen's.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerInfoCircle from "@iconify-icons/tabler/info-circle";
import { motion } from "motion/react";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import {
	type BringInModel,
	createLeadLine,
} from "@/components/bring-in/bringInModel";
import { useDeferredFocus } from "@/lib/ui/hooks/useDeferredFocus";

/** The lead of a create that did not create, as the model holds it. */
export type BringInLead = BringInModel["lead"];

/**
 * The flow's status region, once it is in the document. Null outside the
 * flow, where a frame holds a region of its own.
 */
const StatusRegionContext = createContext<{
	readonly element: HTMLElement | null;
} | null>(null);

/**
 * The one status region of the flow: it stands above the screen and stays
 * mounted while the screens beneath it change, so what each new screen
 * renders into it is announced. `children` is the screen.
 */
export function BringInStatusRegion({
	children,
}: {
	readonly children: ReactNode;
}) {
	const [element, setElement] = useState<HTMLElement | null>(null);
	return (
		<StatusRegionContext.Provider value={{ element }}>
			<div
				role="status"
				ref={setElement}
				className="shrink-0 px-5 sm:px-6"
				data-bring-in-status=""
			/>
			{children}
		</StatusRegionContext.Provider>
	);
}

export function BringInScreenLayout({
	title,
	icon = null,
	lead = null,
	status,
	description,
	children,
	footer,
	footerNote,
	focusKey,
}: {
	/** The screen's `h1`. */
	readonly title: ReactNode;
	/** `info`: the amber mark of a stop, an account or a failure Nova owns. */
	readonly icon?: "info" | null;
	/** A create's lead, drawn first in the status region. */
	readonly lead?: BringInLead;
	/** Progress the screen announces, in the same status region. */
	readonly status?: ReactNode;
	/** The lines under the heading. */
	readonly description?: ReactNode;
	/** The scrolling middle. */
	readonly children?: ReactNode;
	/** The actions, primary first. */
	readonly footer?: ReactNode;
	/** A quiet line beside the actions. */
	readonly footerNote?: ReactNode;
	/** A value whose change moves focus to the heading again, as a new screen would. */
	readonly focusKey?: string;
}) {
	const headingId = useId();
	const headingRef = useRef<HTMLHeadingElement>(null);
	const deferFocus = useDeferredFocus();
	// biome-ignore lint/correctness/useExhaustiveDependencies: focusKey is the dependency on purpose, the screen's heading takes focus again when it changes.
	useEffect(
		() => deferFocus(() => headingRef.current?.focus({ preventScroll: true })),
		[deferFocus, focusKey],
	);
	const region = useContext(StatusRegionContext);
	const leadLine = lead === null ? null : createLeadLine(lead);
	const said = (
		<>
			{leadLine !== null ? (
				<p className="mb-3 text-sm leading-relaxed text-nova-text-secondary">
					{leadLine}
				</p>
			) : null}
			{status}
		</>
	);
	return (
		<motion.section
			aria-labelledby={headingId}
			initial={{ opacity: 0, y: 6 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
			className="@container flex min-h-0 flex-auto flex-col"
		>
			<div className="shrink-0 px-5 pb-3 sm:px-6">
				{region === null ? (
					/* Always rendered, empty or not: a live region announces only
					 * the changes made after it is in the document. */
					<div role="status" className="pt-5">
						{said}
					</div>
				) : region.element !== null ? (
					/* The flow's region stands above this section; the top inset
					 * travels with what is said, so the heading sits where it would
					 * under a region of its own. */
					createPortal(<div className="pt-5">{said}</div>, region.element)
				) : (
					<div className="pt-5" />
				)}
				<div className="flex items-start gap-3">
					{icon === "info" ? (
						<Icon
							icon={tablerInfoCircle}
							className="mt-1 size-5 shrink-0 text-nova-amber"
							aria-hidden="true"
						/>
					) : null}
					<h1
						id={headingId}
						ref={headingRef}
						tabIndex={-1}
						className="min-w-0 text-xl font-semibold text-nova-text outline-none [overflow-wrap:anywhere]"
					>
						{title}
					</h1>
				</div>
				{description !== undefined ? (
					<div
						className={`mt-1.5 text-sm leading-relaxed text-nova-text-secondary [overflow-wrap:anywhere] ${icon === "info" ? "pl-8" : ""}`}
					>
						{description}
					</div>
				) : null}
			</div>
			<div className="min-h-0 flex-auto overflow-y-auto px-5 pb-6 sm:px-6">
				{children}
			</div>
			{footer !== undefined || footerNote !== undefined ? (
				<div className="flex shrink-0 flex-col gap-3 border-t border-nova-border px-5 py-3 sm:px-6 @min-[35rem]:flex-row @min-[35rem]:items-center">
					{footerNote !== undefined ? (
						<p className="text-xs leading-relaxed text-nova-text-muted @min-[35rem]:min-w-0 @min-[35rem]:flex-1">
							{footerNote}
						</p>
					) : null}
					<div className="flex flex-col gap-2 @min-[35rem]:ml-auto @min-[35rem]:flex-row-reverse @min-[35rem]:flex-wrap [&>*]:w-full @min-[35rem]:[&>*]:w-auto">
						{footer}
					</div>
				</div>
			) : null}
		</motion.section>
	);
}
