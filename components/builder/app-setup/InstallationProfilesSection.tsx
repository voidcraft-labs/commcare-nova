"use client";

import { useId, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { Button } from "@/components/shadcn/button";
import { Field, FieldLabel } from "@/components/shadcn/field";
import { Input } from "@/components/shadcn/input";
import { Switch } from "@/components/shadcn/switch";
import { useAppSettings } from "@/lib/doc/hooks/useAppSettings";
import { type AppSettingsPatch, asUuid, type LanguageTag } from "@/lib/domain";

type ProfileChange = NonNullable<AppSettingsPatch["installationProfile"]>;

export function InstallationProfilesSection({
	languages,
	label,
	commit,
}: {
	languages: readonly LanguageTag[];
	label: (language: LanguageTag) => string;
	commit: (change: ProfileChange) => boolean;
}) {
	const profiles = Object.values(useAppSettings().installationProfiles ?? {});
	const [newName, setNewName] = useState("");
	const addId = useId();
	return (
		<section className="space-y-4" aria-label="Installation profiles">
			<div>
				<h3 className="text-sm font-medium text-nova-text">
					Installation profiles
				</h3>
				<p className="text-sm text-nova-text-secondary">
					All app languages are available by default. A profile lets one team
					install just the languages they use.
				</p>
			</div>
			{profiles.map((profile) => {
				const selected = profile.languages;
				const ordered = [
					...selected,
					...languages.filter((language) => !selected.includes(language)),
				];
				const changeLanguages = (next: LanguageTag[]) =>
					commit({
						operation: "update",
						uuid: profile.uuid,
						patch: { languages: next },
					});
				return (
					<article
						key={profile.uuid}
						className="space-y-3 rounded-xl border border-nova-border p-4"
					>
						<Field>
							<FieldLabel htmlFor={profile.uuid}>Profile name</FieldLabel>
							<Input
								key={profile.name}
								id={profile.uuid}
								defaultValue={profile.name}
								onBlur={(event) => {
									const name = event.currentTarget.value.trim();
									if (name && name !== profile.name)
										commit({
											operation: "update",
											uuid: profile.uuid,
											patch: { name },
										});
									else event.currentTarget.value = profile.name;
								}}
							/>
						</Field>
						<fieldset>
							<legend className="text-sm font-medium text-nova-text">
								Installation languages
							</legend>
							{ordered.map((language, index) => {
								const included = selected.includes(language);
								return (
									<div
										key={language}
										className="flex items-center justify-between gap-3 py-1"
									>
										<label
											htmlFor={`${profile.uuid}-${language}`}
											className="flex items-center gap-2 text-sm"
										>
											<Switch
												id={`${profile.uuid}-${language}`}
												checked={included}
												disabled={included && selected.length === 1}
												onCheckedChange={(on) =>
													changeLanguages(
														on
															? [...selected, language]
															: selected.filter((tag) => tag !== language),
													)
												}
											/>
											{label(language)}
											{index === 0 && " (opens first)"}
										</label>
										{included && index > 0 && (
											<Button
												type="button"
												variant="ghost"
												aria-label={`Move ${label(language)} up`}
												onClick={() => {
													const next = [...selected];
													[next[index - 1], next[index]] = [
														next[index],
														next[index - 1],
													];
													changeLanguages(next);
												}}
											>
												Move up
											</Button>
										)}
									</div>
								);
							})}
						</fieldset>
						<label
							htmlFor={`${profile.uuid}-practice`}
							className="flex items-center gap-2 text-sm"
						>
							<Switch
								id={`${profile.uuid}-practice`}
								checked={profile.requiresPracticeWorker}
								onCheckedChange={(requiresPracticeWorker) =>
									commit({
										operation: "update",
										uuid: profile.uuid,
										patch: { requiresPracticeWorker },
									})
								}
							/>
							Use a practice worker
						</label>
						{profile.requiresPracticeWorker && (
							<p className="text-sm text-nova-text-secondary">
								Each project space supplies its own practice worker when you
								publish.
							</p>
						)}
						<Button
							type="button"
							variant="ghost"
							onClick={() =>
								commit({ operation: "remove", uuid: profile.uuid })
							}
						>
							Remove profile
						</Button>
					</article>
				);
			})}
			<form
				className="flex items-end gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					const name = newName.trim();
					if (
						name &&
						commit({
							operation: "add",
							profile: {
								uuid: asUuid(uuidv4()),
								name,
								languages: [...languages],
								requiresPracticeWorker: false,
							},
						})
					)
						setNewName("");
				}}
			>
				<Field>
					<FieldLabel htmlFor={addId}>New profile name</FieldLabel>
					<Input
						id={addId}
						value={newName}
						onChange={(event) => setNewName(event.currentTarget.value)}
					/>
				</Field>
				<Button type="submit" variant="secondary" disabled={!newName.trim()}>
					Add profile
				</Button>
			</form>
		</section>
	);
}
