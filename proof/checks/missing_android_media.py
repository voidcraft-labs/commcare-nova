"""A required picture's failed installation, as the archive, Android and the serving HQ each observed it."""

from dataclasses import replace
from hashlib import sha256
from urllib.parse import urlsplit

from proof.checks import android, broken_menu_images, changes, served
from proof.checks.compare.xml_tree import XmlNotWellFormed, parse_xml, qname
from proof.checks.differences import Difference

MISSING = "MissingResourcesWithMessage"
SUFFIX = ":missing-required-picture"
FAILED_REQUEST = "/hq/hqmedia_download/404/missing-required-picture"


def candidate(d):
    if d.check == "proof1" and d.artifact == android.LOCAL:
        return d.kind == "changed" and (
            (
                d.path == "/installs/*"
                and (d.before, d.after) in ((MISSING, android.INSTALLED), (android.INSTALLED, "DuplicateApp"))
            )
            or (d.path == "/update" and (d.before, d.after) == (f"not installed: {MISSING}", android.INSTALLED))
        )
    if d.check == "proof3":
        return (
            d.artifact in ("android@A", "android-tablet@A")
            and d.kind == "error"
            and d.path.startswith("/hq/hqmedia_download/404/")
        ) or (
            d.artifact in ("android@B", "android@local.ccz", "android-tablet@B", "android-tablet@local.ccz")
            and d.kind == "changed"
            and d.path == "/install"
            and d.before == MISSING
            and d.after == android.INSTALLED
        )
    return False


def _suites(files, read, *, profile_name="profile.ccpr"):
    """Media the profile actually installs: local entry -> (required, remote URL), with no ambiguous entries."""
    if not all(files.get(name) for name in (profile_name, "media_suite.xml")):
        return None
    try:
        profile, suite = (parse_xml(read(files[name])) for name in (profile_name, "media_suite.xml"))
    except XmlNotWellFormed:
        return None
    if (
        qname(profile.tag) not in ((None, "profile"), ("http://cihi.commcarehq.org/jad", "profile"))
        or suite.tag != "suite"
    ):
        return None
    if [node.text for node in profile.findall("{*}suite/{*}resource/{*}location[@authority='local']")].count(
        "./media_suite.xml"
    ) != 1:
        return None
    found = {}
    for media in suite:
        resources = media.findall("resource")
        if media.tag != "media" or len(resources) != 1:
            return None
        resource = resources[0]
        local = resource.findall("location[@authority='local']")
        remote = resource.findall("location[@authority='remote']")
        if len(local) != 1 or not (local[0].text or "").startswith("./") or len(remote) > 1:
            return None
        path = local[0].text[2:]
        if path in found:
            return None
        found[path] = (resource.get("lazy"), remote[0].text if remote else None)
    return found


def _cause(source, reads, a, b, aligned, local, blobs, *, again=None):
    menus = source.get("modules") or []
    used_icons = {
        uri
        for menu in menus
        for form in menu.get("forms") or []
        for uri in (form.get("media_image") or {}).values()
        if isinstance(uri, str)
    }
    original = _suites(a, blobs.get)
    if not original:
        return None
    absent = set(original) - a.keys()
    if len(absent) != 1:
        return None
    entry = absent.pop()
    uri = "jr://file/" + entry
    media_id = broken_menu_images.missing_images(source, reads).get(uri)
    lazy, url = original[entry]
    if uri not in used_icons or not media_id or lazy != "false" or not url:
        return None
    remote = urlsplit(url)
    if (
        remote.scheme != "https"
        or not remote.netloc
        or remote.query
        or remote.fragment
        or remote.path.split("/")
        != ["", "hq", "multimedia", "file", "CommCareImage", media_id, entry.rsplit("/", 1)[-1]]
    ):
        return None
    # Every sibling is present in A. Losing an additional file, substituting bytes, or merely turning off
    # the whole media suite cannot be described as eliminating this single unavailable resource.
    kept = set(original) - {entry}
    ordinary, active = _suites(b, blobs.get), _suites(aligned, blobs.get, profile_name="media_profile.ccpr")
    if entry in b or any(suite is None or set(suite) != kept for suite in (ordinary, active)):
        return None
    if any(a[path] != b.get(path) for path in kept):
        return None
    for archive in (local,) if again is None else (local, again):
        fresh = _suites(archive, lambda data: data)
        if fresh is None or set(fresh) != kept or entry in archive:
            return None
        if any(path not in archive or a[path] != "sha256:" + sha256(archive[path]).hexdigest() for path in kept):
            return None
    return uri, url


def _failed(traffic, url):
    """The only exchange: the device read HQ's own 404 for this exact required resource during installation."""
    if len(traffic) != 1:
        return False
    entry = traffic[0]
    return (
        entry.get("method") == "GET"
        and entry.get("url_name") == "hqmedia_download"
        and entry.get("url") == url
        and entry.get("status") == 404
        and entry.get("raised") is None
        and not entry.get("unread")
    )


def _identity(rows, devices, blobs, url):
    def pair(kind):
        hq, local = ((devices.get(role) or {}).get(kind) or {} for role in ("republish", "local"))
        if hq.get("hq") and hq.get("answer") and local.get("answer") and _failed(blobs.get_json(hq["hq"]), url):
            return blobs.get_json(hq["answer"]), blobs.get_json(local["answer"])
        return {}, {}

    old, new = pair("update")
    if (
        set(old) != {"install", "archives"}
        or old["install"] != MISSING
        or new.get("install") != android.INSTALLED
        or new.get("staged") != android.UP_TO_DATE
        or not android.same_revision(new)
    ):
        return []
    first, second = (old["archives"].get(k) or {} for k in ("before", "after"))
    if (
        not first.get("uniqueid")
        or first.get("uniqueid") != second.get("uniqueid")
        or not all(isinstance(version := item.get("version"), str) and version.isdecimal() for item in (first, second))
        or int(first["version"]) >= int(second["version"])
    ):
        return []
    results = {"/update": (f"not installed: {MISSING}", android.INSTALLED)}
    # The install pair uses these same archives. HQ installs B fresh because A never installed;
    # Android refuses the second local install because the first one already owns that same app ID.
    hq, local = pair("installs")
    hq_id, local_id = first["uniqueid"], new["archives"]["before"]["uniqueid"]
    if hq.get("installs") == [
        {"install": MISSING, "installedApps": []},
        {"install": android.INSTALLED, "installedApps": [hq_id]},
    ] and local.get("installs") == [
        {"install": android.INSTALLED, "installedApps": [local_id]},
        {"install": "DuplicateApp", "installedApps": [local_id]},
    ]:
        results.update(
            {"/installs/0": (MISSING, android.INSTALLED), "/installs/1": (android.INSTALLED, "DuplicateApp")}
        )
    return [d for d in rows if d.at in results and (d.before, d.after) == results[d.at]]


def _tablet_only(phone, tablet):
    """A different value, class, or failed URL on the tablet is independent evidence at the same screen."""
    return [d for d in tablet if replace(d, artifact=d.artifact.replace("android-tablet@", "android@", 1)) not in phone]


def _later_walks(document_id, native, delivered, artifact, others, republished, blobs, rules, menus):
    """Judge both recovered devices against each other and their independent ordinary-B control."""
    device_rows = []
    successful = {}
    for role, key, side in (("B", native, "B"), ("local", delivered, "local.ccz")):
        record = (others.get(role) or {}).get(key) or {}
        answer = blobs.get_json(record["answer"]) if record.get("answer") else {}
        if answer.get("install") != android.INSTALLED:
            device_rows.append(
                Difference(
                    "proof3",
                    document_id,
                    f"{artifact}@{side}",
                    "/after-install/install",
                    "/after-install/install",
                    "error",
                    android.INSTALLED,
                    answer.get("install"),
                )
            )
        else:
            successful[side] = answer
            device_rows.extend(android.recovered_walks(document_id, f"{artifact}@{side}", answer))
            traffic_after = blobs.get_json(record["hq"]) if record.get("hq") else []
            device_rows.extend(
                served.refusal_differences(
                    android.hq_refusals(traffic_after),
                    check="proof3",
                    document=document_id,
                    artifact=f"{artifact}@{side}",
                )
            )
    if successful.keys() == {"B", "local.ccz"}:
        # A's installation failure otherwise suppresses every worker-journey comparison. Compare
        # B and the local archive directly and check the independently walked ordinary B when present.
        evidence = menus or {}
        differences_after = android.app_differences(
            successful["B"],
            successful["local.ccz"],
            check="proof3",
            document=document_id,
            artifact=f"{artifact}@local.ccz",
            rules=rules,
            media=(evidence.get("B"), evidence.get("local")),
        )
        device_rows.extend(
            replace(d, path="/after-install" + d.path, at="/after-install" + d.at) for d in differences_after
        )
        if native == "android":
            as_is = ((others.get("local") or {}).get("android") or {}).get("answer")
            if as_is:
                device_rows.extend(android.signed_in_differences(document_id, successful["B"], blobs.get_json(as_is)))
        control = (((republished.get("proof4") or {}).get("served") or {}).get(native) or {}).get("answer")
        ordinary = blobs.get_json(control) if control else {}
        wanted = ordinary.get("walks") or {}
        if ordinary.get("install") != android.INSTALLED or not wanted:
            device_rows.append(
                Difference(
                    "proof3",
                    document_id,
                    f"{artifact}@B",
                    "/after-install/control",
                    "/after-install/control",
                    "error",
                    "ordinary B installed and walked",
                    ordinary.get("install"),
                )
            )
        else:
            # Proof 4's ordinary B walk ran independently. Compare every actual step, form,
            # completion and resulting record, without conflating the builds' profile/version metadata.
            walks = android.app_differences(
                {"install": android.INSTALLED, "walks": wanted},
                {"install": android.INSTALLED, "walks": successful["B"].get("walks") or {}},
                check="proof3",
                document=document_id,
                artifact=f"{artifact}@B",
                rules=rules,
            )
            device_rows.extend(
                replace(d, path="/after-install/control" + d.path, at="/after-install/control" + d.at) for d in walks
            )
    return successful, device_rows


def classify(
    document, records, name, differences, local, *, identity=False, rules=(), menus=None, tablet_rows=(), again=None
):
    """Return the exact classified rows and their source map place for this one configuration."""
    from proof.checks.served_places import reviewed_source

    rows = [d for d in differences if candidate(d)] + list(tablet_rows)
    placed = {}
    if not rows or not document.hq_authored or document.hq_side:
        return differences, changes.Sites()
    parts, blobs = records.configurations[name], records.blobs
    base, republished, built = parts.a or {}, parts.b or {}, parts.b_aligned or {}
    a = ((base.get("state") or {}).get("archive") or {}).get("entries") or {}
    b = ((republished.get("state") or {}).get("archive") or {}).get("entries") or {}
    aligned = (built.get("aligned") or {}).get("files") or {}
    baseline = ((base.get("hooks") or {}).get("served") or {}).get("A") or {}
    others = built.get("served") or {}
    if (
        not local
        or (identity and not again)
        or any(held.get("releaseDiffers") for held in (baseline, others.get("B") or {}))
    ):
        return differences, changes.Sites()
    reads = ((base.get("apiReads") or {}).get("authored") or {}).get("media") or []
    cause = _cause(reviewed_source(records, name, "authored"), reads, a, b, aligned, local, blobs, again=again)
    if cause is None:
        return differences, changes.Sites()
    uri, url = cause
    recovered = []
    if identity:
        matched = _identity(rows, others.get("devices") or {}, blobs, url)
    else:
        matched = []
        for native, delivered in (("android", "androidDelivered"), ("androidTablet", "androidDeliveredTablet")):
            artifact = "android" if native == "android" else "android-tablet"
            old = baseline.get(native) or {}
            traffic = blobs.get_json(old["hq"]) if old.get("hq") else []
            if (
                not old.get("answer")
                or blobs.get_json(old["answer"]) != {"install": MISSING}
                or not _failed(traffic, url)
            ):
                continue
            successful, device_rows = _later_walks(
                document.id, native, delivered, artifact, others, republished, blobs, rules, menus
            )
            if native == "android":
                recovered.extend(device_rows)
            else:
                recovered.extend(_tablet_only(recovered, device_rows))
            refusals = served.refusal_differences(
                android.hq_refusals(traffic), check="proof3", document=document.id, artifact=f"{artifact}@A"
            )
            installed = {f"{artifact}@{side}" for side in successful}
            matched.extend(d for d in rows if d in refusals or (d.artifact in installed and d.at == "/install"))
    found = []
    for d in [*differences, *tablet_rows]:
        if d in matched:
            placed[d.artifact, d.at] = ("app", "multimedia_map", uri)
            d = replace(d, path=FAILED_REQUEST if d.kind == "error" else d.path + SUFFIX)
        found.append(d)
    siblings = [
        d
        for d in found
        if d.artifact.startswith("android-tablet@")
        and (candidate(d) or d.path == FAILED_REQUEST or d.path.endswith(SUFFIX))
    ]
    if siblings:
        found = [d for d in found if d not in siblings]
        found.extend(_tablet_only(found, siblings))
    return found + recovered, changes.Sites(served=placed)
