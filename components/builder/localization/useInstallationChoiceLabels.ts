"use client";
import {useMemo} from "react";
import {installationChoiceLabel,type InstallationProfile} from "@/lib/domain/installationProfiles";
import {languageEnglishName,languageDisplayLabel} from "@/lib/domain/languageRegistry";
import {useLanguageRegistrySearch} from "./useLanguageRegistrySearch";

const EMPTY_PROFILES: readonly InstallationProfile[] = [];
export function useInstallationChoiceLabels(profiles:readonly InstallationProfile[]=EMPTY_PROFILES){
 const unresolved=profiles.some(profile=>profile.languages.some(tag=>!languageEnglishName(tag)));
 const resolver=useLanguageRegistrySearch(unresolved).data;
 return useMemo(()=>{
  const label=(tag:string)=>{
   const english=languageEnglishName(tag) ?? resolver?.resolvedLanguageEnglishName(tag);
   const local=languageDisplayLabel(tag) ?? resolver?.resolvedLanguageDisplayLabel(tag);
   return local && english && local!==english ? `${local} / ${english}` : english ?? local ?? "Loading language name";
  };
  return new Map(profiles.map((profile,index)=>[profile.uuid,installationChoiceLabel(profile,index,label)]));
 },[profiles,resolver]);
}
