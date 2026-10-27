"use client";

import { Icon } from "@iconify/react/offline";
import tablerInfoCircle from "@iconify-icons/tabler/info-circle";
import { SingleAssetSlot } from "@/components/builder/media/MediaSlot";
import { useAppLogo } from "@/lib/doc/hooks/useAppLogo";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";

/**
 * The line shown under every logo. A publish never sends the logo: HQ
 * writes a logo into its builds and its Web Apps tile only from the record
 * its own uploader stores, so the logo reaches Web Apps once a person adds
 * it in the app's settings there. Android ignores the logo, so Preview
 * draws it only while it runs as Web Apps. No sentence names a downloaded
 * app, because no reader of a `.ccz` reads the key the local archive
 * writes.
 */
export const APP_LOGO_NOTE =
	"Your logo shows in Preview when it runs as Web Apps. Web Apps shows it once you add it in this app's settings in CommCare HQ, and Android doesn't show it.";

/**
 * App-level appearance: the logo image. A single optional image asset: no
 * audio, no per-language variants (Android-only logo slots are out of
 * scope for Nova's web-apps target). The change dispatches through
 * `setAppLogo` so a clear rides the JSON-safe `null` sentinel; the reducer
 * maps `null → undefined` so the cleared key drops off the doc rather than
 * persisting as a literal `null` the `.optional()` schema would reject.
 *
 * Whenever the app has a logo, the section says where it shows, before
 * anyone publishes and wonders why Web Apps does not show it yet.
 */
export function AppAppearanceSection() {
	const logo = useAppLogo();
	const { setAppLogo } = useBlueprintMutations();

	return (
		<div>
			<span className="text-xs font-medium text-nova-text-secondary mb-1.5 block">
				App logo
			</span>
			<div>
				<span className="text-xs text-nova-text-muted mb-1 block">Image</span>
				<SingleAssetSlot
					value={logo}
					kind="image"
					slotKey="app:logo"
					ariaLabel="App logo"
					onChange={(next) => setAppLogo(next ?? null)}
				/>
				{logo !== undefined && (
					<div className="mt-2 flex items-start gap-1.5">
						<Icon
							icon={tablerInfoCircle}
							className="mt-px size-3.5 shrink-0 text-nova-text-muted"
						/>
						<p className="text-xs leading-snug text-nova-text-secondary">
							{APP_LOGO_NOTE}
						</p>
					</div>
				)}
			</div>
		</div>
	);
}
