/**
 * Consent form — renders the requested scopes and hands approve/deny
 * decisions back to Better Auth's oauth-provider plugin. Keeps all
 * interactive state on the client; the RSC shell hydrates the initial
 * view with client name + scope list.
 */

"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertTriangle from "@iconify-icons/tabler/alert-triangle";
import tablerShieldCheck from "@iconify-icons/tabler/shield-check";
import { motion } from "motion/react";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { authClient } from "@/lib/auth-client";
import { deriveCapabilities } from "@/lib/oauth/capabilities";

interface ConsentFormProps {
	clientName: string;
	scopes: readonly string[];
	redirectMismatch: boolean;
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

	const capabilities = deriveCapabilities(scopes);

	/* Ease curve mirrors the landing page's sign-in reveal (0.16, 1, 0.3, 1) —
	 * gentle decelerating arrival. Timing is tight enough to feel instant on
	 * repeat visits but gives the eye a moment to parse hierarchy on first
	 * sight. Three staggered groups (card → content → actions) rather than
	 * per-scope stagger, which at 6 rows would drag past the snappy threshold. */
	const ease = [0.16, 1, 0.3, 1] as const;

	return (
		<ConsentCard tone="default">
			<motion.div
				initial={{ opacity: 0, y: 8 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ duration: 0.5, ease }}
				className="flex flex-col gap-7"
			>
				<div className="flex flex-col items-start gap-5">
					<IconChip tone="violet" icon={tablerShieldCheck} />
					<div className="flex flex-col gap-2">
						<span className="text-[11px] font-medium uppercase tracking-[0.18em] text-nova-text-muted">
							Authorization request
						</span>
						{/* Two distinct entities share this headline — the third-party
						 *   client (quoted, amber) and Nova itself (gradient on the
						 *   last word). Amber on the client name solves "everything
						 *   runs together" by giving the name its own tonal identity
						 *   against the cool-white surrounding copy; the warm accent
						 *   also sits outside Nova's violet brand family, so there's
						 *   zero risk of a viewer reading the color as an endorsement.
						 *   That last part is load-bearing: the consent page is the
						 *   one screen where dressing a third-party name in Nova's
						 *   signature treatment (brand gradient, violet tint) would
						 *   suggest brand overlap — exactly the confusion a consent
						 *   flow has to prevent. Smart quotes stay to reinforce the
						 *   "this is a name" cue; weight contrast (semibold vs the
						 *   surrounding medium) backs up the color shift. */}
						<h1 className="font-display text-[1.75rem] font-medium leading-[1.15] text-nova-text">
							Allow{" "}
							<span className="font-semibold">
								&ldquo;<span className="text-nova-amber">{clientName}</span>
								&rdquo;
							</span>{" "}
							to use your{" "}
							<span className="bg-gradient-to-r from-nova-text to-nova-violet-bright bg-clip-text font-semibold text-transparent">
								nova
							</span>{" "}
							account?
						</h1>
					</div>
				</div>

				<motion.div
					initial={{ opacity: 0, y: 6 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.5, ease, delay: 0.08 }}
					className="flex flex-col gap-3"
				>
					<p className="text-xs font-medium uppercase tracking-[0.14em] text-nova-text-muted">
						It will be able to
					</p>
					<ul className="flex flex-col gap-1.5">
						{capabilities.map((c) => (
							<CapabilityRow key={c.key} label={c.label} icon={c.icon} />
						))}
					</ul>
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
					className="flex flex-col-reverse gap-3 sm:flex-row"
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
			className={`relative w-full rounded-2xl border border-nova-border bg-nova-deep p-7 sm:p-8 ${glow}`}
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
 * Rounded-square icon chip that pairs with a headline. Sized large enough
 * (44px) to act as the dominant visual mass at the top of the card, so the
 * headline gets space to breathe underneath. The inner gradient echoes the
 * logo wordmark's text-gradient for quiet brand continuity.
 */
function IconChip({
	tone,
	icon,
}: {
	tone: "violet" | "error";
	icon: Parameters<typeof Icon>[0]["icon"];
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
	return (
		<div
			className={`flex h-11 w-11 items-center justify-center rounded-xl border ${theme.ring}`}
		>
			<Icon
				icon={icon}
				width="22"
				height="22"
				className={theme.icon}
				aria-hidden
			/>
		</div>
	);
}

/**
 * Single capability row. Plain-English description is the only content —
 * raw scope identifiers are intentionally omitted to keep the list
 * scannable for non-technical users. Every row uses the same surface
 * treatment so the list doesn't read as a multi-select with a chosen
 * item; the semantic icon (user / eye / pencil / key) carries the "what
 * kind of grant this is" signal without needing color or fill.
 */
function CapabilityRow({
	label,
	icon,
}: {
	label: string;
	icon: Parameters<typeof Icon>[0]["icon"];
}) {
	return (
		<li className="relative flex items-center gap-3 rounded-lg border border-nova-border/60 bg-nova-surface/40 px-3.5 py-2.5">
			<Icon
				icon={icon}
				width="16"
				height="16"
				className="shrink-0 text-nova-text-muted"
				aria-hidden
			/>
			<span className="flex-1 text-sm leading-snug text-nova-text">
				{label}
			</span>
		</li>
	);
}
