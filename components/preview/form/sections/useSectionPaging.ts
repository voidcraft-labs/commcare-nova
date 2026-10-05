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
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { Uuid } from "@/lib/domain";
import type {
	InvalidFieldTarget,
	SectionPage,
} from "@/lib/preview/engine/formEngine";
import {
	availablePages,
	pagesToValidate,
	resolveCurrentPage,
} from "@/lib/preview/engine/sectionPaging";
import { useEngineController } from "@/lib/preview/hooks/useEngineController";
import { useEngineEntry } from "@/lib/preview/hooks/useEngineEntry";
import { useSectionPages } from "@/lib/preview/hooks/useSectionPages";
import {
	useActiveSection,
	useGetActiveSection,
	useSetActiveSection,
} from "@/lib/session/hooks";

export interface SectionPagingArgs {
	readonly formUuid: Uuid | undefined;
	/** False outside a sectioned form in preview: the hook then stays
	 *  inert (no writes to the session, no current page). */
	readonly enabled: boolean;
	/** Reveal and focus an invalid question (FormScreen's reveal path). */
	readonly revealInvalid: (target: InvalidFieldTarget) => void;
	/** Announce an invalid page through FormScreen's localized alert intent. */
	readonly refuse: () => void;
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
	readonly goBack: () => Promise<void>;
	readonly goNext: () => Promise<void>;
	readonly goTo: (uuid: Uuid) => Promise<void>;
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

export function useSectionPaging({
	formUuid,
	enabled,
	revealInvalid,
	refuse,
}: SectionPagingArgs): SectionPaging {
	const controller = useEngineController();
	const allPages = useSectionPages();
	/* The engine is one per builder session and activates a form after its
	 * screen mounts, so `enabled` alone would page this form with another
	 * form's pages (opening form B while A's engine still runs) or show
	 * the no-pages state before activation. Everything below keys on the
	 * engine actually running THIS form. */
	const entry = useEngineEntry();
	const engineFormUuid = entry.formUuid;
	const live = enabled && formUuid !== undefined && engineFormUuid === formUuid;
	const active = useActiveSection(formUuid ?? "");
	const readActive = useGetActiveSection();
	const setActive = useSetActiveSection();

	const pages = useMemo(
		() => (live ? availablePages(allPages) : []),
		[live, allPages],
	);
	const current = useMemo(
		() => (live ? resolveCurrentPage(allPages, active) : undefined),
		[live, allPages, active],
	);
	const index = current === undefined ? -1 : pages.indexOf(current);
	const count = pages.length;

	/* Write the resolved page back whenever the slot names a page nobody
	 * can see: the first open (no memory yet) and every re-anchor after a
	 * page emptied. Resolve against the slot's LIVE value, never this
	 * render's: on a flip the edit canvas's unmount cleanup writes the
	 * page it was showing in the same commit this effect runs, and the
	 * render-time closure would overwrite that page with the first one. */
	useEffect(() => {
		if (!live || formUuid === undefined) return;
		const remembered = readActive(formUuid);
		const resolved = resolveCurrentPage(allPages, remembered);
		if (resolved !== undefined && resolved.uuid !== remembered) {
			setActive(formUuid, resolved.uuid);
		}
	}, [live, formUuid, allPages, readActive, setActive]);

	const currentUuid = current?.uuid;
	useEffect(() => {
		if (live && entry.ready && entry.entryKey && currentUuid)
			void controller.enterSectionAsync(currentUuid);
	}, [controller, live, currentUuid, entry.ready, entry.entryKey]);

	const [announcedTurn, setAnnouncedTurn] = useState<{
		readonly entryKey: string;
		readonly uuid: Uuid;
		readonly nonce: number;
	} | null>(null);
	const pendingFocusRef = useRef<{
		readonly entryKey: string;
		readonly uuid: Uuid;
	} | null>(null);
	const turnNonceRef = useRef(0);
	const navigationVersionRef = useRef(0);
	const liveRef = useRef(false);

	/* A retained screen can outlive its entry. Intent belongs to that entry
	 * and its visible page, including before passive heading focus runs. */
	useLayoutEffect(() => {
		liveRef.current = live;
		navigationVersionRef.current += 1;
		const ownsTurn = (turn: { entryKey: string; uuid: Uuid }) =>
			live &&
			formUuid !== undefined &&
			controller.entryKey === turn.entryKey &&
			controller.formUuid === formUuid &&
			turn.entryKey === entry.entryKey &&
			turn.uuid === currentUuid;
		if (pendingFocusRef.current && !ownsTurn(pendingFocusRef.current)) {
			pendingFocusRef.current = null;
		}
		setAnnouncedTurn((turn) => (turn && ownsTurn(turn) ? turn : null));
		return () => {
			liveRef.current = false;
			navigationVersionRef.current += 1;
		};
	}, [controller, live, formUuid, entry.entryKey, currentUuid]);

	const retireTurn = useCallback(() => {
		navigationVersionRef.current += 1;
		pendingFocusRef.current = null;
		setAnnouncedTurn(null);
	}, []);
	const ownsNavigation = useCallback(
		(entryKey: string | undefined, version: number): entryKey is string =>
			liveRef.current &&
			entryKey !== undefined &&
			controller.entryKey === entryKey &&
			controller.formUuid === formUuid &&
			navigationVersionRef.current === version,
		[controller, formUuid],
	);
	const takeFocusOnMount = useCallback((): boolean => {
		const pending = pendingFocusRef.current;
		pendingFocusRef.current = null;
		return (
			pending !== null &&
			liveRef.current &&
			controller.entryKey === pending.entryKey &&
			controller.formUuid === formUuid &&
			formUuid !== undefined &&
			resolveCurrentPage(controller.sectionPages(), readActive(formUuid))
				?.uuid === pending.uuid
		);
	}, [controller, formUuid, readActive]);

	const turnTo = useCallback(
		async (
			page: SectionPage,
			entryKey: string | undefined,
			version: number,
		) => {
			if (
				formUuid === undefined ||
				!ownsNavigation(entryKey, version) ||
				!(await controller.enterSectionAsync(page.uuid)) ||
				!ownsNavigation(entryKey, version)
			)
				return;
			pendingFocusRef.current = { entryKey, uuid: page.uuid };
			setActive(formUuid, page.uuid);
			setAnnouncedTurn({
				entryKey,
				uuid: page.uuid,
				nonce: ++turnNonceRef.current,
			});
		},
		[controller, formUuid, ownsNavigation, setActive],
	);

	const showPage = useCallback(
		(uuid: Uuid) => {
			retireTurn();
			if (formUuid === undefined) return;
			if (!pages.some((page) => page.uuid === uuid)) return;
			setActive(formUuid, uuid);
		},
		[formUuid, pages, retireTurn, setActive],
	);

	const showFirst = useCallback(() => {
		const first = pages[0];
		if (first !== undefined) showPage(first.uuid);
		else retireTurn();
	}, [pages, retireTurn, showPage]);

	/** Validate one page; on failure refuse, turn to it if needed, reveal. */
	const pagePasses = useCallback(
		async (
			page: SectionPage,
			entryKey: string | undefined,
			version: number,
		): Promise<boolean> => {
			if (
				!ownsNavigation(entryKey, version) ||
				!(await controller.enterSectionAsync(page.uuid)) ||
				!ownsNavigation(entryKey, version)
			)
				return false;
			const valid = await controller.validateSectionAsync(page.uuid);
			if (!ownsNavigation(entryKey, version)) return false;
			if (valid) return true;
			const target = controller.firstInvalidFieldTarget({
				withinSection: page.uuid,
			});
			refuse();
			showPage(page.uuid);
			if (target !== undefined) revealInvalid(target);
			return false;
		},
		[controller, ownsNavigation, refuse, revealInvalid, showPage],
	);

	const goNext = useCallback(async () => {
		if (current === undefined) return;
		const next = pages[index + 1];
		if (next === undefined) return;
		const entryKey = controller.entryKey;
		const version = ++navigationVersionRef.current;
		if (!(await pagePasses(current, entryKey, version))) return;
		await turnTo(next, entryKey, version);
	}, [controller, current, pages, index, pagePasses, turnTo]);

	const goBack = useCallback(async () => {
		if (current === undefined) return;
		const previous = pages[index - 1];
		if (previous === undefined) return;
		const entryKey = controller.entryKey;
		const version = ++navigationVersionRef.current;
		await turnTo(previous, entryKey, version);
	}, [controller, current, pages, index, turnTo]);

	const goTo = useCallback(
		async (uuid: Uuid) => {
			if (current === undefined || uuid === current.uuid) return;
			const target = pages.find((page) => page.uuid === uuid);
			if (target === undefined) return;
			const entryKey = controller.entryKey;
			const version = ++navigationVersionRef.current;
			for (const page of pagesToValidate(pages, current.uuid, uuid)) {
				if (!(await pagePasses(page, entryKey, version))) return;
			}
			await turnTo(target, entryKey, version);
		},
		[controller, current, pages, pagePasses, turnTo],
	);
	const announced =
		live &&
		announcedTurn?.entryKey === entry.entryKey &&
		announcedTurn?.uuid === currentUuid
			? announcedTurn
			: null;

	return {
		enabled: live,
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
