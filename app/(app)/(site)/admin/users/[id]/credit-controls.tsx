/**
 * Credit controls — the admin reset/grant surface for a single user.
 *
 * This is the highest-stakes control in the admin app: confirming either
 * dialog fires a real, credit-mutating Firestore write (and an append-only
 * audit row) via `POST /api/admin/users/{id}/credits`. Two principles govern
 * the interaction model here, both load-bearing:
 *
 *   1. Every credit mutation goes through a confirm dialog, so a mis-click
 *      can't zero a user's month or hand out bonus credits silently.
 *   2. The dialog is CONTROLLED and stays open until the request settles —
 *      see `runCreditAction` for why the in-flight state is a flag, not a
 *      never-resolving promise, and why every dismiss path is gated on it.
 *
 * After a successful write we `navigate.refresh()` to re-stream the parent
 * server section, which re-reads Firestore — so the balance summary and the
 * audit list below update from source rather than from optimistic local
 * state we'd otherwise have to keep in sync.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerRefresh from "@iconify-icons/tabler/refresh";
import { useState } from "react";
import { tablerCredits } from "@/components/icons/tablerExtras";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/shadcn/alert-dialog";
import { Field, FieldLabel } from "@/components/shadcn/field";
import { Input } from "@/components/shadcn/input";
import { Badge } from "@/components/ui/Badge";
import { RelativeTime } from "@/components/ui/RelativeTime";
// `import type` is mandatory here: this is a "use client" module, and the
// VALUE side of `@/lib/db/credits` pulls in `@google-cloud/firestore`. A plain
// import would drag server-only Firestore into the client bundle (a build-time
// break that `tsc --noEmit` doesn't surface). The types are erased at compile
// time, so this stays purely a type dependency. `@/lib/admin/types` is already
// type-only by construction but we keep the same discipline for clarity.
import type { CreditGrantAudit } from "@/lib/admin/types";
import type { CreditSummary } from "@/lib/db/credits";
import { useExternalNavigate } from "@/lib/routing/hooks";
import { showToast } from "@/lib/ui/toastStore";
import { formatPeriodLabel } from "@/lib/utils/format";

/** Which action is currently in flight (mutually exclusive — one dialog at a time). */
type PendingAction = "reset" | "grant";

interface CreditControlsProps {
	/** The user whose credits these controls mutate. */
	userId: string;
	/** Current-period balance components + lifetime consumed, read server-side. */
	credits: CreditSummary;
	/** Admin intervention audit trail, already ordered newest-first. */
	grants: CreditGrantAudit[];
}

/** The two request body shapes the credits endpoint accepts. */
type CreditPayload =
	| { action: "reset"; reason?: string }
	| { action: "grant"; amount: number; reason?: string };

export function CreditControls({
	userId,
	credits,
	grants,
}: CreditControlsProps) {
	const navigate = useExternalNavigate();

	// In-flight state is a FLAG, never a never-resolving promise: we set it
	// before `fetch`, clear it in `finally`, and disable controls while it's
	// set. A `new Promise(() => {})` to model "pending forever" would be a
	// permanent async leak (the build has a leak gate that would catch it).
	// `null` = idle; otherwise the action that's mid-request.
	const [pending, setPending] = useState<PendingAction | null>(null);

	// Each dialog owns its open state so we can keep it open across the async
	// request and close it ONLY on success (see `runCreditAction`). An
	// uncontrolled dialog would close on confirm-click before the write
	// resolved, hiding the spinner and losing the place to surface a retry.
	const [resetOpen, setResetOpen] = useState(false);
	const [grantOpen, setGrantOpen] = useState(false);

	// Free-text justification recorded on the audit row. Optional on both arms;
	// an empty string is sent as `undefined` so we never stamp a blank reason.
	const [resetReason, setResetReason] = useState("");
	const [grantReason, setGrantReason] = useState("");

	// The grant amount is held as the raw input string (not a number) so the
	// validity check below can reject an empty field, a fractional value, or a
	// non-positive value uniformly. `Number("")` is `0`, which fails the
	// positive-integer test naturally — no special-casing of the empty case.
	const [grantAmount, setGrantAmount] = useState("");
	const grantAmountValue = Number(grantAmount);
	const grantAmountValid =
		Number.isInteger(grantAmountValue) && grantAmountValue > 0;

	/**
	 * Fire one credit mutation against the endpoint and reconcile the UI.
	 *
	 * The leak-safe contract this function enforces:
	 *   - `setPending(action)` BEFORE the fetch, `setPending(null)` in `finally`
	 *     so the flag clears on the success path, the error path, AND a thrown
	 *     network error — there is no branch that leaves a control stuck disabled.
	 *   - The dialog stays open for the entire request. We close it (and reset
	 *     the form) ONLY after a 2xx; on any failure it stays open so the admin
	 *     can read the toast and retry without re-opening.
	 *   - On success, `navigate.refresh()` re-streams the parent server section,
	 *     which re-reads Firestore — fresh balance + the new audit row, no
	 *     optimistic local mutation to keep consistent.
	 */
	const runCreditAction = async (
		action: PendingAction,
		payload: CreditPayload,
		closeDialog: () => void,
		resetForm: () => void,
	) => {
		setPending(action);
		try {
			const res = await fetch(`/api/admin/users/${userId}/credits`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});

			if (res.ok) {
				showToast(
					"info",
					"Credits updated",
					action === "reset"
						? "This month's used credits were reset to zero."
						: "Bonus credits were added to this user.",
				);
				closeDialog();
				resetForm();
				// Re-read the server section so the balance + audit list reflect
				// the write we just made, sourced from Firestore rather than guessed.
				navigate.refresh();
				return;
			}

			// Non-2xx: surface the endpoint's `{ error }` message and keep the
			// dialog open. `.catch` guards against a non-JSON error body.
			const { error } = await res
				.json()
				.catch(() => ({ error: "Something went wrong." }));
			showToast("error", "Couldn't update credits", error);
		} catch {
			// A network-level failure (fetch rejected) — still toast, still fall
			// through to `finally`. The dialog stays open for a retry.
			showToast(
				"error",
				"Couldn't update credits",
				"The request didn't go through. Check your connection and try again.",
			);
		} finally {
			// Clears on EVERY path above — the single place the in-flight flag
			// is released, so no control can be left permanently disabled.
			setPending(null);
		}
	};

	const handleReset = () =>
		runCreditAction(
			"reset",
			{ action: "reset", reason: resetReason.trim() || undefined },
			() => setResetOpen(false),
			() => setResetReason(""),
		);

	const handleGrant = () =>
		runCreditAction(
			"grant",
			{
				action: "grant",
				amount: grantAmountValue,
				reason: grantReason.trim() || undefined,
			},
			() => setGrantOpen(false),
			() => {
				setGrantAmount("");
				setGrantReason("");
			},
		);

	return (
		<section className="space-y-4">
			<h3 className="text-lg font-display font-semibold">Credits</h3>

			<div className="bg-nova-deep border border-nova-border rounded-xl p-6 space-y-6">
				{/* ── Balance summary — remaining is the headline figure ───────── */}
				<div className="flex flex-wrap items-end justify-between gap-6">
					<div>
						<p className="text-xs uppercase tracking-wide text-nova-text-muted">
							Remaining this month
						</p>
						<p className="mt-1 text-3xl font-display font-semibold tabular-nums">
							{credits.balance.toLocaleString()}
						</p>
						<p className="mt-1 text-sm text-nova-text-muted">
							{formatPeriodLabel(credits.period)}
						</p>
					</div>

					{/* Supporting figures — emphasis comes from weight + position,
					    not decorative color. Bonus is shown only when nonzero so a
					    clean account doesn't carry a meaningless "0 bonus" line. */}
					<dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
						<dt className="text-nova-text-muted">Monthly allowance</dt>
						<dd className="text-right tabular-nums">
							{credits.allowance.toLocaleString()}
						</dd>
						<dt className="text-nova-text-muted">Used this month</dt>
						<dd className="text-right tabular-nums">
							{credits.consumed.toLocaleString()}
						</dd>
						{credits.bonus > 0 && (
							<>
								<dt className="text-nova-text-muted">Bonus granted</dt>
								<dd className="text-right tabular-nums">
									+{credits.bonus.toLocaleString()}
								</dd>
							</>
						)}
						<dt className="text-nova-text-muted">Used all-time</dt>
						<dd className="text-right tabular-nums">
							{credits.lifetimeConsumed.toLocaleString()}
						</dd>
					</dl>
				</div>

				{/* ── Actions — each behind a confirm dialog ───────────────────── */}
				<div className="flex flex-wrap gap-3 border-t border-nova-border pt-5">
					{/* Reset: zeroes this month's consumed; allowance + bonus kept. */}
					<AlertDialog
						open={resetOpen}
						// Gate EVERY dismiss path (esc / backdrop / cancel) on the
						// in-flight flag: while a request is mid-flight the dialog
						// cannot be closed by any route. Success closes via the
						// direct `setResetOpen(false)` in the handler, bypassing this.
						onOpenChange={(next) => {
							if (pending === null) setResetOpen(next);
						}}
					>
						<AlertDialogTrigger
							render={
								<button
									type="button"
									className="inline-flex items-center gap-1.5 rounded-lg border border-nova-border bg-nova-surface px-3 py-1.5 text-sm font-medium text-nova-text transition-all hover:border-nova-border-bright hover:bg-nova-elevated cursor-pointer"
								>
									<Icon icon={tablerRefresh} width="16" height="16" />
									Reset credits
								</button>
							}
						/>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>Reset this month's credits?</AlertDialogTitle>
								<AlertDialogDescription>
									This sets the credits used this month back to zero. The
									monthly allowance and any bonus credits are kept, so the user
									gets a full balance for the rest of the period.
								</AlertDialogDescription>
							</AlertDialogHeader>

							<Field>
								<FieldLabel htmlFor="reset-reason">
									Reason (optional)
								</FieldLabel>
								<Input
									id="reset-reason"
									value={resetReason}
									onChange={(e) => setResetReason(e.target.value)}
									placeholder="Why are you resetting their credits?"
									autoComplete="off"
									data-1p-ignore
									disabled={pending !== null}
								/>
							</Field>

							<AlertDialogFooter>
								<AlertDialogCancel disabled={pending !== null}>
									Cancel
								</AlertDialogCancel>
								{/* This repo's AlertDialogAction is a plain Button (not the
								    primitive Close), so it does NOT auto-close — we just
								    attach the async handler. The dialog closes only when the
								    handler succeeds. */}
								<AlertDialogAction
									onClick={handleReset}
									disabled={pending !== null}
								>
									{pending === "reset" ? "Resetting…" : "Reset credits"}
								</AlertDialogAction>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>

					{/* Grant: adds positive bonus credits on top of the allowance. */}
					<AlertDialog
						open={grantOpen}
						onOpenChange={(next) => {
							if (pending === null) setGrantOpen(next);
						}}
					>
						<AlertDialogTrigger
							render={
								<button
									type="button"
									className="inline-flex items-center gap-1.5 rounded-lg border border-nova-border bg-nova-surface px-3 py-1.5 text-sm font-medium text-nova-text transition-all hover:border-nova-border-bright hover:bg-nova-elevated cursor-pointer"
								>
									<Icon icon={tablerCredits} width="16" height="16" />
									Grant credits
								</button>
							}
						/>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>Grant bonus credits</AlertDialogTitle>
								<AlertDialogDescription>
									Add bonus credits on top of this user's monthly allowance.
									Bonus credits stay available until they're used.
								</AlertDialogDescription>
							</AlertDialogHeader>

							<Field>
								<FieldLabel htmlFor="grant-amount">Amount</FieldLabel>
								<Input
									id="grant-amount"
									type="number"
									min={1}
									step={1}
									inputMode="numeric"
									value={grantAmount}
									onChange={(e) => setGrantAmount(e.target.value)}
									placeholder="e.g. 500"
									autoComplete="off"
									data-1p-ignore
									disabled={pending !== null}
									required
								/>
							</Field>

							<Field>
								<FieldLabel htmlFor="grant-reason">
									Reason (optional)
								</FieldLabel>
								<Input
									id="grant-reason"
									value={grantReason}
									onChange={(e) => setGrantReason(e.target.value)}
									placeholder="Why are you granting bonus credits?"
									autoComplete="off"
									data-1p-ignore
									disabled={pending !== null}
								/>
							</Field>

							<AlertDialogFooter>
								<AlertDialogCancel disabled={pending !== null}>
									Cancel
								</AlertDialogCancel>
								<AlertDialogAction
									onClick={handleGrant}
									// Disabled until the amount is a positive whole number —
									// the same shape the endpoint validates — so an invalid
									// grant can't even be submitted.
									disabled={pending !== null || !grantAmountValid}
								>
									{pending === "grant" ? "Granting…" : "Grant credits"}
								</AlertDialogAction>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>
				</div>
			</div>

			{/* ── Audit trail — every reset/grant, newest first ──────────────── */}
			<div>
				<h4 className="text-sm font-display font-semibold text-nova-text-secondary mb-3">
					Credit interventions
				</h4>
				{grants.length === 0 ? (
					<p className="text-sm text-nova-text-muted">
						No credit interventions yet.
					</p>
				) : (
					<ul className="space-y-2">
						{grants.map((grant) => (
							<li
								// No id on an audit row, so the key is a composite of the
								// fields that together pin down one intervention: the ISO
								// timestamp, the acting admin, the action, and the amount.
								// The list is append-only and server-ordered (never reordered
								// or filtered client-side), so this composite is stable for
								// React's reconciliation — no array index needed.
								key={`${grant.created_at}-${grant.actor_email}-${grant.type}-${grant.amount}`}
								className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-nova-border bg-nova-surface px-4 py-3 text-sm"
							>
								<Badge variant={grant.type === "grant" ? "violet" : "muted"}>
									{grant.type}
								</Badge>
								{grant.type === "grant" && (
									<span className="font-medium tabular-nums">
										+{grant.amount.toLocaleString()}
									</span>
								)}
								<span className="text-nova-text-secondary">
									{grant.actor_email}
								</span>
								{grant.reason && (
									<span className="text-nova-text-muted">— {grant.reason}</span>
								)}
								<RelativeTime
									className="ml-auto text-xs text-nova-text-muted tabular-nums"
									date={new Date(grant.created_at)}
								/>
							</li>
						))}
					</ul>
				)}
			</div>
		</section>
	);
}
