# Step 4: Platforms (outline)

Planned in full when step 3 exits. The design is the research's "Platforms" and
defects 11 (its second half), 18, 19 and 20.

## What it builds

1. **The platform declaration.** Web Apps, Android, or both, as a first-class
   fact of every app. Its wire form is `cloudcare_enabled`, written on every
   publish (`true` for an app that declares Web Apps, `false` otherwise). A new
   app declares both.
2. **Platform behavior per feature.** Each held feature carries, per platform,
   runs, ignored without harm, unavailable, or different, taken from the
   manifest (`lib/commcare/surface/`). The validator refuses any feature
   unavailable on a declared platform, and the builder, SA and MCP offer a
   feature only where it is available on every declared platform and show its
   stated difference where the author works.
3. **Media by platform** (defect 11, second half). A file is accepted only when
   every declared platform plays it and HQ types it as the same kind; a change
   of declaration is refused until each reference to a file the new platform
   cannot play is removed.
4. **Preview per platform.** Preview plays each declared platform, with browser
   stand-ins for device capabilities.
5. **Publish.** The `cloudcare` privilege joins the per-privilege confirmation
   for an app that declares Web Apps. Publish asks before changing a target's
   `cloudcare_enabled`. The sync-on-form-entry and CommTrack confirmations of
   defect 20 are recorded beside the privileges. The lane reproduces defect
   20's session (`targeted-sync-on-form-entry`, `proof/README.md`, "The defect
   rows"), and this step's fix removes its register entries.
6. **Defect 18.** The date-and-time question is offered only in an app that does
   not declare Web Apps.
7. **Defect 19.** Inline search, multi-select case lists, entry points and the
   case list menu item carry their per-platform behavior, and Preview shows it.

## Cutover and migration

One cutover. Each existing app is declared for the platforms its content other
than media runs on. An app whose content runs on neither is declared for Web
Apps and each of its date-and-time questions is split into a date question and
a time question joined by a datetime sibling, as the research's "Platforms"
gives it. Defect 11's removal then drops each reference to an asset a declared
platform does not play. The migration names every app and entity it changes.

## Contracts

- `contracts.md`: "Nova emits one wire flavor" is replaced by emission for the
  declared platforms.
- `lib/commcare/CLAUDE.md`: `cloudcare_enabled` becomes app content Nova writes.
- `lib/media/CLAUDE.md`: acceptance by declared platform.

## Exit

Every held feature carries its platform behavior; no app holds a feature
unavailable on a platform it declares; every platform cell that differs has a
Preview test exercising it on that platform.
