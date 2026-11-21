"""Attribute an Android delivery visit's location in Connect to the form whose fix HQ forwarded."""

from proof.checks import android, changes, connect, connect_contexts

VISIT = "/runs/*/state/visits/*"
LOCATION = VISIT + "/location"
GPS_FLAG = VISIT + "/flags/gps"
MISSING = ["gps", "GPS data is missing"]


def candidate(difference):
    return (
        difference.path == LOCATION
        and difference.kind == "changed"
        and difference.before is None
        and isinstance(difference.after, str)
    ) or (difference.path == GPS_FLAG and difference.kind == "removed" and difference.before == MISSING[1])


def _delivery(run, index):
    """Join the compared visit, in arrival order, to the accepted deliver block that produced it."""
    posts = run.get("posts") or []
    visits = connect.as_received(run.get("state"), posts).get("visits") or []
    if index >= len(visits) or len(posts) != 1 or posts[0].get("status") != connect.TAKEN:
        return None
    visit, payload = visits[index], posts[0].get("payload") or {}
    meta = payload.get("metadata") or {}
    instance = visit.get("xform")
    forwards = [(forward.get("form"), forward.get("state")) for forward in run.get("forwards") or []]
    if (
        run.get("received") != [{"status": 201}]
        or forwards != [(instance, "Success")]
        or not instance
        or instance != payload.get("id")
        or instance != meta.get("instanceID")
        or ("deliver", visit.get("deliverUnit")) not in connect.blocks(payload)
        or "location" not in meta
        or "location" not in visit
        or meta["location"] != visit["location"]
    ):
        return None
    return visit


def _witness(record, reader, device, name, index, captured):
    """One submitted form on the exact device walk. An ambiguous walk supplies no owner."""
    runs = [run for run in record.get("runs", {}).get(reader, []) if run.get("run") == name]
    if len(runs) != 1:
        return None
    visit = _delivery(runs[0], index)
    if visit is None:
        return None
    walk = (device.get("walks") or {}).get(name.removesuffix("@tablet")) or {}
    steps = [step for step in walk.get("steps") or [] if step.get("screen") == "FormEntryActivity"]
    if len(steps) != 1:
        return None
    owner = changes.command_place((steps[0].get("session") or {}).get("command"))
    form = steps[0].get("form") or {}
    if owner[:1] != ("form",):
        return None
    flags = visit.get("flags") or []
    if captured:
        if (
            not android.saved_device_fix(form)
            or form["deviceGave"]["location"] != visit["location"]
            or any(flag[0] == "gps" for flag in flags)
        ):
            return None
    else:
        records = (form.get("saved") or {}).get("records") or []
        if (
            visit["location"] is not None
            or "deviceAsked" in form
            or "deviceGave" in form
            or len(records) != 1
            or records[0].get("metaLocation") not in (None, "")
        ):
            return None
    return (*owner, "xform", "data", "meta", "location")


def locations(differences, before, after, devices):
    """Pair the actual submitted forms on both sides, including the tablet's separate Android observation."""
    found = {}
    for difference in differences:
        if not candidate(difference):
            continue
        path = changes.unescaped(difference.at)
        reader, _, name = path[1].partition(":")
        if reader not in ("android", connect_contexts.AS_INSTALLED) or not path[4].isdigit():
            continue
        old, new = devices(reader, name.endswith("@tablet"))
        source = _witness(before, "android", old, name, int(path[4]), False)
        target = _witness(after, reader, new, name, int(path[4]), True)
        found[difference.artifact, difference.at] = source if source == target else None
    return found
