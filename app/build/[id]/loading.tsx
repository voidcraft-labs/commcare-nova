/**
 * Build page loading skeleton — shown by Next.js while the RSC page
 * awaits server-side data (auth check + Firestore app read).
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
