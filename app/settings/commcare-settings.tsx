/**
 * CommCare HQ integration settings — client component.
 *
 * Card-based UI for managing CommCare HQ API credentials. The verification
 * flow reads an NDJSON stream from the PUT endpoint, showing real-time
 * domain-testing progress ("Checking 2 / 5"). CommCare API keys are scoped
 * to a single domain, so verification bails on the first match.
 *
 * API key field behavior:
 *   - Idle / error: plaintext text input, editable
 *   - Verifying / configured / deleting: masked password field, disabled
 *   - On success: stays masked (credentials saved)
 *   - On error: reverts to plaintext with the original value intact
 */

"use client";

import { Icon } from "@iconify/react/offline";
import tablerCheck from "@iconify-icons/tabler/check";
import tablerCloudUpload from "@iconify-icons/tabler/cloud-upload";
import tablerExternalLink from "@iconify-icons/tabler/external-link";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerTrash from "@iconify-icons/tabler/trash";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useState } from "react";
import type { SettingsStreamEvent } from "@/app/api/settings/commcare/route";
import type { CommCareDomain } from "@/lib/commcare/client";
import { readNdjsonStream } from "@/lib/commcare/ndjson";
import type { CommCareSettingsPublic } from "@/lib/db/settings";

// ── Types ──────────────────────────────────────────────────────────

interface CommCareSettingsProps {
	initial: CommCareSettingsPublic;
	/** Pre-fill the username field with the user's Google email when unconfigured. */
	userEmail: string;
}

/** State machine for the form UI. */
type FormStatus =
	| { type: "idle" }
	| { type: "connecting" }
	| { type: "testing"; tested: number; total: number }
	| { type: "configured" }
	| { type: "error"; message: string }
	| { type: "deleting" };

// ── Styles ─────────────────────────────────────────────────────────

/** Shared input styles for both editable and locked states. */
const INPUT_BASE =
	"w-full px-4 py-2.5 rounded-lg text-sm border transition-all duration-200";

const INPUT_ACTIVE = `${INPUT_BASE} bg-nova-deep border-nova-border text-nova-text placeholder:text-nova-text-muted focus:outline-none focus:border-nova-violet focus:shadow-[var(--nova-glow-violet)]`;

const INPUT_LOCKED = `${INPUT_BASE} bg-nova-deep/50 border-nova-border/50 text-nova-text-muted cursor-not-allowed`;

/** Placeholder shown in the masked API key field. The actual key never leaves the server. */
const API_KEY_MASK = "\u2022".repeat(32);

// ── Animation presets ──────────────────────────────────────────────

const STATUS_ENTER = { opacity: 0, y: -6 } as const;
const STATUS_VISIBLE = { opacity: 1, y: 0 } as const;
const STATUS_EXIT = { opacity: 0, y: 4 } as const;
const STATUS_TRANSITION = { duration: 0.2 } as const;

// ── Component ──────────────────────────────────────────────────────

export function CommCareSettings({
	initial,
	userEmail,
}: CommCareSettingsProps) {
	/* ── Form values ─────────────────────────────────────────────── */
	const [username, setUsername] = useState(initial.username || userEmail);
	const [apiKey, setApiKey] = useState("");

	/* ── Domain + status ─────────────────────────────────────────── */
	const [domain, setDomain] = useState<CommCareDomain | null>(initial.domain);
	const [status, setStatus] = useState<FormStatus>(
		initial.configured ? { type: "configured" } : { type: "idle" },
	);

	/* ── Derived states ──────────────────────────────────────────── */
	const isConfigured = status.type === "configured";
	const isVerifying = status.type === "connecting" || status.type === "testing";
	const fieldsLocked =
		isVerifying || isConfigured || status.type === "deleting";
	const canSave =
		username.trim().length > 0 && apiKey.trim().length > 0 && !fieldsLocked;

	/* Show save button in idle/error/verifying, disconnect in configured/deleting. */
	const showSaveArea = !isConfigured && status.type !== "deleting";
	const showDisconnectArea = isConfigured || status.type === "deleting";

	/* Progress percentage for the verification bar. */
	const progress =
		status.type === "testing" && status.total > 0
			? Math.round((status.tested / status.total) * 100)
			: 0;

	/* ── Save handler (streams NDJSON progress) ──────────────────── */
	const handleSave = useCallback(async () => {
		if (!username.trim() || !apiKey.trim()) return;
		setStatus({ type: "connecting" });

		try {
			const res = await fetch("/api/settings/commcare", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					username: username.trim(),
					apiKey: apiKey.trim(),
				}),
			});

			/* Auth or body validation failures return regular JSON errors. */
			if (!res.ok || !res.body) {
				const data = (await res.json().catch(() => ({}))) as {
					error?: string;
				};
				setStatus({
					type: "error",
					message: data.error ?? `Failed to save (HTTP ${res.status})`,
				});
				return;
			}

			/* Read the NDJSON stream for progress + result events. */
			await readNdjsonStream<SettingsStreamEvent>(res.body, (event) => {
				switch (event.type) {
					case "testing":
						setStatus({
							type: "testing",
							tested: event.tested,
							total: event.total,
						});
						break;
					case "complete":
						setDomain(event.domain);
						setStatus({ type: "configured" });
						break;
					case "no_access":
						setStatus({
							type: "error",
							message:
								"API key doesn't have access to any project space. CommCare keys are scoped to one domain — make sure this key matches the right project.",
						});
						break;
					case "error":
						setStatus({ type: "error", message: event.message });
						break;
				}
			});
		} catch {
			setStatus({
				type: "error",
				message: "Network error. Please try again.",
			});
		}
	}, [username, apiKey]);

	/* ── Disconnect handler ──────────────────────────────────────── */
	const handleDisconnect = useCallback(async () => {
		setStatus({ type: "deleting" });

		try {
			const res = await fetch("/api/settings/commcare", {
				method: "DELETE",
			});

			if (!res.ok) {
				setStatus({
					type: "error",
					message: "Failed to disconnect. Please try again.",
				});
				return;
			}

			setDomain(null);
			setUsername(userEmail);
			setApiKey("");
			setStatus({ type: "idle" });
		} catch {
			setStatus({
				type: "error",
				message: "Failed to disconnect. Please try again.",
			});
		}
	}, [userEmail]);

	/* ── Render ──────────────────────────────────────────────────── */
	return (
		<section className="rounded-xl border border-nova-border overflow-hidden">
			{/* ── Card header ───────────────────────────────────────── */}
			<div className="flex items-center gap-3 px-6 py-4 border-b border-nova-border/50 bg-nova-surface/20">
				<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-nova-violet/10">
					<Icon
						icon={tablerCloudUpload}
						width="18"
						height="18"
						className="text-nova-violet-bright"
					/>
				</div>
				<div className="min-w-0">
					<h2 className="text-base font-display font-semibold text-nova-text">
						CommCare HQ
					</h2>
					<p className="text-xs text-nova-text-muted">
						Upload apps directly from Nova
					</p>
				</div>

				{/* Connected pill — appears in the header corner */}
				<AnimatePresence>
					{isConfigured && (
						<motion.div
							initial={{ opacity: 0, scale: 0.9 }}
							animate={{ opacity: 1, scale: 1 }}
							exit={{ opacity: 0, scale: 0.9 }}
							transition={{ duration: 0.2 }}
							className="ml-auto flex items-center gap-1.5 rounded-full border border-nova-emerald/20 bg-nova-emerald/10 px-2.5 py-1"
						>
							<div className="h-1.5 w-1.5 rounded-full bg-nova-emerald" />
							<span className="text-xs font-medium text-nova-emerald">
								Connected
							</span>
						</motion.div>
					)}
				</AnimatePresence>
			</div>

			{/* ── Card body ─────────────────────────────────────────── */}
			<div className="p-6">
				{/* Connected domain badge — shown above the fields */}
				<AnimatePresence>
					{isConfigured && domain && (
						<motion.div
							initial={{ opacity: 0, height: 0, marginBottom: 0 }}
							animate={{
								opacity: 1,
								height: "auto",
								marginBottom: 20,
							}}
							exit={{ opacity: 0, height: 0, marginBottom: 0 }}
							transition={{ duration: 0.25 }}
						>
							<div className="flex items-center gap-2.5 rounded-lg border border-nova-emerald/10 bg-nova-emerald/[0.04] px-3.5 py-2.5">
								<Icon
									icon={tablerCheck}
									width="15"
									height="15"
									className="shrink-0 text-nova-emerald"
								/>
								<span className="text-sm text-nova-text">
									Connected to{" "}
									<span className="font-semibold text-nova-emerald">
										{domain.displayName}
									</span>
								</span>
							</div>
						</motion.div>
					)}
				</AnimatePresence>

				{/* ── Form fields ────────────────────────────────────── */}
				<div className="space-y-4">
					{/* Username */}
					<label className="flex flex-col gap-1.5">
						<span className="text-sm font-medium text-nova-text-secondary">
							Username
						</span>
						<input
							type="email"
							value={username}
							onChange={(e) => setUsername(e.target.value)}
							placeholder="you@example.com"
							disabled={fieldsLocked}
							autoComplete="off"
							data-1p-ignore
							className={fieldsLocked ? INPUT_LOCKED : INPUT_ACTIVE}
						/>
					</label>

					{/* API Key — masked when locked, plaintext when editable */}
					<label htmlFor="commcare-api-key" className="flex flex-col gap-1.5">
						<span className="text-sm font-medium text-nova-text-secondary">
							API Key
						</span>
						{fieldsLocked ? (
							<input
								id="commcare-api-key"
								type="text"
								value={API_KEY_MASK}
								disabled
								tabIndex={-1}
								autoComplete="off"
								data-1p-ignore
								className={`${INPUT_LOCKED} tracking-wider`}
							/>
						) : (
							<input
								id="commcare-api-key"
								type="text"
								value={apiKey}
								onChange={(e) => setApiKey(e.target.value)}
								placeholder="Paste your API key"
								autoComplete="off"
								data-1p-ignore
								className={INPUT_ACTIVE}
							/>
						)}

						{/* Help link — only when the input is editable */}
						{!fieldsLocked && (
							<span className="text-xs text-nova-text-muted">
								Generate one at{" "}
								<a
									href="https://www.commcarehq.org/account/api_keys/"
									target="_blank"
									rel="noopener noreferrer"
									className="inline-flex items-center gap-0.5 text-nova-violet-bright hover:underline"
								>
									commcarehq.org/account/api_keys
									<Icon icon={tablerExternalLink} width="12" height="12" />
								</a>
							</span>
						)}
					</label>
				</div>

				{/* ── Status feedback area ───────────────────────────── */}
				<div aria-live="polite">
					<AnimatePresence mode="wait">
						{status.type === "connecting" && (
							<motion.div
								key="connecting"
								initial={STATUS_ENTER}
								animate={STATUS_VISIBLE}
								exit={STATUS_EXIT}
								transition={STATUS_TRANSITION}
								className="mt-5 flex items-center gap-2 text-sm text-nova-text-muted"
							>
								<Icon
									icon={tablerLoader2}
									width="14"
									height="14"
									className="animate-spin"
								/>
								<span>Connecting to CommCare HQ...</span>
							</motion.div>
						)}

						{status.type === "testing" && (
							<motion.div
								key="testing"
								initial={STATUS_ENTER}
								animate={STATUS_VISIBLE}
								exit={STATUS_EXIT}
								transition={STATUS_TRANSITION}
								className="mt-5 space-y-2"
							>
								{/* Progress bar */}
								<div className="h-1 w-full overflow-hidden rounded-full bg-white/[0.04]">
									<motion.div
										className="h-full rounded-full bg-gradient-to-r from-nova-violet to-nova-violet-bright shadow-[0_0_8px_rgba(139,92,246,0.3)]"
										initial={{ width: 0 }}
										animate={{ width: `${progress}%` }}
										transition={{
											ease: "easeOut",
											duration: 0.3,
										}}
									/>
								</div>
								<p className="text-xs text-nova-text-muted">
									Checking domain access{" "}
									<span className="tabular-nums text-nova-text-secondary">
										{status.tested}
									</span>
									<span className="mx-0.5 text-nova-text-muted/50">/</span>
									<span className="tabular-nums">{status.total}</span>
								</p>
							</motion.div>
						)}

						{status.type === "error" && (
							<motion.div
								key="error"
								initial={STATUS_ENTER}
								animate={STATUS_VISIBLE}
								exit={STATUS_EXIT}
								transition={STATUS_TRANSITION}
								className="mt-5 text-sm leading-relaxed text-nova-rose"
							>
								{status.message}
							</motion.div>
						)}
					</AnimatePresence>
				</div>

				{/* ── Actions ────────────────────────────────────────── */}
				<div className="mt-5 flex items-center gap-3">
					{showSaveArea && (
						<button
							type="button"
							onClick={handleSave}
							disabled={!canSave || isVerifying}
							className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-nova-violet px-5 py-2.5 text-sm font-medium text-white transition-all duration-200 hover:bg-nova-violet-bright disabled:cursor-not-allowed disabled:opacity-40"
						>
							{isVerifying ? (
								<>
									<Icon
										icon={tablerLoader2}
										width="16"
										height="16"
										className="animate-spin"
									/>
									Verifying...
								</>
							) : (
								"Test & Save"
							)}
						</button>
					)}

					{showDisconnectArea && (
						<button
							type="button"
							onClick={handleDisconnect}
							disabled={status.type === "deleting"}
							className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-4 py-2.5 text-sm text-nova-text-secondary transition-colors hover:bg-nova-rose/[0.06] hover:text-nova-rose disabled:cursor-not-allowed disabled:opacity-40"
						>
							{status.type === "deleting" ? (
								<>
									<Icon
										icon={tablerLoader2}
										width="14"
										height="14"
										className="animate-spin"
									/>
									Removing...
								</>
							) : (
								<>
									<Icon icon={tablerTrash} width="14" height="14" />
									Disconnect
								</>
							)}
						</button>
					)}
				</div>
			</div>
		</section>
	);
}
