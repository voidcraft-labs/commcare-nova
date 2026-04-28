"use client";
import { motion } from "motion/react";
import { useState } from "react";
import { Logo } from "@/components/ui/Logo";
import { useAuth } from "@/lib/auth/hooks/useAuth";
import { SIGN_IN_ERROR } from "@/lib/auth-errors";

/** Google "G" logo for the sign-in button. Inline SVG to avoid external dependencies. */
function GoogleLogo({ size = 18 }: { size?: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			role="img"
			aria-label="Google"
		>
			<path
				d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
				fill="#4285F4"
			/>
			<path
				d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
				fill="#34A853"
			/>
			<path
				d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18A10.96 10.96 0 0 0 1 12c0 1.77.42 3.45 1.18 4.93l3.66-2.84z"
				fill="#FBBC05"
			/>
			<path
				d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
				fill="#EA4335"
			/>
		</svg>
	);
}

interface LandingProps {
	/** Sign-in error forwarded from `?error=…`, set by Better Auth when an
	 * OAuth attempt is rejected (e.g. by the email-domain hook in
	 * `lib/auth.ts`). `null` when there is no error to surface. */
	signInError: string | null;
}

/**
 * Map a Better Auth callback error code to a user-facing message.
 *
 * The `?error=…` value is either a code Nova explicitly emitted (one
 * of `SIGN_IN_ERROR`, matched by exact equality against the imported
 * constant — typos on either side fail at build time) or some other
 * code from Better Auth's internal protocol surface that we do not
 * control. We do not pattern-match the latter; everything outside our
 * own code list collapses to a single generic sentence rather than
 * leaking protocol-level identifiers to the UI.
 *
 * The user-facing prose lives only here, never in `lib/auth.ts`. The
 * hook throws codes; this function owns the words.
 */
function formatSignInError(raw: string | null): string | null {
	if (!raw) return null;
	if (raw === SIGN_IN_ERROR.domainRejected) {
		return "Sign-in is restricted to authorized Dimagi accounts.";
	}
	return "Sign-in failed. Please try again.";
}

/**
 * Landing page client component — Google OAuth sign-in.
 *
 * Rendered by the root page when the user is not authenticated.
 * Sign-in is restricted to the email-domain allowlist enforced by
 * `databaseHooks.user.create.before` in `lib/auth.ts`. When that hook
 * rejects an attempt, Better Auth redirects back here with `?error=…`
 * and the message is surfaced as an inline banner.
 */
export function Landing({ signInError }: LandingProps) {
	const { signIn } = useAuth();
	const [signingIn, setSigningIn] = useState(false);
	const errorMessage = formatSignInError(signInError);

	/** Google OAuth entry — sign in and redirect to builder on success. */
	const signInWithGoogle = async () => {
		setSigningIn(true);
		await signIn();
	};

	return (
		<div className="min-h-screen flex flex-col items-center justify-center relative overflow-hidden">
			{/* Cosmic background */}
			<div className="fixed inset-0 pointer-events-none">
				<div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[800px] h-[800px] rounded-full bg-nova-violet/5 blur-[120px]" />
				<div className="absolute bottom-0 left-1/4 w-[600px] h-[600px] rounded-full bg-nova-violet/3 blur-[100px]" />
			</div>

			<motion.div
				initial={{ opacity: 0, y: 20 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
				className="relative z-10 flex flex-col items-center gap-8 max-w-md w-full px-6"
			>
				<Logo size="lg" />

				<motion.p
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					transition={{ delay: 0.3, duration: 0.6 }}
					className="text-nova-text-secondary text-center text-lg font-light"
				>
					Build CommCare apps from conversation
				</motion.p>

				{errorMessage && (
					<motion.div
						initial={{ opacity: 0, y: -8 }}
						animate={{ opacity: 1, y: 0 }}
						transition={{ duration: 0.4 }}
						/* `role="status"` (== `aria-live="polite"`) — this banner is
						 * server-rendered into the initial HTML when `?error=…` is
						 * present, so by the time a screen reader reaches it the
						 * content is part of normal page flow. `role="alert"` would
						 * `aria-live="assertive"` and interrupt mid-sentence, which
						 * is the wrong semantic for first-paint static content. */
						role="status"
						/* Body text uses `text-nova-text` rather than `text-nova-rose`
						 * for WCAG AA contrast against the `bg-nova-rose/10` tint —
						 * the rose color sits ~4:1 on the composite background, just
						 * below the 4.5:1 threshold for normal text. The rose border
						 * + tint still convey the error semantic visually. */
						className="w-full rounded-lg border border-nova-rose/30 bg-nova-rose/10 px-4 py-3 text-sm text-nova-text"
					>
						{errorMessage}
					</motion.div>
				)}

				<motion.div
					initial={{ opacity: 0, y: 10 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{ delay: 0.5, duration: 0.6 }}
					className="w-full"
				>
					<button
						type="button"
						onClick={signInWithGoogle}
						disabled={signingIn}
						className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-white text-gray-800 font-medium rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer shadow-sm"
					>
						<GoogleLogo />
						{signingIn ? "Redirecting..." : "Sign in with Google"}
					</button>
				</motion.div>
			</motion.div>
		</div>
	);
}
