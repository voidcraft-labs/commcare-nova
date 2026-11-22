"""Independent parity for an app's HQ lookup-resource claims.

The lookup tag belongs to a Project resource outside app.json. Core's parsed instance reads and the Search
itemset supply the referenced tags. The authorized lookup table list supplies their exact definitions.
"""

from __future__ import annotations

from proof.checks import observations
from proof.checks.differences import Difference, pointer_token
from proof.checks.manifest_value_classes import instance_scheme

ALIAS_ENTRY = "expressions-and-data/tag-equal-to-an-instance-name-commcare-owns"
ARTIFACT = "lookup-tables"


def resource_entries(manifest, table):
    """Held name classes of this observed definition, each at its resource pointer."""
    tag = table["tag"]
    # HQ registers the schemes in the extracted manifest. The Search input root is another reserved name in Core.
    if (
        tag.lower() == "input"
        or manifest.item(f"instance-scheme:{instance_scheme(tag.lower())}") is not None
    ):
        yield "lookup-model:LookupTable.tag", f"/{pointer_token(tag)}/tag", ALIAS_ENTRY


def differences(document, manifest, tags, reads, claims):
    """A referenced resource must receive exactly its observed name-class claim."""
    data = reads.get("projectData", {})
    listing = data.get("lookupTables")
    if listing is None:
        if tags:
            raise observations.RecordIncomplete(
                f"{document}'s authored read lacks the lookup definition list."
            )
        definitions = []
    else:
        body = observations.answer_json(listing)
        if (
            listing.get("status") != 200
            or not isinstance(body, dict)
            or not isinstance(body.get("objects"), list)
        ):
            if tags:
                raise observations.RecordIncomplete(
                    f"{document}'s authored read lacks a successful lookup definition list."
                )
            definitions = []
        else:
            definitions = body["objects"]
    expected = {
        (where, entry): key
        for table in definitions
        if table["tag"] in tags
        for key, where, entry in resource_entries(manifest, table)
    }
    actual = {
        (record.where, record.entry): record.standing
        for record in claims
        if record.artifact == ARTIFACT and record.entry == ALIAS_ENTRY
    }
    found = []
    for where, entry in sorted(expected.keys() | actual.keys()):
        pair = (where, entry)
        if pair in expected and actual.get(pair) == "held":
            continue
        key = expected.get(pair, "lookup-model:LookupTable.tag")
        what = (
            "unseen"
            if pair not in expected
            else "unclaimed"
            if pair not in actual
            else "standing"
        )
        path = f"/{pointer_token(key)}/{what}"
        found.append(
            Difference(
                "parity",
                document,
                "claims@A",
                path,
                f"{path}@{ARTIFACT}{where}",
                "changed",
                {"standing": "held", "entries": [entry]} if pair in expected else None,
                {"standing": actual[pair], "entry": entry} if pair in actual else None,
            )
        )
    return found
