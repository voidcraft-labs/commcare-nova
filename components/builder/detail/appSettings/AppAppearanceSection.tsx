"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertTriangle from "@iconify-icons/tabler/alert-triangle";
import { InfoPopover } from "@/components/builder/InfoPopover";
import { SingleAssetSlot } from "@/components/builder/media/MediaSlot";
import { useAppLogo } from "@/lib/doc/hooks/useAppLogo";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useUncarriedLogo } from "@/lib/doc/hooks/useUncarriedLogo";
import { asAssetId } from "@/lib/domain";

/**
 * App-level appearance: the logo image shown on the web-apps login and
 * home screens. A single optional image asset — no audio, no per-language
 * variants (Android-only logo slots are out of scope for Nova's web-apps
 * target). The change dispatches through `setAppLogo` so a clear rides
 * the JSON-safe `null` sentinel; the reducer maps `null → undefined` so
 * the cleared key drops off the doc rather than persisting as a literal
 * `null` the `.optional()` schema would reject.
 *
 * When the logo image is used ONLY as the logo, it won't reach the device:
 * CommCare HQ's upload excludes app-level logos from its media-match set
 * (see `useUncarriedLogo`). We warn here, proactively, rather than letting
 * the user discover a blank banner after uploading.
 */
export function AppAppearanceSection() {
	const logo = useAppLogo();
	const uncarriedLogo = useUncarriedLogo();
	const { setAppLogo } = useBlueprintMutations();

	return (
		<div>
			<span className="text-xs font-medium text-nova-text-secondary uppercase tracking-wider mb-1.5 block">
				App logo
			</span>
			<div>
				<span className="text-xs text-nova-text-muted mb-1 block">Image</span>
				<SingleAssetSlot
					value={logo}
					kind="image"
					slotKey="app:logo"
					ariaLabel="App logo"
					onChange={(next) => setAppLogo(next ? asAssetId(next) : null)}
				/>
				{uncarriedLogo && <UncarriedLogoNotice />}
			</div>
		</div>
	);
}

/**
 * The proactive heads-up shown when the logo image is used nowhere else —
 * a small amber line plus an info popover explaining (in plain terms) why
 * it won't appear and what to do about it.
 */
function UncarriedLogoNotice() {
	return (
		<div className="mt-2 flex items-start gap-1.5">
			<Icon
				icon={tablerAlertTriangle}
				className="mt-px size-3.5 shrink-0 text-nova-amber"
			/>
			<p className="text-xs leading-snug text-nova-amber">
				This logo won't appear on the device on its own.
			</p>
			<InfoPopover
				title="Why won't my logo appear?"
				ariaLabel="Why won't my logo appear?"
				className="mt-px size-3.5"
			>
				CommCare doesn't carry an app logo by itself when you upload — logos are
				set inside <span className="text-nova-text">CommCare HQ</span>. Your app
				still works; it just won't show this logo until you add it there. Tip:
				if you also use this image somewhere in a form — like a question or a
				menu icon — it gets carried with the app automatically.
			</InfoPopover>
		</div>
	);
}
