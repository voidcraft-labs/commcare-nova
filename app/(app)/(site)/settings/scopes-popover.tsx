/**
 * "Permissions" pill rendered on every settings row that represents
 * a credential — both `<ConnectedApps />` (OAuth grants) and
 * `<ApiKeys />` (long-lived bearers). The pill takes a list of
 * granted scopes, runs them through `deriveCapabilities` to
 * translate the raw OAuth tokens into human-readable rows, and
 * shows them in a Base UI popover on hover / focus / click.
 *
 * Lives at the settings-folder level rather than inside either card
 * because both surfaces use the same scope vocabulary
 * (`nova.read`, `nova.write`, `nova.hq.read`, `nova.hq.write`,
 * plus the OIDC `profile` / `email` set), and the visual + ARIA
 * shape should stay identical between them — credential rows that
 * read differently in two corners of the same settings page would
 * train users to think the underlying permission model is
 * different.
 *
 * Suppressed entirely when `deriveCapabilities` returns nothing —
 * no hollow pill opening an empty popover. Glass styles live on
 * the positioner per the project-wide `backdrop-filter` +
 * `will-change` constraint (see `lib/styles.ts`).
 */

"use client";

import { Popover } from "@base-ui/react/popover";
import { Icon } from "@iconify/react/offline";
import { deriveCapabilities } from "@/lib/oauth/capabilities";
import { POPOVER_POPUP_CLS, POPOVER_POSITIONER_GLASS_CLS } from "@/lib/styles";

interface ScopesPopoverProps {
	/** Granted scope tokens, e.g. `["nova.read", "nova.write"]`. */
	scopes: readonly string[];
	/**
	 * Phrase used as the popover title and aria-label, so the user
	 * sees "This OAuth app can…" / "This API key can…" / etc.
	 * Connected-apps passes "OAuth app", api-keys passes "API key";
	 * the calling card decides what reads naturally for its
	 * credential shape.
	 */
	credentialLabel: string;
	/**
	 * Specific subject identifier of the credential (e.g. the OAuth
	 * client name, or the API key's user-given name). Used inside
	 * `aria-label` to disambiguate when the user has multiple
	 * credentials open in the same view.
	 */
	subjectName: string;
}

export function ScopesPopover({
	scopes,
	credentialLabel,
	subjectName,
}: ScopesPopoverProps) {
	const capabilities = deriveCapabilities(scopes);
	if (capabilities.length === 0) return null;

	return (
		<Popover.Root>
			<Popover.Trigger
				openOnHover
				delay={150}
				closeDelay={120}
				aria-label={`Permissions granted to ${subjectName}`}
				className="inline-flex cursor-pointer items-center rounded-md border border-nova-violet/20 bg-nova-violet/[0.08] px-2 py-[2px] text-[11px] font-medium text-nova-violet-bright outline-none transition-all duration-150 hover:border-nova-violet/40 hover:bg-nova-violet/[0.14] focus-visible:border-nova-violet/40 focus-visible:bg-nova-violet/[0.14] focus-visible:ring-1 focus-visible:ring-nova-violet/40"
			>
				Permissions
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Positioner
					side="top"
					align="start"
					sideOffset={8}
					className={POPOVER_POSITIONER_GLASS_CLS}
				>
					<Popover.Popup className={`${POPOVER_POPUP_CLS} w-64`}>
						<div className="px-4 pt-3.5 pb-4">
							<p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-nova-text-muted/70">
								This {credentialLabel} can
							</p>
							<ul className="space-y-2">
								{capabilities.map((c) => (
									<li key={c.key} className="flex items-start gap-2.5">
										<Icon
											icon={c.icon}
											width="14"
											height="14"
											className="mt-[3px] shrink-0 text-nova-text-muted"
											aria-hidden
										/>
										<span className="text-xs leading-snug text-nova-text">
											{c.label}
										</span>
									</li>
								))}
							</ul>
						</div>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}
