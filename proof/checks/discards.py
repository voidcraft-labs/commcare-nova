"""What a republish a person confirmed over their own saves in HQ changes, held to its statement.

A document's ``hq-side.json`` says its republish ``discards`` where a person saved in HQ a setting Nova owns and
writes on every publish: Nova's next publish stops on it (``hq_changed``) and goes through only once the person
confirms the discard (``proof/corpus/publish.ts``), writing Nova's value over theirs. Proofs 2 and 3 hold that the
next publish leaves the app as HQ held it; on such a document, the settings it discards are the one place it does
not, by design.

``DISCARDED`` names, for each setting Nova owns that a save may set, every difference its discard makes, as a
register entry names a class (check, artifact pattern, structural path, kind), written from the evidence of
``targeted-hq-side-owned``:

- "Auto Capture Location" (``appAttributes.auto_gps_capture``): HQ's build of each form loses the location meta
  block, its bind and its poll (``xform.py::XForm._add_meta_2``), and so each submission its location
  (proof 3, on HQ's build and on the local archive made for the project space as the republish left it);
- the required Android apps (``profileFeatures.dependencies``): HQ's profile loses its ``<dependencies>``
  (``templates/app_manager/profile.xml``) in each of its four spellings, and each language's app strings the
  name of each app (``app_strings.py::_create_dependencies_app_strings``).

``discarded`` takes exactly those differences out of a check's findings, and reports a statement that no
difference meets, where its artifact was compared, at ``/discarded-hq-side/<save>/<key><path>``: a discard that
changes nothing is a republish that did not write Nova's value. A document whose republish does not discard holds
no statement, and a save outside ``DISCARDED`` on one that does is refused by name.
"""

from __future__ import annotations

import fnmatch
from dataclasses import dataclass

from proof.checks.differences import Difference

LOCATION_SUBMISSION = "/runs/*/trace/*/submission/data/meta[*]/location[*]"
DEPENDENCIES = "/profile/features[*]/dependencies[*]"


@dataclass(frozen=True)
class Discarded:
    check: str
    artifact: str
    path: str
    kind: str

    def matches(self, difference) -> bool:
        return (
            difference.check == self.check
            and difference.path == self.path
            and difference.kind == self.kind
            and fnmatch.fnmatchcase(difference.artifact, self.artifact)
        )


DISCARDED = {
    ("appAttributes", "auto_gps_capture"): (
        Discarded("proof2", "form:*", "/html/head[*]/model[*]/bind[@nodeset=/data/meta/location]", "removed"),
        Discarded("proof2", "form:*", "/html/head[*]/model[*]/instance[*]/data[*]/meta[*]/location[*]", "removed"),
        Discarded("proof2", "form:*", "/html/head[*]/model[*]/pollsensor[*]", "removed"),
        Discarded("proof3", "trace@B", LOCATION_SUBMISSION, "removed"),
        Discarded("proof3", "trace@local.ccz", LOCATION_SUBMISSION, "removed"),
    ),
    ("profileFeatures", "dependencies"): (
        Discarded("proof2", "profile.xml", DEPENDENCIES, "removed"),
        Discarded("proof2", "profile.ccpr", DEPENDENCIES, "removed"),
        Discarded("proof2", "media_profile.xml", DEPENDENCIES, "removed"),
        Discarded("proof2", "media_profile.ccpr", DEPENDENCIES, "removed"),
        Discarded("proof2", "app_strings:*", "/android.package.name.*", "removed"),
    ),
}


def statements(hq_side, check) -> list[tuple[tuple[str, str], Discarded]]:
    """Each owned ``(save, key)`` a discarding republish writes over, with every statement of it ``check`` holds. A
    save of a setting Nova does not own is kept by the republish, and the other checks hold it."""
    if not hq_side or hq_side.get("republish") != "discards":
        return []
    return [
        ((save, key), one)
        for (save, key), stated in DISCARDED.items()
        if key in (hq_side.get(save) or {})
        for one in stated
        if one.check == check
    ]


def discarded(check, document, hq_side, found, compared=None) -> list:
    """``found`` without the differences ``hq_side``'s confirmed discard makes, and with each statement no difference
    meets where its artifact was compared (``compared``, a set of artifact names; None for every one)."""
    stated = statements(hq_side, check)
    if not stated:
        return found
    kept, met = [], set()
    for difference in found:
        index = next((i for i, (_, one) in enumerate(stated) if one.matches(difference)), None)
        if index is None:
            kept.append(difference)
        else:
            met.add(index)
    for index, ((save, key), one) in enumerate(stated):
        if index in met:
            continue
        if compared is not None and not any(fnmatch.fnmatchcase(name, one.artifact) for name in compared):
            continue
        path = f"/discarded-hq-side/{save}/{key}{one.path}"
        kept.append(
            Difference(check, document, one.artifact, path, path, "removed", {"discarded": f"{save}.{key}"}, None)
        )
    return kept
