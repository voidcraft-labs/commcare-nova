// components/preview/screens/CaseSearchConfigInteractEmptyState.tsx
//
// Live-mode arm for the case-search authoring URL. The
// `CaseSearchConfigPanel` is an edit-mode-only authoring shell — it
// has no running-app counterpart (case-search authoring configures
// HOW the runtime presents search, not data the runtime renders).
// When the user lands on `/search-config` and toggles the global
// cursor-mode pill to "Interact", we render this small empty-state
// card with a single CTA that flips back to edit mode. Without it,
// the scroll container would render with `PreviewHeader` only — a
// blank surface with no indication of what to do.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerPencil from "@iconify-icons/tabler/pencil";
import { useSwitchCursorMode } from "@/lib/session/hooks";

/**
 * Centered empty-state card surfaced at `/build/[id]/{moduleUuid}/search-config`
 * when the global cursor mode is `pointer` (interact). Composes a
 * heading, a one-sentence explanation, and a single primary CTA
 * that calls `switchCursorMode("edit")` — the same atomic switch
 * the toolbar's `CursorModeSelector` calls, so sidebar stash/restore
 * is preserved. Re-uses the `CaseListScreen`-empty-state shape
 * (`rounded-lg border border-pv-input-border p-8 text-center` plus
 * `bg-pv-accent` button) so the surface composes with the rest of
 * the live-mode preview chrome.
 */
export function CaseSearchConfigInteractEmptyState() {
	const switchCursorMode = useSwitchCursorMode();
	return (
		<div className="p-6 max-w-3xl mx-auto">
			<div className="rounded-lg border border-pv-input-border p-8 text-center">
				<h2 className="text-base font-display font-semibold text-nova-text mb-2">
					Search configuration is edit-only
				</h2>
				<p className="text-sm text-nova-text-muted mb-5">
					This screen configures how search behaves at runtime. There's nothing
					to interact with here — switch to edit mode to author the
					configuration.
				</p>
				<button
					type="button"
					onClick={() => switchCursorMode("edit")}
					className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-pv-accent text-white hover:brightness-110 transition-all cursor-pointer"
				>
					<Icon icon={tablerPencil} width="14" height="14" />
					Switch to edit mode
				</button>
			</div>
		</div>
	);
}
