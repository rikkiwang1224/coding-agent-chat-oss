#!/usr/bin/env bash
# Shared helpers: load repo .env, resolve CVM instance id, call tccli.
#
# Expected .env keys (all optional if exported in the shell already):
#   TENCENTCLOUD_SECRET_ID
#   TENCENTCLOUD_SECRET_KEY
#   TENCENT_ECS_REGION          e.g. ap-guangzhou
#   TENCENT_ECS_INSTANCE_ID     e.g. ins-xxxxxxxx (preferred)
#   ECS_IP                      used to look up instance id when ID omitted

_ecs_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

resolve_env_file() {
  if [[ -n "${FORGELET_ENV_FILE:-}" && -f "${FORGELET_ENV_FILE}" ]]; then
    echo "${FORGELET_ENV_FILE}"
    return 0
  fi

  local repo_root
  repo_root="$(cd "$_ecs_lib_dir/../../.." && pwd)"
  if [[ -f "$repo_root/.env" ]]; then
    echo "$repo_root/.env"
    return 0
  fi

  local sibling
  sibling="$(cd "$repo_root/.." && pwd)/coding-agent-chat-oss/.env"
  if [[ -f "$sibling" ]]; then
    echo "$sibling"
    return 0
  fi

  return 1
}

# Load .env without overriding variables already set in the shell.
load_ecs_env() {
  local env_file=""
  env_file="$(resolve_env_file)" || true
  if [[ -z "$env_file" ]]; then
    return 0
  fi

  local line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" != *=* ]] && continue

    key="${line%%=*}"
    key="${key%"${key##*[![:space:]]}"}"
    value="${line#*=}"
    value="${value#"${value%%[![:space:]]*}"}"

    if [[ "$value" == \"*\" && "$value" == *\" ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
      value="${value:1:${#value}-2}"
    fi

    if [[ -n "$key" && -z "${!key+x}" ]]; then
      export "$key=$value"
    fi
  done < "$env_file"
}

require_tccli() {
  if command -v tccli >/dev/null 2>&1; then
    return 0
  fi
  echo "error: tccli not found. Install: pip3 install tccli" >&2
  echo "  then configure TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY in .env" >&2
  exit 1
}

require_tencent_credentials() {
  if [[ -z "${TENCENTCLOUD_SECRET_ID:-}" || -z "${TENCENTCLOUD_SECRET_KEY:-}" ]]; then
    echo "error: set TENCENTCLOUD_SECRET_ID and TENCENTCLOUD_SECRET_KEY in .env" >&2
    exit 1
  fi
}

require_region() {
  if [[ -z "${TENCENT_ECS_REGION:-}" ]]; then
    echo "error: set TENCENT_ECS_REGION in .env (e.g. ap-guangzhou, ap-shanghai)" >&2
    exit 1
  fi
}

resolve_instance_id() {
  if [[ -n "${TENCENT_ECS_INSTANCE_ID:-}" ]]; then
    echo "$TENCENT_ECS_INSTANCE_ID"
    return 0
  fi

  if [[ -z "${ECS_IP:-}" ]]; then
    echo "error: set TENCENT_ECS_INSTANCE_ID or ECS_IP in .env" >&2
    exit 1
  fi

  require_tccli
  require_tencent_credentials
  require_region

  local json instance_id
  json="$(tccli cvm DescribeInstances \
    --region "$TENCENT_ECS_REGION" \
    --Filters "[{\"Name\":\"public-ip-address\",\"Values\":[\"${ECS_IP}\"]}]" \
    --output json 2>/dev/null)" || {
    echo "error: DescribeInstances failed (check region, credentials, ECS_IP=${ECS_IP})" >&2
    exit 1
  }

  if ! command -v jq >/dev/null 2>&1; then
    echo "error: jq required to resolve instance id from ECS_IP" >&2
    exit 1
  fi

  instance_id="$(echo "$json" | jq -r '.InstanceSet[0].InstanceId // empty')"
  if [[ -z "$instance_id" || "$instance_id" == "null" ]]; then
    echo "error: no CVM found for ECS_IP=${ECS_IP} in region ${TENCENT_ECS_REGION}" >&2
    exit 1
  fi

  echo "$instance_id"
}

describe_instance_state() {
  local instance_id="$1"
  tccli cvm DescribeInstances \
    --region "$TENCENT_ECS_REGION" \
    --InstanceIds "[\"${instance_id}\"]" \
    --output json \
    | jq -r '.InstanceSet[0].InstanceState // "UNKNOWN"'
}

wait_for_instance_state() {
  local instance_id="$1"
  local want="$2"
  local timeout="${3:-300}"
  local elapsed=0 state

  while (( elapsed < timeout )); do
    state="$(describe_instance_state "$instance_id")"
    if [[ "$state" == "$want" ]]; then
      echo "$state"
      return 0
    fi
    if [[ "$state" == "LAUNCH_FAILED" || "$state" == "SHUTDOWN" ]]; then
      echo "error: instance ${instance_id} entered ${state}" >&2
      return 1
    fi
    sleep 5
    elapsed=$((elapsed + 5))
    echo "  … state=${state}, waiting for ${want} (${elapsed}s)" >&2
  done

  echo "error: timed out waiting for ${want} (last state=${state})" >&2
  return 1
}
