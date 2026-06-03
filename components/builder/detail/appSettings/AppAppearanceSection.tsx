"use client";

import { SingleAssetSlot } from "@/components/builder/media/MediaSlot";
import { useAppLogo } from "@/lib/doc/hooks/useAppLogo";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { asAssetId } from "@/lib/domain";

/**
 * App-level appearance: the logo image shown on the web-apps login and
 * home screens. A single optional image asset — no audio, no per-language
 * variants (Android-only logo slots are out of scope for Nova's web-apps
 * target). The change dispatches through `setAppLogo` so a clear rides
 * the JSON-safe `null` sentinel; the reducer maps `null → undefined` so
 * the cleared key drops off the doc rather than persisting as a literal
 * `null` the `.optional()` schema would reject.
 */
export function AppAppearanceSection() {
	const logo = useAppLogo();
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
					ariaLabel="App logo"
					onChange={(next) => setAppLogo(next ? asAssetId(next) : null)}
				/>
			</div>
		</div>
	);
}
