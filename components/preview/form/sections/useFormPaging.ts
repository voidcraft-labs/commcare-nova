/**
 * useFormPaging: the running form's pager, on the rules of the platform
 * Preview plays (`lib/preview/platform.ts`, `formScreens`).
 *
 * - **Web Apps** draws every question of the form on one screen, sections
 *   as titled groups, so the pager is off: no pages, no Back or Next, and
 *   Submit validates the whole form. The section in view is remembered by
 *   `useScrolledSection` instead.
 * - **Android, a sectioned form** pages one section at a time. The page list
 *   is the form's root sections (`useSectionScreens`), and the open page
 *   lives in the session (`activeSectionByForm`, the slot the edit canvas
 *   also reads and writes, so a flip keeps the page).
 * - **Android, a form without sections** pages one screen per labeled group
 *   and per question outside one (`useFormScreens`), each identified by its
 *   concrete path. The open screen belongs to the form entry. Stepping Next
 *   past the last entry of a repeat the worker adds to, or past the repeat
 *   when it has none, opens Android's repeat prompt (`prompt`): add an
 *   entry and open its first screen, move on, or go back.
 *
 * In every paged mode this hook is the arbiter between the page list and
 * the remembered page:
 *
 *   - **Which page is current.** The remembered page while it is visible;
 *     a page that just emptied re-anchors (`resolveCurrentPage`) and, for a
 *     section, the re-anchored page is written back, so the slot never names
 *     a page nobody can see.
 *   - **Next validates, Back never does.** `goNext` validates the current
 *     page; a failure refuses (the form's `role="alert"` channel) and
 *     reveals the first invalid question on that page; success turns the
 *     page, moves focus to the new heading, and announces it politely.
 *   - **A jump forward validates the pages between.** `goTo` checks every
 *     visible page from the current one up to (not including) the target,
 *     stopping at the first failure; a jump backward is Back.
 *   - **`showPage` turns without checking.** Submit routing (the earliest
 *     invalid page, `showPageOf`) and Clear form (the first page) use it.
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
	FormScreenPage,
	InvalidFieldTarget,
	RepeatPromptPoint,
} from "@/lib/preview/engine/formEngine";
import {
	availablePages,
	pagesToValidate,
	repeatPromptsBetween,
	resolveCurrentPage,
} from "@/lib/preview/engine/sectionPaging";
import { useEngineController } from "@/lib/preview/hooks/useEngineController";
import { useEngineEntry } from "@/lib/preview/hooks/useEngineEntry";
import {
	useFormScreens,
	useRepeatPromptPoints,
	useSectionScreens,
} from "@/lib/preview/hooks/useFormScreens";
import {
	useActiveSection,
	useGetActiveSection,
	useSetActiveSection,
} from "@/lib/session/hooks";

/** How the running form pages on the platform Preview plays. */
export type FormPagingMode = "none" | "sections" | "screens";

/** A section is remembered by uuid (`activeSectionByForm`); a screen of a
 *  form without sections by its concrete path. */
const sectionIdentity = (page: FormScreenPage): string => page.uuid;
const screenIdentity = (page: FormScreenPage): string => page.path;

/** The paths a screen holds: its own and everything under it. */
function screenHolds(page: FormScreenPage, instancePath: string): boolean {
	return (
		instancePath === page.path ||
		instancePath.startsWith(`${page.path}/`) ||
		instancePath.startsWith(`${page.path}[`)
	);
}

export interface FormPagingArgs {
	readonly formUuid: Uuid | undefined;
	/** `none` outside preview and on Web Apps: the hook then stays inert (no
	 *  writes to the session, no current page). */
	readonly mode: FormPagingMode;
	/** Reveal and focus an invalid question (FormScreen's reveal path). */
	readonly revealInvalid: (target: InvalidFieldTarget) => void;
	/** Announce an invalid page through FormScreen's localized alert intent. */
	readonly refuse: () => void;
}

/** Android's repeat prompt while it is open. */
export interface OpenRepeatPrompt {
	readonly point: RepeatPromptPoint;
	/** Nothing follows the repeat, so declining finishes the form. */
	readonly nothingFollows: boolean;
}

export interface FormPaging {
	/** Whether the form is being paged at all. */
	readonly enabled: boolean;
	readonly mode: FormPagingMode;
	/** The pages a worker can see, in order. */
	readonly pages: ReadonlyArray<FormScreenPage>;
	readonly current: FormScreenPage | undefined;
	/** 0-based position of `current` among `pages`; -1 when none. */
	readonly index: number;
	readonly count: number;
	readonly canGoBack: boolean;
	/** The bottom bar shows Submit (or Finish) rather than Next. */
	readonly isLast: boolean;
	readonly goBack: () => Promise<void>;
	readonly goNext: () => Promise<void>;
	/** Jump to a page by its identity (a section's uuid). */
	readonly goTo: (id: string) => Promise<void>;
	/** Turn to a page by its identity without validating anything. */
	readonly showPage: (id: string) => void;
	/** Turn to the page holding an invalid question (submit routing). */
	readonly showPageOf: (target: InvalidFieldTarget) => void;
	/** Turn to the first visible page without validating (Clear form). */
	readonly showFirst: () => void;
	/** The identity a page is remembered by in this mode. */
	readonly identityOf: (page: FormScreenPage) => string;
	/** The last user-driven page turn, for the polite status region: the
	 *  page's identity and a nonce so the same page turned twice announces
	 *  twice. */
	readonly announced: { readonly id: string; readonly nonce: number } | null;
	/** Read-and-clear: true once after a user-driven page turn, so the new
	 *  page's heading takes focus when it mounts and not on first open. */
	readonly takeFocusOnMount: () => boolean;
	/** Android's repeat prompt, while it is open. */
	readonly prompt: OpenRepeatPrompt | null;
	/** Add an entry to the prompt's repeat and open its first screen. */
	readonly addRepeatEntry: () => Promise<void>;
	/** Decline the prompt: the next prompt, else the next screen, else the
	 *  end of the form. */
	readonly declineRepeatEntry: () => Promise<void>;
	/** Close the prompt and stay on the screen before it. */
	readonly closeRepeatPrompt: () => void;
}

const NO_PAGES: ReadonlyArray<FormScreenPage> = [];

export function useFormPaging({
	formUuid,
	mode,
	revealInvalid,
	refuse,
}: FormPagingArgs): FormPaging {
	const controller = useEngineController();
	const sectionPages = useSectionScreens();
	const screenPages = useFormScreens();
	const promptPoints = useRepeatPromptPoints();
	const allPages =
		mode === "sections"
			? sectionPages
			: mode === "screens"
				? screenPages
				: NO_PAGES;
	const identityOf = mode === "sections" ? sectionIdentity : screenIdentity;
	/* The engine is one per builder session and activates a form after its
	 * screen mounts, so `mode` alone would page this form with another
	 * form's pages (opening form B while A's engine still runs) or show
	 * the no-pages state before activation. Everything below keys on the
	 * engine actually running THIS form. */
	const entry = useEngineEntry();
	const engineFormUuid = entry.formUuid;
	const live =
		mode !== "none" && formUuid !== undefined && engineFormUuid === formUuid;
	const activeSection = useActiveSection(formUuid ?? "");
	const readActiveSection = useGetActiveSection();
	const setActiveSection = useSetActiveSection();
	/* A screen of a form without sections belongs to its form entry. */
	const [screenSlot, setScreenSlot] = useState<{
		readonly entryKey: string | undefined;
		readonly path: string;
	} | null>(null);
	const activeScreen =
		screenSlot !== null && screenSlot.entryKey === entry.entryKey
			? screenSlot.path
			: undefined;
	const remembered = mode === "sections" ? activeSection : activeScreen;
	const [finishedAt, setFinishedAt] = useState<{
		readonly entryKey: string | undefined;
		readonly path: string;
	} | null>(null);
	const [prompt, setPrompt] = useState<{
		readonly entryKey: string | undefined;
		readonly queue: readonly RepeatPromptPoint[];
		readonly from: FormScreenPage;
		readonly next: FormScreenPage | undefined;
	} | null>(null);

	const remember = useCallback(
		(page: FormScreenPage) => {
			if (formUuid === undefined) return;
			if (mode === "sections") setActiveSection(formUuid, page.uuid);
			else setScreenSlot({ entryKey: controller.entryKey, path: page.path });
		},
		[controller, formUuid, mode, setActiveSection],
	);

	const pages = useMemo(
		() => (live ? availablePages(allPages) : NO_PAGES),
		[live, allPages],
	);
	const current = useMemo(
		() =>
			live ? resolveCurrentPage(allPages, remembered, identityOf) : undefined,
		[live, allPages, remembered, identityOf],
	);
	const index = current === undefined ? -1 : pages.indexOf(current);
	const count = pages.length;

	/* Write the resolved section back whenever the slot names a page nobody
	 * can see: the first open (no memory yet) and every re-anchor after a
	 * page emptied. Resolve against the slot's LIVE value, never this
	 * render's: on a flip the edit canvas's unmount cleanup writes the page
	 * it was showing in the same commit this effect runs, and the
	 * render-time closure would overwrite that page with the first one. */
	useEffect(() => {
		if (!live || mode !== "sections" || formUuid === undefined) return;
		const slot = readActiveSection(formUuid);
		const resolved = resolveCurrentPage(allPages, slot, sectionIdentity);
		if (resolved !== undefined && resolved.uuid !== slot) {
			setActiveSection(formUuid, resolved.uuid);
		}
	}, [live, mode, formUuid, allPages, readActiveSection, setActiveSection]);

	const enterPage = useCallback(
		(page: FormScreenPage): Promise<boolean> =>
			mode === "sections"
				? controller.enterSectionAsync(page.uuid)
				: controller.enterScreenAsync(page.path),
		[controller, mode],
	);

	const currentPath = current?.path;
	const currentPage = current;
	// biome-ignore lint/correctness/useExhaustiveDependencies: the page is keyed by its path; a new object for the same screen is the same page
	useEffect(() => {
		if (live && entry.ready && entry.entryKey && currentPage)
			void enterPage(currentPage);
	}, [enterPage, live, currentPath, entry.ready, entry.entryKey]);

	const [announcedTurn, setAnnouncedTurn] = useState<{
		readonly entryKey: string;
		readonly id: string;
		readonly nonce: number;
	} | null>(null);
	const pendingFocusRef = useRef<{
		readonly entryKey: string;
		readonly id: string;
	} | null>(null);
	const turnNonceRef = useRef(0);
	const navigationVersionRef = useRef(0);
	const liveRef = useRef(false);
	const currentId = current === undefined ? undefined : identityOf(current);

	/* A retained screen can outlive its entry. Intent belongs to that entry
	 * and its visible page, including before passive heading focus runs. */
	useLayoutEffect(() => {
		liveRef.current = live;
		navigationVersionRef.current += 1;
		const ownsTurn = (turn: { entryKey: string; id: string }) =>
			live &&
			formUuid !== undefined &&
			controller.entryKey === turn.entryKey &&
			controller.formUuid === formUuid &&
			turn.entryKey === entry.entryKey &&
			turn.id === currentId;
		if (pendingFocusRef.current && !ownsTurn(pendingFocusRef.current)) {
			pendingFocusRef.current = null;
		}
		setAnnouncedTurn((turn) => (turn && ownsTurn(turn) ? turn : null));
		return () => {
			liveRef.current = false;
			navigationVersionRef.current += 1;
		};
	}, [controller, live, formUuid, entry.entryKey, currentId]);

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
		if (
			pending === null ||
			!liveRef.current ||
			controller.entryKey !== pending.entryKey ||
			controller.formUuid !== formUuid ||
			formUuid === undefined
		)
			return false;
		const live =
			mode === "sections"
				? resolveCurrentPage(
						controller.sectionScreens(),
						readActiveSection(formUuid),
						sectionIdentity,
					)
				: resolveCurrentPage(controller.formScreens(), pending.id);
		return live !== undefined && identityOf(live) === pending.id;
	}, [controller, formUuid, identityOf, mode, readActiveSection]);

	const turnTo = useCallback(
		async (
			page: FormScreenPage,
			entryKey: string | undefined,
			version: number,
		) => {
			if (
				formUuid === undefined ||
				!ownsNavigation(entryKey, version) ||
				!(await enterPage(page)) ||
				!ownsNavigation(entryKey, version)
			)
				return;
			const id = identityOf(page);
			pendingFocusRef.current = { entryKey, id };
			setFinishedAt(null);
			remember(page);
			setAnnouncedTurn({ entryKey, id, nonce: ++turnNonceRef.current });
		},
		[enterPage, formUuid, identityOf, ownsNavigation, remember],
	);

	const showPage = useCallback(
		(id: string) => {
			retireTurn();
			setPrompt(null);
			const page = pages.find((candidate) => identityOf(candidate) === id);
			if (formUuid === undefined || page === undefined) return;
			setFinishedAt(null);
			remember(page);
		},
		[formUuid, identityOf, pages, remember, retireTurn],
	);

	const showPageOf = useCallback(
		(target: InvalidFieldTarget) => {
			if (mode === "sections") {
				const first = target.ancestorUuids[0];
				if (first !== undefined) showPage(first);
				return;
			}
			const page = pages.find((candidate) =>
				screenHolds(candidate, target.instancePath),
			);
			if (page !== undefined) showPage(identityOf(page));
		},
		[identityOf, mode, pages, showPage],
	);

	const showFirst = useCallback(() => {
		const first = pages[0];
		if (first !== undefined) showPage(identityOf(first));
		else retireTurn();
	}, [identityOf, pages, retireTurn, showPage]);

	/** Validate one page; on failure refuse, turn to it if needed, reveal. */
	const pagePasses = useCallback(
		async (
			page: FormScreenPage,
			entryKey: string | undefined,
			version: number,
		): Promise<boolean> => {
			if (
				!ownsNavigation(entryKey, version) ||
				!(await enterPage(page)) ||
				!ownsNavigation(entryKey, version)
			)
				return false;
			const validation =
				mode === "sections"
					? await controller.validateSectionAsync(page.uuid)
					: await controller.validateScreenAsync(page.path);
			if (
				!ownsNavigation(entryKey, version) ||
				!controller.isValidationCurrent(validation)
			)
				return false;
			if (validation.kind === "valid") return true;
			if (validation.kind !== "invalid" || validation.target === undefined)
				return false;
			refuse();
			showPage(identityOf(page));
			revealInvalid(validation.target);
			return false;
		},
		[
			controller,
			enterPage,
			identityOf,
			mode,
			ownsNavigation,
			refuse,
			revealInvalid,
			showPage,
		],
	);

	/** The relevant repeat prompts between the current screen and the next
	 *  visible one (Android, a form without sections). */
	const promptsAfter = useCallback(
		(from: FormScreenPage, next: FormScreenPage | undefined) => {
			if (mode !== "screens") return [];
			const fromIndex = allPages.indexOf(from);
			const toIndex =
				next === undefined ? allPages.length : allPages.indexOf(next);
			return repeatPromptsBetween(promptPoints, fromIndex, toIndex);
		},
		[allPages, mode, promptPoints],
	);

	const goNext = useCallback(async () => {
		if (current === undefined) return;
		const next = pages[index + 1];
		const queue = promptsAfter(current, next);
		if (next === undefined && queue.length === 0) return;
		const entryKey = controller.entryKey;
		const version = ++navigationVersionRef.current;
		if (!(await pagePasses(current, entryKey, version))) return;
		if (queue.length > 0) {
			if (ownsNavigation(entryKey, version))
				setPrompt({ entryKey, queue, from: current, next });
			return;
		}
		if (next !== undefined) await turnTo(next, entryKey, version);
	}, [
		controller,
		current,
		pages,
		index,
		pagePasses,
		promptsAfter,
		ownsNavigation,
		turnTo,
	]);

	const goBack = useCallback(async () => {
		if (current === undefined) return;
		const previous = pages[index - 1];
		if (previous === undefined) return;
		const entryKey = controller.entryKey;
		const version = ++navigationVersionRef.current;
		await turnTo(previous, entryKey, version);
	}, [controller, current, pages, index, turnTo]);

	const goTo = useCallback(
		async (id: string) => {
			if (current === undefined || id === identityOf(current)) return;
			const target = pages.find((page) => identityOf(page) === id);
			if (target === undefined) return;
			const entryKey = controller.entryKey;
			const version = ++navigationVersionRef.current;
			for (const page of pagesToValidate(
				pages,
				identityOf(current),
				id,
				identityOf,
			)) {
				if (!(await pagePasses(page, entryKey, version))) return;
			}
			await turnTo(target, entryKey, version);
		},
		[controller, current, identityOf, pages, pagePasses, turnTo],
	);

	const openPrompt =
		prompt !== null &&
		prompt.entryKey === entry.entryKey &&
		live &&
		current !== undefined &&
		prompt.from.path === current.path
			? prompt
			: null;
	const promptPoint = openPrompt?.queue[0];

	const closeRepeatPrompt = useCallback(() => setPrompt(null), []);

	const declineRepeatEntry = useCallback(async () => {
		if (openPrompt === null) return;
		const [, ...rest] = openPrompt.queue;
		if (rest.length > 0) {
			setPrompt({ ...openPrompt, queue: rest });
			return;
		}
		setPrompt(null);
		const entryKey = controller.entryKey;
		const version = ++navigationVersionRef.current;
		if (openPrompt.next !== undefined)
			await turnTo(openPrompt.next, entryKey, version);
		else setFinishedAt({ entryKey, path: openPrompt.from.path });
	}, [controller, openPrompt, turnTo]);

	const addRepeatEntry = useCallback(async () => {
		if (openPrompt === null || promptPoint === undefined) return;
		setPrompt(null);
		const entryKey = controller.entryKey;
		const version = ++navigationVersionRef.current;
		await controller.addRepeatAsync(
			promptPoint.repeatUuid,
			promptPoint.repeatPath,
		);
		if (!ownsNavigation(entryKey, version)) return;
		const entryPrefix = `${promptPoint.repeatPath}[${promptPoint.entryCount}]/`;
		const firstScreen = availablePages(controller.formScreens()).find((page) =>
			page.path.startsWith(entryPrefix),
		);
		if (firstScreen !== undefined) {
			await turnTo(firstScreen, entryKey, version);
			return;
		}
		/* The new entry has nothing to show: move on, as declining does. */
		if (openPrompt.next !== undefined)
			await turnTo(openPrompt.next, entryKey, version);
		else setFinishedAt({ entryKey, path: openPrompt.from.path });
	}, [controller, openPrompt, ownsNavigation, promptPoint, turnTo]);

	const announced =
		live &&
		announcedTurn !== null &&
		announcedTurn.entryKey === entry.entryKey &&
		announcedTurn.id === currentId
			? { id: announcedTurn.id, nonce: announcedTurn.nonce }
			: null;
	const finished =
		finishedAt !== null &&
		finishedAt.entryKey === entry.entryKey &&
		finishedAt.path === current?.path;
	const promptsFollow =
		current !== undefined && promptsAfter(current, undefined).length > 0;
	const isLast =
		current === undefined ||
		(index === count - 1 && (finished || !promptsFollow));

	return {
		enabled: live,
		mode,
		pages,
		current,
		index,
		count,
		canGoBack: index > 0,
		isLast,
		goBack,
		goNext,
		goTo,
		showPage,
		showPageOf,
		showFirst,
		identityOf,
		announced,
		takeFocusOnMount,
		prompt:
			openPrompt !== null && promptPoint !== undefined
				? {
						point: promptPoint,
						nothingFollows:
							openPrompt.next === undefined && openPrompt.queue.length === 1,
					}
				: null,
		addRepeatEntry,
		declineRepeatEntry,
		closeRepeatPrompt,
	};
}
