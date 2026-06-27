#!/usr/bin/env bash
#
# Front Cloud Run with a Global External Application Load Balancer + Cloud Armor
# so the public endpoints (notably /api/log/error) get EDGE rate limiting that
# drops a flood before it reaches the service — the GCP-native replacement for
# the in-app limiter (CWE-770). This is a MIGRATION of three live prod domains
# (commcare.app, mcp.commcare.app, docs.commcare.app) off Cloud Run domain
# mappings onto the LB, so the cutover is outage-capable and partly manual
# (DNS lives at GoDaddy, not Cloud DNS).
#
# Recurring cost once the forwarding rule exists (Phase 2): ~$18/mo forwarding
# rule + $0.008/GiB each way (LB) + $5/mo Armor policy + $1/mo per rule +
# $0.75/M requests. Standard Armor tier — NOT Managed Protection Plus.
#
# Layout: Phase 1 (additive, ZERO traffic impact) is already applied and is
# idempotent. Phase 2 (cutover) and Phase 3 (rollback) are RUNBOOKS — read and
# run them by hand in a maintenance window. This script only (re)applies Phase 1
# and then prints the runbook.

set -euo pipefail

PROJECT="commcare-nova"
REGION="us-central1"
SERVICE="commcare-nova"
DOMAINS=(commcare.app mcp.commcare.app docs.commcare.app)

have() { gcloud "$@" >/dev/null 2>&1; }

echo "### Phase 1 — additive scaffolding (idempotent; no effect on live traffic)"

have compute addresses describe nova-lb-ip --global \
  || gcloud compute addresses create nova-lb-ip --global \
       --description="Nova LB anycast IP (Cloud Armor migration)"

# Read the ACTUAL allocated anycast IP back — never hardcode it. On a fresh
# project the create branch allocates a random global address, so the GoDaddy
# A-records + curl-verify in the runbook below must use whatever was assigned,
# not a stale literal. (Current prod value: 34.8.42.153.)
LB_IP="$(gcloud compute addresses describe nova-lb-ip --global --format='value(address)')"
echo "  nova-lb-ip = ${LB_IP}  (this is your GoDaddy A-record target)"

have compute network-endpoint-groups describe nova-neg --region="$REGION" \
  || gcloud compute network-endpoint-groups create nova-neg \
       --region="$REGION" --network-endpoint-type=serverless \
       --cloud-run-service="$SERVICE"

have compute backend-services describe nova-backend --global \
  || gcloud compute backend-services create nova-backend \
       --global --load-balancing-scheme=EXTERNAL_MANAGED

gcloud compute backend-services add-backend nova-backend --global \
  --network-endpoint-group=nova-neg --network-endpoint-group-region="$REGION" 2>/dev/null \
  || true # already attached

have compute url-maps describe nova-url-map \
  || gcloud compute url-maps create nova-url-map --default-service=nova-backend

have compute security-policies describe nova-armor \
  || gcloud compute security-policies create nova-armor \
       --description="Edge rate limiting for Nova public endpoints"

# ── OWASP CRS WAF rulesets in PREVIEW (log-only) mode ───────────────────────
# All four preconfigured rulesets run with `--preview`: they evaluate every
# request and LOG what they WOULD deny (jsonPayload.previewSecurityPolicy) but
# take no action. rce (100) and protocolattack (120) are kept off enforcement
# because they DO false-positive on this app's own traffic — Next.js Server
# Actions with a non-plain-JSON arg encode as multipart/form-data, whose
# `Content-Disposition` part-headers read as header injection (CRS 921150), and
# the MCP / chat / blueprint surfaces carry XPath that reads as Unix command
# injection (CRS 932xxx). lfi (110) and cve (130) have shown ZERO matches on
# live traffic, but stay in preview too: this deploy has one solo operator not
# watching the WAF logs, so a silent false-positive 403 is worse than the
# marginal edge defense — preview is the fail-open default. Enforce any rule
# only after its previewed matches confirm zero false positives over time (build
# an `opt_out_rule_ids` exclusion for any offending sub-rule first, then drop
# `--preview`). Real defense today is the app's valid-by-construction model +
# input validation + auth; the throttles below are the DDoS/flood backstop.
#
# This loop CONVERGES the four rules to preview on every run (unlike the
# create-only guards elsewhere in this script): an existing rule is `update`d to
# `--preview`, a missing one is `create`d in preview. So re-running the script is
# itself what flips a previously-ENFORCED rule to log-only — the state lives in
# the script, not only in an operator's memory. To RE-ENFORCE a rule once its
# previewed matches come back clean, run, by hand:
#   gcloud compute security-policies rules update <prio> \
#     --security-policy=nova-armor --no-preview
# (add any needed `opt_out_rule_ids` to its expression first), and flip its entry
# here off `--preview` so the next apply doesn't converge it back to log-only.
for pair in "100:rce-v33-stable" "110:lfi-v33-stable" \
            "120:protocolattack-v33-stable" "130:cve-canary"; do
  prio="${pair%%:*}"; ruleset="${pair#*:}"
  if gcloud compute security-policies rules describe "$prio" --security-policy=nova-armor >/dev/null 2>&1; then
    # Exists — force it to log-only (converges any enforce→preview drift).
    gcloud compute security-policies rules update "$prio" \
         --security-policy=nova-armor --preview
  else
    gcloud compute security-policies rules create "$prio" \
         --security-policy=nova-armor \
         --expression="evaluatePreconfiguredWaf('${ruleset}', {'sensitivity': 1})" \
         --action=deny-403 --preview
  fi
done

# ── Per-IP throttle on the Sentry browser-error relay — priority 90 ──────────
# `/api/monitoring` relays the browser SDK's error envelope and can burst, so
# cap it per-IP at 1200 req / 60s (the same ceiling as the site-wide rule below
# — NOT the tighter 60/60s on /api/log/error). Exact-path `==` (NOT `.matches`,
# an unanchored substring) keeps the rule scoped to this one path.
# LOAD-BEARING IF protocolattack (120) is ever re-enforced: the Sentry envelope
# is newline-delimited text/plain, which trips CRS 921150 — this terminal-allow
# throttle, at a LOWER priority than 120, is what lets the envelope skip the WAF.
# While 120 stays in preview the bypass is moot, but do NOT remove/renumber/widen
# rule 90 without first confirming 120 is still `--preview`, or every browser
# error report begins 403ing (silently — Sentry can't report its own ingest 403).
gcloud compute security-policies rules describe 90 --security-policy=nova-armor >/dev/null 2>&1 \
  || gcloud compute security-policies rules create 90 \
       --security-policy=nova-armor \
       --expression="request.path == '/api/monitoring'" \
       --action=throttle \
       --rate-limit-threshold-count=1200 --rate-limit-threshold-interval-sec=60 \
       --conform-action=allow --exceed-action=deny-429 --enforce-on-key=IP

# Per-IP throttle on the public client-error relay → 429 once over 60 req / 60s.
# Add more rules (one per protected path) the same way; each is +$1/mo.
gcloud compute security-policies rules describe 1000 --security-policy=nova-armor >/dev/null 2>&1 \
  || gcloud compute security-policies rules create 1000 \
       --security-policy=nova-armor \
       --expression="request.path.matches('/api/log/error')" \
       --action=throttle \
       --rate-limit-threshold-count=60 --rate-limit-threshold-interval-sec=60 \
       --conform-action=allow --exceed-action=deny-429 --enforce-on-key=IP

gcloud compute backend-services update nova-backend --global --security-policy=nova-armor

# Site-wide per-IP ceiling — DDoS backstop for EVERY path (the rule above is the
# tighter, path-specific limit). ENFORCED in prod (1200 req / 60s per IP). For a
# BRAND-NEW deployment, append `--preview` here first and watch `enforcedAction`
# logs before `--no-preview` — frontline-worker clinics often sit behind one
# shared NAT, so calibrate the threshold against real traffic before enforcing.
gcloud compute security-policies rules describe 2000 --security-policy=nova-armor >/dev/null 2>&1 \
  || gcloud compute security-policies rules create 2000 \
       --security-policy=nova-armor --src-ip-ranges="*" \
       --action=throttle \
       --rate-limit-threshold-count=1200 --rate-limit-threshold-interval-sec=60 \
       --conform-action=allow --exceed-action=deny-429 --enforce-on-key=IP

# HTTP->HTTPS redirect: the LB serves only :443, so a :80 hit needs this 301
# (Cloud Run's domain mapping did the upgrade before; the LB won't without it).
have compute url-maps describe nova-redirect-map \
  || gcloud compute url-maps import nova-redirect-map --global --quiet --source=/dev/stdin <<'YAML'
name: nova-redirect-map
defaultUrlRedirect:
  httpsRedirect: true
  redirectResponseCode: MOVED_PERMANENTLY_DEFAULT
  stripQuery: false
YAML
have compute target-http-proxies describe nova-http-proxy --global \
  || gcloud compute target-http-proxies create nova-http-proxy \
       --url-map=nova-redirect-map --global

# Zero-downtime cert: validate via a DNS authorization (a CNAME you add at
# GoDaddy) so the cert goes ACTIVE BEFORE you move any A record.
gcloud services enable certificatemanager.googleapis.com
for pair in "root:commcare.app" "mcp:mcp.commcare.app" "docs:docs.commcare.app"; do
  name="nova-dnsauth-${pair%%:*}"; domain="${pair##*:}"
  have certificate-manager dns-authorizations describe "$name" \
    || gcloud certificate-manager dns-authorizations create "$name" --domain="$domain"
done
have certificate-manager certificates describe nova-cert \
  || gcloud certificate-manager certificates create nova-cert \
       --domains="commcare.app,mcp.commcare.app,docs.commcare.app" \
       --dns-authorizations="nova-dnsauth-root,nova-dnsauth-mcp,nova-dnsauth-docs"

echo
echo "================================================================"
echo " GoDaddy records — add these CNAMEs now (validates the cert,"
echo " does NOT move traffic). Cert goes ACTIVE a few minutes after."
echo "================================================================"
for a in nova-dnsauth-root nova-dnsauth-mcp nova-dnsauth-docs; do
  gcloud certificate-manager dns-authorizations describe "$a" \
    --format="value(dnsResourceRecord.name, dnsResourceRecord.type, dnsResourceRecord.data)"
done

cat <<EOF

================================================================
 Phase 2 — CUTOVER (run by hand, in a maintenance window)
================================================================
 0. Add the 3 CNAMEs above at GoDaddy. Wait for ACTIVE:
      gcloud certificate-manager certificates describe nova-cert \\
        --format='value(managed.state)'    # → ACTIVE

 1. Build the HTTPS front + the :80 redirect (both forwarding rules sit in the
    first-5 bracket, so this is the ~\$18/mo step):
      gcloud certificate-manager maps create nova-cert-map
      gcloud certificate-manager maps entries create nova-cert-map-entry \\
        --map=nova-cert-map --certificates=nova-cert --set-primary   # primary (catch-all) entry; --hostname takes a real FQDN, not '*'
      gcloud compute target-https-proxies create nova-https-proxy \\
        --url-map=nova-url-map --certificate-map=nova-cert-map
      gcloud compute forwarding-rules create nova-fr --global \\
        --target-https-proxy=nova-https-proxy --address=nova-lb-ip --ports=443
      # :80 -> 301 https (nova-http-proxy/nova-redirect-map already exist)
      gcloud compute forwarding-rules create nova-fr-http --global \\
        --target-http-proxy=nova-http-proxy --address=nova-lb-ip --ports=80

 2. VERIFY via the IP before touching DNS (cert + Armor + Cloud Run path):
      curl -sv --resolve commcare.app:443:${LB_IP} https://commcare.app/ -o /dev/null
   Confirm 200/expected, valid cert, and that a >60/min burst to
   /api/log/error returns 429.

 3. Cut GoDaddy DNS — point each host at the LB IP (apex needs an A record):
      commcare.app        A     ${LB_IP}
      mcp.commcare.app    A     ${LB_IP}
      docs.commcare.app   A     ${LB_IP}
   Wait for propagation; re-verify each host over real DNS.

 4. Remove the now-bypassed Cloud Run domain mappings:
      for d in ${DOMAINS[*]}; do
        gcloud beta run domain-mappings delete --domain="\$d" --region=${REGION} -q
      done

 5. Close the back door — make the LB the ONLY ingress (else the run.app URL
    bypasses Armor). Do this LAST, after DNS is verified through the LB:
      gcloud run services update ${SERVICE} --region=${REGION} \\
        --ingress=internal-and-cloud-load-balancing

================================================================
 Phase 3 — ROLLBACK (if the cutover misbehaves)
================================================================
 - Revert ingress:   gcloud run services update ${SERVICE} --region=${REGION} --ingress=all
 - Recreate mappings: gcloud beta run domain-mappings create --service=${SERVICE} \\
                        --domain=<host> --region=${REGION}   (per host)
 - Revert GoDaddy DNS to the prior targets (apex → Google's 216.239.3x.21 set;
   mcp/docs → ghs.googlehosted.com CNAME). The LB resources can stay; deleting
   the forwarding rules stops the \$18/mo:
      gcloud compute forwarding-rules delete nova-fr nova-fr-http --global -q
EOF
