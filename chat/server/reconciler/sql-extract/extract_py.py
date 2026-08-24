#!/usr/bin/env python3
"""Extract static SQL query literals from Python backend source.

Uses the stdlib `ast` module — the standard way to parse Python — so comments,
log strings, f-strings, and concatenated SQL are correctly distinguished from
real query literals (regex can't). Emits JSON to stdout:
    [{"sql": "...", "file": "...", "line": N}, ...]

Matches asyncpg (fetch/fetchrow/fetchval/fetchmany/execute/executemany) and
psycopg (cursor.execute/executemany) call sites. Only a string-constant first
argument is extracted; f-strings (JoinedStr) and concatenation (BinOp) are
dynamic → skipped (fail-open). Placeholder normalization (%s -> $n) happens on
the Node side.

Usage: extract_py.py <backend_dir>
"""
import ast
import json
import os
import sys

QUERY_METHODS = {"fetch", "fetchrow", "fetchval", "fetchmany", "execute", "executemany"}
SKIP_DIRS = {"__pycache__", "node_modules", "venv", ".venv", "dist", "build"}


def first_str_arg(call):
    if not call.args:
        return None
    a = call.args[0]
    if isinstance(a, ast.Constant) and isinstance(a.value, str):
        return a.value
    return None  # f-string / concat / variable → dynamic, skip


def receiver_name(call):
    # The object the query method is called on: `pool` in `pool.fetch(...)`,
    # or `vector_pool` in `self.vector_pool.fetch(...)`. Used to route the
    # query to the right schema (relational vs vector). None when it isn't a
    # plain name (→ 'unknown', validated against every available schema).
    val = call.func.value
    if isinstance(val, ast.Name):
        return val.id
    if isinstance(val, ast.Attribute):
        return val.attr
    return None


def visit_file(path, out):
    try:
        with open(path, "r", encoding="utf-8") as f:
            src = f.read()
    except Exception:
        return
    try:
        tree = ast.parse(src, filename=path)
    except Exception:
        return  # unparseable → fail-open
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) \
                and node.func.attr in QUERY_METHODS:
            sql = first_str_arg(node)
            if sql and sql.strip():
                out.append({
                    "sql": sql,
                    "file": path,
                    "line": getattr(node, "lineno", 0),
                    "receiver": receiver_name(node),
                })


def walk(root):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".") and d not in SKIP_DIRS]
        for fn in filenames:
            if fn.endswith(".py"):
                yield os.path.join(dirpath, fn)


def main():
    out = []
    if len(sys.argv) >= 2 and os.path.isdir(sys.argv[1]):
        for p in walk(sys.argv[1]):
            visit_file(p, out)
    sys.stdout.write(json.dumps(out))


if __name__ == "__main__":
    main()
