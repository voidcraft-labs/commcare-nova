/**
 * Consent form — renders the requested scopes and hands approve/deny
 * decisions back to Better Auth's oauth-provider plugin. Keeps all
 * interactive state on the client; the RSC shell hydrates the initial
 * view with client name + scope list.
 */

"use client";

import { Popover } from "@base-ui/react/popover";
import { Icon } from "@iconify/react/offline";
import tablerAlertTriangle from "@iconify-icons/tabler/alert-triangle";
import tablerCircleCheck from "@iconify-icons/tabler/circle-check";
import tablerCircleDashed from "@iconify-icons/tabler/circle-dashed";
import tablerInfoCircle from "@iconify-icons/tabler/info-circle";
import tablerShieldCheck from "@iconify-icons/tabler/shield-check";
import { motion } from "motion/react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/Button";
import { authClient } from "@/lib/auth-client";
import { deriveCapabilities } from "@/lib/oauth/capabilities";
import { deriveOAuthClientDisclosure } from "@/lib/oauth/client-display";
import { POPOVER_POPUP_CLS, POPOVER_POSITIONER_GLASS_CLS } from "@/lib/styles";

interface ConsentFormProps {
	clientName: string;
	scopes: readonly string[];
	redirectMismatch: boolean;
	redirectUri?: string;
	clientUri?: string;
	trustedClient: boolean;
	/**
	 * Whether the user has connected a CommCare HQ API key. The OAuth grant
	 * itself is unconditional — the user is granting the SCOPE here, and the
	 * connecting app picks up data access the moment a key is later added —
	 * but if HQ scopes are requested while the key is missing, the
	 * capability list surfaces a dormancy hint so the user isn't surprised
	 * when the connecting app's HQ features no-op until setup completes.
	 *
	 * Three-valued on purpose: `true` means "key present", `false` means
	 * "we asked, no key", and `undefined` means "the question doesn't apply
	 * (no HQ scopes requested)." Collapsing the last two into a single
	 * `false` would force every consumer to re-derive the gating logic the
	 * page already knows.
	 */
	hqConfigured?: boolean;
}

/**
 * Translate the opaque error object from `authClient.oauth2.consent` into
 * a user-readable message. "Consent failed" — the default message on many
 * Better Auth error paths — is meaningless to a non-technical user and
 * leaves them with no recovery path; every branch here ends with an
 * actionable instruction (retry, sign in again, go back to the app).
 *
 * The mapping is best-effort — Better Auth's error shape doesn't
 * guarantee specific codes across versions, so we fall back on HTTP
 * status first and an unknown-error string last.
 */
interface ConsentClientError {
	status?: number;
	code?: string;
	message?: string;
}

function friendlyConsentError(err: ConsentClientError): string {
	const status = err.status;
	if (typeof status === "number") {
		if (status === 401)
			return "Your session expired. Please sign in again, then retry the connection from the app.";
		if (status === 403)
			return "You don't have permission to approve this request.";
		if (status === 400)
			return "This authorization link is no longer valid. Head back to the app that sent you here and start the connection again.";
		if (status === 404)
			return "The authorization request couldn't be found. Please start over from the app that sent you here.";
		if (status >= 500)
			return "Something went wrong on our end. Please try again in a moment.";
	}
	/* A missing status usually means the fetch never completed — offline,
	 * DNS, CORS, etc. Prompt a retry rather than bouncing them back to the
	 * client app, which won't help if their network is down. */
	if (status === undefined)
		return "We couldn't reach Nova. Check your connection and try again.";
	return "We couldn't complete this request. Please head back to the app that sent you here and start over.";
}

export function ConsentForm({
	clientName,
	scopes,
	redirectMismatch,
	redirectUri,
	clientUri,
	trustedClient,
	hqConfigured,
}: ConsentFormProps) {
	const [pending, setPending] = useState<"accept" | "deny" | null>(null);
	const [error, setError] = useState<string | null>(null);

	/* Invalid / expired request branch. Rendered inside the same card shell
	 * as the happy path so the visual identity stays consistent — the user
	 * doesn't bounce between "real Nova screen" and "generic error page" if
	 * their auth link is stale. */
	if (redirectMismatch) {
		return (
			<ConsentCard tone="error">
				<div className="flex flex-col items-start gap-5">
					<IconChip tone="error" icon={tablerAlertTriangle} />
					<div className="flex flex-col gap-2">
						<h1 className="font-display text-2xl font-semibold leading-tight text-nova-text">
							This authorization link isn&rsquo;t valid anymore
						</h1>
						<p className="text-sm leading-relaxed text-nova-text-secondary">
							It may have expired, already been used, or arrived here without
							the right signature. Head back to the app that asked you to sign
							in and start the connection again.
						</p>
					</div>
				</div>
			</ConsentCard>
		);
	}

	const submit = async (accept: boolean) => {
		setPending(accept ? "accept" : "deny");
		setError(null);
		const { error: err } = await authClient.oauth2.consent({ accept });
		if (err) {
			setError(friendlyConsentError(err));
			setPending(null);
		}
		/* Success: plugin redirects the user back to the client's
		 * redirect_uri with an authorization_code — no client-side
		 * navigation needed here. */
	};

	const disclosure = deriveOAuthClientDisclosure({
		clientName,
		redirectUri,
		clientUri,
		trusted: trustedClient,
	});

	/* Split capabilities into the standard rows and the HQ rows so the
	 * dormancy treatment (amber sub-card) can wrap the HQ rows + footnote
	 * without leaking styling onto the standard rows. Order within each
	 * group is preserved from `deriveCapabilities`, which already sequences
	 * known capabilities top-to-bottom in a sensible progression and
	 * appends unknown-scope catch-alls at the end — those land in the
	 * non-HQ bucket, so the HQ sub-card always anchors at the bottom of
	 * the list regardless of whether unknown scopes are present. */
	const allCapabilities = deriveCapabilities(scopes);
	const nonHqCapabilities = allCapabilities.filter(
		(c) => !c.key.startsWith("nova.hq."),
	);
	const hqCapabilities = allCapabilities.filter((c) =>
		c.key.startsWith("nova.hq."),
	);

	/* Render the dormancy sub-card only when the page told us we asked AND
	 * got back a "no key" answer (`hqConfigured === false`) AND the row
	 * actually surfaces. `undefined` means the page never even ran the
	 * Firestore read — collapsing it with `false` would silently treat
	 * "didn't ask" as "asked and got no key" the moment a future caller
	 * forgets to gate the prop on scope content. */
	const showHqPendingGroup =
		hqConfigured === false && hqCapabilities.length > 0;

	/* Ease curve mirrors the landing page's sign-in reveal (0.16, 1, 0.3, 1) —
	 * gentle decelerating arrival. Timing is tight enough to feel instant on
	 * repeat visits but gives the eye a moment to parse hierarchy on first
	 * sight. Three staggered groups (card → content → actions) rather than
	 * per-scope stagger, which at 6 rows would drag past the snappy threshold. */
	const ease = [0.16, 1, 0.3, 1] as const;
	const verified = disclosure.verificationKind === "verified";

	return (
		<ConsentCard tone="default">
			<motion.div
				initial={{ opacity: 0, y: 8 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ duration: 0.5, ease }}
				className="flex flex-col gap-5"
			>
				<div className="flex flex-col gap-4">
					<div className="flex items-center gap-3">
						<IconChip tone="violet" icon={tablerShieldCheck} size="sm" />
						<span className="text-[11px] font-medium uppercase tracking-[0.18em] text-nova-text-muted">
							Authorization request
						</span>
					</div>
					<div className="flex flex-col gap-3">
						<h1 className="font-display text-[1.65rem] font-medium leading-[1.08] text-nova-text">
							Connect to{" "}
							<span
								data-testid="consent-nova-mark"
								className="bg-gradient-to-r from-nova-text to-nova-violet-bright bg-clip-text font-semibold text-transparent [background-position:right_center] [background-size:325%_100%]"
							>
								nova
							</span>
							?
						</h1>
						<div className="overflow-hidden rounded-xl border border-nova-border/70 bg-nova-surface/20 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
							<div className="grid grid-cols-[6.25rem_1fr] items-center gap-3 border-b border-nova-border/60 bg-nova-elevated/20 px-3.5 py-2.5">
								<div className="text-[10px] font-medium uppercase leading-none tracking-[0.12em] text-nova-text-muted">
									Application
								</div>
								<div
									data-testid="consent-app-name"
									className="min-w-0 break-words font-display text-[1.05rem] font-semibold leading-tight text-nova-orchid"
								>
									{disclosure.appName}
								</div>
							</div>
							<dl>
								{disclosure.detailValue ? (
									<IdentityRow
										label="Details"
										value={disclosure.detailValue}
										description={disclosure.detailDescription ?? undefined}
									/>
								) : null}
								<IdentityRow
									label="Redirects to"
									value={disclosure.redirectDisplay}
								/>
								{disclosure.clientUriDisplay ? (
									<IdentityRow
										label="Publisher"
										value={disclosure.clientUriDisplay}
									/>
								) : null}
								<IdentityRow
									label="Verification"
									value={disclosure.verificationLabel}
									valuePrefix={
										<Icon
											data-testid="consent-verification-icon"
											icon={verified ? tablerCircleCheck : tablerAlertTriangle}
											width="16"
											height="16"
											className={`shrink-0 ${verified ? "text-nova-violet-bright" : "text-nova-rose"}`}
											aria-hidden
										/>
									}
								/>
							</dl>
						</div>
						{disclosure.brandWarning ? (
							<div className="border-l-2 border-nova-rose/50 pl-3 text-xs leading-relaxed text-nova-rose">
								Name resembles Nova, CommCare, or Dimagi, but Nova has not
								verified this app.
							</div>
						) : null}
					</div>
				</div>

				<motion.div
					initial={{ opacity: 0, y: 6 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.5, ease, delay: 0.08 }}
					className="flex flex-col gap-2.5"
				>
					<p className="text-[11px] font-medium uppercase tracking-[0.14em] text-nova-text-muted">
						It will be able to
					</p>
					{/* Three rendering shapes share the "It will be able to" slot:
					 *
					 *   1. Standard list — every row in a single <ul> with the
					 *      gray surface treatment (HQ configured, OR no HQ
					 *      scopes requested).
					 *   2. Standard list + amber sub-card — non-HQ rows in the
					 *      gray-bordered <ul> as usual; HQ rows + footnote nest
					 *      below in a self-contained amber sub-card.
					 *   3. Amber sub-card alone — the request is HQ-only (a
					 *      legitimate scope combination for deploy-only
					 *      integrations), so there are zero non-HQ rows and the
					 *      gray wrapper would otherwise render an empty <ul>
					 *      ("list, 0 items" to AT) inside a redundant outer
					 *      border. Surface the amber sub-card as the only
					 *      container in that case. */}
					{showHqPendingGroup && nonHqCapabilities.length === 0 ? (
						<div className="overflow-hidden rounded-xl border border-nova-amber/30 bg-nova-amber/[0.05]">
							<ul>
								{hqCapabilities.map((c) => (
									<CapabilityRow key={c.key} label={c.label} icon={c.icon} />
								))}
							</ul>
							<HqPendingFootnote />
						</div>
					) : (
						<div className="overflow-hidden rounded-xl border border-nova-border/60 bg-nova-surface/20">
							<ul>
								{nonHqCapabilities.map((c) => (
									<CapabilityRow key={c.key} label={c.label} icon={c.icon} />
								))}
								{!showHqPendingGroup
									? hqCapabilities.map((c) => (
											<CapabilityRow
												key={c.key}
												label={c.label}
												icon={c.icon}
											/>
										))
									: null}
							</ul>
							{showHqPendingGroup ? (
								<div className="mx-2 mb-2 mt-2 overflow-hidden rounded-lg border border-nova-amber/30 bg-nova-amber/[0.05]">
									<ul>
										{hqCapabilities.map((c) => (
											<CapabilityRow
												key={c.key}
												label={c.label}
												icon={c.icon}
											/>
										))}
									</ul>
									<HqPendingFootnote />
								</div>
							) : null}
						</div>
					)}
				</motion.div>

				{error ? (
					<motion.div
						initial={{ opacity: 0, y: 4 }}
						animate={{ opacity: 1, y: 0 }}
						transition={{ duration: 0.25 }}
						role="alert"
						className="flex items-start gap-3 rounded-lg border border-nova-rose/30 bg-nova-rose/10 px-3.5 py-3 text-sm text-nova-rose"
					>
						<Icon
							icon={tablerAlertTriangle}
							width="18"
							height="18"
							className="mt-0.5 shrink-0"
						/>
						<span className="leading-relaxed">{error}</span>
					</motion.div>
				) : null}

				<motion.div
					initial={{ opacity: 0, y: 6 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.5, ease, delay: 0.16 }}
					className="flex flex-col-reverse gap-2.5 sm:flex-row"
				>
					<Button
						type="button"
						variant="secondary"
						size="lg"
						disabled={pending !== null}
						onClick={() => submit(false)}
						className="flex-1"
					>
						{pending === "deny" ? "Denying…" : "Deny"}
					</Button>
					<Button
						type="button"
						variant="primary"
						size="lg"
						disabled={pending !== null}
						onClick={() => submit(true)}
						className="flex-1"
					>
						{pending === "accept" ? "Approving…" : "Allow"}
					</Button>
				</motion.div>

				<p className="text-center text-xs leading-relaxed text-nova-text-muted">
					You can revoke this access at any time from your account settings.
				</p>
			</motion.div>
		</ConsentCard>
	);
}

// ── Local primitives ────────────────────────────────────────────────────
//
// Both branches (happy path + invalid-link fallback) share the same elevated
// card shell. Factored locally rather than promoted to `components/ui/` — no
// other surface in the app uses this exact treatment today, and premature
// extraction would fossilize a "Nova card" API around a single caller.

/**
 * Elevated card shell. Uses `bg-nova-deep` (the same tier Nova's
 * `ConfirmDialog` uses) so the consent surface reads as a decision dialog,
 * not a passive panel — it's lifted off the page with border + outer glow
 * rather than a brighter fill.
 *
 * The `tone` prop swaps the accent glow: violet for normal consent, rose
 * for the invalid-link state. The card itself stays dark in both cases —
 * flooding the surface with rose would turn error recovery into a scolding.
 */
function ConsentCard({
	tone,
	children,
}: {
	tone: "default" | "error";
	children: React.ReactNode;
}) {
	const glow =
		tone === "error"
			? "shadow-[0_0_80px_rgba(212,112,143,0.08),inset_0_1px_0_rgba(255,255,255,0.03)]"
			: "shadow-[0_0_80px_rgba(139,92,246,0.1),inset_0_1px_0_rgba(255,255,255,0.04)]";

	return (
		<div
			className={`relative w-full rounded-2xl border border-nova-border bg-nova-deep p-5 sm:p-6 ${glow}`}
		>
			{/* Hairline top highlight — one-pixel violet gradient along the top
			 *   edge of the card. Reads as a light source from above and adds a
			 *   hint of the hardware-panel motif used in `nova-panel` without
			 *   pulling in the full LED/bezel chrome (which would be too loud
			 *   here, where the card is the only element). */}
			<div
				aria-hidden
				className={`pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent ${
					tone === "error" ? "via-nova-rose/40" : "via-nova-violet/50"
				} to-transparent`}
			/>
			{children}
		</div>
	);
}

/**
 * Rounded-square icon chip that pairs with the consent eyebrow. The happy
 * path uses the small size to keep the identity details from crowding the
 * headline; the invalid-link branch keeps the larger size for error focus.
 */
function IconChip({
	tone,
	icon,
	size = "md",
}: {
	tone: "violet" | "error";
	icon: Parameters<typeof Icon>[0]["icon"];
	size?: "sm" | "md";
}) {
	const theme =
		tone === "error"
			? {
					ring: "border-nova-rose/30 bg-nova-rose/10",
					icon: "text-nova-rose",
				}
			: {
					ring: "border-nova-violet/30 bg-nova-violet/10",
					icon: "text-nova-violet-bright",
				};
	const box = size === "sm" ? "h-8 w-8 rounded-lg" : "h-11 w-11 rounded-xl";
	const iconSize = size === "sm" ? "18" : "22";
	return (
		<div
			className={`flex items-center justify-center border ${box} ${theme.ring}`}
		>
			<Icon
				icon={icon}
				width={iconSize}
				height={iconSize}
				className={theme.icon}
				aria-hidden
			/>
		</div>
	);
}

function IdentityRow({
	label,
	value,
	description,
	valuePrefix,
}: {
	label: string;
	value: string;
	description?: string;
	valuePrefix?: ReactNode;
}) {
	return (
		<div className="grid grid-cols-[6.25rem_1fr] items-center gap-3 border-b border-nova-border/50 px-3.5 py-2.5 last:border-b-0">
			<dt className="text-[10px] font-medium uppercase leading-none tracking-[0.12em] text-nova-text-muted">
				{label}
			</dt>
			<dd className="min-w-0 text-sm leading-snug text-nova-text">
				<span className="inline-flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-1">
					{valuePrefix}
					<span className="break-words">{value}</span>
				</span>
				{description ? (
					<span className="mt-1 block text-xs leading-relaxed text-nova-text-muted">
						{description}
					</span>
				) : null}
			</dd>
		</div>
	);
}

/**
 * Single capability row. Plain-English description is the only content —
 * raw scope identifiers are intentionally omitted to keep the list
 * scannable for non-technical users. The semantic icon (user / eye /
 * pencil / cloud) carries the "what kind of grant this is" signal
 * without needing color or fill.
 *
 * The row stays decorationless even in the dormancy case: visual
 * grouping is handled by the surrounding container (the nested amber
 * card the consent form wraps HQ rows in when their data dependency is
 * missing), not by per-row styling. That keeps the row primitive
 * single-purpose and lets the row's amber wash inherit cleanly from the
 * wrapper's `bg-nova-amber/*` instead of double-stacking.
 */
function CapabilityRow({
	label,
	icon,
}: {
	label: string;
	icon: Parameters<typeof Icon>[0]["icon"];
}) {
	return (
		<li className="relative flex items-center gap-3 border-b border-nova-border/50 px-3.5 py-2 last:border-b-0">
			<Icon
				icon={icon}
				width="15"
				height="15"
				className="shrink-0 text-nova-text-muted"
				aria-hidden
			/>
			<span className="flex-1 text-[13px] leading-snug text-nova-text">
				{label}
			</span>
		</li>
	);
}

/**
 * Dormancy footnote attached to the capability list when the user is
 * granting HQ scopes but hasn't connected a CommCare HQ API key yet. The
 * grant itself is unconditional — the connecting app picks up data
 * access the moment a key is added later — so the footnote is purely
 * informational, not a prerequisite or warning.
 *
 * The whole strip is a single popover trigger: opens on hover, focus, or
 * click (no settings link inside, on purpose). A direct "Open settings"
 * affordance would tempt the user to leave mid-flow, and the OAuth `sig`
 * has an `exp` — losing the tab to a settings detour can stale the
 * signature out from under them. The popover explains and reassures;
 * the user finishes consent first, sets up later.
 *
 * Amber rather than rose: this is a "not yet configured" state, not an
 * error. A rose treatment would frame setup as a failure recovery.
 */
function HqPendingFootnote() {
	return (
		<Popover.Root>
			{/* The trigger carries a short accessible signpost; the
			 *   substantive copy lives in `Popover.Title` +
			 *   `Popover.Description` inside the popup so the dialog
			 *   announcement on the touch / tap-to-open path is informative
			 *   on its own.
			 *
			 *   Hover-open relies on Base UI's 300ms default delay to filter
			 *   incidental pass-through hovers — without it, a cursor
			 *   sweeping from the capability list down to the Allow button
			 *   trips the hover threshold and flashes the popup open right
			 *   as the user is about to click, reading as a bug. */}
			<Popover.Trigger
				openOnHover
				closeDelay={120}
				aria-label="Awaiting CommCare HQ setup. Open for details."
				className="group flex w-full cursor-pointer items-center gap-2 border-t border-nova-amber/25 bg-nova-amber/[0.05] px-3.5 py-2 text-left outline-none transition-colors duration-150 hover:bg-nova-amber/[0.12] focus-visible:bg-nova-amber/[0.12] focus-visible:ring-1 focus-visible:ring-nova-amber/40 focus-visible:ring-inset"
			>
				<Icon
					icon={tablerCircleDashed}
					width="11"
					height="11"
					aria-hidden
					className="shrink-0 text-nova-amber"
				/>
				<span className="flex-1 text-[10px] font-medium uppercase tracking-[0.12em] text-nova-amber/85">
					Awaiting CommCare HQ setup
				</span>
				<Icon
					icon={tablerInfoCircle}
					width="12"
					height="12"
					aria-hidden
					className="shrink-0 text-nova-amber/55 transition-colors duration-150 group-hover:text-nova-amber group-focus-visible:text-nova-amber"
				/>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Positioner
					side="top"
					align="end"
					sideOffset={10}
					className={POPOVER_POSITIONER_GLASS_CLS}
				>
					<Popover.Popup className={`${POPOVER_POPUP_CLS} w-[18.5rem]`}>
						<div className="px-4 pt-3.5 pb-4">
							<div className="mb-2 flex items-center gap-2">
								<Icon
									icon={tablerCircleDashed}
									width="13"
									height="13"
									aria-hidden
									className="text-nova-amber"
								/>
								{/* `Popover.Title` is what Base UI threads into the
								 *   popup's `aria-labelledby` — without it, AT users
								 *   who land focus inside the dialog (touch / tap-to-
								 *   open path) hear an unlabelled dialog. Default
								 *   render element is `<h2>`; we override to `<p>`
								 *   because the text is a small uppercase eyebrow,
								 *   not a heading users would navigate to via the
								 *   page's heading outline. */}
								<Popover.Title
									render={<p />}
									className="text-[10px] font-semibold uppercase tracking-[0.12em] text-nova-amber"
								>
									Activates after setup
								</Popover.Title>
							</div>
							{/* `Popover.Description` threads into the popup's
							 *   `aria-describedby`. Carries the substantive
							 *   reassurance copy so the dialog announcement is
							 *   informative, not just a labelled empty box. */}
							<Popover.Description className="text-xs leading-relaxed text-nova-text">
								Approving saves these permissions. Data access turns on
								automatically when you add a CommCare HQ API key under{" "}
								<span className="font-medium text-nova-text">
									Settings &rarr; CommCare HQ
								</span>{" "}
								— you won&rsquo;t need to come back here.
							</Popover.Description>
						</div>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}
