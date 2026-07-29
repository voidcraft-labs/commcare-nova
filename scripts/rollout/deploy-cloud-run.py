#!/usr/bin/env python3
"""Permanent Cloud Run deployment policy.

The service may begin only in ordinary automatic scaling or maintenance-owned
manual-zero scaling. Deploying the immutable image must preserve that mode.
Only after the exact candidate is Ready and owns all traffic does a separate
scaling-only update return the service to automatic scaling; that update must
not create a revision.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Sequence
from typing import Any, NoReturn


DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
RESOURCE_PART_RE = re.compile(r"^[a-z][a-z0-9-]{0,62}$")
SERVICE_READY_STATE = "CONDITION_SUCCEEDED"


class DeploymentPolicyError(RuntimeError):
    pass


def fail(message: str) -> NoReturn:
    raise DeploymentPolicyError(message)


def _integer(value: Any, label: str) -> int:
    if isinstance(value, bool):
        fail(f"{label} must be an integer, not a boolean.")
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        fail(f"{label} is not an integer: {value!r}.")
    if str(parsed) != str(value):
        fail(f"{label} is not a canonical integer: {value!r}.")
    return parsed


def scaling_prestate(service: dict[str, Any]) -> str:
    scaling = service.get("scaling") or {}
    mode = scaling.get("scalingMode") or "AUTOMATIC"
    manual_count = scaling.get("manualInstanceCount")
    if mode in ("AUTOMATIC", "SCALING_MODE_UNSPECIFIED"):
        if manual_count is not None:
            fail("Automatic scaling retained a manual instance count.")
        return "automatic"
    if mode == "MANUAL" and _integer(manual_count, "manualInstanceCount") == 0:
        return "manual-zero"
    fail(
        "Cloud Run deploy accepts only automatic scaling or manual scaling "
        "with exactly zero instances."
    )


def assert_scaling(
    service: dict[str, Any],
    expected_prestate: str,
    *,
    expected_min: int | None = None,
    expected_max: int | None = None,
) -> None:
    actual = scaling_prestate(service)
    if actual != expected_prestate:
        fail(
            f"Cloud Run scaling mode changed from {expected_prestate} to {actual}."
        )
    scaling = service.get("scaling") or {}
    if expected_min is not None and _integer(
        scaling.get("minInstanceCount"), "minInstanceCount"
    ) != expected_min:
        fail(f"Cloud Run service minimum is not {expected_min}.")
    if expected_max is not None and _integer(
        scaling.get("maxInstanceCount"), "maxInstanceCount"
    ) != expected_max:
        fail(f"Cloud Run service maximum is not {expected_max}.")


def revision_names(revisions: Sequence[dict[str, Any]]) -> frozenset[str]:
    names: list[str] = []
    for revision in revisions:
        name = revision.get("name")
        if not isinstance(name, str) or not name:
            fail("Cloud Run returned a revision without a resource name.")
        names.append(name)
    if len(set(names)) != len(names):
        fail("Cloud Run returned duplicate revision resource names.")
    return frozenset(names)


def assert_ready_service(service: dict[str, Any]) -> str:
    if service.get("reconciling") is True:
        fail("Cloud Run service is still reconciling.")
    condition = service.get("terminalCondition") or {}
    if condition.get("state") != SERVICE_READY_STATE:
        fail(
            "Cloud Run service terminal condition is not successful: "
            f"{condition!r}."
        )
    ready = service.get("latestReadyRevision")
    created = service.get("latestCreatedRevision")
    if not isinstance(ready, str) or not ready or ready != created:
        fail("Cloud Run latest created revision is not the latest Ready revision.")
    return ready


def assert_candidate_traffic(service: dict[str, Any], candidate: str) -> None:
    desired = service.get("traffic") or []
    observed = service.get("trafficStatuses") or []
    tagged = [
        target
        for target in [*desired, *observed]
        if isinstance(target, dict) and target.get("tag")
    ]
    if tagged:
        fail("Cloud Run traffic contains a revision tag.")
    candidate_percent = 0
    other_percent = 0
    for target in observed:
        if not isinstance(target, dict):
            fail("Cloud Run returned a malformed traffic status.")
        percent = _integer(target.get("percent", 0), "traffic percent")
        if target.get("revision") == candidate:
            candidate_percent += percent
        else:
            other_percent += percent
    if candidate_percent != 100 or other_percent != 0:
        fail(
            "The exact candidate must own 100% traffic and every old revision "
            f"must own 0%; candidate={candidate_percent}, old={other_percent}."
        )


def _run(
    command: Sequence[str], *, capture: bool = False
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        list(command),
        check=True,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=None,
    )


def _access_token() -> str:
    token = _run(["gcloud", "auth", "print-access-token"], capture=True).stdout.strip()
    if not token:
        fail("gcloud returned an empty access token.")
    return token


class CloudRunApi:
    def __init__(self, project: str, region: str, service: str) -> None:
        self._service_name = (
            f"projects/{project}/locations/{region}/services/{service}"
        )
        self._base = "https://run.googleapis.com/v2/"
        self._token = _access_token()

    def _get(self, path: str) -> dict[str, Any]:
        request = urllib.request.Request(
            urllib.parse.urljoin(self._base, path),
            headers={"Authorization": f"Bearer {self._token}"},
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                value = json.load(response)
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            raise DeploymentPolicyError(
                f"Cloud Run Admin API GET {path} failed with HTTP "
                f"{error.code}: {body}"
            ) from error
        if not isinstance(value, dict):
            fail(f"Cloud Run Admin API GET {path} returned non-object JSON.")
        return value

    def service(self) -> dict[str, Any]:
        return self._get(self._service_name)

    def revisions(self) -> list[dict[str, Any]]:
        revisions: list[dict[str, Any]] = []
        page_token: str | None = None
        while True:
            query = "?pageSize=1000"
            if page_token:
                query += "&pageToken=" + urllib.parse.quote(page_token, safe="")
            page = self._get(f"{self._service_name}/revisions{query}")
            values = page.get("revisions") or []
            if not isinstance(values, list) or any(
                not isinstance(value, dict) for value in values
            ):
                fail("Cloud Run revision list returned malformed JSON.")
            revisions.extend(values)
            next_token = page.get("nextPageToken")
            if not next_token:
                return revisions
            if not isinstance(next_token, str):
                fail("Cloud Run revision list returned a malformed page token.")
            page_token = next_token


def _wait_for(
    description: str,
    check: Callable[[], Any],
    *,
    timeout_seconds: int = 120,
) -> Any:
    deadline = time.monotonic() + timeout_seconds
    last_error: Exception | None = None
    while True:
        try:
            return check()
        except DeploymentPolicyError as error:
            last_error = error
        if time.monotonic() >= deadline:
            raise DeploymentPolicyError(
                f"Timed out waiting for {description}: {last_error}"
            ) from last_error
        time.sleep(2)


def _resolved_image(image: str, project: str) -> tuple[str, str]:
    digest = _run(
        [
            "gcloud",
            "artifacts",
            "docker",
            "images",
            "describe",
            image,
            f"--project={project}",
            "--format=value(image_summary.digest)",
        ],
        capture=True,
    ).stdout.strip()
    if not DIGEST_RE.fullmatch(digest):
        fail(f"Artifact Registry returned an invalid image digest: {digest!r}.")
    repository = image.split("@", 1)[0].rsplit(":", 1)[0]
    return f"{repository}@{digest}", digest


def _candidate_revision_fact(
    candidate: str, region: str, project: str, expected_digest: str
) -> None:
    short_name = candidate.rsplit("/", 1)[-1]
    raw = _run(
        [
            "gcloud",
            "run",
            "revisions",
            "describe",
            short_name,
            f"--region={region}",
            f"--project={project}",
            "--format=json",
        ],
        capture=True,
    ).stdout
    value = json.loads(raw)
    if not isinstance(value, dict):
        fail("gcloud returned malformed revision JSON.")
    revision_ready = any(
        condition.get("type") == "Ready" and condition.get("status") == "True"
        for condition in (value.get("status") or {}).get("conditions", [])
        if isinstance(condition, dict)
    )
    if not revision_ready:
        fail("The exact candidate revision is not Ready.")
    reported_digest = (value.get("status") or {}).get("imageDigest")
    if reported_digest != expected_digest:
        fail(
            "The candidate revision image digest differs from the immutable "
            f"build digest: expected {expected_digest}, got {reported_digest!r}."
        )


def _forbid_deploy_policy_overrides(deploy_args: Sequence[str]) -> None:
    forbidden = (
        "--image",
        "--project",
        "--region",
        "--scaling",
        "--no-traffic",
        "--tag",
    )
    for argument in deploy_args:
        if any(
            argument == option or argument.startswith(option + "=")
            for option in forbidden
        ):
            fail(f"Deployment policy owns {argument.split('=', 1)[0]}.")


def _parse_args(argv: Sequence[str]) -> argparse.Namespace:
    if argv == ["--policy-self-test"]:
        return argparse.Namespace(policy_self_test=True)
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--service", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--expected-min", type=int, required=True)
    parser.add_argument("--expected-max", type=int, required=True)
    parser.add_argument("deploy_args", nargs=argparse.REMAINDER)
    values = parser.parse_args(argv)
    values.policy_self_test = False
    if values.deploy_args[:1] == ["--"]:
        values.deploy_args = values.deploy_args[1:]
    return values


def _policy_self_test() -> None:
    automatic = {"scaling": {"scalingMode": "AUTOMATIC"}}
    manual_zero = {
        "scaling": {"scalingMode": "MANUAL", "manualInstanceCount": 0}
    }
    assert scaling_prestate(automatic) == "automatic"
    assert scaling_prestate(manual_zero) == "manual-zero"
    try:
        scaling_prestate(
            {"scaling": {"scalingMode": "MANUAL", "manualInstanceCount": 1}}
        )
    except DeploymentPolicyError:
        pass
    else:
        raise AssertionError("manual non-zero scaling was accepted")
    candidate = "projects/p/locations/r/services/s/revisions/s-00002-x"
    assert_candidate_traffic(
        {
            "traffic": [{"revision": candidate, "percent": 100}],
            "trafficStatuses": [{"revision": candidate, "percent": 100}],
        },
        candidate,
    )
    try:
        assert_candidate_traffic(
            {
                "traffic": [
                    {"revision": candidate, "percent": 100, "tag": "legacy"}
                ],
                "trafficStatuses": [{"revision": candidate, "percent": 100}],
            },
            candidate,
        )
    except DeploymentPolicyError:
        pass
    else:
        raise AssertionError("tagged traffic was accepted")
    _forbid_deploy_policy_overrides(["--timeout=3600s"])
    try:
        _forbid_deploy_policy_overrides(["--scaling=auto"])
    except DeploymentPolicyError:
        pass
    else:
        raise AssertionError("deploy-time scaling override was accepted")
    print("deploy-cloud-run policy self-test passed")


def main(argv: Sequence[str]) -> None:
    args = _parse_args(argv)
    if args.policy_self_test:
        _policy_self_test()
        return
    for label in ("project", "region", "service"):
        value = getattr(args, label)
        if not RESOURCE_PART_RE.fullmatch(value):
            fail(f"Invalid Cloud Run {label}: {value!r}.")
    if args.expected_min < 0 or args.expected_max < args.expected_min:
        fail("Expected Cloud Run min/max scaling bounds are invalid.")
    _forbid_deploy_policy_overrides(args.deploy_args)

    immutable_image, expected_digest = _resolved_image(args.image, args.project)
    api = CloudRunApi(args.project, args.region, args.service)
    before_service = api.service()
    prestate = scaling_prestate(before_service)
    before_revisions = revision_names(api.revisions())
    print(
        "NOVA_DEPLOY_PRESTATE="
        + json.dumps(
            {
                "scaling": prestate,
                "revisionCount": len(before_revisions),
                "revisions": sorted(before_revisions),
                "imageDigest": expected_digest,
            },
            separators=(",", ":"),
            sort_keys=True,
        )
    )

    _run(
        [
            "gcloud",
            "run",
            "deploy",
            args.service,
            f"--image={immutable_image}",
            f"--region={args.region}",
            f"--project={args.project}",
            "--quiet",
            *args.deploy_args,
        ]
    )

    def deployed_candidate() -> tuple[dict[str, Any], frozenset[str], str]:
        service = api.service()
        assert_scaling(
            service,
            prestate,
            expected_min=args.expected_min,
            expected_max=args.expected_max,
        )
        candidate = assert_ready_service(service)
        revisions = revision_names(api.revisions())
        if candidate in before_revisions:
            fail("Cloud Run deploy did not create a new candidate revision.")
        if revisions != before_revisions | {candidate}:
            fail("Cloud Run revision inventory changed by more than one candidate.")
        assert_candidate_traffic(service, candidate)
        return service, revisions, candidate

    _, deployed_revisions, candidate = _wait_for(
        "the exact candidate deployment", deployed_candidate
    )
    _candidate_revision_fact(
        candidate, args.region, args.project, expected_digest
    )
    print(
        "NOVA_DEPLOY_CANDIDATE="
        + json.dumps(
            {
                "revision": candidate,
                "image": immutable_image,
                "prestate": prestate,
            },
            separators=(",", ":"),
            sort_keys=True,
        )
    )

    _run(
        [
            "gcloud",
            "run",
            "services",
            "update",
            args.service,
            f"--region={args.region}",
            f"--project={args.project}",
            "--scaling=auto",
            "--quiet",
        ]
    )

    def automatic_without_revision() -> dict[str, Any]:
        service = api.service()
        assert_scaling(
            service,
            "automatic",
            expected_min=args.expected_min,
            expected_max=args.expected_max,
        )
        if assert_ready_service(service) != candidate:
            fail("Scaling-only update changed the latest Ready revision.")
        current_revisions = revision_names(api.revisions())
        if current_revisions != deployed_revisions:
            fail("Scaling-only update created or removed a revision.")
        assert_candidate_traffic(service, candidate)
        return service

    _wait_for(
        "automatic scaling without a revision change",
        automatic_without_revision,
    )
    print(
        "NOVA_DEPLOY_RESULT="
        + json.dumps(
            {
                "candidateRevision": candidate,
                "imageDigest": expected_digest,
                "prestate": prestate,
                "finalScaling": "automatic",
                "revisionCount": len(deployed_revisions),
            },
            separators=(",", ":"),
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (DeploymentPolicyError, subprocess.CalledProcessError, json.JSONDecodeError) as error:
        print(f"deploy-cloud-run policy failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
