#!/usr/bin/env python3
"""Dump a FastAPI app's real route table as JSON behind a marker.

Usage: dump_fastapi_routes.py <backend_dir> <module:attr>

FastAPI exposes the route table natively (app.routes), so there's no parsing —
we import the app object and read it. Best-effort: any failure prints nothing
and exits non-zero, and the caller treats that as introspection unavailable
(fail-open). Like the Express dumper, the result is emitted behind a unique
marker so the app's own stdout noise is ignored.
"""
import importlib
import json
import os
import sys

MARKER = "__DD_ROUTES__"


def main():
    if len(sys.argv) < 3:
        sys.exit(2)
    backend_dir, target = sys.argv[1], sys.argv[2]
    module_name, _, attr = target.partition(":")
    attr = attr or "app"
    sys.path.insert(0, backend_dir)
    os.chdir(backend_dir)
    try:
        mod = importlib.import_module(module_name)
        app = getattr(mod, attr)
    except Exception:
        sys.exit(1)  # import / missing app → fail-open

    out = []
    try:
        for r in getattr(app, "routes", []):
            path = getattr(r, "path", None)
            methods = getattr(r, "methods", None)
            if not path or not methods:
                continue
            for m in methods:
                if m.upper() in ("HEAD", "OPTIONS"):
                    continue  # auto-added by FastAPI, not real endpoints
                out.append({"method": m.upper(), "path": path})
    except Exception:
        sys.exit(1)

    sys.stdout.write("\n" + MARKER + json.dumps(out) + "\n")


if __name__ == "__main__":
    main()
