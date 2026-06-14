/**
 * Async server component — user profile card.
 *
 * Fetches the user document from Firestore and renders the profile card
 * with an impersonate action for admins viewing another user's profile.
 * Wrapped in a Suspense boundary by the parent page so it streams in
 * independently of the usage table and app list.
 */
import Image from "next/image";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/Badge";
import { getSession } from "@/lib/auth-utils";
import { getAdminUserProfile } from "@/lib/db/admin";
import { formatRelativeDate } from "@/lib/utils/format";
import { ImpersonateButton } from "./impersonate-button";

interface UserProfileSectionProps {
	userId: string;
}

export async function UserProfileSection({ userId }: UserProfileSectionProps) {
	const [user, session] = await Promise.all([
		getAdminUserProfile(userId),
		getSession(),
	]);
	if (!user) notFound();

	const isSelf = session?.user?.id === userId;

	return (
		<div className="bg-nova-deep border border-nova-border rounded-xl p-6">
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-4">
					{user.image ? (
						<Image
							src={user.image}
							alt=""
							width={48}
							height={48}
							className="w-12 h-12 rounded-full border border-nova-border"
						/>
					) : (
						<div className="w-12 h-12 rounded-full bg-nova-surface border border-nova-border flex items-center justify-center text-lg text-nova-text-secondary">
							{user.name.charAt(0).toUpperCase()}
						</div>
					)}
					<div>
						<h2 className="text-lg font-display font-semibold">{user.name}</h2>
						<p className="text-sm text-nova-text-secondary">{user.email}</p>
						<p className="text-xs text-nova-text-muted mt-1">
							Joined{" "}
							{new Date(user.created_at).toLocaleDateString("en-US", {
								month: "short",
								day: "numeric",
								year: "numeric",
							})}
							{" \u00b7 "}
							Active {formatRelativeDate(new Date(user.last_active_at))}
						</p>
					</div>
				</div>
				<div className="flex items-center gap-3">
					{!isSelf && (
						<ImpersonateButton userId={userId} userName={user.name} />
					)}
					<Badge variant={user.role === "admin" ? "violet" : "muted"}>
						{user.role}
					</Badge>
				</div>
			</div>
		</div>
	);
}
