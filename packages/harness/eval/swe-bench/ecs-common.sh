#!/usr/bin/env bash
# Shared ECS helpers for SWE-bench agent batch + official eval harness.
# Source from docker-batch.sh, run-eval-ecs.sh, ecs-preflight.sh — do not execute directly.

# Mac pproxy reverse tunnel (see start-mac-tunnel.sh). Used for GitHub / HuggingFace during eval.
ECS_EVAL_PROXY="${ECS_EVAL_PROXY:-http://127.0.0.1:7890}"

ecs_export_eval_proxy() {
  export http_proxy="${ECS_EVAL_PROXY}"
  export https_proxy="${ECS_EVAL_PROXY}"
  export HTTP_PROXY="${ECS_EVAL_PROXY}"
  export HTTPS_PROXY="${ECS_EVAL_PROXY}"
  export NO_PROXY="${NO_PROXY:-localhost,127.0.0.1,mirror.ccs.tencentyun.com}"
}

# Same pins as docker-batch.sh — SWE-bench sphinx images break when PyPI serves newer deps.
# pytest>=8 uses progress-only output; swebench parse_log_pytest_v2 expects PASSED/FAIL lines.
ecs_sphinx_pip_install_cmd() {
  cat <<'EOS'
source /opt/miniconda3/etc/profile.d/conda.sh && conda activate testbed && pip install -q --no-warn-script-location \
  'markupsafe<=2.0.1' \
  'Jinja2<3.1' \
  'alabaster>=0.7,<0.7.12' \
  'sphinxcontrib-applehelp<=1.0.7' \
  'sphinxcontrib-devhelp<=1.0.5' \
  'sphinxcontrib-htmlhelp<=2.0.4' \
  'sphinxcontrib-serializinghtml<=1.1.9' \
  'sphinxcontrib-qthelp<=1.0.6' \
  'docutils<0.21' \
  'pytest>=6.0,<8' \
  2>/dev/null || true
EOS
}

ecs_is_sphinx_instance() {
  [[ "${1:-}" == sphinx-doc__sphinx-* ]]
}
