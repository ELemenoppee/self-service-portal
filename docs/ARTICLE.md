# I built a self-service portal so I'd stop running Jenkins jobs by hand

Every place I've worked with Jenkins runs into the same problem: who should get access to it?

If everyone gets access, you end up with people who can trigger a production deploy but don't really know what the parameters mean. The audit log just says "ran by admin" fifty times a day. If you lock it down instead, every small request — add a DNS record, open a port, add someone's SSH key to a server — turns into a Slack message or a ticket that waits until whoever owns Jenkins has time. I've been that person waiting on the other end of those tickets, and it's not a good use of anyone's time.

So on the side, I built `self-service-portal`. It's a small web app that sits in front of Jenkins and gives people a form instead of a login. You pick a task, fill in the fields, and submit. If you're a developer, the request goes into a queue and an admin has to approve or decline it. If you're an admin, it just runs. Either way, Jenkins does the real work — not the portal. I'll explain why that matters below.

Here's the repo if you want to look: [github.com/ELemenoppee/self-service-portal](https://github.com/ELemenoppee/self-service-portal). Everything in it is generic — no real URLs, no real AWS account, nothing tied to any company. You can clone it and point it at your own Jenkins.

## What it can do

Right now there are eight tasks, grouped into categories you see in the sidebar: deploying an app for the first time, setting up a new Kubernetes namespace with Argo CD, managing Route53/Nginx records, adding or removing security group rules, and managing EC2 users over Ansible (add, remove, or replace an SSH key).

I didn't make these up. They're the kind of requests that come up all the time on any infra team. The goal wasn't to build a general automation tool that does anything — it was to cover the small, repeated tasks that don't need real judgment calls, and to add an extra confirmation step for the risky ones, like removing access or deleting a DNS record. Before you can submit one of those, the app shows you exactly what's about to happen.

## The part I always have to explain: the portal doesn't do the actual work

People get confused about this when they first read the code, so let me be clear: the portal never touches AWS, Ansible, or Kubernetes directly. It only talks to one thing — Jenkins — through its API. When a request is approved, the portal calls Jenkins' `buildWithParameters` endpoint with the values from the form. After that, it's all up to the Jenkinsfile behind that job. The real work — the Ansible playbook that adds the SSH key, the AWS call that opens a port, the `kubectl` command that creates a namespace — lives on the Jenkins side, not in this repo.

I thought about doing it differently at first. It would have been simpler in some ways to have the portal call AWS and Ansible directly, instead of going through Jenkins. But then the portal would need its own credentials for every system, its own retry logic, its own way to run Ansible. It would basically become the automation tool instead of just being the front door to one that already exists. Keeping the portal simple about *how* work gets done, and only smart about *who's allowed to ask and whether it's approved*, is what let me keep the whole backend in one file, with no framework.

So in practice, the portal knows the shape of a request — which fields it needs, what's required, what a good default looks like — and it knows how to talk to the Jenkins API: get a security token, send the build request, then check the queue and the build status every five seconds until it's done. If the job isn't where the settings say it should be, the portal searches through Jenkins folders looking for a job with a matching name before it gives up and shows a clear error. Everything after "Jenkins accepted the job" is Jenkins' job to handle, not the portal's.

## How it's built

The frontend is Angular 18, using standalone components, no Angular Material. I wrote the CSS by hand because I wanted full control over how the design looked, and because pulling in a whole component library for a few screens felt like too much. The Angular build gets turned into static files, and the same Node process that runs the API also serves those files. So there's no separate frontend server to set up.

The backend is plain Node — just the built-in `http` module, no Express. That might sound unusual, but there are only about fifteen routes, and they're all simple. I didn't feel like I needed a framework just to handle fifteen paths. It's one file, and you can read the whole thing in one sitting.

For storage, users, run history, and pending approvals all live in SQLite through `better-sqlite3` — one file on disk, no separate database to run. Some people assume that's a shortcut for a small starter project, but it's actually the right choice here. This app only ever runs as one instance (SQLite doesn't handle multiple writers well across replicas, so I never tried to scale it out), and the number of writes is tiny — a few people submitting a few requests a day. Running a full database server for that would just be one more thing to patch and pay for. If this ever needs more than one instance, that's when I'd switch it out — not before.

One small detail I'm kind of proud of: the database runs with `journal_mode = DELETE` instead of the more common `WAL` mode. In Kubernetes, the database file usually sits on a `PersistentVolumeClaim`, and if that storage is backed by something like EFS or NFS, WAL mode's file locking can become unreliable — you can get corruption or strange lock errors that are painful to debug. The older journal mode is a bit slower, but it's correct on network storage, and with this little write activity, the speed difference doesn't matter. I only found this out because I'd seen a similar setup get flaky before, so I decided to avoid that whole problem here.

## Logins that double-check themselves

When you log in, you get a signed cookie — HMAC-SHA256, HttpOnly, SameSite — but it only holds your username and an expiry time. No role, no "is this account disabled" flag. Every request that needs to know your role goes back and checks the database again.

That's on purpose. It means every request does one extra database read, which costs almost nothing on a database this small. In return, if an admin disables someone's account — say they're leaving the team, or something looks wrong — that takes effect on their very next request, not whenever their cookie happens to expire eight hours later. A token that stores the role directly would skip that extra check, but it would also mean a disabled account stays logged in until the token runs out. For something that can trigger infrastructure changes, I didn't want that gap.

## Running it

Locally, it's just `npm install && npm run build && npm start`, and it starts on port 8080. You can sign in and click around the whole app even without Jenkins set up — it just tells you clearly that Jenkins isn't configured if you try to submit something, instead of pretending it worked.

There's a Dockerfile with a two-stage build. The first stage needs Python and a C++ compiler, which surprised me the first time I set it up — it turns out `better-sqlite3` compiles a native piece of code with node-gyp when there's no prebuilt version for your exact Node version, and the slim base image doesn't come with a compiler. The second stage only has the built app and the production dependencies, running as a non-root user, with a `/health` endpoint for the container's healthcheck.

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

In Kubernetes, it's a plain single-replica Deployment with a Service, an Ingress, and a `PersistentVolumeClaim` mounted at `/app/data` so the database survives pod restarts. Everything the app needs comes in through environment variables, so it doesn't matter if those come from Vault, a plain Kubernetes Secret, or a `.env` file on your laptop — the app doesn't know or care where they came from.

## What you'd need to connect this to a real Jenkins

If you wanted to actually use this instead of just reading the code, here's the honest answer: the portal is the easy part. The real work is setting up Jenkins.

You need one Jenkins job per task, and the parameter names on that job have to match exactly what the portal sends — things like `NAMESPACE`, `RECORD_NAME`, `SECURITY_GROUP`. The portal checks this before it even tries to trigger a build. If a job is missing a parameter it expects, it tells you exactly which parameter and which job — instead of the build just failing quietly on the Jenkins side. You also need a Jenkins API token for a service account, not someone's login password (Jenkins won't accept a plain password for API calls anyway). And the job needs to be enabled and buildable — the portal checks that too before it tries anything.

If your jobs live inside a folder, there's a `JENKINS_JOB_PREFIX` setting for that. If a job's default name in the portal doesn't match what you actually called it in Jenkins, `JOB_NAME_OVERRIDES` lets you fix that without touching any code.

The real automation — the Ansible playbook, the AWS call, the Argo CD setup — that part you'd have to write yourself, or already have. This repo doesn't include any of it on purpose, because that logic is going to look different for every team's setup anyway.

## What I'd like to add next

A few things are still on my list: switching the cookie-and-database-check login to something like short-lived tokens, in case this ever needs to run as more than one instance behind a load balancer (right now it's meant to run as just one, so this hasn't come up yet). Adding a role that lets someone approve routine requests without giving them full control over user accounts. And streaming build logs instead of checking Jenkins every five seconds — Jenkins actually supports this, I just haven't wired it up yet.

Here's the repo again if you want to look closer or reuse any of it: [github.com/ELemenoppee/self-service-portal](https://github.com/ELemenoppee/self-service-portal)
