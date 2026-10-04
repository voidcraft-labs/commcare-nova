"""The rule ``profile-required-minimal`` is sound: Core installs and runs a profile alike with ``requiredMinimal``
``"0"`` and without it.

Contract: the rule erases, in a session trace, the profile's
``requiredMinimal`` ``"0"`` against its absence: HQ's profile writes ``"0"``,
and Nova's local archive writes none. The plausible failures: Core reading
an absent minimal version otherwise than 0 (so the two archives would
install or run differently), and the rule erasing another minimal version,
which Core checks against the platform.

Core checks a profile's minimal version only where the profile asks for
the platform's own minor version (commcare-core ``xml/ProfileParser.java::
parseProfileElement``), so every variant here asks for it
(``PLATFORM_MINOR``). HQ's build of a corpus document is installed with
``requiredMinimal`` ``"0"`` and with it taken out of its profiles: Core
admits both and the sessions it derives on the first replay on the second,
and the traces differ only where they record the attribute, which the rule
erases. A minimal version above the platform's (``"1"``) is refused by
Core's version check, and in a trace the rule leaves it.
"""

from __future__ import annotations

import copy

from lxml import etree

from proof.checks import casedata
from proof.rules.conftest import Ran, published, restore, run, runs_alike, shown, trace_differences
from proof.rules.profile_required_minimal import RULE

DOCUMENT = "arithmetic"
PROFILES = ("profile.xml", "profile.ccpr", "media_profile.xml", "media_profile.ccpr")
# The Core runner's platform minor version and minimal version (commcare-core ``CommCareConfigEngine.MINOR_VERSION``
# and ``MINIMAL_VERSION`` at the pin, 2.64.0).
PLATFORM_MINOR = "64"


def _minimal(files, value):
    """The build's files with each profile asking for the platform's minor version, and its ``requiredMinimal``
    set to ``value``, or taken out where None."""
    changed = dict(files)
    for name in PROFILES:
        if name not in files:
            continue
        root = etree.fromstring(files[name])
        assert root.get("requiredMinimal") == "0", root.attrib
        root.set("requiredMinor", PLATFORM_MINOR)
        if value is None:
            del root.attrib["requiredMinimal"]
        else:
            root.set("requiredMinimal", value)
        changed[name] = etree.tostring(root, encoding="utf-8", xml_declaration=True)
    return changed


def test_core_reads_an_absent_minimal_version_as_zero(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        built = app.spell()
        zero, absent = _minimal(built.build.files, "0"), _minimal(built.build.files, None)
        ran_zero, ran_absent, raw = runs_alike(
            app, core_runner, built.build, built.build, first_files=zero, second_files=absent
        )
        _, _, after = runs_alike(
            app, core_runner, built.build, built.build, first_files=zero, second_files=absent, rules=(RULE,)
        )
        database = casedata.case_database(rule_documents[DOCUMENT].document)
        higher = run(
            app, core_runner, built.build, restore(app, database), database, files=_minimal(built.build.files, "1")
        )

    assert ran_zero.admission["versionCheck"] == ran_absent.admission["versionCheck"]
    assert ran_zero.admission["versionCheck"]["accepted"] is True, ran_zero.admission["versionCheck"]
    assert shown(raw) == [("trace", "/profile/requiredVersion/requiredMinimal", "changed")], shown(raw)
    assert after == []
    assert higher.admission["versionCheck"]["accepted"] is False, higher.admission["versionCheck"]
    # Core admits no build asking for "1", so its trace is the admitted one's with the attribute "1".
    one = copy.deepcopy(ran_zero.trace)
    one["profile"]["requiredVersion"]["requiredMinimal"] = "1"
    left = trace_differences(Ran(ran_zero.admission, one, ran_zero.processed), ran_absent, rules=(RULE,))
    assert shown(left) == [("trace", "/profile/requiredVersion/requiredMinimal", "changed")], shown(left)
