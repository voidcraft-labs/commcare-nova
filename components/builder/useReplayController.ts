/**
 * useReplayController — owns the replay-bar's behavior layer.
 *
 * The hook reads replay state from the session store, derives which
 * chapter contains the cursor, and exposes three callbacks the view
 * binds to the ←, →, and ✕ buttons:
 *
 *   - `goToChapter(N)` resets the doc + engine + signal grid, replays
 *     `events[0..chapters[N].endIndex]` cumulatively, then commits the
 *     new cursor. Session state (`replay.*`) is preserved so the
 *     transport bar survives the scrub.
 *   - `handleExit` composes `resetBuilder + sessionStore.reset() +
 *     navigate.push(exitPath)` in that order; session must reset
 *     before navigation so the destination route's mount doesn't
 *     observe stale state.
 *   - `error` carries an auto-dismissing toast string for failed
 *     scrubs.
 *
 * The view component (`ReplayController.tsx`) is a presentational
 * shell over these outputs — it carries no behavior of its own.
 */

"use client";
import { useCallback, useContext, useEffect, useState } from "react";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { resetBuilder } from "@/lib/doc/resetBuilder";
import { replayEventsSync } from "@/lib/log/replay";
import type { Event } from "@/lib/log/types";
import { useBuilderFormEngine } from "@/lib/preview/engine/provider";
import { useExternalNavigate } from "@/lib/routing/hooks";
import { useReplayState } from "@/lib/session/hooks";
import { BuilderSessionContext } from "@/lib/session/provider";
import type { ReplayChapter } from "@/lib/session/types";

/* Reference-stable empty-array sentinels used when replay is not loaded.
 * `useReplayState` returns `undefined` in that case; these sentinels keep
 * the destructured `events` / `chapters` references stable across renders
 * so the controller's downstream `findIndex` calls don't thrash. */
const EMPTY_EVENTS: readonly Event[] = [];
const EMPTY_CHAPTERS: readonly ReplayChapter[] = [];

/** Public surface returned to the view component. */
export interface ReplayControllerState {
	/** The chapter whose inclusive `[startIndex, endIndex]` range contains
	 *  the current cursor — undefined while chapters are still hydrating. */
	currentChapter: ReplayChapter | undefined;
	/** The index of `currentChapter` within `chapters`; -1 only during
	 *  the sub-frame between mount and `loadReplay`. */
	currentChapterIndex: number;
	/** Total chapter count, exposed so the view can render "N/M" copy
	 *  without re-subscribing to the session store itself. */
	totalChapters: number;
	/** Render-time gating for the back arrow — false at chapter 0. */
	canGoBack: boolean;
	/** Render-time gating for the forward arrow — false at the last chapter. */
	canGoForward: boolean;
	/** Auto-dismissing error toast text — undefined when no error is showing. */
	error: string | undefined;
	/**
	 * Scrub to a chapter. Resets the doc + engine + signal grid, replays
	 * `events[0..chapters[N].endIndex]` cumulatively, then commits the
	 * new cursor. Session state (`replay.*`) is preserved by composition
	 * — only `handleExit` clears the session entirely.
	 */
	goToChapter: (chapterIndex: number) => void;
	/**
	 * Leave replay mode entirely: composes `resetBuilder` (doc + engine
	 * + signal grid) → `sessionStore.reset()` (clears `replay.*`,
	 * cursor mode, sidebar) → `navigate.push(exitPath)`. Order matters
	 * so the destination route's initial render doesn't observe stale
	 * session state.
	 */
	handleExit: () => void;
}

export function useReplayController(): ReplayControllerState {
	const navigate = useExternalNavigate();
	const docStore = useContext(BlueprintDocContext);
	const sessionStore = useContext(BuilderSessionContext);
	const engineController = useBuilderFormEngine();

	const replay = useReplayState();
	const events = replay?.events ?? EMPTY_EVENTS;
	const chapters = replay?.chapters ?? EMPTY_CHAPTERS;
	const cursor = replay?.cursor ?? 0;
	const [error, setError] = useState<string>();

	/* Which chapter does the current cursor fall inside? Chapters cover
	 * inclusive `[startIndex, endIndex]` ranges and the cursor is always
	 * clamped into the `events` range by `setReplayCursor`. `findIndex`
	 * therefore returns a valid index for every real cursor; the only
	 * legitimate -1 case is `chapters.length === 0` during the sub-frame
	 * between mount and hydration (pre-`loadReplay`). */
	const currentChapterIndex = chapters.findIndex(
		(c) => cursor >= c.startIndex && cursor <= c.endIndex,
	);
	/* Assert cursor/chapter consistency once chapters are populated. A
	 * mismatch here means either `setReplayCursor`'s clamp is broken or
	 * `deriveReplayChapters` skipped a range — either way the user can't
	 * navigate, so failing loudly beats rendering a stuck "Loading…"
	 * header. The empty-chapters case is the transient pre-hydration
	 * state and is handled by callers via `currentChapter ?? "Loading…"`. */
	if (chapters.length > 0 && currentChapterIndex === -1) {
		throw new Error(
			`useReplayController: cursor ${cursor} outside chapter ranges (${chapters.length} chapters)`,
		);
	}
	const currentChapter = chapters[currentChapterIndex];

	/* Auto-dismiss the error toast 3s after it appears. Keyed on `error`
	 * so a new error resets the timer; cleanup fires on unmount or when
	 * `error` changes so the dismiss never stacks and can't clobber a
	 * newer toast. */
	useEffect(() => {
		if (!error) return;
		const timer = setTimeout(() => setError(undefined), 3000);
		return () => clearTimeout(timer);
	}, [error]);

	const goToChapter = useCallback(
		(chapterIndex: number) => {
			const chapter = chapters[chapterIndex];
			if (!chapter || !docStore || !sessionStore) return;
			try {
				/* Reset the doc + engine + signal grid only. Session state
				 * (`replay.events` / `replay.chapters` / the transport bar)
				 * must survive the scrub — only `handleExit` clears session.
				 * Bundling `sessionStore.reset()` here would wipe `replay`
				 * and render the transport bar as `0/0` chapters. */
				resetBuilder({ docStore, engineController });
				/* Cumulative replay — from event 0 through this chapter's
				 * end. Chapters are scrub targets, not independent segments,
				 * so every scrub reconstructs state from the beginning. The
				 * doc store was just wiped by the reset, so no stale entities
				 * bleed into the new frame.
				 *
				 * `replayEventsSync` guarantees every mutation lands before
				 * the `setReplayCursor` call below — otherwise the chat
				 * view (derived from the cursor) could race ahead of the
				 * doc view and render a mismatched frame. */
				const slice = events.slice(0, chapter.endIndex + 1);
				replayEventsSync(
					slice,
					(m) => docStore.getState().applyMany([m]),
					() => {
						/* Conversation events are projected on read by
						 * `useReplayMessages`; no side channel needed. */
					},
				);
				/* Swap the session events buffer to the new slice so
				 * lifecycle derivations see the chapter's terminal frame —
				 * the frame live rendered at the same cursor position.
				 * Exception: the final chapter represents a *completed*
				 * run, and live's post-endRun state has an empty buffer →
				 * derivePhase returns Ready. Mirroring that here means
				 * clearing the buffer on the terminal scrub so the final
				 * frame doesn't flash Generating. All earlier chapters use
				 * the normal slice so Generating phase + stage progression
				 * render correctly mid-scrub.
				 *
				 * `replaceEvents` (not `pushEvents`) because scrub is a
				 * full reconstruction, not a delta. */
				const atTerminal = chapterIndex === chapters.length - 1;
				sessionStore.getState().replaceEvents(atTerminal ? [] : slice);
				/* Record the new scrub position — `useReplayMessages`
				 * subscribes to this and re-derives the chat view. */
				sessionStore.getState().setReplayCursor(chapter.endIndex);
				setError(undefined);
			} catch (err) {
				setError(
					`Cannot load chapter: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
		[chapters, events, docStore, sessionStore, engineController],
	);

	const handleExit = useCallback(() => {
		if (!docStore || !sessionStore) {
			throw new Error(
				"useReplayController.handleExit: missing docStore or sessionStore",
			);
		}
		const exitPath = sessionStore.getState().replay?.exitPath;
		if (!exitPath) {
			throw new Error(
				"useReplayController.handleExit: no exitPath in replay state",
			);
		}
		resetBuilder({ docStore, engineController });
		sessionStore.getState().reset();
		navigate.push(exitPath);
	}, [docStore, sessionStore, engineController, navigate]);

	const canGoBack = currentChapterIndex > 0;
	/* When chapters is empty `currentChapterIndex` is -1 — the
	 * `!chapter` branch in `goToChapter` would reject any click anyway,
	 * but short-circuit here so the arrow renders disabled too. */
	const canGoForward =
		currentChapterIndex >= 0 && currentChapterIndex < chapters.length - 1;

	return {
		currentChapter,
		currentChapterIndex,
		totalChapters: chapters.length,
		canGoBack,
		canGoForward,
		error,
		goToChapter,
		handleExit,
	};
}
