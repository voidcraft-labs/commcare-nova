/**
 * Nova API Keys settings card. Long-lived service-account credentials
 * for the MCP route. Lives next to `<ConnectedApps />`: that card
 * manages OAuth-flow grants for browser-mediated user delegation
 * (per-app revocation, rotation-as-theft-detection); this one manages
 * static bearer credentials for non-interactive automation
 * (ACE-style consumers running many concurrent worktrees against one
 * service identity, where OAuth's rotation invalidates parallel
 * sessions against each other).
 *
 * Lifecycle of a key:
 *   1. User clicks "+ New Key" → `<MintDialog />` opens.
 *   2. User picks a name + scopes + expiry, hits Mint → Server Action
 *      returns `{ key, keyId, displayPrefix, expiresAt }` exactly once.
 *   3. Dialog flips to a "reveal" screen: full plaintext key with a
 *      Copy button. The key lives in component state only — closing
 *      the dialog clears it.
 *   4. User clicks "I've saved this key" → dialog closes, the new row
 *      appears in the list with the masked prefix only.
 *
 * Per-row UI: name + scope chips + relative-time created / last-used /
 * expiry, plus a kebab menu with "Edit scopes" (opens
 * `<EditScopesDialog />`) and "Revoke" (inline confirm-in-place,
 * matching `ConnectedApps`'s pattern).
 */

"use client";

import { Checkbox } from "@base-ui/react/checkbox";
import { Dialog } from "@base-ui/react/dialog";
import { Field } from "@base-ui/react/field";
import { Menu } from "@base-ui/react/menu";
import { Select } from "@base-ui/react/select";
import { Icon } from "@iconify/react/offline";
import tablerCheck from "@iconify-icons/tabler/check";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerCircleCheck from "@iconify-icons/tabler/circle-check";
import tablerCopy from "@iconify-icons/tabler/copy";
import tablerDotsVertical from "@iconify-icons/tabler/dots-vertical";
import tablerExternalLink from "@iconify-icons/tabler/external-link";
import tablerKey from "@iconify-icons/tabler/key";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerPencil from "@iconify-icons/tabler/pencil";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerShieldLock from "@iconify-icons/tabler/shield-lock";
import tablerTrash from "@iconify-icons/tabler/trash";
import tablerX from "@iconify-icons/tabler/x";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	NOVA_API_KEY_SCOPES,
	NOVA_MCP_FLOOR_SCOPES,
	NOVA_MCP_SCOPE_LABELS,
} from "@/lib/auth-public";
import type { ApiKeySummary } from "@/lib/db/api-keys";
import { docsLink } from "@/lib/hostnames";
import {
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
} from "@/lib/styles";
import {
	type ExpiryOption,
	editApiKeyScopes,
	mintApiKey,
	revokeApiKey,
} from "./api-key-actions";
import { ScopesPopover } from "./scopes-popover";

// ── Types ──────────────────────────────────────────────────────────

interface ApiKeysProps {
	initial: ApiKeySummary[];
}

/** Per-row UI status. Each row owns its own copy. */
type RowStatus =
	| { type: "idle" }
	| { type: "confirming" }
	| { type: "revoking" }
	| { type: "error"; message: string };

interface RowData extends ApiKeySummary {
	status: RowStatus;
}

// ── Constants & helpers ────────────────────────────────────────────

/**
 * Set view of the floor scopes (read + write) for O(1) lookup in the
 * checkbox-locked-checked predicate. Sourced from
 * `NOVA_MCP_FLOOR_SCOPES` — the single literal lives in
 * `lib/auth-public.ts` and is shared by the MCP route, the Server
 * Actions, and this UI, so the "what's required" answer cannot drift
 * across surfaces.
 */
const FLOOR_SCOPES_SET = new Set<string>(NOVA_MCP_FLOOR_SCOPES);

/**
 * Renders "12 Apr 2026". Locale pinned to `en-GB` for stability, same
 * choice as `ConnectedApps`. Display in the row metadata strip.
 */
const DATE_FORMATTER = new Intl.DateTimeFormat("en-GB", {
	day: "numeric",
	month: "short",
	year: "numeric",
});

const RELATIVE_FORMATTER = new Intl.RelativeTimeFormat("en-US", {
	numeric: "auto",
});

/**
 * Convert a past ISO timestamp to a short relative label
 * ("2 hours ago", "yesterday", "3 days ago"). Anything older than a
 * week falls back to absolute date — at that distance the relative
 * label loses information without saving any space.
 */
function formatRelativePast(iso: string): string {
	const past = new Date(iso).getTime();
	const now = Date.now();
	const diffSeconds = Math.round((past - now) / 1000);
	const absSeconds = Math.abs(diffSeconds);

	if (absSeconds < 60) return RELATIVE_FORMATTER.format(diffSeconds, "second");
	if (absSeconds < 60 * 60)
		return RELATIVE_FORMATTER.format(Math.round(diffSeconds / 60), "minute");
	if (absSeconds < 60 * 60 * 24)
		return RELATIVE_FORMATTER.format(Math.round(diffSeconds / 3600), "hour");
	if (absSeconds < 60 * 60 * 24 * 7)
		return RELATIVE_FORMATTER.format(Math.round(diffSeconds / 86400), "day");
	return DATE_FORMATTER.format(new Date(iso));
}

/**
 * Threshold for detecting the "Never expires" mint choice from a
 * row's `expiresAt`. The mint UI maps "Never" to 36500 days (the
 * `keyExpiration.maxExpiresIn` cap configured in `lib/auth.ts`), so
 * the row's actual expiry sits ~100 years out. A 50-day buffer below
 * that ceiling covers clock skew and mint-vs-read time gaps without
 * admitting any realistic finite-expiry choice — the next-longest
 * mintable expiry is 1 year, two orders of magnitude away.
 */
const NEVER_EXPIRES_THRESHOLD_SECONDS = (36500 - 50) * 24 * 60 * 60;

function isEffectivelyNeverExpiring(iso: string): boolean {
	const future = new Date(iso).getTime();
	const now = Date.now();
	return (future - now) / 1000 > NEVER_EXPIRES_THRESHOLD_SECONDS;
}

/**
 * Convert a future ISO timestamp to a short "in N days" / "in 2 months"
 * label. Used for the per-row expiry strip. Caller is responsible for
 * detecting the never-expires sentinel via
 * `isEffectivelyNeverExpiring` first — this formatter only handles
 * realistic distances and would emit "in 73 years" for the 100-year
 * sentinel otherwise.
 */
function formatRelativeFuture(iso: string): string {
	const future = new Date(iso).getTime();
	const now = Date.now();
	const diffSeconds = Math.round((future - now) / 1000);
	const absSeconds = Math.abs(diffSeconds);

	if (absSeconds < 60 * 60 * 24)
		return RELATIVE_FORMATTER.format(Math.round(diffSeconds / 3600), "hour");
	if (absSeconds < 60 * 60 * 24 * 60)
		return RELATIVE_FORMATTER.format(Math.round(diffSeconds / 86400), "day");
	if (absSeconds < 60 * 60 * 24 * 365 * 2)
		return RELATIVE_FORMATTER.format(
			Math.round(diffSeconds / (86400 * 30)),
			"month",
		);
	return RELATIVE_FORMATTER.format(
		Math.round(diffSeconds / (86400 * 365)),
		"year",
	);
}

// ── Animation presets ──────────────────────────────────────────────

const ROW_EXIT = { opacity: 0, height: 0, marginTop: 0 } as const;
const ROW_TRANSITION = { duration: 0.25 } as const;

const REVEAL_VARIANTS = {
	hidden: { opacity: 0, y: 8 },
	visible: { opacity: 1, y: 0 },
} as const;

// ── Component ──────────────────────────────────────────────────────

export function ApiKeys({ initial }: ApiKeysProps) {
	const [rows, setRows] = useState<RowData[]>(() =>
		initial.map((r) => ({ ...r, status: { type: "idle" } as RowStatus })),
	);
	const [mintOpen, setMintOpen] = useState(false);
	const [editTarget, setEditTarget] = useState<RowData | null>(null);

	const setRowStatus = useCallback((keyId: string, status: RowStatus) => {
		setRows((prev) =>
			prev.map((r) => (r.keyId === keyId ? { ...r, status } : r)),
		);
	}, []);

	const handleRequestConfirm = useCallback(
		(keyId: string) => setRowStatus(keyId, { type: "confirming" }),
		[setRowStatus],
	);

	const handleCancelConfirm = useCallback(
		(keyId: string) => setRowStatus(keyId, { type: "idle" }),
		[setRowStatus],
	);

	const handleConfirmRevoke = useCallback(
		async (keyId: string) => {
			setRowStatus(keyId, { type: "revoking" });
			try {
				const result = await revokeApiKey(keyId);
				if (result.success) {
					setRows((prev) => prev.filter((r) => r.keyId !== keyId));
				} else {
					setRowStatus(keyId, { type: "error", message: result.error });
				}
			} catch {
				setRowStatus(keyId, {
					type: "error",
					message: "Could not revoke. Check your connection and try again.",
				});
			}
		},
		[setRowStatus],
	);

	/**
	 * Append a freshly-minted key to the visible list. Called from the
	 * mint dialog after the user confirms they've saved the plaintext
	 * key (the dialog handles the one-time reveal; this handler only
	 * sees the masked summary).
	 */
	const handleMintComplete = useCallback((row: ApiKeySummary) => {
		setRows((prev) => [
			{ ...row, status: { type: "idle" } as RowStatus },
			...prev,
		]);
	}, []);

	const handleScopesEdited = useCallback((keyId: string, scopes: string[]) => {
		/* Reset the row's status to idle alongside the scope update — a
		 * successful edit should clear any stale error from a previous
		 * revoke attempt on the same row. Without this, the error
		 * message would persist visually until the next revoke, which
		 * reads as "the edit failed" even though it didn't. */
		setRows((prev) =>
			prev.map((r) =>
				r.keyId === keyId ? { ...r, scopes, status: { type: "idle" } } : r,
			),
		);
		setEditTarget(null);
	}, []);

	return (
		<>
			<section className="rounded-xl border border-nova-border bg-nova-surface overflow-hidden">
				{/* ── Card header ───────────────────────────────────────── */}
				<div className="flex items-center gap-3 px-6 py-4 border-b border-nova-border/50">
					<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-nova-violet/10">
						<Icon
							icon={tablerKey}
							width="18"
							height="18"
							className="text-nova-violet-bright"
						/>
					</div>
					<div className="min-w-0 flex-1">
						<h2 className="text-base font-display font-semibold text-nova-text">
							API keys
						</h2>
						<p className="text-xs text-nova-text-muted">
							Keys you&apos;ve issued for accessing Nova on your behalf ·{" "}
							<a
								href={docsLink("/mcp/api-keys")}
								target="_blank"
								rel="noopener noreferrer"
								aria-label="Learn more about API keys"
								className="inline-flex items-center gap-0.5 text-nova-violet-bright transition-colors hover:text-nova-violet-bright underline-offset-2 hover:underline"
							>
								Learn more
								<Icon icon={tablerExternalLink} width="11" height="11" />
							</a>
						</p>
					</div>
					<button
						type="button"
						onClick={() => setMintOpen(true)}
						className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-nova-violet/30 bg-nova-violet/[0.10] px-3 py-1.5 text-xs font-medium text-nova-violet-bright outline-none transition-all duration-150 hover:border-nova-violet/50 hover:bg-nova-violet/[0.16] focus-visible:ring-1 focus-visible:ring-nova-violet/40"
					>
						<Icon icon={tablerPlus} width="13" height="13" />
						New key
					</button>
				</div>

				{/* ── Card body ─────────────────────────────────────────── */}
				<div className="p-6">
					<ul className="divide-y divide-nova-border/30">
						<AnimatePresence initial={false}>
							{rows.map((row) => (
								<motion.li
									key={row.keyId}
									/* No `layout` prop. We had it for smooth
									 * row-reorder animation, but every status flip
									 * (idle ↔ confirming ↔ revoking) routed through
									 * motion's layout system and triggered a height
									 * bounce on the entire row even with
									 * `layout="position"` — motion snapshots
									 * children's bounding boxes on every render and
									 * any subtree resize spills into the
									 * `<motion.li>`'s tracked geometry.
									 *
									 * Explicit `initial` / `animate` / `exit` give a
									 * grow-in / collapse-out animation when rows are
									 * added or removed, which is the only transition
									 * we actually want; status flips inside the row
									 * no longer touch the row's envelope at all. */
									initial={{ opacity: 0, height: 0 }}
									animate={{ opacity: 1, height: "auto" }}
									exit={ROW_EXIT}
									transition={ROW_TRANSITION}
									className="overflow-hidden"
								>
									<Row
										row={row}
										onRequestConfirm={handleRequestConfirm}
										onCancelConfirm={handleCancelConfirm}
										onConfirmRevoke={handleConfirmRevoke}
										onEditScopes={() => setEditTarget(row)}
									/>
								</motion.li>
							))}
						</AnimatePresence>
					</ul>
					<AnimatePresence initial={false}>
						{rows.length === 0 && (
							<motion.div
								key="empty"
								/* Collapse height (not just fade) on exit so the
								 * empty state doesn't sit underneath the freshly-
								 * minted first row during the swap. Without the
								 * height collapse, a new row mounts at the top of
								 * the `<ul>` while this div is still occupying
								 * full height below it, opacity dropping — the
								 * "stack flash" the user reported. `overflow:
								 * hidden` clips the contents while the wrapper
								 * shrinks. `height: "auto"` on entry/idle is what
								 * `motion` animates from/to via its internal
								 * layout machinery. */
								initial={{ opacity: 0, height: 0 }}
								animate={{ opacity: 1, height: "auto" }}
								exit={{ opacity: 0, height: 0 }}
								style={{ overflow: "hidden" }}
								transition={{ duration: 0.2 }}
							>
								<EmptyState />
							</motion.div>
						)}
					</AnimatePresence>
				</div>

				{/* ── Footer / assurance strip ──────────────────────────── */}
				<div className="flex items-start gap-2 border-t border-nova-border/30 px-6 py-3">
					<Icon
						icon={tablerShieldLock}
						width="14"
						height="14"
						className="mt-0.5 shrink-0 text-nova-violet-bright"
					/>
					<p className="text-xs text-nova-text-muted leading-relaxed">
						Keys are hashed at rest. Full values are shown once at creation, so
						store them somewhere safe.
					</p>
				</div>
			</section>

			<MintDialog
				open={mintOpen}
				onOpenChange={setMintOpen}
				onComplete={handleMintComplete}
			/>
			<EditScopesDialog
				target={editTarget}
				onCancel={() => setEditTarget(null)}
				onComplete={handleScopesEdited}
			/>
		</>
	);
}

// ── Row ────────────────────────────────────────────────────────────

interface RowProps {
	row: RowData;
	onRequestConfirm: (keyId: string) => void;
	onCancelConfirm: (keyId: string) => void;
	onConfirmRevoke: (keyId: string) => void;
	onEditScopes: () => void;
}

function Row({
	row,
	onRequestConfirm,
	onCancelConfirm,
	onConfirmRevoke,
	onEditScopes,
}: RowProps) {
	const { keyId, name, displayPrefix, scopes, lastUsedAt, expiresAt, status } =
		row;

	const expiryLabel =
		!expiresAt || isEffectivelyNeverExpiring(expiresAt)
			? "Never expires"
			: `Expires ${formatRelativeFuture(expiresAt)}`;
	const lastUsedLabel = lastUsedAt
		? `Last used ${formatRelativePast(lastUsedAt)}`
		: "Never used";

	return (
		<div className="flex items-center gap-4 py-3.5">
			<div className="min-w-0 flex-1">
				{/* Identity line: name + prefix + permissions chip.
				 *   The chip lives up here next to the name (rather
				 *   than down on the meta row) so it reads as part of
				 *   the credential's identity ("here is this key, and
				 *   here's what it can do") rather than as a metadata
				 *   sibling of the timestamps below. Mirrors the
				 *   connected-apps card so both rows on the settings
				 *   page have identical structure. */}
				<div className="flex items-center gap-2 min-w-0">
					<p className="text-sm font-medium text-nova-text truncate">{name}</p>
					{displayPrefix && (
						<code className="shrink-0 text-[11px] font-mono text-nova-text-muted">
							{displayPrefix}…
						</code>
					)}
					<ScopesPopover
						scopes={scopes}
						credentialLabel="API key"
						subjectName={name}
					/>
				</div>
				{/* Meta line: timestamps only. Stable two-item shape,
				 *   no wrap potential under action-column expansion
				 *   (the column to the right is width-reserved for the
				 *   confirm-revoke state). */}
				<div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-nova-text-muted">
					{/* Both labels are "now"-relative (down to seconds for a
					 *  just-used key), so the server render and the hydration
					 *  pass legitimately disagree — same contract as
					 *  `RelativeTime`, which these can't reuse because they
					 *  format through Intl with their own prefixes. */}
					<span suppressHydrationWarning>{lastUsedLabel}</span>
					<span className="text-nova-text-muted">·</span>
					<span suppressHydrationWarning>{expiryLabel}</span>
				</div>
				<AnimatePresence>
					{status.type === "error" && (
						<motion.p
							key="error"
							initial={{ opacity: 0, y: -4 }}
							animate={{ opacity: 1, y: 0 }}
							exit={{ opacity: 0, y: -4 }}
							transition={{ duration: 0.2 }}
							className="mt-1 text-xs leading-relaxed text-nova-rose"
						>
							{status.message}
						</motion.p>
					)}
				</AnimatePresence>
			</div>

			{/* Reserved-width action column. The kebab (idle) is 36px,
			 *   `Cancel + Confirm revoke` (confirming) is ~190px. Without
			 *   pinning the column to the WIDEST state, the swap would
			 *   eat space from the meta line and wrap "Last used X ·
			 *   Expires Y" onto a second row mid-transition. Holding the
			 *   space reserved keeps the left column's width stable
			 *   across every status, and `justify-end` pushes the
			 *   narrower idle/revoking content to the right edge so the
			 *   visual position of the trigger doesn't move either. */}
			<div className="flex shrink-0 justify-end min-w-[12rem]">
				<RowActions
					keyId={keyId}
					status={status}
					onRequestConfirm={onRequestConfirm}
					onCancelConfirm={onCancelConfirm}
					onConfirmRevoke={onConfirmRevoke}
					onEditScopes={onEditScopes}
				/>
			</div>
		</div>
	);
}

// ── Scope checkbox grid ────────────────────────────────────────────

interface ScopeCheckboxGridProps {
	selectedScopes: Set<string>;
	onToggle: (scope: string) => void;
}

/**
 * Two-column scope picker, shared by `MintForm` and
 * `EditScopesDialog`. Floor scopes (`nova.read` + `nova.write`) are
 * locked-checked via Base UI's `disabled` prop — Base UI handles the
 * disabled-state styling, ARIA, focus rings, and keyboard semantics
 * (Space toggles, Tab traverses) automatically; we just style off the
 * `data-checked` / `data-disabled` attributes Base UI sets.
 *
 * `Checkbox.Root` is rendered as the WHOLE card (not a nested
 * indicator). That way the entire colored card is the click target,
 * keyboard focus lands on the same surface a user clicks, and
 * disabled state propagates to the wrapper visuals without a
 * separate hand-painted "wrapper sees one state, control sees
 * another" path. The indicator pip renders as a child element
 * inside.
 */
function ScopeCheckboxGrid({
	selectedScopes,
	onToggle,
}: ScopeCheckboxGridProps) {
	return (
		<div className="grid grid-cols-2 gap-2">
			{NOVA_API_KEY_SCOPES.map((scope) => {
				const locked = FLOOR_SCOPES_SET.has(scope);
				return (
					<Checkbox.Root
						key={scope}
						checked={selectedScopes.has(scope)}
						disabled={locked}
						onCheckedChange={() => onToggle(scope)}
						className="group flex w-full cursor-pointer items-center gap-2 rounded-md border border-nova-border bg-transparent px-2.5 py-2 text-sm text-nova-text outline-none transition-colors not-data-[disabled]:hover:border-nova-violet/30 not-data-[disabled]:hover:bg-nova-violet/[0.05] data-[checked]:border-nova-violet/40 data-[checked]:bg-nova-violet/[0.10] data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 focus-visible:border-nova-violet focus-visible:ring-1 focus-visible:ring-nova-violet/40"
					>
						<span
							aria-hidden
							className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border border-nova-border bg-nova-deep transition-colors group-data-[checked]:border-nova-violet group-data-[checked]:bg-nova-violet"
						>
							<Checkbox.Indicator className="flex items-center justify-center text-nova-deep">
								<Icon icon={tablerCheck} width="11" height="11" />
							</Checkbox.Indicator>
						</span>
						<span>{NOVA_MCP_SCOPE_LABELS[scope] ?? scope}</span>
					</Checkbox.Root>
				);
			})}
		</div>
	);
}

// ── Row actions ────────────────────────────────────────────────────

interface RowActionsProps {
	keyId: string;
	status: RowStatus;
	onRequestConfirm: (keyId: string) => void;
	onCancelConfirm: (keyId: string) => void;
	onConfirmRevoke: (keyId: string) => void;
	onEditScopes: () => void;
}

function RowActions({
	keyId,
	status,
	onRequestConfirm,
	onCancelConfirm,
	onConfirmRevoke,
	onEditScopes,
}: RowActionsProps) {
	/* All three branches return content sized to the SAME 36px tall
	 * box. Without that, swapping idle ↔ confirming ↔ revoking would
	 * change the action column's height by a few pixels (the kebab is
	 * 36px while a `py-1.5 text-sm` button is ~32px), which the parent
	 * `<motion.li>` would then try to animate. Pinning every variant
	 * to `h-9` keeps the row's bounding box stable across state
	 * flips. */
	if (status.type === "revoking") {
		return (
			<span className="inline-flex h-9 items-center gap-1.5 px-3 text-sm text-nova-text-muted">
				<Icon
					icon={tablerLoader2}
					width="14"
					height="14"
					className="animate-spin"
				/>
				Revoking…
			</span>
		);
	}

	if (status.type === "confirming") {
		return (
			<div className="flex h-9 items-center gap-1.5">
				<button
					type="button"
					onClick={() => onCancelConfirm(keyId)}
					className="cursor-pointer rounded-md px-3 h-full text-sm text-nova-text-secondary transition-colors hover:bg-nova-border/30 hover:text-nova-text"
				>
					Cancel
				</button>
				<button
					type="button"
					onClick={() => onConfirmRevoke(keyId)}
					className="cursor-pointer rounded-md bg-nova-rose/10 px-3 h-full text-sm font-medium text-nova-rose transition-colors hover:bg-nova-rose/15"
				>
					Confirm revoke
				</button>
			</div>
		);
	}

	/* idle / error: kebab menu with Edit / Revoke */
	return (
		<Menu.Root>
			<Menu.Trigger
				aria-label="Actions for this key"
				className="w-9 h-9 flex items-center justify-center rounded-md transition-colors text-nova-text-muted hover:text-nova-text hover:bg-white/[0.06] cursor-pointer outline-none data-[popup-open]:bg-white/[0.06]"
			>
				<Icon icon={tablerDotsVertical} width="18" height="18" />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner
					className={MENU_POSITIONER_CLS}
					sideOffset={4}
					align="end"
				>
					<Menu.Popup className={MENU_POPUP_CLS} style={{ minWidth: 180 }}>
						<Menu.Item className={MENU_ITEM_CLS} onClick={onEditScopes}>
							<Icon
								icon={tablerPencil}
								width="15"
								height="15"
								className="text-nova-text-muted"
							/>
							Edit scopes
						</Menu.Item>
						<Menu.Separator className="mx-2 h-px bg-white/[0.06]" />
						<Menu.Item
							className={`${MENU_ITEM_CLS} data-[highlighted]:bg-nova-rose/[0.08] data-[highlighted]:text-nova-rose`}
							onClick={() => onRequestConfirm(keyId)}
						>
							<Icon
								icon={tablerTrash}
								width="15"
								height="15"
								className="text-nova-rose"
							/>
							Revoke
						</Menu.Item>
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}

// ── Empty state ────────────────────────────────────────────────────

function EmptyState() {
	return (
		<div className="flex flex-col items-center gap-3 py-6 text-center">
			<Icon
				icon={tablerKey}
				width="28"
				height="28"
				className="text-nova-text-muted"
			/>
			<div className="space-y-1">
				<p className="text-sm text-nova-text">No API keys yet</p>
				<p className="max-w-xs text-xs text-nova-text-muted leading-relaxed">
					Mint one to connect a tool to Nova on your behalf.
				</p>
			</div>
		</div>
	);
}

// ── Mint dialog ────────────────────────────────────────────────────

const DIALOG_BACKDROP_CLS =
	"fixed inset-0 z-modal bg-black/60 transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0";

const DIALOG_POPUP_CLS =
	"fixed z-modal top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md rounded-xl bg-nova-deep border border-nova-border shadow-xl outline-none transition-[transform,opacity] data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0";

interface MintDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onComplete: (row: ApiKeySummary) => void;
}

/**
 * Two-phase dialog. Phase 1: form (name + scopes + expiry). Phase 2:
 * key reveal (full plaintext + Copy + acknowledgment). The reveal phase
 * is reachable only via a successful mint — there is no "regenerate"
 * affordance because the plugin doesn't store the plaintext to
 * regenerate from.
 */
function MintDialog({ open, onOpenChange, onComplete }: MintDialogProps) {
	const [phase, setPhase] = useState<"form" | "reveal">("form");
	const [name, setName] = useState("");
	const [selectedScopes, setSelectedScopes] = useState<Set<string>>(
		() => new Set(NOVA_MCP_FLOOR_SCOPES),
	);
	const [expiry, setExpiry] = useState<ExpiryOption>("1y");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [revealedKey, setRevealedKey] = useState<string | null>(null);
	const [revealedSummary, setRevealedSummary] = useState<ApiKeySummary | null>(
		null,
	);
	const [copied, setCopied] = useState(false);

	/**
	 * Clear the plaintext key from React state on dialog close. The
	 * value never goes to localStorage / sessionStorage / the DOM
	 * after the reveal phase is dismissed, and never crosses a
	 * network transport beyond the original mint response. The clear
	 * here drops the in-memory reference so React's eventual GC can
	 * reclaim it; under a same-origin debugger or React DevTools the
	 * value is recoverable for the duration of the user's session
	 * regardless. This is the surface the "show the key once" flow
	 * actually defends — not in-process JS introspection (which
	 * isn't a meaningful threat for an authenticated settings page).
	 */
	useEffect(() => {
		if (open) return;
		setRevealedKey(null);
		setRevealedSummary(null);
		setCopied(false);
	}, [open]);

	/* Reset the form (and any error from the previous mint) when the
	 * dialog opens fresh — keeps the next mint from inheriting stale
	 * state if the user closed mid-form last time. */
	useEffect(() => {
		if (!open) return;
		setPhase("form");
		setName("");
		setSelectedScopes(new Set(NOVA_MCP_FLOOR_SCOPES));
		setExpiry("1y");
		setSubmitting(false);
		setError(null);
	}, [open]);

	const toggleScope = useCallback((scope: string) => {
		setSelectedScopes((prev) => {
			const next = new Set(prev);
			if (next.has(scope)) {
				/* Floor scopes can't be unchecked — both are required for any
				 * MCP call, and silently re-adding them on submit would
				 * mislead the user about what their key can do. The checkbox
				 * is rendered as disabled-but-checked in the form. */
				if (FLOOR_SCOPES_SET.has(scope)) return prev;
				next.delete(scope);
			} else {
				next.add(scope);
			}
			return next;
		});
	}, []);

	const handleSubmit = useCallback(async () => {
		setError(null);
		setSubmitting(true);
		try {
			const result = await mintApiKey({
				name,
				scopes: Array.from(selectedScopes),
				expiry,
			});
			if (!result.success) {
				setError(result.error);
				setSubmitting(false);
				return;
			}
			const summary: ApiKeySummary = {
				keyId: result.keyId,
				name,
				displayPrefix: result.displayPrefix,
				scopes: Array.from(selectedScopes),
				createdAt: result.createdAt,
				expiresAt: result.expiresAt,
				lastUsedAt: null,
			};
			setRevealedKey(result.key);
			setRevealedSummary(summary);
			setPhase("reveal");
			setSubmitting(false);
		} catch {
			setError("Could not reach the server. Try again in a moment.");
			setSubmitting(false);
		}
	}, [name, selectedScopes, expiry]);

	const handleCopy = useCallback(async () => {
		if (!revealedKey) return;
		try {
			await navigator.clipboard.writeText(revealedKey);
			setCopied(true);
			/* Reset the "Copied" affordance after a beat so a second copy
			 * (e.g., after switching to a different terminal) still gets the
			 * confirming flash. */
			window.setTimeout(() => setCopied(false), 1800);
		} catch {
			setError(
				"Couldn't copy automatically — select the key and copy by hand.",
			);
		}
	}, [revealedKey]);

	const handleAcknowledge = useCallback(() => {
		if (revealedSummary) onComplete(revealedSummary);
		onOpenChange(false);
	}, [revealedSummary, onComplete, onOpenChange]);

	/**
	 * Block accidental dismissal during two windows where closing the
	 * dialog destroys data:
	 *
	 *   1. **Reveal phase.** The plaintext key lives in component
	 *      state only; once the dialog closes the reset effect clears
	 *      `revealedKey` and the user has no recovery path — the row
	 *      exists hashed in Firestore but the plaintext is
	 *      unrecoverable, costing a credential and a slot toward the
	 *      per-user limit. The "I've saved this key" button is the
	 *      only acknowledgment path the design admits.
	 *   2. **Form phase while submitting.** Same data-loss shape: the
	 *      in-flight `mintApiKey` resolves on a now-closed dialog, the
	 *      close-effect has already nulled `revealedKey`, and the user
	 *      never sees the response. The Cancel and X buttons are
	 *      disabled during submit (button-level guard), but Escape /
	 *      outside-press / focus-out skip the buttons and would
	 *      otherwise close — this branch closes that race.
	 *
	 * Imperative closes (the "I've saved this key" acknowledgment)
	 * carry `reason: "none"` and pass through.
	 */
	const handleDialogOpenChange = useCallback(
		(next: boolean, details: Dialog.Root.ChangeEventDetails) => {
			const isDismissReason =
				details.reason === "outside-press" ||
				details.reason === "escape-key" ||
				details.reason === "focus-out";
			const wouldDestroyData =
				phase === "reveal" || (phase === "form" && submitting);
			if (!next && isDismissReason && wouldDestroyData) {
				details.cancel();
				return;
			}
			onOpenChange(next);
		},
		[phase, submitting, onOpenChange],
	);

	return (
		<Dialog.Root open={open} onOpenChange={handleDialogOpenChange}>
			<Dialog.Portal>
				<Dialog.Backdrop className={DIALOG_BACKDROP_CLS} />
				<Dialog.Popup className={DIALOG_POPUP_CLS}>
					{phase === "form" ? (
						<MintForm
							name={name}
							onNameChange={setName}
							selectedScopes={selectedScopes}
							onToggleScope={toggleScope}
							expiry={expiry}
							onExpiryChange={setExpiry}
							submitting={submitting}
							error={error}
							onSubmit={handleSubmit}
							onCancel={() => onOpenChange(false)}
						/>
					) : (
						<RevealedKey
							revealedKey={revealedKey ?? ""}
							copied={copied}
							error={error}
							onCopy={handleCopy}
							onAcknowledge={handleAcknowledge}
						/>
					)}
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

// ── Mint form (phase 1) ─────────────────────────────────────────────

interface MintFormProps {
	name: string;
	onNameChange: (name: string) => void;
	selectedScopes: Set<string>;
	onToggleScope: (scope: string) => void;
	expiry: ExpiryOption;
	onExpiryChange: (expiry: ExpiryOption) => void;
	submitting: boolean;
	error: string | null;
	onSubmit: () => void;
	onCancel: () => void;
}

const EXPIRY_OPTIONS: ReadonlyArray<{ value: ExpiryOption; label: string }> = [
	{ value: "30d", label: "30 days" },
	{ value: "90d", label: "90 days" },
	{ value: "1y", label: "1 year" },
	{ value: "never", label: "Never expires" },
];

function MintForm({
	name,
	onNameChange,
	selectedScopes,
	onToggleScope,
	expiry,
	onExpiryChange,
	submitting,
	error,
	onSubmit,
	onCancel,
}: MintFormProps) {
	const canSubmit = name.trim().length > 0 && !submitting;

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				if (canSubmit) onSubmit();
			}}
		>
			<div className="flex items-start justify-between border-b border-nova-border/40 px-6 py-4">
				<div>
					<Dialog.Title className="text-base font-display font-semibold text-nova-text">
						New API key
					</Dialog.Title>
					<Dialog.Description className="mt-0.5 text-xs text-nova-text-muted">
						You'll see the full key once. Store it somewhere safe.
					</Dialog.Description>
				</div>
				<button
					type="button"
					onClick={onCancel}
					disabled={submitting}
					aria-label="Close"
					className="rounded-md p-1 text-nova-text-muted transition-colors hover:bg-white/[0.06] hover:text-nova-text disabled:cursor-not-allowed disabled:opacity-40"
				>
					<Icon icon={tablerX} width="16" height="16" />
				</button>
			</div>

			<div className="space-y-5 px-6 py-5">
				{/* Name */}
				<Field.Root name="name" className="block">
					<Field.Label className="text-xs font-medium text-nova-text">
						Name{" "}
						<span aria-hidden className="text-nova-rose">
							*
						</span>
						<span className="sr-only">(required)</span>
					</Field.Label>
					<Field.Control
						required
						value={name}
						onValueChange={onNameChange}
						placeholder="e.g., ACE service account"
						maxLength={32}
						autoComplete="off"
						data-1p-ignore
						className="mt-1.5 w-full rounded-lg border border-nova-border bg-nova-deep px-3 py-2 text-sm text-nova-text placeholder:text-nova-text-muted outline-none transition-all focus:border-nova-violet focus:shadow-[var(--nova-glow-violet)]"
					/>
				</Field.Root>

				{/* Scopes */}
				<fieldset className="space-y-2">
					<legend className="text-xs font-medium text-nova-text">Scopes</legend>
					<p className="-mt-1 text-[11px] text-nova-text-muted">
						Read and write are required. Add the HQ scopes if your tool needs to
						upload finished apps to CommCare HQ.
					</p>
					<div className="mt-2">
						<ScopeCheckboxGrid
							selectedScopes={selectedScopes}
							onToggle={onToggleScope}
						/>
					</div>
				</fieldset>

				{/* Expiry */}
				<Select.Root
					value={expiry}
					onValueChange={(v) => onExpiryChange(v as ExpiryOption)}
					items={EXPIRY_OPTIONS}
				>
					<Select.Label className="block text-xs font-medium text-nova-text">
						Expiry
					</Select.Label>
					<Select.Trigger className="mt-1.5 flex w-full cursor-pointer items-center justify-between rounded-lg border border-nova-border bg-nova-deep px-3 py-2 text-sm text-nova-text outline-none transition-all focus-visible:border-nova-violet focus-visible:shadow-[var(--nova-glow-violet)] data-[popup-open]:border-nova-violet">
						<Select.Value />
						<Select.Icon className="text-nova-text-muted transition-transform data-[popup-open]:rotate-180">
							<Icon icon={tablerChevronDown} width="14" height="14" />
						</Select.Icon>
					</Select.Trigger>
					<Select.Portal>
						<Select.Positioner
							sideOffset={4}
							alignItemWithTrigger={false}
							className="z-modal min-w-[var(--anchor-width)] outline-none"
						>
							<Select.Popup className="overflow-hidden rounded-lg border border-nova-border bg-nova-deep shadow-xl outline-none">
								{EXPIRY_OPTIONS.map((opt) => (
									<Select.Item
										key={opt.value}
										value={opt.value}
										className="flex cursor-pointer items-center justify-between px-3 py-2 text-sm text-nova-text outline-none transition-colors data-[highlighted]:bg-nova-violet/[0.10] data-[selected]:bg-nova-violet/[0.06]"
									>
										<Select.ItemText>{opt.label}</Select.ItemText>
										<Select.ItemIndicator className="text-nova-violet-bright">
											<Icon icon={tablerCheck} width="13" height="13" />
										</Select.ItemIndicator>
									</Select.Item>
								))}
							</Select.Popup>
						</Select.Positioner>
					</Select.Portal>
				</Select.Root>

				{/* Inline error */}
				<AnimatePresence>
					{error && (
						<motion.p
							key="error"
							initial={{ opacity: 0, y: -4 }}
							animate={{ opacity: 1, y: 0 }}
							exit={{ opacity: 0, y: -4 }}
							transition={{ duration: 0.2 }}
							className="text-xs leading-relaxed text-nova-rose"
						>
							{error}
						</motion.p>
					)}
				</AnimatePresence>
			</div>

			{/*
			 * Cancel + X disabled during submit. Two layers cover the
			 * same data-loss race (mid-mint dismissal closes the dialog
			 * before `mintApiKey` resolves, the close-effect nulls
			 * `revealedKey`, the user can't see the plaintext but the
			 * row exists hashed in Firestore consuming a slot):
			 *   - Button level (here): Escape / outside-press still
			 *     work without these but the buttons themselves bypass
			 *     `Dialog.Root.onOpenChange`, so the dialog-level guard
			 *     can't reach them.
			 *   - Dialog level (`handleDialogOpenChange`): cancels
			 *     dismiss reasons during reveal-phase AND during
			 *     form-phase + submitting.
			 */}
			<div className="flex items-center justify-end gap-2 border-t border-nova-border/40 bg-nova-surface/10 px-6 py-3.5">
				<button
					type="button"
					onClick={onCancel}
					disabled={submitting}
					className="rounded-md px-3 py-1.5 text-sm text-nova-text-secondary transition-colors enabled:cursor-pointer enabled:hover:bg-nova-border/30 enabled:hover:text-nova-text disabled:cursor-not-allowed disabled:opacity-40"
				>
					Cancel
				</button>
				<button
					type="submit"
					disabled={!canSubmit}
					className="inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-nova-action px-4 py-1.5 text-sm font-medium text-white outline-none transition-all hover:bg-nova-action-hover focus-visible:ring-1 focus-visible:ring-nova-violet-bright disabled:cursor-not-allowed disabled:opacity-40"
				>
					{submitting && (
						<Icon
							icon={tablerLoader2}
							width="13"
							height="13"
							className="animate-spin"
						/>
					)}
					{submitting ? "Minting…" : "Mint key"}
				</button>
			</div>
		</form>
	);
}

// ── Revealed key (phase 2) ──────────────────────────────────────────

interface RevealedKeyProps {
	revealedKey: string;
	copied: boolean;
	/** Error surfaced from `handleCopy` (e.g., clipboard permission
	 *  denied, insecure context). Rendered below the copy button so
	 *  the user has a recovery path — without this, a clipboard
	 *  failure looks identical to a slow click and the key appears
	 *  uncopyable. */
	error: string | null;
	onCopy: () => void;
	onAcknowledge: () => void;
}

function RevealedKey({
	revealedKey,
	copied,
	error,
	onCopy,
	onAcknowledge,
}: RevealedKeyProps) {
	return (
		<motion.div
			initial="hidden"
			animate="visible"
			variants={REVEAL_VARIANTS}
			transition={{ duration: 0.25 }}
		>
			<div className="border-b border-nova-border/40 px-6 py-4">
				<div className="flex items-center gap-2">
					<Icon
						icon={tablerCircleCheck}
						width="16"
						height="16"
						className="text-nova-violet-bright"
					/>
					<Dialog.Title className="text-base font-display font-semibold text-nova-text">
						Key created
					</Dialog.Title>
				</div>
				<Dialog.Description className="mt-1 text-xs text-nova-text-muted leading-relaxed">
					Copy this key now. Nova won't keep the full value — close this and
					it's gone.
				</Dialog.Description>
			</div>

			<div className="space-y-3 px-6 py-5">
				<div className="rounded-lg border border-nova-violet/25 bg-nova-violet/[0.06] p-3">
					<code className="block break-all font-mono text-[12px] leading-relaxed text-nova-text">
						{revealedKey}
					</code>
				</div>
				<button
					type="button"
					onClick={onCopy}
					className="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-md border border-nova-border bg-transparent px-3 py-2 text-sm text-nova-text transition-colors hover:border-nova-violet/40 hover:bg-nova-violet/[0.05]"
				>
					<AnimatePresence mode="wait" initial={false}>
						{copied ? (
							<motion.span
								key="copied"
								initial={{ opacity: 0, scale: 0.95 }}
								animate={{ opacity: 1, scale: 1 }}
								exit={{ opacity: 0, scale: 0.95 }}
								transition={{ duration: 0.15 }}
								className="inline-flex items-center gap-1.5 text-nova-violet-bright"
							>
								<Icon icon={tablerCheck} width="14" height="14" />
								Copied to clipboard
							</motion.span>
						) : (
							<motion.span
								key="copy"
								initial={{ opacity: 0, scale: 0.95 }}
								animate={{ opacity: 1, scale: 1 }}
								exit={{ opacity: 0, scale: 0.95 }}
								transition={{ duration: 0.15 }}
								className="inline-flex items-center gap-1.5"
							>
								<Icon icon={tablerCopy} width="14" height="14" />
								Copy key
							</motion.span>
						)}
					</AnimatePresence>
				</button>
				<AnimatePresence>
					{error && (
						<motion.p
							key="reveal-error"
							initial={{ opacity: 0, y: -4 }}
							animate={{ opacity: 1, y: 0 }}
							exit={{ opacity: 0, y: -4 }}
							transition={{ duration: 0.2 }}
							className="text-xs leading-relaxed text-nova-rose"
						>
							{error}
						</motion.p>
					)}
				</AnimatePresence>
			</div>

			<div className="flex items-center justify-end border-t border-nova-border/40 bg-nova-surface/10 px-6 py-3.5">
				<button
					type="button"
					onClick={onAcknowledge}
					className="rounded-md bg-nova-action px-4 py-1.5 text-sm font-medium text-white transition-all hover:bg-nova-action-hover"
				>
					I've saved this key
				</button>
			</div>
		</motion.div>
	);
}

// ── Edit scopes dialog ──────────────────────────────────────────────

interface EditScopesDialogProps {
	target: RowData | null;
	onCancel: () => void;
	onComplete: (keyId: string, scopes: string[]) => void;
}

function EditScopesDialog({
	target,
	onCancel,
	onComplete,
}: EditScopesDialogProps) {
	const [selectedScopes, setSelectedScopes] = useState<Set<string>>(new Set());
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!target) return;
		setSelectedScopes(new Set(target.scopes));
		setSubmitting(false);
		setError(null);
	}, [target]);

	const toggleScope = useCallback((scope: string) => {
		setSelectedScopes((prev) => {
			const next = new Set(prev);
			if (next.has(scope)) {
				if (FLOOR_SCOPES_SET.has(scope)) return prev;
				next.delete(scope);
			} else {
				next.add(scope);
			}
			return next;
		});
	}, []);

	const dirty = useMemo(() => {
		if (!target) return false;
		const current = new Set(target.scopes);
		if (current.size !== selectedScopes.size) return true;
		for (const s of current) if (!selectedScopes.has(s)) return true;
		return false;
	}, [target, selectedScopes]);

	const handleSave = useCallback(async () => {
		if (!target) return;
		setError(null);
		setSubmitting(true);
		try {
			const result = await editApiKeyScopes(
				target.keyId,
				Array.from(selectedScopes),
			);
			if (!result.success) {
				setError(result.error);
				setSubmitting(false);
				return;
			}
			onComplete(target.keyId, Array.from(selectedScopes));
		} catch {
			setError("Could not reach the server. Try again in a moment.");
			setSubmitting(false);
		}
	}, [target, selectedScopes, onComplete]);

	/**
	 * Block accidental dismissal during a save — same data-loss-class
	 * race as `MintDialog`, smaller surface (no plaintext key, but the
	 * inline error from a failed save would unmount mid-await and
	 * vanish). Cancels Escape / outside-press / focus-out only while
	 * `submitting`; clicks on the explicit Cancel / X / Save buttons
	 * carry `reason: "none"` and pass through.
	 */
	const handleDialogOpenChange = useCallback(
		(next: boolean, details: Dialog.Root.ChangeEventDetails) => {
			const isDismissReason =
				details.reason === "outside-press" ||
				details.reason === "escape-key" ||
				details.reason === "focus-out";
			if (!next && submitting && isDismissReason) {
				details.cancel();
				return;
			}
			if (!next) onCancel();
		},
		[submitting, onCancel],
	);

	if (!target) return null;

	return (
		<Dialog.Root open={!!target} onOpenChange={handleDialogOpenChange}>
			<Dialog.Portal>
				<Dialog.Backdrop className={DIALOG_BACKDROP_CLS} />
				<Dialog.Popup className={DIALOG_POPUP_CLS}>
					<div className="flex items-start justify-between border-b border-nova-border/40 px-6 py-4">
						<div className="min-w-0">
							<Dialog.Title className="text-base font-display font-semibold text-nova-text">
								Edit scopes
							</Dialog.Title>
							<Dialog.Description className="mt-0.5 text-xs text-nova-text-muted truncate">
								{target.name}
							</Dialog.Description>
						</div>
						<button
							type="button"
							onClick={onCancel}
							disabled={submitting}
							aria-label="Close"
							className="rounded-md p-1 text-nova-text-muted transition-colors hover:bg-white/[0.06] hover:text-nova-text disabled:cursor-not-allowed disabled:opacity-40"
						>
							<Icon icon={tablerX} width="16" height="16" />
						</button>
					</div>

					<div className="space-y-3 px-6 py-5">
						<ScopeCheckboxGrid
							selectedScopes={selectedScopes}
							onToggle={toggleScope}
						/>

						<AnimatePresence>
							{error && (
								<motion.p
									key="error"
									initial={{ opacity: 0, y: -4 }}
									animate={{ opacity: 1, y: 0 }}
									exit={{ opacity: 0, y: -4 }}
									transition={{ duration: 0.2 }}
									className="text-xs leading-relaxed text-nova-rose"
								>
									{error}
								</motion.p>
							)}
						</AnimatePresence>
					</div>

					<div className="flex items-center justify-end gap-2 border-t border-nova-border/40 bg-nova-surface/10 px-6 py-3.5">
						<button
							type="button"
							onClick={onCancel}
							disabled={submitting}
							className="rounded-md px-3 py-1.5 text-sm text-nova-text-secondary transition-colors enabled:cursor-pointer enabled:hover:bg-nova-border/30 enabled:hover:text-nova-text disabled:cursor-not-allowed disabled:opacity-40"
						>
							Cancel
						</button>
						<button
							type="button"
							onClick={handleSave}
							disabled={!dirty || submitting}
							className="inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-nova-action px-4 py-1.5 text-sm font-medium text-white outline-none transition-all hover:bg-nova-action-hover focus-visible:ring-1 focus-visible:ring-nova-violet-bright disabled:cursor-not-allowed disabled:opacity-40"
						>
							{submitting && (
								<Icon
									icon={tablerLoader2}
									width="13"
									height="13"
									className="animate-spin"
								/>
							)}
							{submitting ? "Saving…" : "Save scopes"}
						</button>
					</div>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
