/**
 * Async server component — user credit balance + admin controls.
 *
 * Fetches the user's current-period balance and the admin-intervention audit
 * trail from Firestore, then hands both to the interactive `CreditControls`
 * client component. Wrapped in a Suspense boundary by the parent page so it
 * streams in independently of the profile card, usage table, and app list.
 *
 * The split mirrors `UserUsageSection`: the server does the read (auth is
 * already guaranteed by the admin layout), the client owns the credit-mutating
 * actions. After a successful mutation the client calls `navigate.refresh()`,
 * which re-runs this server component — so the rendered balance + audit list
 * always reflect Firestore, never optimistic local state.
 */
import { getAdminUserCredits } from "@/lib/db/admin";
import { CreditControls } from "./credit-controls";

interface UserCreditsSectionProps {
	userId: string;
}

export async function UserCreditsSection({ userId }: UserCreditsSectionProps) {
	const { credits, grants } = await getAdminUserCredits(userId);

	return <CreditControls userId={userId} credits={credits} grants={grants} />;
}
