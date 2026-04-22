/**
 * Consent form — renders the requested scopes and hands approve/deny
 * decisions back to Better Auth's oauth-provider plugin. Keeps all
 * interactive state on the client; the RSC shell hydrates the initial
 * view with client name + scope list.
 */

"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";

interface ConsentFormProps {
	clientName: string;
	scopes: readonly string[];
	redirectMismatch: boolean;
}

/**
 * Human-readable descriptions for every scope Nova's authorization server
 * advertises. Keep this table in sync with `NOVA_OAUTH_SCOPES` in lib/auth.ts
 * — an unknown scope falls back to rendering its raw id, which is safe but
 * ugly, so anything added to the AS config should land here too.
 */
const SCOPE_DESCRIPTIONS: Record<string, string> = {
	openid: "Identify you to the app",
	profile: "See your name",
	email: "See your email",
	offline_access: "Stay signed in when you're not using it",
	"nova.read": "Read your CommCare apps",
	"nova.write": "Create, edit, and deploy CommCare apps on your behalf",
};

export function ConsentForm({
	clientName,
	scopes,
	redirectMismatch,
}: ConsentFormProps) {
	const [pending, setPending] = useState<"accept" | "deny" | null>(null);
	const [error, setError] = useState<string | null>(null);

	if (redirectMismatch) {
		return (
			<p className="text-red-500">
				Authorization request invalid or expired. Start again from the app that
				initiated sign-in.
			</p>
		);
	}

	const submit = async (accept: boolean) => {
		setPending(accept ? "accept" : "deny");
		setError(null);
		const { error: err } = await authClient.oauth2.consent({ accept });
		if (err) {
			setError(err.message ?? "Consent failed.");
			setPending(null);
		}
		/* Success: plugin redirects the user back to the client's
		 * redirect_uri with an authorization_code — no client-side
		 * navigation needed here. */
	};

	return (
		<div className="flex flex-col gap-6">
			<h1 className="text-2xl font-semibold">
				Allow {clientName} to access your account?
			</h1>
			<ul className="flex flex-col gap-2">
				{scopes.map((s) => (
					<li key={s} className="flex gap-2">
						<span className="font-mono text-sm text-zinc-400">{s}</span>
						<span>{SCOPE_DESCRIPTIONS[s] ?? s}</span>
					</li>
				))}
			</ul>
			{error && <p className="text-red-500">{error}</p>}
			<div className="flex gap-3">
				<button
					type="button"
					disabled={pending !== null}
					onClick={() => submit(true)}
					className="rounded bg-violet-600 px-4 py-2 text-white disabled:opacity-50"
				>
					{pending === "accept" ? "Approving..." : "Allow"}
				</button>
				<button
					type="button"
					disabled={pending !== null}
					onClick={() => submit(false)}
					className="rounded border border-zinc-700 px-4 py-2 disabled:opacity-50"
				>
					{pending === "deny" ? "Denying..." : "Deny"}
				</button>
			</div>
		</div>
	);
}
