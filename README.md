# Self-Service Portal

A self-service web portal that lets approved users trigger parameterized Jenkins jobs
for infrastructure and application workflows, then watch the queue/build status live —
without needing direct Jenkins access.

Built as a generic, reusable template: every job definition, environment variable, and
URL in this repo is a placeholder (`jenkins.example.com`, `registry.example.com`, and so
on), so it can be pointed at any Jenkins instance.

## Features

- Login-protected dashboard with brute-force-limited sign-in
- Role-based access: **admin** and **developer** accounts, managed from an in-app Users screen (create, change password, disable/enable, delete)
- Approval workflow: developer submissions wait for admin approval before anything reaches Jenkins; admins can approve (runs immediately) or decline (with an optional reason) from an Approvals queue with a live pending-count badge
- Angular 18 standalone-component frontend, plain Node.js backend (no framework), SQLite for storage (no separate database server)
- Searchable, filterable workflow catalog grouped by category (Applications, Kubernetes, Networking, Security, Access)
- Forms for application deployment, namespace bootstrap, Route53/Nginx, security group rules, and EC2 user management
- Jenkins `buildWithParameters` integration with automatic job discovery
- Live Jenkins queue/build status polling with an animated progress bar and toast notifications
- Confirmation step before submitting destructive requests (removing access, deleting DNS records, etc.)
- Per-user run history as a dense audit-log table with expandable rows (last 7 days, auto-pruned, with a manual "Clear History" action and per-entry delete)
- Sidebar navigation (collapses to an off-canvas drawer on mobile) with quick category filters and breadcrumbs
- Auto sign-out after 15 minutes of inactivity, with a warning toast before it happens
- Light/dark theme with no flash-of-wrong-theme on load, a single inline SVG icon set (no icon font/CDN)
- Docker and Kubernetes ready, with a container healthcheck

## Tech Stack

- **Frontend:** Angular 18 (standalone components, no Angular Material — hand-rolled CSS)
- **Backend:** Node.js `http` server, no Express — a single `server.js`
- **Storage:** SQLite via `better-sqlite3` (one file, no separate database server)
- **Auth:** Signed, HttpOnly session cookie (HMAC-SHA256); the cookie only carries the
  username, so the live role/disabled state is always re-checked against the database

## Required Environment Variables

```text
SESSION_SECRET       long random string used to sign login cookies
ADMIN_USERNAME       fallback local admin username
ADMIN_PASSWORD       fallback local admin password
JENKINS_URL          https://jenkins.example.com
JENKINS_USER         Jenkins username
JENKINS_API_TOKEN    Jenkins API token
```

The app can start without Jenkins variables, but Jenkins actions will fail with a configuration message until these values are set. See [`.env.example`](.env.example) for a copy-pasteable list.

Optional:

```text
APP_NAME             page title
JENKINS_JOB_PREFIX   Jenkins folder path, for example self-service
JENKINS_JOB_DISCOVERY auto-search Jenkins folders for jobs, default true
USERS_JSON           JSON user list with password or passwordHash, used to seed the database
JOB_NAME_OVERRIDES   JSON map when Jenkins job names differ from defaults
SECURITY_GROUPS_JSON JSON array of "name - sg-id" strings for the Security Group dropdown
HOSTED_ZONES_JSON    JSON array of "domain - zone-id" strings for the Hosted Zone ID dropdown
DB_PATH              SQLite file path, default ./data/portal.db
```

Without `SECURITY_GROUPS_JSON`, the Security Group dropdown falls back to a few placeholder
entries. This list is intentionally not hardcoded to any real AWS account — set the env var
to your own approved security groups (never commit real security group IDs to source control).

Example `SECURITY_GROUPS_JSON`:

```json
["app-sg - sg-0123456789abcdef0", "db-sg - sg-0fedcba9876543210", "mgmt-sg - sg-0aabbccddeeff0011"]
```

Example `USERS_JSON`. `role` is `"admin"` or `"developer"` (defaults to `"developer"` if omitted); at
least one enabled admin must exist at startup or the app refuses to start:

```json
{
  "users": [
    {
      "username": "devops",
      "displayName": "DevOps",
      "passwordHash": "sha256-hex-value",
      "role": "admin"
    },
    {
      "username": "jdoe",
      "displayName": "Jane Doe",
      "passwordHash": "sha256-hex-value",
      "role": "developer"
    }
  ]
}
```

The `ADMIN_USERNAME`/`ADMIN_PASSWORD` fallback account is always created with `role: "admin"`.
`USERS_JSON`/`ADMIN_USERNAME` only seed the database the first time it is empty — on later
restarts they are ignored, and the database is authoritative. Manage users from the in-app
**Users** screen (create, change password, disable/enable, delete) once signed in as an admin;
those changes persist in SQLite just like everything else.

### Roles and the approval workflow

- **admin** — full access: runs any workflow immediately, manages users, and approves or
  declines requests submitted by developers.
- **developer** — can submit any workflow, but the request is held as "Pending Approval" and
  does not call Jenkins until an admin approves it from the **Approvals** screen. A declined
  request never reaches Jenkins; the developer sees the decline (and reason, if given) on the
  request page and in Run History.

Example `JOB_NAME_OVERRIDES`.

The key can be the portal card id or the default Jenkins job name. The value is the actual Jenkins job path/name.

```json
{
  "app-deployment": "app-deployment-v2",
  "app-deployment-v2": "app-deployment-v2",
  "route53-record": "infra-route53-record",
  "namespace-bootstrap": "app-argocd-project-bootstrap"
}
```

If the Jenkins job was created using the self-service automation filename as the job name, use:

```json
{
  "route53-record": "Jenkinsfile.infra-route53-record"
}
```

If the Jenkins job is inside a folder, set `JENKINS_JOB_PREFIX` instead:

```text
JENKINS_JOB_PREFIX=self-service
```

For example, with `JENKINS_JOB_PREFIX=self-service` and job `app-deployment-v2`, the portal calls:

```text
https://jenkins.example.com/job/self-service/job/app-deployment-v2/buildWithParameters
```

The portal also auto-discovers Jenkins jobs by default. If the configured path is not found, it searches Jenkins folders for a matching job name. To disable this behavior:

```text
JENKINS_JOB_DISCOVERY=false
```

You can also point a single portal card to an exact Jenkins path or full URL:

```json
{
  "route53-record": "webhooks/infra-route53-record",
  "namespace-bootstrap": "job/platform/job/app-argocd-project-bootstrap",
  "app-deployment": "https://jenkins.example.com/job/devops/job/app-deployment-v2"
}
```

Generate a password hash:

```bash
printf '%s' 'your-password' | sha256sum
```

## Run With Docker

```bash
docker build -t self-service-portal .
docker run --rm -p 8080:8080 \
  -v self-service-data:/app/data \
  -e SESSION_SECRET='change-me-long-random' \
  -e ADMIN_USERNAME='admin' \
  -e ADMIN_PASSWORD='change-me' \
  -e JENKINS_URL='https://jenkins.example.com' \
  -e JENKINS_USER='jenkins-user' \
  -e JENKINS_API_TOKEN='jenkins-token' \
  self-service-portal
```

The `-v self-service-data:/app/data` volume is where the SQLite database lives. Skip it and
the database still works, but users/history/approvals reset every time the container is
recreated.

## Run Locally Without Docker

```bash
npm install
npm run build
npm start
```

Open:

```text
http://localhost:8080
```

Without `JENKINS_URL`/`JENKINS_USER`/`JENKINS_API_TOKEN` set, you can still sign in and browse
the workflow catalog and forms — submitting a request will just return a clear "Jenkins is not
configured" error instead of calling a real Jenkins server.

Run history lives in the same SQLite database as users, scoped per logged-in user, capped at
200 entries, and pruned after 7 days. It survives restarts as long as `DB_PATH` points at a
persistent location (the default `./data/portal.db`, or the mounted volume in Docker/Kubernetes).

## Kubernetes

The app reads its configuration from environment variables/secrets, so it deploys with a
standard Deployment + Service + Ingress and can be wired into whatever secret manager (Vault,
Sealed Secrets, External Secrets, etc.) your cluster already uses. Every variable in this
README — including `SECURITY_GROUPS_JSON` — is a plain env var, so it doesn't matter whether
it comes from an `ExternalSecret` synced from Vault, a plain Kubernetes `Secret`, or a local
`.env` file; the app doesn't know or care.

The one thing the app is **not** stateless about is `/app/data`, where the SQLite database
lives. Mount a `PersistentVolumeClaim` at that path (`ReadWriteOnce` is enough — this app is
a single replica; SQLite does not support multiple writers across pods) so users, run history,
and pending approvals survive pod restarts and redeploys. Without a PVC, `/app/data` is just
container-local disk and resets on every new pod.

## Project Structure

```text
server.js            Node HTTP server: auth, job definitions, Jenkins API proxy, SQLite storage
data/                 SQLite database file (created on first run, gitignored)
src/main.ts           Angular standalone component (app shell, state, API calls)
src/app.component.html  Angular template
src/styles.css         Design system (light/dark theme, layout, components)
Dockerfile             Multi-stage build: Angular build -> slim Node runtime
```
