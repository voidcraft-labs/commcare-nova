/**
 * Chapter-metadata derivation for the ReplayController's transport UI.
 *
 * A chapter is a contiguous run of mutation events sharing the same
 * `stage` tag, preceded by an optional "Conversation" chapter if the log
 * begins with chat-only events. Chapters are cumulative scrub targets —
 * clicking chapter N replays `events[0..chapters[N].endIndex]`. The
 * final real chapter doubles as the terminal scrub target (no synthetic
 * "Done" chapter; an earlier iteration had one, and its overlap with
 * the previous chapter's final index made `findIndex` report `N-1/N`
 * at the completion cursor).
 *
 * Subtitle resolution walks a running doc chapter-by-chapter via
 * `applyMutations` so a `module:N` tag resolves to the module's display
 * name — the scaffold that minted module N landed in an earlier
 * chapter and is already present by the time subtitle resolution runs.
 */
import { produce } from "immer";
import { applyMutations } from "@/lib/doc/mutations";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import type { ReplayChapter } from "@/lib/session/types";
import type { Event } from "./types";

/**
 * Map a `stage` tag on a MutationEvent to a chapter header.
 *
 * The SA emits compound stage tags like "fix:attempt-1",
 * "rename:0-2", "edit:0-3" — `startsWith` collapses each family onto
 * one header. Exact `"schema"` / `"scaffold"` comparisons cover the
 * schema + scaffold phases which are not compound. If a future stage
 * name accidentally collides (e.g. "fixture") the prefix match will
 * over-group — audit stage tags when adding new phases.
 */
function headerForStage(stage: string | undefined): string {
	if (!stage) return "Update";
	if (stage === "schema") return "Data Model";
	if (stage === "scaffold") return "Scaffold";
	if (stage.startsWith("module:")) return "Module";
	if (stage.startsWith("form:")) return "Form";
	if (stage.startsWith("fix")) return "Validation Fix";
	if (stage.startsWith("rename")) return "Edit";
	if (stage.startsWith("edit")) return "Edit";
	return "Update";
}

/**
 * Empty BlueprintDoc seed — mirrors the chat route's initial `sessionDoc`
 * shape. The running doc used for subtitle resolution starts here and is
 * advanced chapter-by-chapter as we walk the event stream, so a `module:1`
 * chapter whose scaffold was minted several chapters earlier can still
 * resolve its index to the real module name.
 *
 * Inlined (not extracted) because this is the only consumer in this file
 * and the shape is small + stable — hoisting it into a shared helper
 * would trade minor deduplication (`lib/doc/resetBuilder.ts` has a
 * near-identical constant) for a cross-layer coupling that would force
 * `lib/log` to depend on `lib/doc`'s internal initial-state helper.
 */
function emptyBlueprintDoc(): BlueprintDoc {
	return {
		appId: "",
		appName: "",
		connectType: null,
		caseTypes: null,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		fieldParent: {},
	};
}

/**
 * Map a `stage` tag onto a user-facing subtitle, resolving indexed
 * references (`module:N`, `form:M-F`) against a running BlueprintDoc
 * snapshot so the UI shows the module's / form's display name rather
 * than the SA's raw index-based tag.
 *
 * Called with the doc state that reflects every mutation from PREVIOUS
 * chapters but none from the current chapter — the scaffold establishing
 * the module/form landed earlier, so the name is already in place by the
 * time a `module:N` / `form:M-F` chapter starts.
 *
 * Falls back to the raw tag (`Module N`, `Form M-F`) when the index
 * can't be resolved — a migrated legacy log might carry a stage tag
 * that points at an entity the running doc never minted (e.g. a
 * `data-module-done` whose matching `data-scaffold` was dropped). A
 * degraded subtitle is better than a thrown error mid-render.
 */
function subtitleForStage(
	stage: string | undefined,
	doc: BlueprintDoc,
): string | undefined {
	if (!stage) return undefined;
	if (stage.startsWith("module:")) {
		const n = Number.parseInt(stage.slice("module:".length), 10);
		if (!Number.isFinite(n)) return stage;
		const uuid = doc.moduleOrder[n];
		return uuid ? (doc.modules[uuid]?.name ?? `Module ${n}`) : `Module ${n}`;
	}
	if (stage.startsWith("form:")) {
		const [mRaw, fRaw] = stage.slice("form:".length).split("-");
		const m = Number.parseInt(mRaw ?? "", 10);
		const f = Number.parseInt(fRaw ?? "", 10);
		if (!Number.isFinite(m) || !Number.isFinite(f)) return stage;
		const moduleUuid = doc.moduleOrder[m];
		const formUuid = moduleUuid ? doc.formOrder[moduleUuid]?.[f] : undefined;
		return formUuid
			? (doc.forms[formUuid]?.name ?? `Form ${m}-${f}`)
			: `Form ${m}-${f}`;
	}
	return undefined;
}

/**
 * Derive the chapter metadata for a replay log.
 *
 * Pure over the `events[]` input: no persistence, no side effects.
 * Consumers pass the chapters into `setReplayChapters` on the session
 * store and read them back for the transport UI.
 */
export function deriveReplayChapters(
	events: readonly Event[],
): ReplayChapter[] {
	const chapters: ReplayChapter[] = [];

	let cursor = 0;
	/* Running doc — advanced chapter-by-chapter so subtitle resolution
	 * below sees exactly the state the live SA would have observed at
	 * the start of each chapter. Uses the same `produce` + `applyMutations`
	 * pipeline as the live store so the two code paths stay in agreement
	 * on mutation semantics. */
	let doc = emptyBlueprintDoc();

	/* Leading "Conversation" chapter — the span of events before the first
	 * mutation, if any. Represents the initial chat exchange (user
	 * message + assistant preamble) before the SA starts building. No
	 * mutations to apply yet, so the running doc stays empty. */
	let firstMutationIdx = events.findIndex((e) => e.kind === "mutation");
	if (firstMutationIdx === -1) firstMutationIdx = events.length;
	if (firstMutationIdx > 0) {
		chapters.push({
			header: "Conversation",
			startIndex: 0,
			endIndex: firstMutationIdx - 1,
		});
		cursor = firstMutationIdx;
	}

	/* Now walk mutation events, grouping contiguous runs with the same
	 * `stage` tag. Intervening conversation events are absorbed into the
	 * current chapter — they ride alongside the mutations that produced
	 * them. A chapter ends when the `stage` tag changes. */
	while (cursor < events.length) {
		const e = events[cursor];
		if (e.kind !== "mutation") {
			cursor++;
			continue;
		}
		const stage = e.stage;
		const start = cursor;

		/* Resolve the subtitle BEFORE applying this chapter's mutations —
		 * the scaffold that minted the referenced module/form landed in a
		 * prior chapter and is already in `doc`. Applying the current
		 * chapter's mutations first would let a `module:N` chapter resolve
		 * against a doc where the Nth module has been updated mid-chapter,
		 * reporting a stale-then-new name on each scrub. */
		const subtitle = subtitleForStage(stage, doc);

		/* Advance through every consecutive mutation sharing this stage,
		 * applying each to the running doc so the next chapter's subtitle
		 * resolution sees final post-chapter state. Conversation events in
		 * the middle are absorbed (no mutation to apply) but still extend
		 * the chapter's end index. */
		const chapterMutations: Mutation[] = [];
		let end = cursor;
		chapterMutations.push(e.mutation);
		while (end + 1 < events.length) {
			const next = events[end + 1];
			if (next.kind === "mutation" && next.stage !== stage) break;
			if (next.kind === "mutation") chapterMutations.push(next.mutation);
			end++;
		}
		doc = produce(doc, (draft) => {
			applyMutations(draft, chapterMutations);
		});

		chapters.push({
			header: headerForStage(stage),
			...(subtitle && { subtitle }),
			startIndex: start,
			endIndex: end,
		});
		cursor = end + 1;
	}

	return chapters;
}
