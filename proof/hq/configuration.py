"""A check's configuration: the project space HQ builds and runs against.

A configuration names what a real project space would hold and HQ reads
from outside the app: the feature flags turned on for it, the privileges its
plan grants, the CommCare version HQ builds at by default, whether case search
is on for it (``CaseSearchConfig.enabled``, which Nova's publish checks), and
the project settings publish asks about (CommTrack, sync cases on form entry).
Everything it does not name is off.

Sync cases on form entry is a setting of the project's case search config,
and HQ reads it only from an enabled one
(``case_search/models.py::case_search_sync_cases_on_form_entry_enabled_for_domain``),
so a configuration that turns it on with case search off names a project
space that cannot exist, and is refused.
"""

import hashlib
import json
from dataclasses import dataclass, field

# The harness builds at CommCare 2.57, the highest
# feature_support.py::_require_minimum_version.
DEFAULT_COMMCARE_VERSION = "2.57.0"
DEFAULT_DOMAIN = "nova-proof"


@dataclass(frozen=True)
class Configuration:
    # Flag symbols from corehq/toggles/__init__.py or corehq/feature_previews.py.
    flags: frozenset[str] = field(default_factory=frozenset)
    # Privilege symbols from corehq/privileges.py (``CLOUDCARE``, not ``cloudcare``).
    privileges: frozenset[str] = field(default_factory=frozenset)
    commcare_version: str = DEFAULT_COMMCARE_VERSION
    commtrack: bool = False
    # Only with case search on (see the module's docstring).
    sync_cases_on_form_entry: bool = False
    # HQ's state holds CaseSearchConfig(domain, enabled=True) when set.
    case_search_enabled: bool = False
    domain: str = DEFAULT_DOMAIN

    def __post_init__(self):
        object.__setattr__(self, "flags", frozenset(self.flags))
        object.__setattr__(self, "privileges", frozenset(self.privileges))
        if self.sync_cases_on_form_entry and not self.case_search_enabled:
            raise ValueError(
                "The configuration turns sync cases on form entry on with case search off, which no project space "
                "holds: HQ reads that setting only from an enabled case search config "
                "(case_search/models.py::case_search_sync_cases_on_form_entry_enabled_for_domain). Turn case search "
                "on with it (case_search_enabled=True)."
            )

    def canonical(self) -> bytes:
        """The configuration as canonical JSON: every field, sets sorted, keys sorted, no whitespace."""
        return json.dumps(
            {
                "flags": sorted(self.flags),
                "privileges": sorted(self.privileges),
                "commcare_version": self.commcare_version,
                "commtrack": self.commtrack,
                "sync_cases_on_form_entry": self.sync_cases_on_form_entry,
                "case_search_enabled": self.case_search_enabled,
                "domain": self.domain,
            },
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode()

    def digest(self) -> bytes:
        """The sha256 of ``canonical()``: two configurations that name the same project space share it."""
        return hashlib.sha256(self.canonical()).digest()

    def flag_toggles(self):
        """The toggle objects the configuration turns on, by symbol."""
        return {symbol: resolve_flag(symbol) for symbol in sorted(self.flags)}

    def privilege_slugs(self):
        """The privilege slugs HQ asks about, for the symbols the configuration grants."""
        return {resolve_privilege(symbol): symbol for symbol in sorted(self.privileges)}


def resolve_flag(symbol):
    import corehq.feature_previews as previews
    import corehq.toggles as toggles

    found = [
        getattr(module, symbol)
        for module in (toggles, previews)
        if isinstance(getattr(module, symbol, None), toggles.StaticToggle)
    ]
    if len(found) != 1:
        raise ValueError(
            f"The configuration names the flag {symbol!r}, which "
            + ("names no toggle or feature preview" if not found else "names both a toggle and a feature preview")
            + " in HQ at the pin. Name flags by their symbol in corehq/toggles/__init__.py "
            "or corehq/feature_previews.py."
        )
    return found[0]


def resolve_privilege(symbol):
    import corehq.privileges as privileges

    slug = getattr(privileges, symbol, None)
    if not isinstance(slug, str) or not symbol.isupper():
        raise ValueError(
            f"The configuration names the privilege {symbol!r}, which names no "
            "privilege in corehq/privileges.py at the pin. Name privileges by their "
            "symbol there (CLOUDCARE, VELLUM_SAVE_TO_CASE)."
        )
    return slug
