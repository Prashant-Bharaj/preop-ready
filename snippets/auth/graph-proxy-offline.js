/**
 * Platform Graph OBO proxy — OFFLINE (unattended / cron) access.
 *
 * Lets a project act on behalf of users when NO user is present — a scheduled
 * job — by remembering each user's platform session id (`sid`) and replaying it
 * against the proxy later. The proxy holds the Entra refresh token and silently
 * refreshes for up to ~30 days, so the cron keeps working without anyone
 * logging in.
 *
 * WHEN YOU NEED THIS
 *   - Interactive (a user is in the app): you DON'T need this. The frontend
 *     sends `X-Platform-Session` and the backend calls
 *     `callGraphProxy(op, body, sid)` from graph-proxy-backend.js. Done.
 *   - Unattended (no user present — nightly summary, polling, etc.): you must
 *     REMEMBER the sid so a cron can use it. This snippet stores it in SSM
 *     Parameter Store (SecureString) under /<project>/offline-sessions/<userId>
 *     and replays it for each user.
 *
 * PREREQUISITES
 *   1. The user signs in with offline access ON — the frontend adds `&offline=1`
 *      to /platform/auth/start (e.g. a "stay signed in" toggle). Without it the
 *      session is 1 hour and the cron stops working after an hour. With it the
 *      proxy keeps the refresh token (~30-day session, silent refresh).
 *   2. Per-user consent for each scope the cron uses, granted once on the
 *      platform consent screen (interactively). Consent lasts ~30 days.
 *   3. IAM: the managed policy `vibe-platform-vibe-project-offline-sessions` is
 *      attached to your task role automatically by the platform deploy. It
 *      scopes ssm Put/Get/GetParametersByPath/Delete to /<project>/offline-sessions/*
 *      via your role's Project tag. Nothing for you to configure.
 *
 * ZERO CONFIG (no env vars)
 *   - Project name is derived from the task-role ARN via STS.
 *   - Region comes from the ECS runtime; SecureString uses the default
 *     alias/aws/ssm key; credentials come from the task role.
 *
 * SECURITY
 *   - Only the `sid` is stored — an opaque pointer, never a token. The proxy
 *     holds the refresh token. A stored sid is bearer-equivalent to "act as this
 *     user, consented scopes only, ≤30 days" AND is only usable from THIS
 *     project's task role (the proxy binds sessions to the project). A user
 *     sign-out / revoke kills it immediately. Encrypted at rest (KMS via SSM);
 *     every read is logged in CloudTrail.
 *
 * SETUP
 *   npm i @aws-sdk/client-ssm @aws-sdk/client-sts
 *
 * USAGE
 *   const { enrollOffline, deleteEnrollment, runForEachEnrolledUser } = require('./graph-proxy-offline')
 *   const { callGraphProxy } = require('./graph-proxy-backend')
 *   const { getUser } = require('./user-identity')   // OIDC headers -> { sub, ... }
 *
 *   // 1. Enroll: call after an offline (&offline=1) sign-in. The frontend POSTs
 *   //    here with the X-Platform-Session header once it has a sid.
 *   app.post('/offline/enroll', async (req, res) => {
 *     const sid = req.headers['x-platform-session']
 *     const { sub } = getUser(req)               // user id from ALB OIDC headers
 *     await enrollOffline(sub, sid)
 *     res.json({ ok: true })
 *   })
 *   app.post('/offline/unenroll', async (req, res) => {
 *     await deleteEnrollment(getUser(req).sub); res.json({ ok: true })
 *   })
 *
 *   // 2. Cron: do the per-user work. Let proxy errors propagate — the runner
 *   //    drops users whose session/consent is gone (401/403).
 *   const cron = require('node-cron')
 *   cron.schedule('0 6 * * *', async () => {
 *     const summary = await runForEachEnrolledUser(async (userId, sid) => {
 *       const files = await callGraphProxy('files/recent', {}, sid)
 *       // ...your work for this user: summarize, store, email, etc.
 *     })
 *     console.log('[offline] cron summary', summary)
 *   })
 *   // NOTE: run the scheduler on a SINGLE replica (or take a lock) so each user
 *   // is processed once, not once per running container.
 */

const {
  SSMClient,
  PutParameterCommand,
  GetParametersByPathCommand,
  DeleteParameterCommand,
} = require('@aws-sdk/client-ssm')
const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts')

const ssm = new SSMClient({})
const sts = new STSClient({})

let _project
// Derive this project's name from the task-role ARN — the same identity the
// proxy uses for session-binding, so the SSM path always matches the IAM grant.
async function getProjectName() {
  if (_project) return _project
  const { Arn } = await sts.send(new GetCallerIdentityCommand({}))
  // arn:aws:sts::<acct>:assumed-role/vibe-<project>-task/<task-id>
  const m = (Arn || '').match(/assumed-role\/vibe-(.+?)-(?:vectordb-task|db-task|task)\//)
  if (!m) throw new Error(`cannot derive project from caller ARN: ${Arn}`)
  _project = m[1]
  return _project
}

async function paramName(userId) {
  return `/${await getProjectName()}/offline-sessions/${userId}`
}

/**
 * Remember a user's offline session. Call from your enroll route after an
 * offline (&offline=1) sign-in. `userId` is the user's OIDC `sub`; `sid` is the
 * X-Platform-Session value the frontend obtained.
 */
async function enrollOffline(userId, sid) {
  if (!userId || !sid) throw new Error('enrollOffline requires userId and sid')
  await ssm.send(
    new PutParameterCommand({
      Name: await paramName(userId),
      Value: sid,
      Type: 'SecureString',
      Overwrite: true,
    }),
  )
}

/** Forget a user's offline session (on logout, or after a 401/403 from the proxy). */
async function deleteEnrollment(userId) {
  try {
    await ssm.send(new DeleteParameterCommand({ Name: await paramName(userId) }))
  } catch (e) {
    if (e.name !== 'ParameterNotFound') throw e
  }
}

/** List every enrolled { userId, sid } for this project. */
async function listEnrolled() {
  const path = `/${await getProjectName()}/offline-sessions/`
  const out = []
  let token
  do {
    const r = await ssm.send(
      new GetParametersByPathCommand({
        Path: path,
        Recursive: true,
        WithDecryption: true,
        NextToken: token,
      }),
    )
    for (const p of r.Parameters || []) {
      out.push({ userId: p.Name.split('/').pop(), sid: p.Value })
    }
    token = r.NextToken
  } while (token)
  return out
}

/**
 * Run `task(userId, sid)` for every enrolled user. Use from your cron.
 *
 * If a user's proxy call throws 401 (session expired/revoked) or 403 (consent
 * revoked), that user's enrollment is deleted and skipped — they re-enroll the
 * next time they use the app interactively. Other errors are logged and counted
 * but don't drop the user. Returns { ran, dropped, failed }.
 */
async function runForEachEnrolledUser(task) {
  const users = await listEnrolled()
  const summary = { ran: 0, dropped: 0, failed: 0 }
  for (const { userId, sid } of users) {
    try {
      await task(userId, sid)
      summary.ran++
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        await deleteEnrollment(userId)
        summary.dropped++
      } else {
        console.error(`[offline] task failed for ${userId}: ${e.message}`)
        summary.failed++
      }
    }
  }
  return summary
}

module.exports = {
  enrollOffline,
  deleteEnrollment,
  listEnrolled,
  runForEachEnrolledUser,
  getProjectName,
}
