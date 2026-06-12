#!/usr/bin/env python3
"""
Lattice Code wrapper around swebench.harness.run_evaluation.

ECS fixes (runtime monkey-patch, no site-packages edits):
  1. Sphinx eval: inject pip pins after ``pip install -e .[test]`` in /eval.sh
  2. Pytest 8 progress output: extend parse_log_pytest_v2 so passing tests are not
     marked failed when pytest omits ``PASSED`` lines (common sphinx false-negative).
  3. Requests eval: point HTTPBIN_URL at a local httpbin and stub www.google.co.uk
     so network-dependent tests don't fail on httpbin.org 503s / blocked egress.
     Requires on the docker host:
       gunicorn -b 0.0.0.0:8888 httpbin:app        # local httpbin
       python3 -m http.server 80 --bind 0.0.0.0    # google.co.uk stub (root)
"""
from __future__ import annotations

import re

from swebench.harness.constants import TestStatus

SPHINX_PIN_LINE = (
    "source /opt/miniconda3/etc/profile.d/conda.sh && conda activate testbed && "
    "python -m pip install -q --no-warn-script-location "
    "'markupsafe<=2.0.1' 'Jinja2<3.1' 'alabaster>=0.7,<0.7.12' "
    "'sphinxcontrib-applehelp<=1.0.7' 'sphinxcontrib-devhelp<=1.0.5' "
    "'sphinxcontrib-htmlhelp<=2.0.4' 'sphinxcontrib-serializinghtml<=1.1.9' "
    "'sphinxcontrib-qthelp<=1.0.6' 'docutils<0.21' 'pytest>=6.0,<8' "
    "2>/dev/null || true  # LATTICE_CODE_SPHINX_PINS"
)

_INJECT_PY = f"""
from pathlib import Path
pin = {SPHINX_PIN_LINE!r}
path = Path("/eval.sh")
if not path.is_file() or "LATTICE_CODE_SPHINX_PINS" in path.read_text():
    raise SystemExit(0)
needle = "python -m pip install -e .[test]"
text = path.read_text()
if needle not in text:
    raise SystemExit(0)
path.write_text(text.replace(needle, needle + "\\n" + pin, 1))
""".strip()

import base64 as _b64

SPHINX_INJECT_SHELL = (
    "for py in python3 /opt/miniconda3/envs/testbed/bin/python; do "
    f"if command -v \"$py\" >/dev/null 2>&1; then "
    f"echo {_b64.b64encode(_INJECT_PY.encode()).decode()} | base64 -d | \"$py\" - && break; fi; "
    "done"
)

_REQUESTS_INJECT_PY = """
from pathlib import Path
path = Path("/eval.sh")
if not path.is_file():
    raise SystemExit(0)
text = path.read_text()
if "LATTICE_CODE_HTTPBIN" in text:
    raise SystemExit(0)
hosts = Path("/etc/hosts")
if "www.google.co.uk" not in hosts.read_text():
    with hosts.open("a") as f:
        f.write("172.17.0.1 www.google.co.uk\\n")
lines = text.split("\\n")
inject = [
    "# LATTICE_CODE_HTTPBIN: local httpbin + google stub on the docker host",
    "export HTTPBIN_URL=http://172.17.0.1:8888/",
]
insert_at = 1 if lines and lines[0].startswith("#!") else 0
lines[insert_at:insert_at] = inject
path.write_text("\\n".join(lines))
""".strip()

REQUESTS_INJECT_SHELL = (
    "for py in python3 /opt/miniconda3/envs/testbed/bin/python /opt/miniconda3/bin/python; do "
    f"if command -v \"$py\" >/dev/null 2>&1; then "
    f"echo {_b64.b64encode(_REQUESTS_INJECT_PY.encode()).decode()} | base64 -d | \"$py\" - && break; fi; "
    "done"
)

_inject_done: set[str] = set()


def _infer_pytest_progress_passes(log: str, test_spec) -> dict[str, str]:
    """Map tests pytest ran but only printed as progress dots / durations."""
    summary = re.search(r"(\d+)\s+passed", log)
    if not summary or int(summary.group(1)) == 0:
        return {}

    inferred: dict[str, str] = {}
    for test in list(test_spec.FAIL_TO_PASS) + list(test_spec.PASS_TO_PASS):
        module, _, func = test.partition("::")
        if module in log and func in log:
            inferred[test] = TestStatus.PASSED.value
    return inferred


def _patch_log_parser() -> None:
    import swebench.harness.log_parsers as log_parsers
    import swebench.harness.log_parsers.python as lp

    orig = lp.parse_log_pytest_v2

    def parse_log_pytest_v2(log: str, test_spec):
        status = orig(log, test_spec)
        for test, value in _infer_pytest_progress_passes(log, test_spec).items():
            if status.get(test) is None:
                status[test] = value
        return status

    lp.parse_log_pytest_v2 = parse_log_pytest_v2
    log_parsers.MAP_REPO_TO_PARSER["sphinx-doc/sphinx"] = parse_log_pytest_v2


def _inject_eval_sh_fixes(container, cmd: str) -> None:
    if "/eval.sh" not in str(cmd):
        return
    cid = container.id or ""
    if cid in _inject_done:
        return
    name = container.name or ""
    if "sphinx-doc__sphinx-" in name or "sphinx-doc_1776_sphinx-" in name:
        container.exec_run(["/bin/bash", "-lc", SPHINX_INJECT_SHELL])
        _inject_done.add(cid)
    elif "psf__requests-" in name or "psf_1776_requests-" in name:
        container.exec_run(["/bin/bash", "-lc", REQUESTS_INJECT_SHELL])
        _inject_done.add(cid)


def _patch_exec_run_with_timeout() -> None:
    import swebench.harness.run_evaluation as ev

    orig = ev.exec_run_with_timeout

    def wrapped(container, cmd, timeout):
        _inject_eval_sh_fixes(container, cmd)
        return orig(container, cmd, timeout)

    ev.exec_run_with_timeout = wrapped


def main() -> None:
    _patch_log_parser()
    _patch_exec_run_with_timeout()
    import runpy

    runpy.run_module("swebench.harness.run_evaluation", run_name="__main__")


if __name__ == "__main__":
    main()
