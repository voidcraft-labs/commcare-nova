#!/usr/bin/env python3
"""Admit a reproducible migration artifact through an exact Cloud Run Execution.

A prior successful Execution is reusable only while the complete Job contract,
its etag, and its latest Execution identity still match. Caches are not evidence
of migration success. Missing/failed evidence requires an actual execution.
"""
from __future__ import annotations

import argparse
import copy
import importlib.util
import json
from pathlib import Path
import sys
import urllib.error

spec = importlib.util.spec_from_file_location("nova_deploy_policy", Path(__file__).with_name("deploy-cloud-run.py"))
policy = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = policy
spec.loader.exec_module(policy)


def execution_name(job: dict, job_name: str) -> str | None:
    name = (job.get("latestCreatedExecution") or {}).get("name")
    if name is None:
        return None
    if not isinstance(name, str) or not policy.RESOURCE_PART_RE.fullmatch(name):
        raise policy.TerminalDeploymentPolicyError("Job returned an invalid latest Execution identity.")
    return f"{job_name}/executions/{name}"


def admit_migration(*, project: str, region: str, job: str, image: str, wait_seconds: int = 3060) -> dict:
    policy._immutable_image(image)
    for value in (project, region, job):
        if not policy.RESOURCE_PART_RE.fullmatch(value):
            raise policy.TerminalDeploymentPolicyError("Invalid migration Job resource name.")
    if job != "commcare-nova-migrate":
        raise policy.TerminalDeploymentPolicyError("The migration gate admits only the recurring migration Job.")
    name = f"projects/{project}/locations/{region}/jobs/{job}"
    token = policy._access_token()
    current = policy._run_api_request(token, "GET", name)
    current_image = policy._single_container(current["template"]["template"]["containers"], "Job containers")["image"]
    etag = policy._exact_ready_job_etag(current, name, current_image)
    latest_name = execution_name(current, name)
    latest_summary = current.get("latestCreatedExecution") or {}
    latest_active = latest_name is not None and not latest_summary.get("completionTime")

    if latest_name is not None and (current_image == image or latest_active):
        try:
            execution = policy._run_api_request(token, "GET", latest_name)
        except policy.TerminalDeploymentPolicyError as error:
            if not isinstance(error.__cause__, urllib.error.HTTPError) or error.__cause__.code != 404:
                raise
            # Cloud Run may prune historical executions. Absence never attests
            # success; rerun the artifact instead of trusting the Job summary.
            execution = {}
            latest_active = False
        if latest_active:
            # Joining a concurrent execution is safe only for this exact artifact.
            # Do not launch a second migration or overwrite another active Job.
            policy._assert_task_template(execution["template"], policy._job_contract(name),
                                        image, ["migrate.cjs"], "Active migration", require_vpc=False)
            execution = policy._wait_for("the active migration execution", lambda:
                policy._assert_exact_execution_succeeded(
                    policy._run_api_request(token, "GET", latest_name), name, image, ["migrate.cjs"]),
                timeout_seconds=wait_seconds)
        if current_image == image and execution.get("completionTime") and execution.get("succeededCount") == 1:
            policy._assert_exact_execution_succeeded(execution, name, image, ["migrate.cjs"])
            after = policy._run_api_request(token, "GET", name)
            if policy._exact_ready_job_etag(after, name, image) != etag or execution_name(after, name) != latest_name:
                raise policy.TerminalDeploymentPolicyError("Migration Job changed while verifying the prior successful Execution.")
            return {"mode": "reused", "image": image, "execution": latest_name}
        if latest_active:
            raise policy.TerminalDeploymentPolicyError("Another migration artifact is active; retry after it finishes.")

    if current_image != image:
        containers = copy.deepcopy(current["template"]["template"]["containers"])
        containers[0]["image"] = image
        # Only the image changes. The same generation fence protects this update
        # and the subsequent execution admission; neither mutation is retried.
        policy._run_api_request(token, "PATCH", name + "?updateMask=template.template.containers", {
            "name": name, "etag": etag, "template": {"template": {"containers": containers}},
        })
        policy._wait_for("the new immutable migration Job", lambda:
            policy._exact_ready_job_etag(policy._run_api_request(token, "GET", name), name, image),
            timeout_seconds=120)
    execution = policy._execute_job_exact(project=project, region=region, job=job,
        expected_image=image, execution_args=[], wait_seconds=wait_seconds)
    return {"mode": "executed", "image": image, "execution": execution["name"]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--job", required=True)
    parser.add_argument("--image", required=True)
    args = parser.parse_args()
    print("NOVA_MIGRATION_ADMISSION=" + json.dumps(admit_migration(**vars(args)), sort_keys=True), flush=True)
