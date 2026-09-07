"""Policy tests cross the real JSON/HTTP boundary without contacting Google."""
import copy
from contextlib import redirect_stdout
import io
import json
import unittest
import urllib.error
from unittest.mock import patch

from deployment_fixtures import (
    deploy, gate, IMAGE, JOB, EXECUTION, OPERATION, job_fixture,
    completed_job_fixture, execution_fixture, http_responses, http_error, requests,
)


class JobExecutionTests(unittest.TestCase):
    def execute(self):
        return deploy._execute_job_exact(
            project="commcare-nova", region="us-central1", job="commcare-nova-migrate",
            expected_image=IMAGE, execution_args=[], wait_seconds=10,
        )

    def test_completed_execution_uses_etag_and_exact_immutable_snapshot(self):
        execution = execution_fixture()
        with patch.object(deploy, "_access_token", return_value="synthetic"), patch(
            "urllib.request.urlopen", side_effect=http_responses(
                job_fixture(), {"name": OPERATION}, {"done": True, "response": execution}, execution,
            ),
        ) as http:
            self.assertEqual(self.execute(), execution)
        sent = requests(http)
        self.assertEqual([request.get_method() for request in sent], ["GET", "POST", "GET", "GET"])
        self.assertEqual(sent[1].full_url, "https://run.googleapis.com/v2/" + JOB + ":run")
        self.assertEqual(json.loads(sent[1].data), {"etag": "generation-3"})
        self.assertEqual(sent[1].get_header("Content-type"), "application/json")
        self.assertEqual(sent[1].get_header("Authorization"), "Bearer synthetic")
        self.assertEqual(sent[-1].full_url, "https://run.googleapis.com/v2/" + EXECUTION)

    def test_job_drift_refuses_before_any_execution_request(self):
        mutations = {
            "image": lambda job: job["template"]["template"]["containers"][0].update(image=IMAGE.replace("a" * 64, "b" * 64)),
            "authority": lambda job: job["template"]["template"].update(serviceAccount="wrong@example.com"),
            "environment": lambda job: job["template"]["template"]["containers"][0]["env"][0].update(value="wrong-database"),
            "network": lambda job: job["template"]["template"]["vpcAccess"].update(egress="ALL_TRAFFIC"),
            "missing-network": lambda job: job["template"]["template"].pop("vpcAccess"),
            "generation": lambda job: job.update(generation="4"),
            "retries": lambda job: job["template"]["template"].update(maxRetries=1),
            "cpu": lambda job: job["template"]["template"]["containers"][0]["resources"]["limits"].update(cpu="1"),
            "command": lambda job: job["template"]["template"]["containers"][0].update(command=["sh"]),
            "args": lambda job: job["template"]["template"]["containers"][0].update(args=["unexpected.cjs"]),
            "task-count": lambda job: job["template"].update(taskCount=2),
        }
        for name, mutate in mutations.items():
            job = job_fixture()
            mutate(job)
            with self.subTest(name=name), patch.object(deploy, "_access_token", return_value="synthetic"), patch(
                "urllib.request.urlopen", side_effect=http_responses(job),
            ) as http:
                with self.assertRaises(deploy.DeploymentPolicyError):
                    self.execute()
                self.assertEqual([request.get_method() for request in requests(http)], ["GET"])

    def test_post_is_sent_once_for_http_and_transport_failures(self):
        for error in (http_error(503), urllib.error.URLError("connection lost"), TimeoutError("timeout")):
            with self.subTest(error=type(error)), patch.object(deploy, "_access_token", return_value="synthetic"), patch(
                "urllib.request.urlopen", side_effect=http_responses(job_fixture(), error),
            ) as http:
                with self.assertRaises(deploy.TerminalDeploymentPolicyError):
                    self.execute()
                self.assertEqual([request.get_method() for request in requests(http)], ["GET", "POST"])
                self.assertEqual(json.loads(requests(http)[1].data), {"etag": "generation-3"})

    def test_transient_reads_retry_without_repeating_the_execution_post(self):
        execution = execution_fixture()
        with patch.object(deploy, "_access_token", return_value="synthetic"), patch(
            "urllib.request.urlopen", side_effect=http_responses(
                http_error(503), job_fixture(), {"name": OPERATION},
                http_error(429), {"done": True, "response": execution},
                urllib.error.URLError("connection reset"), execution,
            ),
        ) as http, patch.object(deploy.time, "sleep") as sleep:
            self.assertEqual(self.execute(), execution)
        self.assertEqual([request.get_method() for request in requests(http)], ["GET", "GET", "POST", "GET", "GET", "GET", "GET"])
        self.assertEqual(sleep.call_count, 3)

    def test_authorization_failure_is_terminal_without_sleep_or_write(self):
        with patch.object(deploy, "_access_token", return_value="synthetic"), patch(
            "urllib.request.urlopen", side_effect=http_responses(http_error(403)),
        ) as http, patch.object(deploy.time, "sleep") as sleep:
            with self.assertRaises(deploy.TerminalDeploymentPolicyError):
                self.execute()
        self.assertEqual([request.get_method() for request in requests(http)], ["GET"])
        sleep.assert_not_called()

    def test_polling_stops_at_its_deadline(self):
        with patch("urllib.request.urlopen", side_effect=http_responses(http_error(503))) as http, patch.object(
            deploy.time, "monotonic", side_effect=[10, 12],
        ), patch.object(deploy.time, "sleep") as sleep:
            with self.assertRaisesRegex(deploy.DeploymentPolicyError, "Timed out"):
                deploy._wait_for("read", lambda: deploy._run_api_request("synthetic", "GET", JOB), timeout_seconds=1)
        self.assertEqual(len(requests(http)), 1)
        sleep.assert_not_called()

    def test_immutable_execution_failures_never_count_as_success_or_poll_again(self):
        for mutation in (
            {"failedCount": 1}, {"cancelledCount": 1}, {"succeededCount": 0},
            {"name": "projects/foreign/locations/r/jobs/other/executions/run-1"},
        ):
            execution = {**execution_fixture(), **mutation}
            with self.subTest(mutation=mutation), patch.object(deploy, "_access_token", return_value="synthetic"), patch(
                "urllib.request.urlopen", side_effect=http_responses(
                    job_fixture(), {"name": OPERATION}, {"done": True, "response": execution}, execution,
                ),
            ) as http, patch.object(deploy.time, "sleep") as sleep:
                with self.assertRaises(deploy.TerminalDeploymentPolicyError):
                    self.execute()
                self.assertEqual(len(requests(http)), 4)
                sleep.assert_not_called()

    def test_execution_vpc_is_optional_but_if_present_must_match(self):
        execution = execution_fixture()
        self.assertEqual(deploy._assert_exact_execution_succeeded(execution, JOB, IMAGE, ["migrate.cjs"]), execution)
        execution["template"]["vpcAccess"] = {"egress": "ALL_TRAFFIC"}
        with self.assertRaises(deploy.TerminalDeploymentPolicyError):
            deploy._assert_exact_execution_succeeded(execution, JOB, IMAGE, ["migrate.cjs"])

    def test_override_operations_are_exact_and_default_to_scan(self):
        operations = [
            ("commcare-nova-legacy-preplan-repair", ["legacy-preplan-repair.cjs", "--execute"]),
            ("commcare-nova-case-type-schema-retirement", ["schema-drift.cjs", "--execute", "--app", "app_123"]),
            ("commcare-nova-case-parent-relationship-repair",
             ["case-parent-relationship-repair.cjs", "--execute", "--confirm-old-revision-drained", "--app", "app_123"]),
        ]
        self.assertEqual(deploy._effective_execution_args(JOB, []), ("migrate.cjs",))
        for name, args in operations:
            self.assertEqual(deploy._effective_execution_args(name, args), tuple(args))
        for args in (["arbitrary.cjs"], ["migrate.cjs", "--terminate-runtime-sessions-only"], ["migrate.cjs", "--finalize-better-auth-17"]):
            with self.assertRaises(deploy.DeploymentPolicyError):
                deploy._effective_execution_args(JOB, args)


class MigrationAdmissionTests(unittest.TestCase):
    def admit(self, image=IMAGE):
        return gate.admit_migration(
            project="commcare-nova", region="us-central1", job="commcare-nova-migrate",
            image=image, wait_seconds=10,
        )

    def test_identical_successful_artifact_uses_only_read_evidence(self):
        job, execution = completed_job_fixture(), execution_fixture()
        with patch.object(gate.policy, "_access_token", return_value="synthetic"), patch(
            "urllib.request.urlopen", side_effect=http_responses(job, execution, job),
        ) as http:
            result = self.admit()
        self.assertEqual(result, {"mode": "reused", "image": IMAGE, "execution": EXECUTION})
        self.assertEqual([request.get_method() for request in requests(http)], ["GET", "GET", "GET"])

    def test_job_or_latest_execution_change_refuses_cached_success(self):
        for change in ("etag", "latest"):
            job = completed_job_fixture()
            after = copy.deepcopy(job)
            if change == "etag":
                after["etag"] = "generation-4"
            else:
                after["latestCreatedExecution"]["name"] = "run-2"
            with self.subTest(change=change), patch.object(gate.policy, "_access_token", return_value="synthetic"), patch(
                "urllib.request.urlopen", side_effect=http_responses(job, execution_fixture(), after),
            ) as http:
                with self.assertRaises(gate.policy.TerminalDeploymentPolicyError):
                    self.admit()
                self.assertEqual([request.get_method() for request in requests(http)], ["GET", "GET", "GET"])

    def test_changed_artifact_patches_with_etag_and_then_executes_the_new_snapshot(self):
        job = completed_job_fixture()
        job.update(labels={"team": "nova"}, annotations={"example.com/owner": "deployment"},
                   binaryAuthorization={"useDefault": True}, startExecutionToken="never-replay-this")
        image = IMAGE.replace("a" * 64, "b" * 64)
        updated = copy.deepcopy(job)
        updated["template"]["template"]["containers"][0]["image"] = image
        updated["etag"] = "generation-4"
        execution = execution_fixture(image)
        with patch.object(gate.policy, "_access_token", return_value="synthetic"), patch(
            "urllib.request.urlopen", side_effect=http_responses(
                job, {}, updated, updated, {"name": OPERATION}, {"done": True, "response": execution}, execution,
            ),
        ) as http:
            self.assertEqual(self.admit(image), {"mode": "executed", "image": image, "execution": EXECUTION})
        sent = requests(http)
        self.assertEqual([request.get_method() for request in sent], ["GET", "PATCH", "GET", "GET", "POST", "GET", "GET"])
        update = json.loads(sent[1].data)
        self.assertEqual(update, {
            "name": JOB, "etag": "generation-3", "template": updated["template"],
            "labels": {"team": "nova"}, "annotations": {"example.com/owner": "deployment"},
            "binaryAuthorization": {"useDefault": True},
        })
        self.assertEqual(sent[1].full_url, "https://run.googleapis.com/v2/" + JOB)
        self.assertEqual(json.loads(sent[4].data), {"etag": "generation-4"})

    def test_patch_failure_never_retries_or_executes_the_job(self):
        with patch.object(gate.policy, "_access_token", return_value="synthetic"), patch(
            "urllib.request.urlopen", side_effect=http_responses(completed_job_fixture(), http_error(503)),
        ) as http:
            with self.assertRaises(gate.policy.TerminalDeploymentPolicyError):
                self.admit(IMAGE.replace("a" * 64, "b" * 64))
        self.assertEqual([request.get_method() for request in requests(http)], ["GET", "PATCH"])

    def test_failed_or_pruned_execution_requires_an_actual_new_execution(self):
        failed = execution_fixture()
        failed.update(succeededCount=0, failedCount=1)
        for prior in (failed, http_error(404)):
            execution = execution_fixture()
            execution["name"] = JOB + "/executions/run-2"
            with self.subTest(prior=type(prior)), patch.object(gate.policy, "_access_token", return_value="synthetic"), patch(
                "urllib.request.urlopen", side_effect=http_responses(
                    completed_job_fixture(), prior, job_fixture(), {"name": OPERATION},
                    {"done": True, "response": execution}, execution,
                ),
            ) as http:
                result = self.admit()
            self.assertEqual(result["mode"], "executed")
            self.assertEqual(result["execution"], JOB + "/executions/run-2")
            self.assertEqual([request.get_method() for request in requests(http)], ["GET", "GET", "GET", "POST", "GET", "GET"])

    def test_active_different_artifact_is_not_overwritten(self):
        job = completed_job_fixture()
        del job["latestCreatedExecution"]["completionTime"]
        execution = execution_fixture()
        del execution["completionTime"]
        with patch.object(gate.policy, "_access_token", return_value="synthetic"), patch(
            "urllib.request.urlopen", side_effect=http_responses(job, execution),
        ) as http:
            with self.assertRaises(gate.policy.DeploymentPolicyError):
                self.admit(IMAGE.replace("a" * 64, "b" * 64))
        self.assertEqual([request.get_method() for request in requests(http)], ["GET", "GET"])

    def test_active_same_artifact_is_joined_and_rechecked_without_another_post(self):
        job = completed_job_fixture()
        del job["latestCreatedExecution"]["completionTime"]
        active = execution_fixture()
        del active["completionTime"]
        complete = execution_fixture()
        with patch.object(gate.policy, "_access_token", return_value="synthetic"), patch(
            "urllib.request.urlopen", side_effect=http_responses(job, active, active, complete, job),
        ) as http, patch.object(gate.policy.time, "sleep"):
            self.assertEqual(self.admit(), {"mode": "reused", "image": IMAGE, "execution": EXECUTION})
        self.assertEqual([request.get_method() for request in requests(http)], ["GET"] * 5)


SERVICE = "projects/commcare-nova/locations/us-central1/services/commcare-nova"
OLD = SERVICE + "/revisions/old"
CANDIDATE = SERVICE + "/revisions/new"
UNUSED = SERVICE + "/revisions/unused"


def service_fixture(revision=OLD):
    return {
        "name": SERVICE, "latestReadyRevision": revision, "latestCreatedRevision": revision,
        "terminalCondition": {"state": "CONDITION_SUCCEEDED"}, "reconciling": False,
        "scaling": {"scalingMode": "AUTOMATIC", "minInstanceCount": 1, "maxInstanceCount": 4},
        "traffic": [{"revision": revision, "percent": 100}],
        "trafficStatuses": [{"revision": revision, "percent": 100}],
    }


class ServicePolicyTests(unittest.TestCase):
    def test_automatic_scaling_requires_canonical_bounds_and_no_manual_override(self):
        deploy.assert_scaling(service_fixture(), "automatic", expected_min=1, expected_max=4)
        for scaling in (
            {"scalingMode": "MANUAL", "manualInstanceCount": 0},
            {"scalingMode": "MANUAL", "manualInstanceCount": 1},
            {"scalingMode": "AUTOMATIC", "manualInstanceCount": 1},
            {"scalingMode": "AUTOMATIC"},
            {"scalingMode": "AUTOMATIC", "minInstanceCount": True, "maxInstanceCount": 4},
            {"scalingMode": "AUTOMATIC", "minInstanceCount": "01", "maxInstanceCount": 4},
            {"scalingMode": "AUTOMATIC", "minInstanceCount": 1, "maxInstanceCount": 5},
        ):
            with self.subTest(scaling=scaling), self.assertRaises(deploy.DeploymentPolicyError):
                deploy.assert_scaling({"scaling": scaling}, "automatic", expected_min=1, expected_max=4)

    def test_latest_and_short_revision_traffic_resolve_to_the_same_candidate(self):
        service = service_fixture(CANDIDATE)
        service["traffic"] = [{"type": "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", "percent": 100},
                              {"revision": "old", "percent": 0}]
        deploy.assert_candidate_traffic(service, CANDIDATE)
        service["traffic"] = [{"revision": "new", "percent": 100}]
        deploy.assert_candidate_traffic(service, CANDIDATE)

    def test_both_desired_and_observed_traffic_must_fully_belong_to_untagged_candidate(self):
        for field in ("traffic", "trafficStatuses"):
            for targets in (
                [{"revision": CANDIDATE, "percent": 100, "tag": "preview"}],
                [{"revision": CANDIDATE, "percent": 99}, {"revision": OLD, "percent": 1}],
                [{"revision": CANDIDATE, "percent": 101}],
                [{"revision": CANDIDATE, "percent": True}],
                [],
            ):
                service = service_fixture(CANDIDATE)
                service[field] = targets
                with self.subTest(field=field, targets=targets), self.assertRaises(deploy.DeploymentPolicyError):
                    deploy.assert_candidate_traffic(service, CANDIDATE)

    def test_only_unused_untagged_revisions_may_disappear_and_exactly_one_candidate_may_appear(self):
        before = service_fixture()
        self.assertEqual(deploy.assert_revision_transition(
            before_service=before, before_revisions=frozenset([OLD, UNUSED]),
            after_revisions=frozenset([OLD, CANDIDATE]), expected_additions=frozenset([CANDIDATE]),
        ), frozenset([UNUSED]))
        for after in (frozenset([CANDIDATE]), frozenset([OLD, CANDIDATE, UNUSED]), frozenset([OLD])):
            with self.assertRaises(deploy.DeploymentPolicyError):
                deploy.assert_revision_transition(
                    before_service=before, before_revisions=frozenset([OLD]),
                    after_revisions=after, expected_additions=frozenset([CANDIDATE]),
                )
        before["trafficStatuses"].append({"revision": UNUSED, "percent": 0, "tag": "kept"})
        with self.assertRaises(deploy.DeploymentPolicyError):
            deploy.assert_revision_transition(
                before_service=before, before_revisions=frozenset([OLD, UNUSED]),
                after_revisions=frozenset([OLD, CANDIDATE]), expected_additions=frozenset([CANDIDATE]),
            )

    def test_mutable_images_and_policy_overrides_refuse_before_accessing_google(self):
        arguments = ["--project=commcare-nova", "--region=us-central1", "--service=commcare-nova",
                     "--expected-min=1", "--expected-max=4"]
        with patch("subprocess.run") as process, patch("urllib.request.urlopen") as http:
            for image in ("registry/app:latest", "registry/app@sha256:" + "g" * 64):
                with self.assertRaises(deploy.DeploymentPolicyError):
                    deploy.main([*arguments, "--image=" + image])
            for override in ("--scaling=auto", "--image=other", "--no-traffic", "--tag=preview", "--project=other", "--region=other"):
                with self.subTest(override=override), self.assertRaises(deploy.DeploymentPolicyError):
                    deploy.main([*arguments, "--image=" + IMAGE, "--", override])
            process.assert_not_called()
            http.assert_not_called()

    def test_deploy_executes_once_and_verifies_the_new_ready_image_and_traffic(self):
        import subprocess
        candidate = {
            "spec": {"containers": [{"image": IMAGE}]},
            "status": {"imageDigest": IMAGE, "conditions": [{"type": "Ready", "status": "True"}]},
        }

        def gcloud(command, **kwargs):
            output = "synthetic" if command[1:3] == ["auth", "print-access-token"] else json.dumps(candidate)
            return subprocess.CompletedProcess(command, 0, stdout=output)

        with patch("subprocess.run", side_effect=gcloud) as process, patch(
            "urllib.request.urlopen", side_effect=http_responses(
                service_fixture(), {"revisions": [{"name": OLD}]},
                service_fixture(CANDIDATE), {"revisions": [{"name": OLD}, {"name": CANDIDATE}]},
            ),
        ) as http, redirect_stdout(io.StringIO()) as output:
            deploy.main(["--project=commcare-nova", "--region=us-central1", "--service=commcare-nova",
                         "--expected-min=1", "--expected-max=4", "--image=" + IMAGE, "--", "--timeout=3600s"])
        commands = [call.args[0] for call in process.call_args_list]
        self.assertEqual([command[1:3] for command in commands], [
            ["auth", "print-access-token"], ["run", "deploy"], ["run", "revisions"],
        ])
        self.assertIn("--image=" + IMAGE, commands[1])
        self.assertIn("--timeout=3600s", commands[1])
        self.assertEqual([request.get_method() for request in requests(http)], ["GET"] * 4)
        report = json.loads(output.getvalue().split("NOVA_DEPLOY_RESULT=")[1])
        self.assertEqual(report, {"candidateRevision": CANDIDATE, "image": IMAGE, "finalScaling": "automatic"})

    def test_candidate_proof_rejects_a_wrong_digest_repository_or_readiness(self):
        import subprocess
        for change in ("digest", "repository", "ready"):
            fact = {"spec": {"containers": [{"image": IMAGE}]},
                    "status": {"imageDigest": IMAGE, "conditions": [{"type": "Ready", "status": "True"}]}}
            if change == "digest":
                fact["status"]["imageDigest"] = IMAGE.replace("a" * 64, "b" * 64)
            elif change == "repository":
                fact["spec"]["containers"][0]["image"] = IMAGE.replace("/repo/", "/different/")
            else:
                fact["status"]["conditions"][0]["status"] = "False"
            with self.subTest(change=change), patch("subprocess.run", return_value=subprocess.CompletedProcess(
                ["gcloud"], 0, stdout=json.dumps(fact),
            )), self.assertRaises(deploy.DeploymentPolicyError):
                deploy._candidate_revision_fact(CANDIDATE, "us-central1", "commcare-nova", IMAGE, "sha256:" + "a" * 64)
