"""
Platform Graph OBO proxy -- OFFLINE (unattended / cron) access.

Lets a project act on behalf of users when NO user is present -- a scheduled
job -- by remembering each user's platform session id (`sid`) and replaying it
against the proxy later. The proxy holds the Entra refresh token and silently
refreshes for up to ~30 days, so the cron keeps working without anyone logging
in.

WHEN YOU NEED THIS
  - Interactive (a user is in the app): you DON'T need this. The frontend sends
    X-Platform-Session and the backend calls call_graph_proxy(op, body, sid)
    from graph_proxy_backend.py. Done.
  - Unattended (no user present): you must REMEMBER the sid so a cron can use
    it. This stores it in SSM Parameter Store (SecureString) under
    /<project>/offline-sessions/<user_id> and replays it for each user.

PREREQUISITES
  1. The user signs in with offline access ON -- the frontend adds &offline=1 to
     /platform/auth/start (e.g. a "stay signed in" toggle). Without it the
     session is 1 hour and the cron stops after an hour. With it the proxy keeps
     the refresh token (~30-day session, silent refresh).
  2. Per-user consent for each scope the cron uses, granted once on the platform
     consent screen (interactively). Consent lasts ~30 days.
  3. IAM: the managed policy vibe-platform-vibe-project-offline-sessions is
     attached to your task role automatically by the platform deploy. It scopes
     ssm Put/Get/GetParametersByPath/Delete to /<project>/offline-sessions/* via
     your role's Project tag. Nothing for you to configure.

ZERO CONFIG (no env vars)
  - Project name is derived from the task-role ARN via STS.
  - Region comes from the ECS runtime; SecureString uses the default
    alias/aws/ssm key; credentials come from the task role.

SECURITY
  - Only the sid is stored -- an opaque pointer, never a token. The proxy holds
    the refresh token. A stored sid is bearer-equivalent to "act as this user,
    consented scopes only, <=30 days" AND only usable from THIS project's task
    role (the proxy binds sessions to the project). Sign-out / revoke kills it.
    Encrypted at rest (KMS via SSM); every read is logged in CloudTrail.

SETUP
  pip install boto3   # usually already present

USAGE (FastAPI)
  from graph_proxy_offline import enroll_offline, delete_enrollment, run_for_each_enrolled_user
  from graph_proxy_backend import call_graph_proxy
  from user_identity import get_user            # OIDC headers -> {"sub": ...}

  # 1. Enroll after an offline (&offline=1) sign-in: the frontend POSTs here
  #    with the X-Platform-Session header once it has a sid.
  @app.post("/api/offline/enroll")
  async def enroll(request: Request, x_platform_session: str = Header(...)):
      enroll_offline(get_user(request)["sub"], x_platform_session)
      return {"ok": True}

  # 2. Cron (e.g. APScheduler). Let proxy errors propagate -- the runner drops
  #    users whose session/consent is gone (401/403).
  async def nightly():
      async def task(user_id, sid):
          files = await call_graph_proxy("files/recent", {}, sid)
          # ...your work for this user.
      summary = await run_for_each_enrolled_user(task)
      print("[offline] cron summary", summary)
  # NOTE: run the scheduler on a SINGLE replica (or take a lock) so each user is
  # processed once, not once per running container.
"""

import functools
import re
from typing import Awaitable, Callable, Dict, List

import boto3

_ssm = boto3.client("ssm")
_sts = boto3.client("sts")


@functools.lru_cache(maxsize=1)
def get_project_name() -> str:
    """Derive this project's name from the task-role ARN -- the same identity the
    proxy uses for session-binding, so the SSM path matches the IAM grant."""
    arn = _sts.get_caller_identity()["Arn"]
    # arn:aws:sts::<acct>:assumed-role/vibe-<project>-task/<task-id>
    m = re.search(r"assumed-role/vibe-(.+?)-(?:vectordb-task|db-task|task)/", arn)
    if not m:
        raise RuntimeError(f"cannot derive project from caller ARN: {arn}")
    return m.group(1)


def _param_name(user_id: str) -> str:
    return f"/{get_project_name()}/offline-sessions/{user_id}"


def enroll_offline(user_id: str, sid: str) -> None:
    """Remember a user's offline session. Call from your enroll route after an
    offline (&offline=1) sign-in. user_id is the OIDC `sub`; sid is the
    X-Platform-Session value the frontend obtained."""
    if not user_id or not sid:
        raise ValueError("enroll_offline requires user_id and sid")
    _ssm.put_parameter(
        Name=_param_name(user_id), Value=sid, Type="SecureString", Overwrite=True
    )


def delete_enrollment(user_id: str) -> None:
    """Forget a user's offline session (on logout, or after a 401/403)."""
    try:
        _ssm.delete_parameter(Name=_param_name(user_id))
    except _ssm.exceptions.ParameterNotFound:
        pass


def list_enrolled() -> List[Dict[str, str]]:
    """List every enrolled {user_id, sid} for this project."""
    prefix = f"/{get_project_name()}/offline-sessions/"
    paginator = _ssm.get_paginator("get_parameters_by_path")
    users: List[Dict[str, str]] = []
    for page in paginator.paginate(Path=prefix, Recursive=True, WithDecryption=True):
        for p in page["Parameters"]:
            users.append({"user_id": p["Name"].split("/")[-1], "sid": p["Value"]})
    return users


async def run_for_each_enrolled_user(
    task: Callable[[str, str], Awaitable[None]],
) -> Dict[str, int]:
    """Run `await task(user_id, sid)` for every enrolled user. Use from your cron.

    If a user's proxy call raises 401 (session expired/revoked) or 403 (consent
    revoked), that user's enrollment is deleted and skipped -- they re-enroll the
    next time they use the app interactively. Other errors are counted but don't
    drop the user. Returns {"ran", "dropped", "failed"}.
    """
    summary = {"ran": 0, "dropped": 0, "failed": 0}
    for u in list_enrolled():
        try:
            await task(u["user_id"], u["sid"])
            summary["ran"] += 1
        except Exception as e:  # noqa: BLE001 -- per-user isolation
            if getattr(e, "status_code", None) in (401, 403):
                delete_enrollment(u["user_id"])
                summary["dropped"] += 1
            else:
                summary["failed"] += 1
    return summary
