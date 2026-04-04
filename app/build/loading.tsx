/**
 * Loading skeleton for /build/* routes.
 *
 * Shows during client-side navigation while the build layout's server-side
 * auth gate (`requireAuth()`) resolves. Displays the same centered logo
 * spinner that BuilderLayout shows during app loading — so the user sees
 * one continuous loading state instead of flashing back to the app list.
 */
import { Logo } from "@/components/ui/Logo";

export default function BuildLoading() {
	return (
		<div className="h-full flex items-center justify-center">
			<div className="animate-pulse">
				<Logo size="md" />
			</div>
		</div>
	);
}
