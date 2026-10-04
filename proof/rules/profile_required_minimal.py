"""A profile's ``requiredMinimal`` ``"0"`` or absent, as a session trace records it.

HQ's profile writes ``requiredMinimal`` (the patch release of the build's
CommCare version, ``templates/app_manager/profile.xml``), ``"0"`` at the
versions it builds for; a profile without it reads the same: Core takes an
absent ``requiredMinimal`` as 0 (commcare-core
``xml/ProfileParser.java::parseProfileElement``: "defaults to 0 since old app builds don't
have requiredMinimal defined in Profile") and checks it only against the
platform's minimal version at the same minor version. The Core runner's
trace records the three ``required*`` attributes as the profile states them
(``proof/core/src/nova/proof/core/Admission.java::profileForTrace``), so the
two spellings show there and nowhere else.

The rule makes a trace's ``profile.requiredVersion.requiredMinimal`` null
where it is ``"0"``.
"""

from __future__ import annotations

from proof.rules import SpellingRule


def normalize(trace):
    profile = trace.get("profile") if isinstance(trace, dict) else None
    required = profile.get("requiredVersion") if isinstance(profile, dict) else None
    if isinstance(required, dict) and required.get("requiredMinimal") == "0":
        required["requiredMinimal"] = None
    return trace


RULE = SpellingRule(
    "profile-required-minimal",
    "trace",
    'A profile\'s requiredMinimal "0" or absent, which Core reads as 0 (xml/ProfileParser.java::parseProfileElement).',
    normalize,
)
