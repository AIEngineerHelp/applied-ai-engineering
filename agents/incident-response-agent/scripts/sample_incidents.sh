#!/usr/bin/env bash
# Send realistic sample incidents to the agent. Each points at a Loghub sample dataset
# (label "dataset") whose logs contain the matching failure.
#
#   scripts/sample_incidents.sh            # send all
#   scripts/sample_incidents.sh 2 5        # send only #2 and #5
#
# Env: API_URL (default http://localhost:8000), TOKEN (bearer token when AUTH_MODE=oidc;
# an INTAKE_TOKENS value works too), DRY_RUN=1 prints the JSON instead of sending.
# Each incident costs a few cents of LLM usage.
set -euo pipefail

API_URL="${API_URL:-http://localhost:8000}"
RUN_ID="$(date +%s)"   # unique external ids so re-runs create new incidents

incident() {
  cat <<EOF
{"source": "alertmanager", "external_id": "demo-$1-$RUN_ID", "title": "$2",
 "description": "$3", "service": "$4", "severity": "$5", "environment": "prod",
 "labels": {"dataset": "$6", "alertname": "$7"}}
EOF
}

payload() {
  case "$1" in
    1) incident 1 "BGL rack R02-M1 compute nodes throwing TLB and storage interrupts" \
         "Jobs on midplane R02-M1 are aborting. RAS stream shows repeated data TLB error interrupts and data storage interrupts on several compute nodes since 06:00." \
         "bgl-compute" "sev1" "BGL" "NodeInterruptStorm" ;;
    2) incident 2 "Hadoop MapReduce jobs stuck: containers cannot reach ResourceManager" \
         "Map tasks are retrying repeatedly and jobs are not completing. Node managers report lease renewal failures." \
         "hadoop-yarn" "sev2" "Hadoop" "YarnTaskRetries" ;;
    3) incident 3 "ZooKeeper quorum unstable: followers dropping connections" \
         "Clients see session expirations. Quorum peers log broken connections and interrupted send workers." \
         "zookeeper-quorum" "sev2" "Zookeeper" "ZkQuorumFlapping" ;;
    4) incident 4 "Spike in SSH authentication failures on bastion hosts" \
         "Security alert: thousands of failed SSH password attempts from external addresses in the last hour. Possible brute-force attempt." \
         "bastion-ssh" "sev2" "OpenSSH" "SshAuthFailureSpike" ;;
    5) incident 5 "Apache web tier: mod_jk workers in error state" \
         "Users get intermittent 503 errors. Apache logs report mod_jk child workers in error state and missing scoreboard entries." \
         "web-frontend" "sev3" "Apache" "Http5xxRate" ;;
    6) incident 6 "HDFS DataNodes throwing exceptions while serving blocks" \
         "Readers see slow or failed block reads. DataNodes log exceptions while serving blocks to clients." \
         "hdfs-datanode" "sev3" "HDFS" "HdfsReadErrors" ;;
    *) echo "unknown incident $1 (1-6)" >&2; return 1 ;;
  esac
}

auth=()
[[ -n "${TOKEN:-}" ]] && auth=(-H "Authorization: Bearer $TOKEN")

for n in "${@:-1 2 3 4 5 6}"; do
  for i in $n; do
    body="$(payload "$i")"
    if [[ -n "${DRY_RUN:-}" ]]; then echo "$body"; continue; fi
    resp="$(curl -sS -X POST "$API_URL/v1/incidents" -H 'Content-Type: application/json' \
      ${auth[@]+"${auth[@]}"} -d "$body")"
    echo "$resp" | N="$i" python3 -c '
import json, os, sys
d = json.load(sys.stdin)
if "id" not in d:
    sys.exit("#%s failed: %s" % (os.environ["N"], d))
print("#%s %s %-9s %s  %s" % (os.environ["N"], d["severity"], d["status"], d["id"], d["title"]))'
  done
done
[[ -n "${DRY_RUN:-}" ]] || echo "Open the UI (http://localhost:3000) to watch them run."
