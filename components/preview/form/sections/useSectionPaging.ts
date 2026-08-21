/**
 * useSectionPaging: the running form's pager, on Android's rules.
 *
 * A sectioned form previews one page at a time. The page list comes from
 * the engine (`useSectionPages`: root sections plus whether each has
 * anything to show right now), the open page lives in the session
 * (`activeSectionByForm`, the slot the edit canvas also reads and writes so
 * a flip keeps the page), and this hook is the arbiter between them:
 *
 *   - **Which page is current.** The remembered page while it is visible;
 *     a page that just emptied re-anchors (`resolveCurrentPage`) and the
 *     re-anchored page is written back, so the slot never names a page
 *     nobody can see.
 *   - **Next validates, Back never does.** `goNext` runs
 *     `validateSection` on the current page; a failure refuses (the form's
 *     `role="alert"` channel) and reveals the first invalid question on
 *     that page; success turns the page, moves focus to the new heading,
 *     and announces "Section k of n" politely.
 *   - **A jump forward validates the pages between.** `goTo` checks every
 *     visible page from the current one up to (not including) the target,
 *     stopping at the first failure; a jump backward is Back.
 *   - **`showPage` turns without checking.** Submit routing (the earliest
 *     invalid page) and Clear form (the first page) use it.
 *
 * Enter never advances: the body is a `fieldset`, not a `form`, and the
 * pager binds no key handler.
 */
"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Uuid } from "@/lib/domain";
import type {
	InvalidFieldTarget,
	SectionPage,
} from "@/lib/preview/engine/formEngine";
import { useEngineController } from "@/lib/preview/hooks/useEngineController";
import { useSectionPages } from "@/lib/preview/hooks/useSectionPages";
import { useActiveSection, useSetActiveSection } from "@/lib/session/hooks";
import {
	pagesToValidate,
	resolveCurrentPage,
	visiblePages,
} from "./sectionPaging";

export interface SectionPagingArgs {
	readonly formUuid: Uuid | undefined;
	/** False outside a sectioned form in preview: the hook then stays
	 *  inert (no writes to the session, no current page). */
	readonly enabled: boolean;
	/** Reveal and focus an invalid question (FormScreen's reveal path). */
	readonly revealInvalid: (target: InvalidFieldTarget) => void;
	/** Say why the page did not turn (FormScreen's `role="alert"` node). */
	readonly refuse: (message: string) => void;
}

export interface SectionPaging {
	/** Whether the form is being paged at all (a sectioned form in preview). */
	readonly enabled: boolean;
	/** The pages a worker can see, in order. */
	readonly pages: ReadonlyArray<SectionPage>;
	readonly current: SectionPage | undefined;
	/** 0-based position of `current` among `pages`; -1 when none. */
	readonly index: number;
	readonly count: number;
	readonly canGoBack: boolean;
	readonly isLast: boolean;
	readonly goBack: () => void;
	readonly goNext: () => void;
	readonly goTo: (uuid: Uuid) => void;
	/** Turn to a page without validating anything (submit routing). */
	readonly showPage: (uuid: Uuid) => void;
	/** Turn to the first visible page without validating (Clear form). */
	readonly showFirst: () => void;
	/** The last user-driven page turn, for the polite status region: the
	 *  page and a nonce so the same page turned twice announces twice. */
	readonly announced: { readonly uuid: Uuid; readonly nonce: number } | null;
	/** Read-and-clear: true once after a user-driven page turn, so the new
	 *  page's heading takes focus when it mounts and not on first open. */
	readonly takeFocusOnMount: () => boolean;
}

const REFUSAL = "Review the highlighted question.";

export function useSectionPaging({
	formUuid,
	enabled,
	revealInvalid,
	refuse,
}: SectionPagingArgs): SectionPaging {
	const controller = useEngineController();
	const allPages = useSectionPages();
	const active = useActiveSection(formUuid ?? "");
	const setActive = useSetActiveSection();

	const pages = useMemo(
		() => (enabled ? visiblePages(allPages) : []),
		[enabled, allPages],
	);
	const current = useMemo(
		() => (enabled ? resolveCurrentPage(allPages, active) : undefined),
		[enabled, allPages, active],
	);
	const index = current === undefined ? -1 : pages.indexOf(current);
	const count = pages.length;

	/* Write the resolved page back whenever it differs from the slot: the
	 * first open (no memory yet) and every re-anchor after a page emptied. */
	useEffect(() => {
		if (!enabled || formUuid === undefined || current === undefined) return;
		if (current.uuid !== active) setActive(formUuid, current.uuid);
	}, [enabled, formUuid, current, active, setActive]);

	const [announced, setAnnounced] = useState<SectionPaging["announced"]>(null);
	const pendingFocusRef = useRef(false);
	const takeFocusOnMount = useCallback((): boolean => {
		const pending = pendingFocusRef.current;
		pendingFocusRef.current = false;
		return pending;
	}, []);

	const turnTo = useCallback(
		(page: SectionPage) => {
			if (formUuid === undefined) return;
			pendingFocusRef.current = true;
			setActive(formUuid, page.uuid);
			setAnnounced((previous) => ({
				uuid: page.uuid,
				nonce: (previous?.nonce ?? 0) + 1,
			}));
		},
		[formUuid, setActive],
	);

	const showPage = useCallback(
		(uuid: Uuid) => {
			if (formUuid === undefined) return;
			if (!pages.some((page) => page.uuid === uuid)) return;
			setActive(formUuid, uuid);
		},
		[formUuid, pages, setActive],
	);

	const showFirst = useCallback(() => {
		const first = pages[0];
		if (first !== undefined) showPage(first.uuid);
	}, [pages, showPage]);

	/** Validate one page; on failure refuse, turn to it if needed, reveal. */
	const pagePasses = useCallback(
		(page: SectionPage): boolean => {
			if (controller.validateSection(page.uuid)) return true;
			const target = controller.firstInvalidFieldTarget({
				withinSection: page.uuid,
			});
			refuse(REFUSAL);
			if (page.uuid !== current?.uuid) showPage(page.uuid);
			if (target !== undefined) revealInvalid(target);
			return false;
		},
		[controller, current?.uuid, refuse, revealInvalid, showPage],
	);

	const goNext = useCallback(() => {
		if (current === undefined) return;
		const next = pages[index + 1];
		if (next === undefined) return;
		if (!pagePasses(current)) return;
		turnTo(next);
	}, [current, pages, index, pagePasses, turnTo]);

	const goBack = useCallback(() => {
		if (current === undefined) return;
		const previous = pages[index - 1];
		if (previous === undefined) return;
		turnTo(previous);
	}, [current, pages, index, turnTo]);

	const goTo = useCallback(
		(uuid: Uuid) => {
			if (current === undefined || uuid === current.uuid) return;
			const target = pages.find((page) => page.uuid === uuid);
			if (target === undefined) return;
			for (const page of pagesToValidate(pages, current.uuid, uuid)) {
				if (!pagePasses(page)) return;
			}
			turnTo(target);
		},
		[current, pages, pagePasses, turnTo],
	);

	return {
		enabled,
		pages,
		current,
		index,
		count,
		canGoBack: index > 0,
		isLast: current === undefined || index === count - 1,
		goBack,
		goNext,
		goTo,
		showPage,
		showFirst,
		announced,
		takeFocusOnMount,
	};
}
