#!/usr/bin/env python3
"""Permanent immutable-image Cloud Run deployment policy.

The image resolver runs immediately after the build tag is pushed and writes a
shell-safe ``repository@sha256`` reference for every later Job and service
operation. The service deployment accepts only ordinary automatic scaling or
maintenance-owned manual-zero scaling, preserves that mode until the exact
candidate is Ready at 100%, then performs one revision-free scaling-only return
to automatic.

When the service begins in manual-zero, the failure arm is always live. Any
non-terminal exit restores and verifies the maintenance posture: ingress
detached, manual-zero, direct runtime sessions terminated, and cleanup paused.
Recovery errors are reported without replacing the original deployment error.
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
from dataclasses import dataclass
from typing import Any, NoReturn


DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
IMAGE_REPOSITORY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]*$")
RESOURCE_PART_RE = re.compile(r"^[a-z][a-z0-9-]{0,62}$")
APP_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
SERVICE_READY_STATE = "CONDITION_SUCCEEDED"
MAINTENANCE_RECOVERY_ACTIONS = (
    "detach-ingress",
    "manual-zero",
    "terminate-runtime-sessions",
    "pause-cleanup",
    "verify-maintenance-posture",
)
RECOVERABLE_PHASES = (
    "manual-zero",
    "candidate-ready",
    "automatic-resumed",
    "ingress-attached",
    "cleanup-enabled",
)
TERMINAL_PHASE = "terminal-success"


@dataclass(frozen=True)
class JobTemplateContract:
    service_account: str
    command: tuple[str, ...]
    stored_args: tuple[str, ...]
    task_count: int
    parallelism: int
    max_retries: int
    timeout: str


# An etag prevents a Job mutation after it is inspected. These contracts also
# prove that the inspected generation has the intended authority and execution
# shape before it is allowed to run. Keep them aligned with cloudbuild.yaml.
JOB_TEMPLATE_CONTRACTS = {
    "commcare-nova-media-policy": JobTemplateContract(
        service_account="nova-media-policy@commcare-nova.iam.gserviceaccount.com",
        command=("node",),
        stored_args=("media-bucket-policy.cjs",),
        task_count=1,
        parallelism=1,
        max_retries=1,
        timeout="300s",
    ),
    "commcare-nova-migrate": JobTemplateContract(
        service_account="nova-migrate@commcare-nova.iam.gserviceaccount.com",
        command=("node",),
        stored_args=("migrate.cjs",),
        task_count=1,
        parallelism=1,
        max_retries=0,
        timeout="3000s",
    ),
    "commcare-nova-legacy-preplan-repair": JobTemplateContract(
        service_account="nova-migrate@commcare-nova.iam.gserviceaccount.com",
        command=("node",),
        stored_args=("legacy-preplan-repair.cjs",),
        task_count=1,
        parallelism=1,
        max_retries=0,
        timeout="900s",
    ),
    "commcare-nova-capture-cleanup": JobTemplateContract(
        service_account="nova-capture-cleanup@commcare-nova.iam.gserviceaccount.com",
        command=("node",),
        stored_args=("capture-cleanup.cjs",),
        task_count=1,
        parallelism=1,
        max_retries=0,
        timeout="1260s",
    ),
    "commcare-nova-case-type-schema-retirement": JobTemplateContract(
        service_account="nova-migrate@commcare-nova.iam.gserviceaccount.com",
        command=("node",),
        stored_args=("case-type-schema-retirement.cjs",),
        task_count=1,
        parallelism=1,
        max_retries=0,
        timeout="3000s",
    ),
    "commcare-nova-case-parent-relationship-repair": JobTemplateContract(
        service_account="nova-migrate@commcare-nova.iam.gserviceaccount.com",
        command=("node",),
        stored_args=("case-parent-relationship-repair.cjs",),
        task_count=1,
        parallelism=1,
        max_retries=0,
        timeout="3000s",
    ),
}


class DeploymentPolicyError(RuntimeError):
    pass


class TerminalDeploymentPolicyError(DeploymentPolicyError):
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
        fail(f"Cloud Run scaling mode changed from {expected_prestate} to {actual}.")
    # Cloud Run's v2 service representation omits the automatic min/max fields
    # while the service is in manual scaling mode. The deployment still proves
    # those retained bounds after it switches the service back to AUTOMATIC;
    # they cannot be observed during the maintenance-owned manual-zero phase.
    if actual == "manual-zero":
        return
    scaling = service.get("scaling") or {}
    if (
        expected_min is not None
        and _integer(scaling.get("minInstanceCount"), "minInstanceCount")
        != expected_min
    ):
        fail(f"Cloud Run service minimum is not {expected_min}.")
    if (
        expected_max is not None
        and _integer(scaling.get("maxInstanceCount"), "maxInstanceCount")
        != expected_max
    ):
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
        fail(f"Cloud Run service terminal condition is not successful: {condition!r}.")
    ready = service.get("latestReadyRevision")
    created = service.get("latestCreatedRevision")
    if not isinstance(ready, str) or not ready or ready != created:
        fail("Cloud Run latest created revision is not the latest Ready revision.")
    return ready


def _service_name(service: dict[str, Any]) -> str:
    name = service.get("name")
    if not isinstance(name, str) or not name:
        fail("Cloud Run returned a service without a resource name.")
    return name


def _normalize_revision_name(service: dict[str, Any], value: str) -> str:
    if "/revisions/" in value:
        return value
    return f"{_service_name(service)}/revisions/{value}"


def _traffic_target_revision(service: dict[str, Any], target: dict[str, Any]) -> str:
    allocation_type = target.get("type")
    revision = target.get("revision")
    if (
        allocation_type
        in (
            None,
            "",
            "TRAFFIC_TARGET_ALLOCATION_TYPE_UNSPECIFIED",
            "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST",
        )
        and not revision
    ):
        latest = service.get("latestReadyRevision")
        if not isinstance(latest, str) or not latest:
            fail("LATEST traffic has no latest Ready revision.")
        return latest
    if allocation_type not in (
        None,
        "",
        "TRAFFIC_TARGET_ALLOCATION_TYPE_UNSPECIFIED",
        "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION",
    ):
        fail(
            f"Cloud Run returned an unknown traffic allocation type: {allocation_type!r}."
        )
    if not isinstance(revision, str) or not revision:
        fail("Explicit Cloud Run traffic omitted its revision.")
    return _normalize_revision_name(service, revision)


def _traffic_distribution(
    service: dict[str, Any],
    field: str,
) -> tuple[dict[str, int], frozenset[str]]:
    raw_targets = service.get(field) or []
    if not isinstance(raw_targets, list):
        fail(f"Cloud Run {field} is not an array.")
    percentages: dict[str, int] = {}
    tagged: set[str] = set()
    for target in raw_targets:
        if not isinstance(target, dict):
            fail(f"Cloud Run returned malformed {field} traffic.")
        revision = _traffic_target_revision(service, target)
        percent = _integer(target.get("percent", 0), f"{field} traffic percent")
        if percent < 0 or percent > 100:
            fail(f"Cloud Run {field} traffic percent is out of range.")
        percentages[revision] = percentages.get(revision, 0) + percent
        tag = target.get("tag")
        if tag:
            tagged.add(revision)
    return percentages, frozenset(tagged)


def assert_candidate_traffic(service: dict[str, Any], candidate: str) -> None:
    for field in ("traffic", "trafficStatuses"):
        percentages, tagged = _traffic_distribution(service, field)
        if tagged:
            fail(f"Cloud Run {field} traffic contains a revision tag.")
        candidate_percent = percentages.get(candidate, 0)
        other_percent = sum(
            percent
            for revision, percent in percentages.items()
            if revision != candidate
        )
        if candidate_percent != 100 or other_percent != 0:
            fail(
                "The exact candidate must own 100% traffic and every old revision "
                f"must own 0% in {field}; candidate={candidate_percent}, "
                f"old={other_percent}."
            )


def _gc_eligible_revisions(service: dict[str, Any]) -> frozenset[str]:
    desired, desired_tagged = _traffic_distribution(service, "traffic")
    observed, observed_tagged = _traffic_distribution(service, "trafficStatuses")
    targeted = set(desired) | set(observed)
    tagged = desired_tagged | observed_tagged
    return frozenset(
        revision
        for revision in targeted
        if desired.get(revision, 0) == 0
        and observed.get(revision, 0) == 0
        and revision not in tagged
    )


def assert_revision_transition(
    *,
    before_service: dict[str, Any],
    before_revisions: frozenset[str],
    after_revisions: frozenset[str],
    expected_additions: frozenset[str],
) -> frozenset[str]:
    additions = after_revisions - before_revisions
    if additions != expected_additions:
        fail(
            "Cloud Run revision inventory added an unexpected revision: "
            f"expected={sorted(expected_additions)}, actual={sorted(additions)}."
        )
    removed = before_revisions - after_revisions
    if removed:
        desired, desired_tagged = _traffic_distribution(before_service, "traffic")
        observed, observed_tagged = _traffic_distribution(
            before_service, "trafficStatuses"
        )
        forbidden = [
            revision
            for revision in removed
            if desired.get(revision, 0) != 0
            or observed.get(revision, 0) != 0
            or revision in desired_tagged
            or revision in observed_tagged
        ]
        if forbidden:
            fail(
                "Cloud Run removed a tagged or traffic-owning revision: "
                + ", ".join(sorted(forbidden))
                + "."
            )
    if not expected_additions.issubset(after_revisions):
        fail("Cloud Run garbage-collected the required candidate revision.")
    return frozenset(removed)


def maintenance_recovery_actions(phase: str) -> tuple[str, ...]:
    if phase == TERMINAL_PHASE:
        return ()
    if phase not in RECOVERABLE_PHASES:
        fail(f"Unknown maintenance recovery phase: {phase!r}.")
    return MAINTENANCE_RECOVERY_ACTIONS


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
        self._service_name = f"projects/{project}/locations/{region}/services/{service}"
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
                f"Cloud Run Admin API GET {path} failed with HTTP {error.code}: {body}"
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
        except TerminalDeploymentPolicyError:
            raise
        except DeploymentPolicyError as error:
            last_error = error
        if time.monotonic() >= deadline:
            raise DeploymentPolicyError(
                f"Timed out waiting for {description}: {last_error}"
            ) from last_error
        time.sleep(2)


def _tagged_repository(image: str) -> str:
    if "@" in image:
        fail("Image resolution requires the pushed build tag, not a digest.")
    repository, separator, tag = image.rpartition(":")
    if not separator or not repository or not tag:
        fail(f"Image is not a tagged Artifact Registry reference: {image!r}.")
    if not IMAGE_REPOSITORY_RE.fullmatch(repository):
        fail(f"Image repository is not canonical: {repository!r}.")
    return repository


def _immutable_image(image: str) -> tuple[str, str]:
    repository, separator, digest = image.partition("@")
    if (
        not separator
        or not IMAGE_REPOSITORY_RE.fullmatch(repository)
        or not DIGEST_RE.fullmatch(digest)
    ):
        fail(
            "Deployment image must be the complete immutable "
            "repository@sha256:<digest> reference."
        )
    return repository, digest


def _resolve_image(image: str, project: str) -> tuple[str, str]:
    repository = _tagged_repository(image)
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
    return f"{repository}@{digest}", digest


def _write_resolved_image(path: str, immutable_image: str, digest: str) -> None:
    if not path.startswith("/workspace/"):
        fail("Resolved-image output must stay inside /workspace.")
    with open(path, "w", encoding="utf-8") as output:
        output.write(f"NOVA_IMMUTABLE_IMAGE='{immutable_image}'\n")
        output.write(f"NOVA_IMAGE_DIGEST='{digest}'\n")


def _all_image_values(value: Any) -> list[str]:
    images: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "image" and isinstance(child, str):
                images.append(child)
            else:
                images.extend(_all_image_values(child))
    elif isinstance(value, list):
        for child in value:
            images.extend(_all_image_values(child))
    return images


def _run_api_request(
    token: str,
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    data = (
        json.dumps(body, separators=(",", ":"), sort_keys=True).encode("utf-8")
        if body is not None
        else None
    )
    request = urllib.request.Request(
        urllib.parse.urljoin("https://run.googleapis.com/v2/", path),
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            **({"Content-Type": "application/json"} if data is not None else {}),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            value = json.load(response)
    except urllib.error.HTTPError as error:
        response_body = error.read().decode("utf-8", errors="replace")
        raise TerminalDeploymentPolicyError(
            f"Cloud Run Admin API {method} {path} failed with HTTP "
            f"{error.code}: {response_body}"
        ) from error
    if not isinstance(value, dict):
        fail(f"Cloud Run Admin API {method} {path} returned non-object JSON.")
    return value


def _job_contract(expected_name: str) -> JobTemplateContract:
    short_name = expected_name.rsplit("/", 1)[-1]
    contract = JOB_TEMPLATE_CONTRACTS.get(short_name)
    if contract is None:
        fail(f"Cloud Run Job has no checked-in execution contract: {short_name!r}.")
    return contract


def _effective_execution_args(
    expected_name: str, execution_args: Sequence[str]
) -> tuple[str, ...]:
    contract = _job_contract(expected_name)
    requested = tuple(execution_args)
    if not requested:
        return contract.stored_args

    short_name = expected_name.rsplit("/", 1)[-1]
    exact_overrides = {
        "commcare-nova-migrate": {
            ("migrate.cjs", "--terminate-runtime-sessions-only"),
        },
        "commcare-nova-capture-cleanup": {
            ("capture-cleanup.cjs", "--probe-schema"),
        },
    }
    if requested in exact_overrides.get(short_name, set()):
        return requested

    if short_name == "commcare-nova-legacy-preplan-repair" and requested == (
        "legacy-preplan-repair.cjs",
        "--execute",
    ):
        return requested

    if short_name == "commcare-nova-case-type-schema-retirement":
        writer_prefixes = (
            (
                "case-type-schema-retirement.cjs",
                "--execute",
                "--confirm-old-revision-drained",
            ),
            ("schema-drift.cjs", "--execute"),
        )
        for prefix in writer_prefixes:
            if requested == prefix:
                return requested
            if (
                requested[: len(prefix)] == prefix
                and len(requested) == len(prefix) + 2
                and requested[-2] == "--app"
                and APP_ID_RE.fullmatch(requested[-1]) is not None
            ):
                return requested

    if short_name == "commcare-nova-case-parent-relationship-repair":
        prefix = (
            "case-parent-relationship-repair.cjs",
            "--execute",
            "--confirm-old-revision-drained",
        )
        if requested == prefix:
            return requested
        if (
            requested[: len(prefix)] == prefix
            and len(requested) == len(prefix) + 2
            and requested[-2] == "--app"
            and APP_ID_RE.fullmatch(requested[-1]) is not None
        ):
            return requested

    fail(
        f"Cloud Run Job override args are not an allowed checked-in operation: "
        f"job={short_name!r}, args={requested!r}."
    )


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        fail(f"{label} is not an object.")
    return value


def _single_container(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, list) or len(value) != 1:
        fail(f"{label} must contain exactly one container.")
    return _object(value[0], f"{label}[0]")


def _assert_task_template(
    task_template: dict[str, Any],
    contract: JobTemplateContract,
    expected_image: str,
    expected_args: Sequence[str],
    label: str,
) -> None:
    container = _single_container(
        task_template.get("containers"), f"{label} containers"
    )
    if container.get("image") != expected_image:
        fail(
            f"{label} container image is not the expected immutable image: "
            f"expected={expected_image!r}, actual={container.get('image')!r}."
        )
    if tuple(container.get("command") or ()) != contract.command:
        fail(
            f"{label} command does not match the checked-in Job contract: "
            f"expected={contract.command!r}, actual={container.get('command')!r}."
        )
    if tuple(container.get("args") or ()) != tuple(expected_args):
        fail(
            f"{label} args do not match the effective execution contract: "
            f"expected={tuple(expected_args)!r}, actual={container.get('args')!r}."
        )
    if task_template.get("serviceAccount") != contract.service_account:
        fail(
            f"{label} service account does not match the checked-in authority: "
            f"expected={contract.service_account!r}, "
            f"actual={task_template.get('serviceAccount')!r}."
        )
    if (
        _integer(task_template.get("maxRetries"), f"{label} maxRetries")
        != contract.max_retries
    ):
        fail(f"{label} maxRetries does not match the checked-in Job contract.")
    if task_template.get("timeout") != contract.timeout:
        fail(
            f"{label} timeout does not match the checked-in Job contract: "
            f"expected={contract.timeout!r}, actual={task_template.get('timeout')!r}."
        )


def _assert_execution_shape(
    execution_template: dict[str, Any],
    contract: JobTemplateContract,
    label: str,
) -> None:
    if (
        _integer(execution_template.get("taskCount"), f"{label} taskCount")
        != contract.task_count
    ):
        fail(f"{label} taskCount does not match the checked-in Job contract.")
    if (
        _integer(execution_template.get("parallelism"), f"{label} parallelism")
        != contract.parallelism
    ):
        fail(f"{label} parallelism does not match the checked-in Job contract.")


def _exact_ready_job_etag(
    job: dict[str, Any],
    expected_name: str,
    expected_image: str,
) -> str:
    if job.get("name") != expected_name:
        fail("Cloud Run returned the wrong Job resource.")
    if job.get("reconciling") is True:
        fail("Cloud Run Job is still reconciling.")
    generation = job.get("generation")
    if generation is None or job.get("observedGeneration") != generation:
        fail("Cloud Run Job generation has not been fully observed.")
    terminal = job.get("terminalCondition") or {}
    if terminal.get("state") != SERVICE_READY_STATE:
        fail("Cloud Run Job terminal condition is not successful.")
    contract = _job_contract(expected_name)
    execution_template = _object(job.get("template"), "Cloud Run Job template")
    _assert_execution_shape(execution_template, contract, "Cloud Run Job")
    task_template = _object(
        execution_template.get("template"), "Cloud Run Job task template"
    )
    _assert_task_template(
        task_template,
        contract,
        expected_image,
        contract.stored_args,
        "Cloud Run Job",
    )
    etag = job.get("etag")
    if not isinstance(etag, str) or not etag:
        fail("Cloud Run Job omitted its generation fingerprint.")
    return etag


def _assert_exact_execution_succeeded(
    execution: dict[str, Any],
    expected_job: str,
    expected_image: str,
    expected_args: Sequence[str],
) -> dict[str, Any]:
    # Bind the execution to its Job through its own resource name, which is
    # fully qualified and unambiguous. The `job` field carries only the short
    # name, so comparing it against a `projects/.../jobs/...` path never
    # matches and rejects every execution, including successful ones.
    execution_name = execution.get("name")
    if not isinstance(execution_name, str) or not execution_name.startswith(
        f"{expected_job}/executions/"
    ):
        raise TerminalDeploymentPolicyError(
            "Cloud Run execution belongs to the wrong Job: "
            f"expected an execution of {expected_job!r}, got {execution_name!r}."
        )
    contract = _job_contract(expected_job)
    _assert_execution_shape(execution, contract, "Cloud Run execution")
    task_template = _object(
        execution.get("template"), "Cloud Run execution task template"
    )
    _assert_task_template(
        task_template,
        contract,
        expected_image,
        expected_args,
        "Cloud Run execution",
    )
    task_count = _integer(execution.get("taskCount"), "execution taskCount")
    succeeded = _integer(execution.get("succeededCount", 0), "execution succeededCount")
    failed = _integer(execution.get("failedCount", 0), "execution failedCount")
    cancelled = _integer(execution.get("cancelledCount", 0), "execution cancelledCount")
    if failed > 0 or cancelled > 0:
        raise TerminalDeploymentPolicyError(
            "Cloud Run Job execution failed or was cancelled."
        )
    if not execution.get("completionTime"):
        fail("Cloud Run Job execution has not completed.")
    if task_count < 1 or succeeded != task_count:
        raise TerminalDeploymentPolicyError(
            "Cloud Run Job execution did not succeed every task."
        )
    return execution


def _execute_job_exact(
    *,
    project: str,
    region: str,
    job: str,
    expected_image: str,
    execution_args: Sequence[str],
    wait_seconds: int,
) -> dict[str, Any]:
    _immutable_image(expected_image)
    if not RESOURCE_PART_RE.fullmatch(project):
        fail(f"Invalid Cloud Run project: {project!r}.")
    if not RESOURCE_PART_RE.fullmatch(region):
        fail(f"Invalid Cloud Run region: {region!r}.")
    if not RESOURCE_PART_RE.fullmatch(job):
        fail(f"Invalid Cloud Run Job: {job!r}.")
    if not isinstance(wait_seconds, int) or wait_seconds < 1:
        fail("Cloud Run Job wait bound must be a positive integer.")

    job_name = f"projects/{project}/locations/{region}/jobs/{job}"
    token = _access_token()
    job_resource = _run_api_request(token, "GET", job_name)
    etag = _exact_ready_job_etag(job_resource, job_name, expected_image)
    effective_args = _effective_execution_args(job_name, execution_args)
    request_body: dict[str, Any] = {"etag": etag}
    if execution_args:
        request_body["overrides"] = {
            "containerOverrides": [{"args": list(execution_args)}]
        }
    operation = _run_api_request(
        token,
        "POST",
        f"{job_name}:run",
        request_body,
    )
    operation_name = operation.get("name")
    if not isinstance(operation_name, str) or not operation_name:
        fail("Cloud Run Job execution omitted its operation name.")

    def completed_operation() -> dict[str, Any]:
        current = _run_api_request(token, "GET", operation_name)
        operation_error = current.get("error")
        if operation_error is not None:
            raise TerminalDeploymentPolicyError(
                "Cloud Run Job execution operation failed: "
                + json.dumps(operation_error, separators=(",", ":"), sort_keys=True)
            )
        if current.get("done") is not True:
            fail("Cloud Run Job execution operation is still running.")
        response = current.get("response")
        if not isinstance(response, dict):
            raise TerminalDeploymentPolicyError(
                "Cloud Run Job execution operation omitted its Execution response."
            )
        return response

    operation_response = _wait_for(
        f"generation-bound execution of {job}",
        completed_operation,
        timeout_seconds=wait_seconds,
    )
    execution_name = operation_response.get("name")
    if not isinstance(execution_name, str) or not execution_name:
        fail("Cloud Run Job execution response omitted its resource name.")

    return _wait_for(
        f"successful immutable execution of {job}",
        lambda: _assert_exact_execution_succeeded(
            _run_api_request(token, "GET", execution_name),
            job_name,
            expected_image,
            effective_args,
        ),
        timeout_seconds=wait_seconds,
    )


def _ready_service_image(
    service: dict[str, Any], revisions: Sequence[dict[str, Any]]
) -> str:
    candidate = _normalize_revision_name(service, assert_ready_service(service))
    assert_candidate_traffic(service, candidate)
    matches = [revision for revision in revisions if revision.get("name") == candidate]
    if len(matches) != 1:
        fail(
            "Cloud Run did not return exactly one 100%-traffic Ready revision: "
            f"candidate={candidate!r}, matches={len(matches)}."
        )
    images = _all_image_values(matches[0])
    if len(images) != 1:
        fail(
            "The 100%-traffic Ready revision does not contain exactly one image: "
            f"revision={candidate!r}, images={images!r}."
        )
    _immutable_image(images[0])
    return images[0]


def _candidate_revision_fact(
    candidate: str,
    region: str,
    project: str,
    expected_image: str,
    expected_digest: str,
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
    # Cloud Run reports `imageDigest` as the complete pinned reference
    # (`repository@sha256:...`), while the immutable build digest is the bare
    # `sha256:...`. Comparing them directly can never match, so the digest is
    # taken from the reference and the repository is proved separately by the
    # complete-reference check below. A value with no `@` is compared as-is
    # rather than assumed to be a reference.
    reported_digest = (value.get("status") or {}).get("imageDigest")
    reported_digest_only = (
        reported_digest.rpartition("@")[2]
        if isinstance(reported_digest, str) and "@" in reported_digest
        else reported_digest
    )
    if reported_digest_only != expected_digest:
        fail(
            "The candidate revision image digest differs from the immutable "
            f"build digest: expected {expected_digest}, got {reported_digest!r}."
        )
    if expected_image not in _all_image_values(value):
        fail(
            "The candidate revision does not report the complete immutable "
            f"image reference {expected_image}."
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


def _scheduler_state(args: argparse.Namespace) -> str:
    return _run(
        [
            "gcloud",
            "scheduler",
            "jobs",
            "describe",
            args.maintenance_cleanup_scheduler,
            f"--location={args.region}",
            f"--project={args.project}",
            "--format=value(state)",
        ],
        capture=True,
    ).stdout.strip()


def _backend(args: argparse.Namespace) -> dict[str, Any]:
    raw = _run(
        [
            "gcloud",
            "compute",
            "backend-services",
            "describe",
            args.maintenance_backend_service,
            "--global",
            f"--project={args.project}",
            "--format=json",
        ],
        capture=True,
    ).stdout
    value = json.loads(raw)
    if not isinstance(value, dict):
        fail("gcloud returned malformed backend-service JSON.")
    return value


def _ingress_attached(args: argparse.Namespace) -> bool:
    suffix = f"/networkEndpointGroups/{args.maintenance_neg}"
    backends = _backend(args).get("backends") or []
    if not isinstance(backends, list):
        fail("Backend service returned malformed backends.")
    return any(
        isinstance(backend, dict)
        and isinstance(backend.get("group"), str)
        and backend["group"].endswith(suffix)
        for backend in backends
    )


def _assert_maintenance_posture(
    args: argparse.Namespace,
    api: CloudRunApi,
) -> None:
    assert_scaling(
        api.service(),
        "manual-zero",
        expected_min=args.expected_min,
        expected_max=args.expected_max,
    )
    if _scheduler_state(args) != "PAUSED":
        fail("Maintenance requires the capture-cleanup scheduler to stay PAUSED.")
    if _ingress_attached(args):
        fail("Maintenance requires the public serverless NEG to stay detached.")


def _detach_ingress(args: argparse.Namespace) -> None:
    if not _ingress_attached(args):
        return
    _run(
        [
            "gcloud",
            "compute",
            "backend-services",
            "remove-backend",
            args.maintenance_backend_service,
            "--global",
            f"--network-endpoint-group={args.maintenance_neg}",
            f"--network-endpoint-group-region={args.region}",
            f"--project={args.project}",
            "--quiet",
        ]
    )


def _attach_ingress(args: argparse.Namespace) -> None:
    if _ingress_attached(args):
        return
    _run(
        [
            "gcloud",
            "compute",
            "backend-services",
            "add-backend",
            args.maintenance_backend_service,
            "--global",
            f"--network-endpoint-group={args.maintenance_neg}",
            f"--network-endpoint-group-region={args.region}",
            f"--project={args.project}",
            "--quiet",
        ]
    )
    if not _ingress_attached(args):
        fail("Maintenance exit did not restore the public serverless NEG.")


def _restore_manual_zero(args: argparse.Namespace, api: CloudRunApi) -> None:
    before_service = api.service()
    before_revisions = revision_names(api.revisions())
    _run(
        [
            "gcloud",
            "run",
            "services",
            "update",
            args.service,
            f"--region={args.region}",
            f"--project={args.project}",
            "--scaling=0",
            "--quiet",
        ]
    )

    def manual_zero_without_revision() -> None:
        service = api.service()
        assert_scaling(
            service,
            "manual-zero",
            expected_min=args.expected_min,
            expected_max=args.expected_max,
        )
        assert_revision_transition(
            before_service=before_service,
            before_revisions=before_revisions,
            after_revisions=revision_names(api.revisions()),
            expected_additions=frozenset(),
        )

    _wait_for("manual-zero recovery without a revision", manual_zero_without_revision)


def _terminate_runtime_sessions(args: argparse.Namespace) -> None:
    _execute_job_exact(
        project=args.project,
        region=args.region,
        job=args.maintenance_session_fence_job,
        expected_image=args.image,
        execution_args=("migrate.cjs", "--terminate-runtime-sessions-only"),
        wait_seconds=1_080,
    )


def _pause_cleanup(args: argparse.Namespace) -> None:
    if _scheduler_state(args) == "PAUSED":
        return
    _run(
        [
            "gcloud",
            "scheduler",
            "jobs",
            "pause",
            args.maintenance_cleanup_scheduler,
            f"--location={args.region}",
            f"--project={args.project}",
            "--quiet",
        ]
    )
    if _scheduler_state(args) != "PAUSED":
        fail("Capture-cleanup recovery did not restore PAUSED.")


def _resume_cleanup(args: argparse.Namespace) -> None:
    state = _scheduler_state(args)
    if state == "ENABLED":
        return
    if state != "PAUSED":
        fail(f"Cannot resume cleanup from scheduler state {state!r}.")
    _run(
        [
            "gcloud",
            "scheduler",
            "jobs",
            "resume",
            args.maintenance_cleanup_scheduler,
            f"--location={args.region}",
            f"--project={args.project}",
            "--quiet",
        ]
    )
    if _scheduler_state(args) != "ENABLED":
        fail("Maintenance exit did not resume capture cleanup.")


def _automatic_scaling_update_command(args: argparse.Namespace) -> list[str]:
    return [
        "gcloud",
        "run",
        "services",
        "update",
        args.service,
        f"--region={args.region}",
        f"--project={args.project}",
        "--scaling=auto",
        f"--min={args.expected_min}",
        f"--max={args.expected_max}",
        "--quiet",
    ]


def _recover_maintenance(
    args: argparse.Namespace,
    api: CloudRunApi,
    phase: str,
) -> None:
    def dispatch(action: str) -> None:
        if action == "detach-ingress":
            _detach_ingress(args)
        elif action == "manual-zero":
            _restore_manual_zero(args, api)
        elif action == "terminate-runtime-sessions":
            _terminate_runtime_sessions(args)
        elif action == "pause-cleanup":
            _pause_cleanup(args)
        elif action == "verify-maintenance-posture":
            _assert_maintenance_posture(args, api)
        else:
            raise AssertionError(f"unhandled recovery action {action}")

    _run_all_recovery_actions(maintenance_recovery_actions(phase), dispatch)


def _run_all_recovery_actions(
    actions: Sequence[str],
    dispatch: Callable[[str], None],
) -> None:
    errors: list[BaseException] = []
    for action in actions:
        try:
            dispatch(action)
        except BaseException as error:
            errors.append(error)
            print(
                f"deploy-cloud-run maintenance recovery action {action} failed: {error}",
                file=sys.stderr,
            )
    if errors:
        raise BaseExceptionGroup(
            "One or more maintenance recovery actions failed.",
            errors,
        )


def _parse_args(argv: Sequence[str]) -> argparse.Namespace:
    if argv == ["--policy-self-test"]:
        return argparse.Namespace(mode="self-test")
    if argv[:1] == ["--read-scaling-prestate"]:
        parser = argparse.ArgumentParser()
        parser.add_argument("--read-scaling-prestate", action="store_true")
        parser.add_argument("--project", required=True)
        parser.add_argument("--region", required=True)
        parser.add_argument("--service", required=True)
        values = parser.parse_args(argv)
        values.mode = "read-scaling-prestate"
        return values
    if argv[:1] == ["--execute-job"]:
        parser = argparse.ArgumentParser()
        parser.add_argument("--execute-job", action="store_true")
        parser.add_argument("--project", required=True)
        parser.add_argument("--region", required=True)
        parser.add_argument("--job", required=True)
        image_source = parser.add_mutually_exclusive_group(required=True)
        image_source.add_argument("--image")
        image_source.add_argument("--service")
        parser.add_argument("--wait-seconds", required=True, type=int)
        parser.add_argument("--execution-arg", action="append", default=[])
        values = parser.parse_args(argv)
        values.mode = "execute-job"
        return values
    if argv[:1] == ["--resolve-image"]:
        parser = argparse.ArgumentParser()
        parser.add_argument("--resolve-image", action="store_true")
        parser.add_argument("--project", required=True)
        parser.add_argument("--image", required=True)
        parser.add_argument("--output", required=True)
        values = parser.parse_args(argv)
        values.mode = "resolve-image"
        return values
    if argv[:1] == ["--enter-maintenance"]:
        parser = argparse.ArgumentParser()
        parser.add_argument("--enter-maintenance", action="store_true")
        parser.add_argument("--project", required=True)
        parser.add_argument("--region", required=True)
        parser.add_argument("--service", required=True)
        parser.add_argument("--image", required=True)
        parser.add_argument("--expected-min", type=int, required=True)
        parser.add_argument("--expected-max", type=int, required=True)
        parser.add_argument("--maintenance-backend-service", required=True)
        parser.add_argument("--maintenance-neg", required=True)
        parser.add_argument("--maintenance-cleanup-scheduler", required=True)
        parser.add_argument("--maintenance-session-fence-job", required=True)
        values = parser.parse_args(argv)
        values.mode = "enter-maintenance"
        return values
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--service", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--expected-min", type=int, required=True)
    parser.add_argument("--expected-max", type=int, required=True)
    parser.add_argument("--maintenance-backend-service", required=True)
    parser.add_argument("--maintenance-neg", required=True)
    parser.add_argument("--maintenance-cleanup-scheduler", required=True)
    parser.add_argument("--maintenance-session-fence-job", required=True)
    parser.add_argument("deploy_args", nargs=argparse.REMAINDER)
    values = parser.parse_args(argv)
    values.mode = "deploy"
    if values.deploy_args[:1] == ["--"]:
        values.deploy_args = values.deploy_args[1:]
    return values


def _production_service(
    *,
    latest: str,
    traffic: list[dict[str, Any]],
    observed: list[dict[str, Any]],
    scaling: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "name": "projects/p/locations/r/services/s",
        "latestReadyRevision": latest,
        "latestCreatedRevision": latest,
        "terminalCondition": {"state": SERVICE_READY_STATE},
        "reconciling": False,
        "scaling": scaling or {"scalingMode": "AUTOMATIC"},
        "traffic": traffic,
        "trafficStatuses": observed,
    }


def _expect_policy_failure(body: Callable[[], object], label: str) -> None:
    try:
        body()
    except DeploymentPolicyError:
        return
    raise AssertionError(f"{label} was accepted")


def _policy_self_test() -> None:
    service_name = "projects/p/locations/r/services/s"
    old = f"{service_name}/revisions/s-00001-old"
    candidate = f"{service_name}/revisions/s-00002-new"
    irrelevant = f"{service_name}/revisions/s-00000-gc"

    assert scaling_prestate({"scaling": {"scalingMode": "AUTOMATIC"}}) == "automatic"
    assert (
        scaling_prestate(
            {"scaling": {"scalingMode": "MANUAL", "manualInstanceCount": 0}}
        )
        == "manual-zero"
    )
    assert_scaling(
        {"scaling": {"scalingMode": "MANUAL", "manualInstanceCount": 0}},
        "manual-zero",
        expected_min=1,
        expected_max=4,
    )
    assert_scaling(
        {
            "scaling": {
                "scalingMode": "AUTOMATIC",
                "minInstanceCount": 1,
                "maxInstanceCount": 4,
            }
        },
        "automatic",
        expected_min=1,
        expected_max=4,
    )
    _expect_policy_failure(
        lambda: assert_scaling(
            {"scaling": {"scalingMode": "AUTOMATIC"}},
            "automatic",
            expected_min=1,
            expected_max=4,
        ),
        "automatic scaling without exact bounds",
    )
    automatic_args = argparse.Namespace(
        service="s",
        region="r",
        project="p",
        expected_min=1,
        expected_max=4,
    )
    assert _automatic_scaling_update_command(automatic_args) == [
        "gcloud",
        "run",
        "services",
        "update",
        "s",
        "--region=r",
        "--project=p",
        "--scaling=auto",
        "--min=1",
        "--max=4",
        "--quiet",
    ]
    _expect_policy_failure(
        lambda: scaling_prestate(
            {"scaling": {"scalingMode": "MANUAL", "manualInstanceCount": 1}}
        ),
        "manual non-zero scaling",
    )

    latest_service = _production_service(
        latest=candidate,
        traffic=[
            {
                "type": "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST",
                "percent": 100,
            },
            {
                "type": "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION",
                "revision": "s-00001-old",
                "percent": 0,
            },
        ],
        observed=[
            {
                "type": "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION",
                "revision": candidate,
                "percent": 100,
            }
        ],
    )
    assert_candidate_traffic(latest_service, candidate)

    explicit_service = _production_service(
        latest=candidate,
        traffic=[{"revision": "s-00002-new", "percent": 100}],
        observed=[{"revision": candidate, "percent": 100}],
    )
    assert_candidate_traffic(explicit_service, candidate)

    tagged = _production_service(
        latest=candidate,
        traffic=[{"revision": candidate, "percent": 100, "tag": "preview"}],
        observed=[{"revision": candidate, "percent": 100}],
    )
    _expect_policy_failure(
        lambda: assert_candidate_traffic(tagged, candidate), "tagged traffic"
    )
    observed_tagged = _production_service(
        latest=candidate,
        traffic=[{"revision": candidate, "percent": 100}],
        observed=[{"revision": candidate, "percent": 100, "tag": "preview"}],
    )
    _expect_policy_failure(
        lambda: assert_candidate_traffic(observed_tagged, candidate),
        "observed tagged traffic",
    )

    split = _production_service(
        latest=candidate,
        traffic=[
            {"revision": candidate, "percent": 99},
            {"revision": old, "percent": 1},
        ],
        observed=[{"revision": candidate, "percent": 100}],
    )
    _expect_policy_failure(
        lambda: assert_candidate_traffic(split, candidate), "desired traffic split"
    )

    before = _production_service(
        latest=old,
        traffic=[{"revision": old, "percent": 100}],
        observed=[{"revision": old, "percent": 100}],
    )
    assert_revision_transition(
        before_service=before,
        before_revisions=frozenset({old, irrelevant}),
        after_revisions=frozenset({old, candidate}),
        expected_additions=frozenset({candidate}),
    )
    _expect_policy_failure(
        lambda: assert_revision_transition(
            before_service=before,
            before_revisions=frozenset({old, irrelevant}),
            after_revisions=frozenset({candidate}),
            expected_additions=frozenset({candidate}),
        ),
        "garbage collection of a traffic-owning revision",
    )
    _expect_policy_failure(
        lambda: assert_revision_transition(
            before_service=before,
            before_revisions=frozenset({old}),
            after_revisions=frozenset({old, candidate, irrelevant}),
            expected_additions=frozenset({candidate}),
        ),
        "unexpected revision addition",
    )

    for phase in RECOVERABLE_PHASES:
        assert maintenance_recovery_actions(phase) == MAINTENANCE_RECOVERY_ACTIONS
    assert maintenance_recovery_actions(TERMINAL_PHASE) == ()
    attempted_recovery_actions: list[str] = []

    def failing_recovery_dispatch(action: str) -> None:
        attempted_recovery_actions.append(action)
        if action == "detach-ingress":
            raise DeploymentPolicyError("synthetic detach failure")

    try:
        _run_all_recovery_actions(
            MAINTENANCE_RECOVERY_ACTIONS,
            failing_recovery_dispatch,
        )
    except ExceptionGroup as error:
        assert len(error.exceptions) == 1
    else:
        raise AssertionError("synthetic recovery failure was accepted")
    assert attempted_recovery_actions == list(MAINTENANCE_RECOVERY_ACTIONS)

    _forbid_deploy_policy_overrides(["--timeout=3600s"])
    _expect_policy_failure(
        lambda: _forbid_deploy_policy_overrides(["--scaling=auto"]),
        "deploy-time scaling override",
    )
    repository, digest = _immutable_image(
        "us-central1-docker.pkg.dev/p/r/i@" + "sha256:" + "a" * 64
    )
    assert repository == "us-central1-docker.pkg.dev/p/r/i"
    assert digest == "sha256:" + "a" * 64
    immutable_image = repository + "@" + digest
    assert (
        _ready_service_image(
            latest_service,
            [
                {"name": candidate, "containers": [{"image": immutable_image}]},
                {"name": old, "containers": [{"image": immutable_image}]},
            ],
        )
        == immutable_image
    )
    _expect_policy_failure(
        lambda: _ready_service_image(
            split,
            [{"name": candidate, "containers": [{"image": immutable_image}]}],
        ),
        "split-traffic production Job image",
    )
    job_name = "projects/p/locations/r/jobs/commcare-nova-migrate"
    migrate_contract = JOB_TEMPLATE_CONTRACTS["commcare-nova-migrate"]
    assert _effective_execution_args(job_name, ()) == migrate_contract.stored_args
    assert _effective_execution_args(
        "projects/p/locations/r/jobs/commcare-nova-legacy-preplan-repair",
        ("legacy-preplan-repair.cjs", "--execute"),
    ) == ("legacy-preplan-repair.cjs", "--execute")
    assert _effective_execution_args(
        "projects/p/locations/r/jobs/commcare-nova-case-type-schema-retirement",
        ("schema-drift.cjs", "--execute", "--app", "app_123"),
    ) == ("schema-drift.cjs", "--execute", "--app", "app_123")
    assert _effective_execution_args(
        "projects/p/locations/r/jobs/commcare-nova-case-parent-relationship-repair",
        (
            "case-parent-relationship-repair.cjs",
            "--execute",
            "--confirm-old-revision-drained",
            "--app",
            "app_123",
        ),
    ) == (
        "case-parent-relationship-repair.cjs",
        "--execute",
        "--confirm-old-revision-drained",
        "--app",
        "app_123",
    )
    _expect_policy_failure(
        lambda: _effective_execution_args(job_name, ("arbitrary.cjs",)),
        "arbitrary Job override args",
    )
    ready_job = {
        "name": job_name,
        "generation": "7",
        "observedGeneration": "7",
        "reconciling": False,
        "terminalCondition": {"state": SERVICE_READY_STATE},
        "etag": "job-etag-7",
        "template": {
            "taskCount": 1,
            "parallelism": 1,
            "template": {
                "containers": [
                    {
                        "image": immutable_image,
                        "command": list(migrate_contract.command),
                        "args": list(migrate_contract.stored_args),
                    }
                ],
                "serviceAccount": migrate_contract.service_account,
                "maxRetries": 0,
                "timeout": "3000s",
            },
        },
    }
    assert _exact_ready_job_etag(ready_job, job_name, immutable_image) == "job-etag-7"
    wrong_authority_job = json.loads(json.dumps(ready_job))
    wrong_authority_job["template"]["template"]["serviceAccount"] = (
        "commcare-nova@commcare-nova.iam.gserviceaccount.com"
    )
    _expect_policy_failure(
        lambda: _exact_ready_job_etag(wrong_authority_job, job_name, immutable_image),
        "wrong Job service account",
    )
    _expect_policy_failure(
        lambda: _exact_ready_job_etag(
            {
                "name": job_name,
                "generation": "8",
                "observedGeneration": "7",
                "reconciling": False,
                "terminalCondition": {"state": SERVICE_READY_STATE},
                "etag": "stale",
                "template": {
                    "taskCount": 1,
                    "parallelism": 1,
                    "template": {
                        "containers": [
                            {
                                "image": immutable_image,
                                "command": list(migrate_contract.command),
                                "args": list(migrate_contract.stored_args),
                            }
                        ],
                        "serviceAccount": migrate_contract.service_account,
                        "maxRetries": 0,
                        "timeout": "3000s",
                    },
                },
            },
            job_name,
            immutable_image,
        ),
        "unobserved Job generation",
    )
    execution_name = f"{job_name}/executions/migrate-execution"
    assert (
        _assert_exact_execution_succeeded(
            {
                "name": execution_name,
                # The real Cloud Run v2 API returns the SHORT job name here, not
                # the resource path. The fixture said otherwise, so this assertion
                # proved only that the code agreed with itself.
                "job": "migrate",
                "taskCount": 1,
                "parallelism": 1,
                "succeededCount": 1,
                "failedCount": 0,
                "cancelledCount": 0,
                "completionTime": "2026-07-30T00:00:00Z",
                "template": {
                    "containers": [
                        {
                            "image": immutable_image,
                            "command": list(migrate_contract.command),
                            "args": [
                                "migrate.cjs",
                                "--terminate-runtime-sessions-only",
                            ],
                        }
                    ],
                    "serviceAccount": migrate_contract.service_account,
                    "maxRetries": 0,
                    "timeout": "3000s",
                },
            },
            job_name,
            immutable_image,
            ("migrate.cjs", "--terminate-runtime-sessions-only"),
        )["name"]
        == execution_name
    )
    _expect_policy_failure(
        lambda: _immutable_image("us-central1-docker.pkg.dev/p/r/i:build"),
        "mutable deployment image",
    )
    _expect_policy_failure(
        lambda: _immutable_image("us-central1-docker.pkg.dev/p/r/i@sha256:" + "g" * 64),
        "non-hex deployment digest",
    )
    print("deploy-cloud-run policy self-test passed")


def _resolve_mode(args: argparse.Namespace) -> None:
    if not RESOURCE_PART_RE.fullmatch(args.project):
        fail(f"Invalid Artifact Registry project: {args.project!r}.")
    immutable_image, digest = _resolve_image(args.image, args.project)
    _write_resolved_image(args.output, immutable_image, digest)
    print(
        "NOVA_RESOLVED_IMAGE="
        + json.dumps(
            {"image": immutable_image, "digest": digest},
            separators=(",", ":"),
            sort_keys=True,
        )
    )


def _read_scaling_prestate_mode(args: argparse.Namespace) -> None:
    for label in ("project", "region", "service"):
        value = getattr(args, label)
        if not RESOURCE_PART_RE.fullmatch(value):
            fail(f"Invalid Cloud Run {label}: {value!r}.")
    api = CloudRunApi(args.project, args.region, args.service)
    print(scaling_prestate(api.service()))


def _execute_job_mode(args: argparse.Namespace) -> None:
    expected_image = args.image
    if expected_image is None:
        api = CloudRunApi(args.project, args.region, args.service)
        expected_image = _ready_service_image(api.service(), api.revisions())
    execution = _execute_job_exact(
        project=args.project,
        region=args.region,
        job=args.job,
        expected_image=expected_image,
        execution_args=args.execution_arg,
        wait_seconds=args.wait_seconds,
    )
    print(
        "NOVA_JOB_EXECUTION="
        + json.dumps(
            {
                "job": args.job,
                "execution": execution.get("name"),
                "image": expected_image,
            },
            separators=(",", ":"),
            sort_keys=True,
        )
    )


def _enter_maintenance_mode(args: argparse.Namespace) -> None:
    for label in (
        "project",
        "region",
        "service",
        "maintenance_backend_service",
        "maintenance_neg",
        "maintenance_cleanup_scheduler",
        "maintenance_session_fence_job",
    ):
        value = getattr(args, label)
        if not RESOURCE_PART_RE.fullmatch(value):
            fail(f"Invalid maintenance {label.replace('_', '-')}: {value!r}.")
    if args.expected_min < 0 or args.expected_max < args.expected_min:
        fail("Expected Cloud Run min/max scaling bounds are invalid.")
    _immutable_image(args.image)
    api = CloudRunApi(args.project, args.region, args.service)
    prestate = scaling_prestate(api.service())
    if prestate == "manual-zero":
        # A retry can arrive after any recovery action failed. Manual-zero
        # proves only the scaling axis, so re-converge every maintenance axis
        # (including the exact-image session fence) before the fleet verifier
        # is allowed to proceed. The recovery runner attempts every action even
        # when an earlier one fails, leaving a later retry able to converge.
        _recover_maintenance(args, api, "manual-zero")
    elif prestate == "automatic":
        try:
            # Stop independent writers first, remove public admission, then
            # drain instances and terminate any database sessions that survived
            # the scale transition. A failure converges to the same fail-closed
            # maintenance posture as a failed candidate deployment.
            _pause_cleanup(args)
            _detach_ingress(args)
            _restore_manual_zero(args, api)
            _terminate_runtime_sessions(args)
            _assert_maintenance_posture(args, api)
        except BaseException as original_error:
            try:
                _recover_maintenance(args, api, "manual-zero")
            except BaseException as recovery_error:
                raise BaseExceptionGroup(
                    "Maintenance entry and fail-closed recovery both failed.",
                    [original_error, recovery_error],
                ) from original_error
            raise
    else:
        fail(f"Cannot enter maintenance from scaling state {prestate!r}.")
    print(
        "NOVA_MAINTENANCE_ENTERED="
        + json.dumps(
            {"image": args.image, "prestate": prestate},
            separators=(",", ":"),
            sort_keys=True,
        )
    )


def _deploy_mode(args: argparse.Namespace) -> None:
    for label in (
        "project",
        "region",
        "service",
        "maintenance_backend_service",
        "maintenance_neg",
        "maintenance_cleanup_scheduler",
        "maintenance_session_fence_job",
    ):
        value = getattr(args, label)
        if not RESOURCE_PART_RE.fullmatch(value):
            fail(f"Invalid Cloud Run {label.replace('_', '-')}: {value!r}.")
    if args.expected_min < 0 or args.expected_max < args.expected_min:
        fail("Expected Cloud Run min/max scaling bounds are invalid.")
    _forbid_deploy_policy_overrides(args.deploy_args)
    _, expected_digest = _immutable_image(args.image)

    api = CloudRunApi(args.project, args.region, args.service)
    before_service = api.service()
    prestate = scaling_prestate(before_service)
    before_revisions = revision_names(api.revisions())
    maintenance = prestate == "manual-zero"
    phase = "manual-zero"
    success = False
    original_error: BaseException | None = None
    recovery_error: BaseException | None = None

    print(
        "NOVA_DEPLOY_PRESTATE="
        + json.dumps(
            {
                "scaling": prestate,
                "revisionCount": len(before_revisions),
                "revisions": sorted(before_revisions),
                "image": args.image,
            },
            separators=(",", ":"),
            sort_keys=True,
        )
    )

    try:
        if maintenance:
            _assert_maintenance_posture(args, api)

        _run(
            [
                "gcloud",
                "run",
                "deploy",
                args.service,
                f"--image={args.image}",
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
            assert_revision_transition(
                before_service=before_service,
                before_revisions=before_revisions,
                after_revisions=revisions,
                expected_additions=frozenset({candidate}),
            )
            assert_candidate_traffic(service, candidate)
            return service, revisions, candidate

        deployed_service, deployed_revisions, candidate = _wait_for(
            "the exact candidate deployment", deployed_candidate
        )
        phase = "candidate-ready"
        _candidate_revision_fact(
            candidate,
            args.region,
            args.project,
            args.image,
            expected_digest,
        )
        if maintenance:
            if _scheduler_state(args) != "PAUSED" or _ingress_attached(args):
                fail(
                    "Candidate deployment changed the maintenance ingress or cleanup posture."
                )
        print(
            "NOVA_DEPLOY_CANDIDATE="
            + json.dumps(
                {
                    "revision": candidate,
                    "image": args.image,
                    "prestate": prestate,
                },
                separators=(",", ":"),
                sort_keys=True,
            )
        )

        _run(_automatic_scaling_update_command(args))

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
            assert_revision_transition(
                before_service=deployed_service,
                before_revisions=deployed_revisions,
                after_revisions=current_revisions,
                expected_additions=frozenset(),
            )
            if candidate not in current_revisions:
                fail("Scaling-only update lost the exact candidate revision.")
            assert_candidate_traffic(service, candidate)
            return service

        final_service = _wait_for(
            "automatic scaling without a revision change",
            automatic_without_revision,
        )
        phase = "automatic-resumed"
        final_revisions = revision_names(api.revisions())
        if maintenance:
            if _scheduler_state(args) != "PAUSED" or _ingress_attached(args):
                fail(
                    "Automatic scaling changed the maintenance ingress or cleanup posture."
                )
            _attach_ingress(args)
            phase = "ingress-attached"
            _resume_cleanup(args)
            phase = "cleanup-enabled"
        success = True
        phase = TERMINAL_PHASE
        print(
            "NOVA_DEPLOY_RESULT="
            + json.dumps(
                {
                    "candidateRevision": candidate,
                    "image": args.image,
                    "prestate": prestate,
                    "finalScaling": scaling_prestate(final_service),
                    "revisionCount": len(final_revisions),
                },
                separators=(",", ":"),
                sort_keys=True,
            )
        )
    except BaseException as error:
        original_error = error
    finally:
        if maintenance and not success:
            try:
                _recover_maintenance(args, api, phase)
            except BaseException as error:
                recovery_error = error
                print(
                    f"deploy-cloud-run maintenance recovery also failed: {error}",
                    file=sys.stderr,
                )

    if original_error is not None:
        raise original_error
    if recovery_error is not None:
        raise recovery_error


def main(argv: Sequence[str]) -> None:
    args = _parse_args(argv)
    if args.mode == "self-test":
        _policy_self_test()
        return
    if args.mode == "read-scaling-prestate":
        _read_scaling_prestate_mode(args)
        return
    if args.mode == "execute-job":
        _execute_job_mode(args)
        return
    if args.mode == "enter-maintenance":
        _enter_maintenance_mode(args)
        return
    if args.mode == "resolve-image":
        _resolve_mode(args)
        return
    _deploy_mode(args)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (
        DeploymentPolicyError,
        subprocess.CalledProcessError,
        json.JSONDecodeError,
        OSError,
    ) as error:
        print(f"deploy-cloud-run policy failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
