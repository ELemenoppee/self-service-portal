'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const Database = require('better-sqlite3');

const PORT = Number(process.env.PORT || 8080);
const APP_NAME = process.env.APP_NAME || 'Self-Service Portal';
const SESSION_SECRET = requiredEnv('SESSION_SECRET');
const JENKINS_URL = trimRight(process.env.JENKINS_URL || '', '/');
const JENKINS_USER = process.env.JENKINS_USER || '';
const JENKINS_API_TOKEN = process.env.JENKINS_API_TOKEN || '';
const JENKINS_JOB_PREFIX = trimSlashes(process.env.JENKINS_JOB_PREFIX || '');
const JOB_NAME_OVERRIDES = loadJobNameOverrides();
const JENKINS_JOB_DISCOVERY = process.env.JENKINS_JOB_DISCOVERY !== 'false';
const COOKIE_NAME = 'self_service_session';
const STATIC_DIR = path.join(__dirname, 'dist', 'self-service-portal', 'browser');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'portal.db');

const db = openDatabase();
initializeUsers();
const SECURITY_GROUPS = loadSecurityGroups();
const HOSTED_ZONES = loadHostedZones();
const jobDefinitions = [
  {
    id: 'app-deployment',
    category: 'Applications',
    title: 'Application First Deployment',
    description: 'Bootstrap app manifests, optional Jenkins job, and optional Argo CD application.',
    job: 'app-deployment-v2',
    method: 'jenkins',
    fields: [
      choice('APP_TYPE', 'App Type', ['common-app', 'node-app', 'wordpress-efs']),
      choice('ENVIRONMENT', 'Environment', ['staging', 'production']),
      text('APPLICATION_NAME', 'Application Name', 'inventory-api', true, 'Lowercase app name used for Kubernetes and Jenkins resources. Example: notification-api.'),
      text('REPOSITORY_NAME', 'Repository Name', 'inventory-api', true, 'GitHub repository name of the application.'),
      text('GITHUB_ORG', 'GitHub Org/User', 'your-github-org', true, 'GitHub organization or username where the app and config repos live.'),
      text('NAMESPACE', 'Kubernetes Namespace', 'inventory-staging', true, 'Target Kubernetes namespace. Use default only if the app really belongs in default.'),
      text('REGISTRY', 'Container Registry', 'registry.example.com', true, 'Container registry hostname without image name.'),
      text('IMAGE_NAME', 'Image Name', '', false, 'Optional. Defaults to Application Name when blank.'),
      text('INITIAL_IMAGE_TAG', 'Initial Image Tag', 'bootstrap', true, 'Initial manifest image tag before the app pipeline deploys a real build tag.'),
      text('NODE_PORT', 'NodePort', '30310', true, 'Kubernetes NodePort, usually 30000-32767. Must be unique.'),
      text('CONTAINER_PORT', 'Container Port', '3000', true, 'Port exposed by the application container.'),
      text('HEALTH_PATH', 'Health Path', '/', true, 'HTTP path used by probes and smoke checks. Use / if the app has no /health.'),
      text('K8_OUTPUT_FILE', 'K8 Output File', '', false, 'Optional path inside k8-config. Blank uses app/environment/app-environment.yaml.'),
      choice('IF_EXISTS', 'If File Exists', ['fail', 'overwrite']),
      checkbox('CREATE_JENKINS_JOB', 'Create Jenkins Job', true),
      checkbox('TRIGGER_JENKINS_JOB', 'Trigger Jenkins Job', false),
      checkbox('CREATE_ARGOCD_APP', 'Create Argo CD App', false),
      choice('ARGOCD_SYNC_POLICY', 'Argo CD Sync Policy', ['manual', 'automated']),
      checkbox('ENABLE_TESTING', 'Enable Testing', true),
      text('REQUEST_ID', 'Request ID', 'manual-request', true, 'Ticket number or request reference for audit trail.')
    ]
  },
  {
    id: 'namespace-bootstrap',
    category: 'Kubernetes',
    title: 'Kubernetes Namespace Bootstrap',
    description: 'Create namespace, registry pull secret, default service account patch, and Argo CD project.',
    job: 'app-argocd-project-bootstrap',
    method: 'jenkins',
    fields: [
      text('NEW_NAMESPACE', 'New Namespace', 'inventory-production', true, 'Kubernetes namespace to create. Lowercase letters, numbers, and dashes only.'),
      text('DOCKER_USERNAME', 'Docker Username', '', true, 'Registry username used to create registry-credential in the namespace.'),
      password('DOCKER_PASSWORD', 'Docker Password'),
      text('DOCKER_EMAIL', 'Docker Email', '', true, 'Email value stored in the docker registry secret.')
    ]
  },
  {
    id: 'route53-record',
    category: 'Networking',
    title: 'Route53 and Nginx Entry',
    description: 'Create, update, or delete DNS records and optionally update Nginx reverse proxy.',
    job: 'infra-route53-record',
    method: 'jenkins',
    fields: [
      choice('ACTION', 'Action', ['create', 'update', 'delete']),
      choice('HOSTED_ZONE_ID', 'Hosted Zone ID', HOSTED_ZONES, 'Approved Route53 hosted zones. Configure the full list with HOSTED_ZONES_JSON.'),
      text('RECORD_NAME', 'Record Name', 'www.example.com', true, 'DNS name to create or update. Example: app.example.com.'),
      choice('RECORD_TYPE', 'Record Type', ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'SRV']),
      textarea('RECORD_VALUE', 'Record Value', '', true, 'DNS target value. For A record, use IP. For CNAME, use DNS name.'),
      text('TTL', 'TTL', '300', true, 'DNS TTL in seconds. Use 300 for normal requests.'),
      checkbox('CONFIGURE_NGINX', 'Configure Nginx', true),
      text('NGINX_DOMAIN', 'Nginx Domain', '', false, 'Optional. Defaults to Record Name. Use when Nginx server_name differs from DNS record.'),
      text('NGINX_PROXY_HOST', 'Backend IP/Host', '', false, 'Backend private IP or hostname for proxy_pass. Required for create/update when Configure Nginx is enabled.'),
      text('NGINX_PROXY_PORT', 'Backend Port', '', false, 'Backend port for proxy_pass. Example: 30000.'),
      text('NGINX_SITE_FILE', 'Nginx Site File', '/etc/nginx/sites-available/default', true, 'Nginx site file to update on the Nginx server.'),
      checkbox('RUN_CERTBOT', 'Run Certbot', true, 'Runs sudo certbot -d DOMAIN -v on the Nginx server after create/update. Requires Configure Nginx. Skipped for delete actions.'),
      text('REQUEST_ID', 'Request ID', 'manual-request', true, 'Ticket number or request reference for audit trail.')
    ]
  },
  {
    id: 'add-security-group-rule',
    category: 'Security',
    title: 'Add Security Group Rule',
    description: 'Add approved inbound access to an AWS security group.',
    job: 'infra-add-security-group-rule',
    method: 'jenkins',
    fields: [
      text('AWS_REGION', 'AWS Region', 'ap-southeast-2', true, 'AWS region where the security group exists.'),
      choice('SECURITY_GROUP', 'Security Group', SECURITY_GROUPS, 'Approved security groups. Configure the full list with SECURITY_GROUPS_JSON.'),
      choice('PROTOCOL', 'Protocol', ['tcp', 'udp', 'icmp']),
      text('PORT', 'Port', '443', true, 'Port number to allow. Use -1 for ICMP.'),
      text('SOURCE_CIDR', 'Source CIDR', '203.0.113.10/32', true, 'CIDR to allow. Prefer /32 for one public IP.'),
      text('DESCRIPTION', 'Description', '', true, 'Business reason shown in the AWS rule description.'),
      text('EXPIRY_DATE', 'Expiry Date', '', false, 'Optional expiry date in YYYY-MM-DD format.'),
      text('REQUEST_ID', 'Request ID', 'manual-request', true, 'Ticket number or request reference for audit trail.')
    ]
  },
  {
    id: 'remove-security-group-rule',
    category: 'Security',
    title: 'Remove Security Group Rule',
    description: 'Remove an existing inbound rule from an AWS security group.',
    job: 'infra-remove-security-group-rule',
    method: 'jenkins',
    fields: [
      text('AWS_REGION', 'AWS Region', 'ap-southeast-2', true, 'AWS region where the security group exists.'),
      choice('SECURITY_GROUP', 'Security Group', SECURITY_GROUPS, 'Approved security groups. Configure the full list with SECURITY_GROUPS_JSON.'),
      choice('PROTOCOL', 'Protocol', ['tcp', 'udp', 'icmp']),
      text('PORT', 'Port', '443', true, 'Port number to remove. Must match the existing rule.'),
      text('SOURCE_CIDR', 'Source CIDR', '203.0.113.10/32', true, 'CIDR to remove. Must match the existing rule.'),
      text('REASON', 'Reason', '', true, 'Reason for removing the access.'),
      text('REQUEST_ID', 'Request ID', 'manual-request', true, 'Ticket number or request reference for audit trail.')
    ]
  },
  {
    id: 'add-ec2-user',
    category: 'Access',
    title: 'Add EC2 User',
    description: 'Create a Linux user and add an SSH public key via Ansible.',
    job: 'infra-add-ec2-user',
    method: 'jenkins',
    fields: [
      text('ANSIBLE_SERVER_HOST', 'Ansible Server Host', 'serverA'),
      text('ANSIBLE_SERVER_USER', 'Ansible Server User', 'ubuntu'),
      text('TARGET_HOST', 'Target Host', ''),
      text('ANSIBLE_USER', 'Ansible User', 'ubuntu'),
      text('NEW_USERNAME', 'New Username', ''),
      textarea('SSH_PUBLIC_KEY', 'SSH Public Key', ''),
      choice('GRANT_SUDO', 'Grant Sudo', ['no', 'yes']),
      checkbox('ALLOW_PASSWORDLESS_SUDO', 'Allow Passwordless Sudo', false),
      text('REQUEST_ID', 'Request ID', 'manual-request')
    ]
  },
  {
    id: 'remove-ec2-user',
    category: 'Access',
    title: 'Remove EC2 User',
    description: 'Remove a Linux user from one or more EC2 instances.',
    job: 'infra-remove-ec2-user',
    method: 'jenkins',
    fields: [
      text('ANSIBLE_SERVER_HOST', 'Ansible Server Host', 'serverA'),
      text('ANSIBLE_SERVER_USER', 'Ansible Server User', 'ubuntu'),
      textarea('TARGET_HOST', 'Target Hosts', ''),
      text('ANSIBLE_USER', 'Ansible User', 'ubuntu'),
      text('TARGET_USERNAME', 'Target Username', ''),
      checkbox('REMOVE_HOME', 'Remove Home Directory', false),
      checkbox('KILL_USER_PROCESSES', 'Kill User Processes', false),
      text('REASON', 'Reason', ''),
      text('REQUEST_ID', 'Request ID', 'manual-request')
    ]
  },
  {
    id: 'replace-ssh-key',
    category: 'Access',
    title: 'Replace SSH Key',
    description: 'Replace an old SSH public key for an existing Linux user.',
    job: 'infra-replace-ssh-key',
    method: 'jenkins',
    fields: [
      text('ANSIBLE_SERVER_HOST', 'Ansible Server Host', 'serverA'),
      text('ANSIBLE_SERVER_USER', 'Ansible Server User', 'ubuntu'),
      textarea('TARGET_HOST', 'Target Hosts', ''),
      text('ANSIBLE_USER', 'Ansible User', 'ubuntu'),
      text('TARGET_USER', 'Target User', 'ubuntu'),
      textarea('NEW_SSH_PUBLIC_KEY', 'New SSH Public Key', ''),
      textarea('OLD_SSH_PUBLIC_KEY', 'Old SSH Public Key', ''),
      text('REASON', 'Reason', ''),
      text('REQUEST_ID', 'Request ID', 'manual-request')
    ]
  }
];

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const session = readSession(req);

    if (url.pathname === '/health') {
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === '/api/login' && req.method === 'POST') {
      const clientIp = clientIpFrom(req);
      const limited = checkLoginRateLimit(clientIp);
      if (limited) {
        res.setHeader('Retry-After', String(limited.retryAfterSeconds));
        return sendJson(res, 429, { error: `Too many login attempts. Try again in ${limited.retryAfterSeconds} seconds.` });
      }

      const body = await readJson(req);
      const user = authenticate(body.username || '', body.password || '');
      if (!user) {
        recordFailedLogin(clientIp);
        return sendJson(res, 401, { error: 'Invalid username or password.' });
      }
      clearFailedLogins(clientIp);
      setSession(res, user);
      return sendJson(res, 200, { user });
    }
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      clearSession(res);
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === '/api/me' && req.method === 'GET') {
      return sendJson(res, 200, { user: session });
    }

    if (url.pathname.startsWith('/api/')) {
      if (!session) {
        return sendJson(res, 401, { error: 'Authentication required.' });
      }

      if (url.pathname === '/api/jobs' && req.method === 'GET') {
        return sendJson(res, 200, { jobs: jobDefinitions.map(publicJob) });
      }

      if (url.pathname === '/api/jenkins/status' && req.method === 'GET') {
        const queueUrl = url.searchParams.get('queueUrl') || '';
        const buildUrl = url.searchParams.get('buildUrl') || '';
        const historyId = url.searchParams.get('historyId') || '';

        if (historyId) {
          const entry = getOwnHistoryEntry(historyId, session.username);
          if (entry) {
            if (entry.status === 'pending_approval' || entry.status === 'declined') {
              return sendJson(res, 200, { status: approvalStatusPayload(entry) });
            }
            const effectiveQueueUrl = queueUrl || entry.queueUrl || '';
            const effectiveBuildUrl = buildUrl || entry.buildUrl || '';
            const status = await getJenkinsBuildStatus({ queueUrl: effectiveQueueUrl, buildUrl: effectiveBuildUrl });
            updateHistoryStatus(historyId, session.username, status);
            return sendJson(res, 200, { status, queueUrl: effectiveQueueUrl, jobUrl: entry.jobUrl });
          }
        }

        const status = await getJenkinsBuildStatus({ queueUrl, buildUrl });
        if (historyId) updateHistoryStatus(historyId, session.username, status);
        return sendJson(res, 200, { status });
      }

      if (url.pathname === '/api/history' && req.method === 'GET') {
        pruneHistory();
        const mine = listHistoryFor(session.username).map(publicHistoryEntry);
        return sendJson(res, 200, { history: mine, retentionDays: HISTORY_RETENTION_DAYS });
      }

      if (url.pathname === '/api/history' && req.method === 'DELETE') {
        if (!requireAdmin(session, res)) return;
        clearHistoryFor(session.username);
        return sendJson(res, 200, { ok: true });
      }

      const historyMatch = url.pathname.match(/^\/api\/history\/([^/]+)$/);
      if (historyMatch && req.method === 'DELETE') {
        if (!requireAdmin(session, res)) return;
        const removed = deleteHistoryEntry(historyMatch[1], session.username);
        if (!removed) return sendJson(res, 404, { error: 'History entry not found.' });
        return sendJson(res, 200, { ok: true });
      }

      if (url.pathname === '/api/approvals' && req.method === 'GET') {
        if (!requireAdmin(session, res)) return;
        pruneHistory();
        const pending = listPendingApprovals().map(publicHistoryEntry);
        return sendJson(res, 200, { approvals: pending });
      }

      const approveMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/approve$/);
      if (approveMatch && req.method === 'POST') {
        if (!requireAdmin(session, res)) return;
        const entry = getPendingApproval(approveMatch[1]);
        if (!entry) return sendJson(res, 404, { error: 'Pending request not found.' });
        const job = findJob(entry.jobId);
        if (!job) return sendJson(res, 500, { error: 'The job definition for this request no longer exists.' });

        const result = await triggerJenkins(job, entry.rawValues);
        const updated = approveHistoryEntry(entry.id, session, result);
        return sendJson(res, 200, { entry: publicHistoryEntry(updated) });
      }

      const declineMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/decline$/);
      if (declineMatch && req.method === 'POST') {
        if (!requireAdmin(session, res)) return;
        const entry = getPendingApproval(declineMatch[1]);
        if (!entry) return sendJson(res, 404, { error: 'Pending request not found.' });
        const body = await readJson(req);
        const updated = declineHistoryEntry(entry.id, session, body.reason);
        return sendJson(res, 200, { entry: publicHistoryEntry(updated) });
      }

      if (url.pathname === '/api/admin/users' && req.method === 'GET') {
        if (!requireAdmin(session, res)) return;
        return sendJson(res, 200, { users: listPublicUsers() });
      }

      if (url.pathname === '/api/admin/users' && req.method === 'POST') {
        if (!requireAdmin(session, res)) return;
        const body = await readJson(req);
        try {
          const user = createUser(body);
          return sendJson(res, 200, { user: publicUser(user) });
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }

      const userPasswordMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/password$/);
      if (userPasswordMatch && req.method === 'POST') {
        if (!requireAdmin(session, res)) return;
        const body = await readJson(req);
        try {
          setUserPassword(decodeURIComponent(userPasswordMatch[1]), body.password || '');
          return sendJson(res, 200, { ok: true });
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }

      const userDisableMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/(disable|enable)$/);
      if (userDisableMatch && req.method === 'POST') {
        if (!requireAdmin(session, res)) return;
        try {
          setUserDisabled(decodeURIComponent(userDisableMatch[1]), userDisableMatch[2] === 'disable', session.username);
          return sendJson(res, 200, { ok: true });
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }

      const userMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (userMatch && req.method === 'DELETE') {
        if (!requireAdmin(session, res)) return;
        try {
          deleteUser(decodeURIComponent(userMatch[1]), session.username);
          return sendJson(res, 200, { ok: true });
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }

      const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
      if (jobMatch && req.method === 'GET') {
        const job = findJob(jobMatch[1]);
        if (!job) return sendJson(res, 404, { error: 'Job not found.' });
        return sendJson(res, 200, { job: publicJob(job) });
      }

      if (jobMatch && req.method === 'POST') {
        const job = findJob(jobMatch[1]);
        if (!job) return sendJson(res, 404, { error: 'Job not found.' });

        const body = await readJson(req);
        const values = collectValues(job, body.values || {});

        if (session.role !== 'admin') {
          const entry = recordHistory(session.username, job, values, null);
          return sendJson(res, 200, { values: maskSensitiveValues(values), result: null, historyId: entry.id, pendingApproval: true });
        }

        const result = await triggerJenkins(job, values);
        const historyEntry = recordHistory(session.username, job, values, result);
        return sendJson(res, 200, { values: maskSensitiveValues(values), result, historyId: historyEntry.id });
      }

      return sendJson(res, 404, { error: 'API route not found.' });
    }

    if (req.method === 'GET' && serveStatic(req, res, url.pathname)) {
      return;
    }

    if (req.method === 'GET') {
      return serveIndex(res);
    }

    sendJson(res, 404, { error: 'Not found.' });
  } catch (error) {
    console.error(error);
    if (req.url.startsWith('/api/')) {
      return sendJson(res, 500, { error: error.message });
    }
    send(res, 500, renderError(error), 'text/html; charset=utf-8');
  }
});

server.listen(PORT, () => {
  console.log(`${APP_NAME} listening on port ${PORT}`);
});

setInterval(pruneHistory, 60 * 60 * 1000);

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

function openDatabase() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const database = new Database(DB_PATH);
  // DB_PATH may live on a network filesystem (e.g. EFS/NFS-backed PVC in
  // Kubernetes), where WAL mode's shared-memory locking is unreliable.
  // The default rollback journal is slower but safe there.
  database.pragma('journal_mode = DELETE');
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'developer')),
      disabled INTEGER NOT NULL DEFAULT 0,
      password TEXT,
      password_hash TEXT
    );

    CREATE TABLE IF NOT EXISTS history (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      job_title TEXT NOT NULL,
      category TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      request_id TEXT,
      submitted_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      label TEXT,
      queue_url TEXT,
      build_url TEXT,
      job_url TEXT,
      build_number INTEGER,
      values_json TEXT NOT NULL,
      raw_values_json TEXT NOT NULL,
      decided_by TEXT,
      decided_at INTEGER,
      decline_reason TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_history_requested_by ON history(requested_by);
    CREATE INDEX IF NOT EXISTS idx_history_status ON history(status);
    CREATE INDEX IF NOT EXISTS idx_history_submitted_at ON history(submitted_at);
  `);
  return database;
}

function loadUsers() {
  if (process.env.USERS_JSON) {
    const parsed = parseJsonEnv('USERS_JSON');
    const list = parsed.users || parsed;
    if (!Array.isArray(list)) {
      throw new Error('USERS_JSON must be a JSON array of users, or an object with a "users" array.');
    }
    return list.map((item) => ({
      username: item.username,
      displayName: item.displayName || item.username,
      password: item.password,
      passwordHash: item.passwordHash,
      role: item.role === 'admin' ? 'admin' : 'developer',
      disabled: Boolean(item.disabled)
    }));
  }

  const username = requiredEnv('ADMIN_USERNAME');
  const password = requiredEnv('ADMIN_PASSWORD');
  return [{ username, password, displayName: 'DevOps Admin', role: 'admin', disabled: false }];
}

// USERS_JSON/ADMIN_USERNAME only seed the database the first time it is empty.
// After that, the database is authoritative; manage users from the Users screen.
function initializeUsers() {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM users').get();
  if (count === 0) {
    const insert = db.prepare(`
      INSERT OR IGNORE INTO users (username, display_name, role, disabled, password, password_hash)
      VALUES (@username, @displayName, @role, @disabled, @password, @passwordHash)
    `);
    for (const user of loadUsers()) {
      if (!user.username) continue;
      insert.run({
        username: user.username,
        displayName: user.displayName || user.username,
        role: user.role === 'admin' ? 'admin' : 'developer',
        disabled: user.disabled ? 1 : 0,
        password: user.password || null,
        passwordHash: user.passwordHash || null
      });
    }
  }

  const hasEnabledAdmin = db.prepare(`SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND disabled = 0`).get().count > 0;
  if (!hasEnabledAdmin) {
    throw new Error('At least one enabled admin user is required. Set ADMIN_USERNAME/ADMIN_PASSWORD, or include a user with "role":"admin" in USERS_JSON.');
  }
}

function loadSecurityGroups() {
  if (process.env.SECURITY_GROUPS_JSON) {
    const parsed = parseJsonEnv('SECURITY_GROUPS_JSON');
    if (!Array.isArray(parsed)) {
      throw new Error(`SECURITY_GROUPS_JSON must be a JSON array of strings, for example ["app-sg - sg-0123456789abcdef0"]. Got: ${typeof parsed}.`);
    }
    if (parsed.length > 0) return parsed;
  }
  return [
    'app-sg - sg-0123456789abcdef0',
    'db-sg - sg-0fedcba9876543210',
    'mgmt-sg - sg-0aabbccddeeff0011'
  ];
}

function loadHostedZones() {
  if (process.env.HOSTED_ZONES_JSON) {
    const parsed = parseJsonEnv('HOSTED_ZONES_JSON');
    if (!Array.isArray(parsed)) {
      throw new Error(`HOSTED_ZONES_JSON must be a JSON array of strings, for example ["example.com - Z123456789ABC"]. Got: ${typeof parsed}.`);
    }
    if (parsed.length > 0) return parsed;
  }
  return [
    'example.com - Z123456789ABC',
    'internal.example.com - Z987654321XYZ'
  ];
}

const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const loginAttempts = new Map();

function clientIpFrom(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function checkLoginRateLimit(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return null;
  const elapsed = Date.now() - entry.firstAttemptAt;
  if (elapsed > LOGIN_WINDOW_MS) {
    loginAttempts.delete(ip);
    return null;
  }
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    return { retryAfterSeconds: Math.ceil((LOGIN_WINDOW_MS - elapsed) / 1000) };
  }
  return null;
}

function recordFailedLogin(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry || Date.now() - entry.firstAttemptAt > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, firstAttemptAt: Date.now() });
    return;
  }
  entry.count += 1;
}

function clearFailedLogins(ip) {
  loginAttempts.delete(ip);
}

function findUserRow(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) || null;
}

function authenticate(username, password) {
  const user = findUserRow(username);
  if (!user || user.disabled) return null;
  if (user.password_hash) {
    const hash = crypto.createHash('sha256').update(password).digest('hex');
    if (!timingSafeEqual(hash, user.password_hash)) return null;
  } else if (!timingSafeEqual(password, user.password || '')) {
    return null;
  }
  return publicUser(user);
}

function readSession(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies[COOKIE_NAME];
  if (!token) return null;

  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;

  const expected = sign(payload);
  if (!timingSafeEqual(signature, expected)) return null;

  const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (Date.now() > data.expiresAt) return null;

  const user = findUserRow(data.username);
  if (!user || user.disabled) return null;
  return publicUser(user);
}

function setSession(res, user) {
  const payload = Buffer.from(JSON.stringify({
    username: user.username,
    expiresAt: Date.now() + 8 * 60 * 60 * 1000
  })).toString('base64url');
  const token = `${payload}.${sign(payload)}`;
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`);
}

function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

function publicUser(user) {
  return {
    username: user.username,
    displayName: user.display_name || user.username,
    role: user.role,
    disabled: Boolean(user.disabled)
  };
}

function listPublicUsers() {
  return db.prepare('SELECT * FROM users ORDER BY username').all().map(publicUser);
}

function requireAdmin(session, res) {
  if (session.role !== 'admin') {
    sendJson(res, 403, { error: 'Admin access required.' });
    return false;
  }
  return true;
}

function createUser({ username, displayName, password, role }) {
  const cleanUsername = String(username || '').trim();
  if (!cleanUsername || !/^[A-Za-z0-9._-]+$/.test(cleanUsername)) {
    throw new Error('Username must contain only letters, numbers, dots, dashes, and underscores.');
  }
  if (findUserRow(cleanUsername)) {
    throw new Error('A user with this username already exists.');
  }
  if (!password || password.length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }
  const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
  db.prepare(`
    INSERT INTO users (username, display_name, role, disabled, password_hash)
    VALUES (?, ?, ?, 0, ?)
  `).run(cleanUsername, String(displayName || '').trim() || cleanUsername, role === 'admin' ? 'admin' : 'developer', passwordHash);
  return findUserRow(cleanUsername);
}

function deleteUser(username, actingUsername) {
  const user = findUserRow(username);
  if (!user) throw new Error('User not found.');
  if (username === actingUsername) throw new Error('You cannot delete your own account.');
  if (user.role === 'admin') assertNotLastAdmin(username);
  db.prepare('DELETE FROM users WHERE username = ?').run(username);
}

function setUserDisabled(username, disabled, actingUsername) {
  const user = findUserRow(username);
  if (!user) throw new Error('User not found.');
  if (disabled && username === actingUsername) throw new Error('You cannot disable your own account.');
  if (disabled && user.role === 'admin') assertNotLastAdmin(username);
  db.prepare('UPDATE users SET disabled = ? WHERE username = ?').run(disabled ? 1 : 0, username);
}

function setUserPassword(username, password) {
  const user = findUserRow(username);
  if (!user) throw new Error('User not found.');
  if (!password || password.length < 8) throw new Error('Password must be at least 8 characters.');
  const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
  db.prepare('UPDATE users SET password_hash = ?, password = NULL WHERE username = ?').run(passwordHash, username);
}

function assertNotLastAdmin(excludingUsername) {
  const { count } = db.prepare(`
    SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND disabled = 0 AND username != ?
  `).get(excludingUsername);
  if (count === 0) {
    throw new Error('At least one enabled admin must remain.');
  }
}

function sign(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
}

async function triggerJenkins(job, values) {
  requireJenkinsConfig();
  const resolvedJobName = resolveJobName(job);
  const jobBaseUrl = await resolveJenkinsJobUrl(resolvedJobName, job);
  await validateJenkinsSession();
  const jobInfo = await getJenkinsJobInfo(jobBaseUrl);
  validateJenkinsJobBeforeBuild(job, jobInfo, values);

  const crumb = await getJenkinsCrumb();
  const jobUrl = `${jobBaseUrl}/buildWithParameters`;
  const form = new URLSearchParams(values);
  const headers = {
    Authorization: basicAuth(),
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/x-www-form-urlencoded'
  };
  if (crumb) headers[crumb.field] = crumb.value;

  const response = await fetch(jobUrl, {
    method: 'POST',
    headers,
    body: form.toString(),
    redirect: 'manual'
  });

  const text = await response.text();
  const queueUrl = response.headers.get('location') || '';
  const acceptedStatuses = [200, 201, 202, 302, 303];
  if (!acceptedStatuses.includes(response.status)) {
    throw new Error(`Jenkins returned HTTP ${response.status} for ${jobUrl}. ${jenkinsErrorHint(response.status, text)}`);
  }

  return {
    status: response.status,
    queueUrl: queueUrl ? normalizeJenkinsUrl(queueUrl) : '',
    jobUrl: jobBaseUrl,
    progress: {
      state: 'queued',
      percent: 5,
      label: 'Queued',
      message: 'Jenkins accepted the request and placed it in the queue.'
    }
  };
}

async function validateJenkinsSession() {
  const response = await fetch(`${JENKINS_URL}/whoAmI/api/json`, {
    headers: {
      Authorization: basicAuth(),
      Accept: 'application/json'
    }
  });
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`Unable to authenticate to Jenkins. Jenkins returned HTTP ${response.status}. Check JENKINS_USER and JENKINS_API_TOKEN. Response: ${htmlToText(body).slice(0, 500)}`);
  }

  let data;
  try {
    data = JSON.parse(body);
  } catch (error) {
    throw new Error(`Unable to read Jenkins authentication status. Jenkins returned a non-JSON response. Check JENKINS_URL and credentials. Response: ${htmlToText(body).slice(0, 500)}`);
  }

  if (!data.authenticated) {
    throw new Error('Jenkins credentials are not authenticated. Check JENKINS_USER and use a valid Jenkins API token, not the login password.');
  }
}

async function getJenkinsJobInfo(jobBaseUrl) {
  const tree = 'fullName,url,buildable,disabled,color,property[parameterDefinitions[name,type,defaultParameterValue[value]]]';
  return fetchJenkinsJson(`${jobBaseUrl}/api/json?tree=${encodeURIComponent(tree)}`);
}

function validateJenkinsJobBeforeBuild(job, jobInfo, values) {
  if (jobInfo.disabled || jobInfo.buildable === false) {
    throw new Error(`Jenkins job '${jobInfo.fullName || job.title}' is disabled or not buildable. Enable the job before submitting requests.`);
  }

  const parameterDefinitions = (jobInfo.property || [])
    .flatMap((item) => item.parameterDefinitions || []);

  if (parameterDefinitions.length === 0) {
    throw new Error(`Jenkins job '${jobInfo.fullName || job.title}' has no parameter definitions. Open the job in Jenkins and run/configure it once so Jenkins loads the parameters from its Jenkinsfile, then retry.`);
  }

  const knownParameterNames = new Set(parameterDefinitions.map((item) => item.name));
  const expectedNames = job.fields.map((field) => field.name);
  const missingInJenkins = expectedNames.filter((name) => !knownParameterNames.has(name));
  if (missingInJenkins.length > 0) {
    throw new Error(`Jenkins job '${jobInfo.fullName || job.title}' is missing expected parameter(s): ${missingInJenkins.join(', ')}. Update the Jenkins job to use the matching self-service Jenkinsfile, then run the job once to refresh parameters.`);
  }

  const emptyRequired = job.fields
    .filter((field) => field.required !== false && field.type !== 'checkbox')
    .filter((field) => String(values[field.name] || '').trim() === '')
    .map((field) => field.name);
  if (emptyRequired.length > 0) {
    throw new Error(`Required parameter(s) are empty: ${emptyRequired.join(', ')}.`);
  }
}

function jenkinsErrorHint(status, body) {
  const message = htmlToText(body).slice(0, 900);
  const prefix = status === 500
    ? 'The Jenkins job exists, but Jenkins failed while scheduling it.'
    : 'Jenkins rejected the build request.';
  return `${prefix} Check the Jenkins job configuration, required parameters, and script approval. Response: ${message}`;
}

function htmlToText(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getJenkinsBuildStatus({ queueUrl, buildUrl }) {
  requireJenkinsConfig();
  if (buildUrl) {
    return getJenkinsBuildByUrl(buildUrl);
  }

  if (!queueUrl) {
    return {
      state: 'unknown',
      percent: 0,
      label: 'Waiting',
      message: 'No Jenkins queue URL was returned for this request.'
    };
  }

  const safeQueueUrl = normalizeJenkinsUrl(queueUrl);
  const queueData = await fetchJenkinsJson(`${trimRight(safeQueueUrl, '/')}/api/json`);

  if (queueData.cancelled) {
    return {
      state: 'cancelled',
      percent: 100,
      label: 'Cancelled',
      message: 'The queued Jenkins item was cancelled.'
    };
  }

  if (!queueData.executable?.url) {
    return {
      state: 'queued',
      percent: 10,
      label: 'Queued',
      message: queueData.why || 'Waiting for a Jenkins executor.',
      queueUrl: safeQueueUrl
    };
  }

  return getJenkinsBuildByUrl(queueData.executable.url);
}

async function getJenkinsBuildByUrl(buildUrl) {
  const safeBuildUrl = normalizeJenkinsUrl(buildUrl);
  const data = await fetchJenkinsJson(`${trimRight(safeBuildUrl, '/')}/api/json`);
  const building = Boolean(data.building);
  const estimated = Number(data.estimatedDuration || 0);
  const elapsed = Number(data.timestamp ? Date.now() - data.timestamp : 0);
  const percent = building
    ? Math.max(25, Math.min(95, estimated > 0 ? Math.round((elapsed / estimated) * 90) : 50))
    : 100;
  const result = data.result || '';

  return {
    state: building ? 'building' : result.toLowerCase() || 'completed',
    percent,
    label: building ? 'Building' : result || 'Completed',
    message: building ? 'Jenkins build is running.' : `Jenkins build finished with result: ${result || 'UNKNOWN'}.`,
    buildUrl: trimRight(safeBuildUrl, '/'),
    buildNumber: data.number,
    durationMs: data.duration || 0,
    estimatedDurationMs: estimated,
    result
  };
}

async function fetchJenkinsJson(url) {
  const response = await fetch(url, {
    headers: {
      Authorization: basicAuth(),
      Accept: 'application/json'
    }
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Unable to read Jenkins API. Jenkins returned HTTP ${response.status} for ${url}. Response: ${htmlToText(body).slice(0, 500)}`);
  }
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`Jenkins returned a non-JSON response for ${url}. This usually means the Jenkins URL, credentials, or permissions are wrong. Response: ${htmlToText(body).slice(0, 500)}`);
  }
}

function normalizeJenkinsUrl(url) {
  const parsed = new URL(url, JENKINS_URL);
  const allowed = new URL(JENKINS_URL);
  if (parsed.origin !== allowed.origin) {
    throw new Error('Jenkins status URL is outside the configured Jenkins server.');
  }
  return parsed.toString();
}

async function getJenkinsCrumb() {
  const response = await fetch(`${JENKINS_URL}/crumbIssuer/api/json`, {
    headers: {
      Authorization: basicAuth(),
      Accept: 'application/json'
    }
  });
  if (response.status === 404) return null;
  if (!response.ok) return null;
  const body = await response.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  return { field: data.crumbRequestField, value: data.crumb };
}

async function resolveJenkinsJobUrl(jobName, job) {
  const candidates = jobNameCandidates(jobName, job);
  const triedUrls = [];

  for (const candidate of candidates) {
    const configuredUrl = configuredJobUrl(candidate);
    triedUrls.push(configuredUrl);
    if (await jenkinsUrlExists(`${configuredUrl}/api/json`)) {
      return configuredUrl;
    }
  }

  if (!JENKINS_JOB_DISCOVERY) {
    return configuredJobUrl(jobName);
  }

  const discovered = await discoverJenkinsJob(candidates);
  if (discovered) {
    return trimRight(discovered.url, '/');
  }

  throw new Error(`Jenkins job was not found. Tried ${triedUrls.join(', ')}. Auto-discovery could not find any matching job: ${candidates.join(', ')}. Set JOB_NAME_OVERRIDES to the exact Jenkins fullName/path or set JENKINS_JOB_PREFIX if it is inside a folder.`);
}

function jobNameCandidates(jobName, job) {
  const baseNames = [
    jobName,
    job?.job,
    job?.id,
    job?.job && `Jenkinsfile.${job.job}`,
    job?.id && `Jenkinsfile.${job.id}`,
    jobName && `Jenkinsfile.${trimSlashes(jobName).split('/').pop()}`
  ].filter(Boolean);

  const commonFolders = ['self-service-automation', 'self-service'];
  const names = [...baseNames];
  if (!JENKINS_JOB_PREFIX) {
    for (const folder of commonFolders) {
      for (const name of baseNames) {
        names.push(`${folder}/${name}`);
      }
    }
  }

  const unique = [];
  for (const name of names) {
    if (name && !unique.includes(name)) unique.push(name);
  }
  return unique;
}

function configuredJobUrl(jobName) {
  if (!JENKINS_URL) return '';

  if (/^https?:\/\//i.test(jobName)) {
    return trimRight(jobName, '/');
  }

  const cleanName = trimSlashes(jobName);
  if (cleanName.startsWith('job/')) {
    return `${JENKINS_URL}/${cleanName}`;
  }

  return `${JENKINS_URL}/${jobPath(cleanName)}`;
}

function jobPath(jobName) {
  const names = JENKINS_JOB_PREFIX ? `${JENKINS_JOB_PREFIX}/${jobName}` : jobName;
  return names.split('/').filter(Boolean).map((part) => `job/${encodeURIComponent(part)}`).join('/');
}

async function jenkinsUrlExists(url) {
  const response = await fetch(url, {
    headers: { Authorization: basicAuth() }
  });
  return response.ok;
}

async function discoverJenkinsJob(jobNames) {
  const tree = 'jobs[name,fullName,url,jobs[name,fullName,url,jobs[name,fullName,url,jobs[name,fullName,url,jobs[name,fullName,url]]]]]';
  const response = await fetch(`${JENKINS_URL}/api/json?tree=${encodeURIComponent(tree)}`, {
    headers: { Authorization: basicAuth() }
  });
  if (!response.ok) {
    throw new Error(`Unable to discover Jenkins jobs. Jenkins API returned HTTP ${response.status}.`);
  }

  const data = await response.json();
  const allJobs = flattenJenkinsJobs(data.jobs || []);

  for (const jobName of jobNames) {
    const normalizedWanted = trimSlashes(jobName);
    const wantedLeafName = normalizedWanted.split('/').pop();
    const match = allJobs.find((item) => trimSlashes(item.fullName || '') === normalizedWanted)
      || allJobs.find((item) => trimSlashes(item.name || '') === normalizedWanted)
      || allJobs.find((item) => item.name === wantedLeafName);
    if (match) return match;
  }

  return null;
}

function flattenJenkinsJobs(jobs) {
  const output = [];
  for (const job of jobs) {
    output.push(job);
    if (Array.isArray(job.jobs)) {
      output.push(...flattenJenkinsJobs(job.jobs));
    }
  }
  return output;
}

function resolveJobName(job) {
  return JOB_NAME_OVERRIDES[job.id] || JOB_NAME_OVERRIDES[job.job] || job.job;
}

function loadJobNameOverrides() {
  if (!process.env.JOB_NAME_OVERRIDES) return {};
  return parseJsonEnv('JOB_NAME_OVERRIDES');
}

function parseJsonEnv(name) {
  try {
    return JSON.parse(process.env[name]);
  } catch (error) {
    throw new Error(`${name} is not valid JSON: ${error.message}. Check for a missing [ ] or { } wrapper, unquoted values, or a trailing comma.`);
  }
}

function collectValues(job, body) {
  const values = {};
  for (const field of job.fields) {
    if (field.type === 'checkbox') {
      const raw = body[field.name];
      values[field.name] = (raw === true || raw === 'true' || raw === 'on') ? 'true' : 'false';
    } else {
      values[field.name] = body[field.name] || '';
    }
  }
  if (values.HOSTED_ZONE_ID) {
    values.HOSTED_ZONE_ID = dropdownIdSuffix(values.HOSTED_ZONE_ID);
  }
  return values;
}

function dropdownIdSuffix(value) {
  const parts = value.split(' - ');
  return parts.length > 1 ? parts[parts.length - 1].trim() : value.trim();
}

function publicJob(job) {
  const resolvedJobName = resolveJobName(job);
  return {
    id: job.id,
    category: job.category || 'Workflow',
    title: job.title,
    description: job.description,
    jobName: resolvedJobName,
    configuredUrl: configuredJobUrl(resolvedJobName),
    discoveryEnabled: JENKINS_JOB_DISCOVERY,
    fields: job.fields
  };
}

function maskSensitiveValues(values) {
  const output = {};
  for (const [key, value] of Object.entries(values)) {
    output[key] = key.toLowerCase().includes('password') ? '********' : value;
  }
  return output;
}

const HISTORY_RETENTION_DAYS = 7;
const HISTORY_RETENTION_MS = HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const HISTORY_MAX_ENTRIES = 200;

function rowToHistoryEntry(row) {
  return {
    id: row.id,
    jobId: row.job_id,
    jobTitle: row.job_title,
    category: row.category,
    requestedBy: row.requested_by,
    requestId: row.request_id,
    submittedAt: row.submitted_at,
    status: row.status,
    label: row.label,
    queueUrl: row.queue_url,
    buildUrl: row.build_url,
    jobUrl: row.job_url,
    buildNumber: row.build_number ?? undefined,
    values: JSON.parse(row.values_json),
    rawValues: JSON.parse(row.raw_values_json),
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    declineReason: row.decline_reason
  };
}

function recordHistory(username, job, values, result) {
  const pending = !result;
  const entry = {
    id: crypto.randomUUID(),
    jobId: job.id,
    jobTitle: job.title,
    category: job.category || 'Workflow',
    requestedBy: username,
    requestId: values.REQUEST_ID || '',
    submittedAt: Date.now(),
    status: pending ? 'pending_approval' : (result.progress?.state || 'queued'),
    label: pending ? 'Pending Approval' : (result.progress?.label || 'Queued'),
    queueUrl: pending ? '' : (result.queueUrl || ''),
    buildUrl: '',
    jobUrl: pending ? '' : (result.jobUrl || ''),
    buildNumber: null,
    values: maskSensitiveValues(values),
    rawValues: values,
    decidedBy: null,
    decidedAt: null,
    declineReason: null
  };

  db.prepare(`
    INSERT INTO history (
      id, job_id, job_title, category, requested_by, request_id, submitted_at,
      status, label, queue_url, build_url, job_url, build_number,
      values_json, raw_values_json, decided_by, decided_at, decline_reason
    ) VALUES (@id, @jobId, @jobTitle, @category, @requestedBy, @requestId, @submittedAt,
      @status, @label, @queueUrl, @buildUrl, @jobUrl, @buildNumber,
      @valuesJson, @rawValuesJson, @decidedBy, @decidedAt, @declineReason)
  `).run({
    ...entry,
    valuesJson: JSON.stringify(entry.values),
    rawValuesJson: JSON.stringify(entry.rawValues)
  });

  pruneHistory();
  return entry;
}

function getHistoryEntry(id) {
  const row = db.prepare('SELECT * FROM history WHERE id = ?').get(id);
  return row ? rowToHistoryEntry(row) : null;
}

function getOwnHistoryEntry(id, username) {
  const row = db.prepare('SELECT * FROM history WHERE id = ? AND requested_by = ?').get(id, username);
  return row ? rowToHistoryEntry(row) : null;
}

function getPendingApproval(id) {
  const row = db.prepare(`SELECT * FROM history WHERE id = ? AND status = 'pending_approval'`).get(id);
  return row ? rowToHistoryEntry(row) : null;
}

function listHistoryFor(username) {
  return db.prepare('SELECT * FROM history WHERE requested_by = ? ORDER BY submitted_at DESC').all(username).map(rowToHistoryEntry);
}

function listPendingApprovals() {
  return db.prepare(`SELECT * FROM history WHERE status = 'pending_approval' ORDER BY submitted_at ASC`).all().map(rowToHistoryEntry);
}

function publicHistoryEntry(entry) {
  const { rawValues, ...rest } = entry;
  return rest;
}

function approvalStatusPayload(entry) {
  if (entry.status === 'declined') {
    return {
      state: 'declined',
      percent: 100,
      label: 'Declined',
      message: entry.declineReason ? `Declined by an admin: ${entry.declineReason}` : 'This request was declined by an admin.'
    };
  }
  return {
    state: 'pending_approval',
    percent: 0,
    label: 'Pending Approval',
    message: 'Waiting for an admin to approve this request.'
  };
}

function approveHistoryEntry(id, session, result) {
  db.prepare(`
    UPDATE history SET status = ?, label = ?, queue_url = ?, job_url = ?, decided_by = ?, decided_at = ?
    WHERE id = ?
  `).run(
    result.progress?.state || 'queued',
    result.progress?.label || 'Queued',
    result.queueUrl || '',
    result.jobUrl || '',
    session.username,
    Date.now(),
    id
  );
  return getHistoryEntry(id);
}

function declineHistoryEntry(id, session, reason) {
  db.prepare(`
    UPDATE history SET status = 'declined', label = 'Declined', decided_by = ?, decided_at = ?, decline_reason = ?
    WHERE id = ?
  `).run(session.username, Date.now(), String(reason || '').trim(), id);
  return getHistoryEntry(id);
}

function updateHistoryStatus(id, username, status) {
  const entry = getOwnHistoryEntry(id, username);
  if (!entry) return;
  db.prepare('UPDATE history SET status = ?, label = ?, build_url = ?, build_number = ? WHERE id = ?').run(
    status.state,
    status.label,
    status.buildUrl || entry.buildUrl,
    status.buildNumber ?? entry.buildNumber ?? null,
    id
  );
}

function clearHistoryFor(username) {
  db.prepare('DELETE FROM history WHERE requested_by = ?').run(username);
}

function deleteHistoryEntry(id, username) {
  const result = db.prepare('DELETE FROM history WHERE id = ? AND requested_by = ?').run(id, username);
  return result.changes > 0;
}

function pruneHistory() {
  const cutoff = Date.now() - HISTORY_RETENTION_MS;
  db.prepare('DELETE FROM history WHERE submitted_at < ?').run(cutoff);
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM history').get();
  if (count > HISTORY_MAX_ENTRIES) {
    db.prepare(`
      DELETE FROM history WHERE id IN (
        SELECT id FROM history ORDER BY submitted_at ASC LIMIT ?
      )
    `).run(count - HISTORY_MAX_ENTRIES);
  }
}

function renderError(error) {
  return layout('Error', null, `<section class="panel"><h1>Request Failed</h1><div class="alert">${escapeHtml(error.message)}</div><a class="secondary" href="/">Back</a></section>`);
}

function layout(title, session, body) {
  const nav = session ? `
    <header style="display:flex;align-items:center;justify-content:space-between;padding:16px 24px;border-bottom:1px solid #2a3140;">
      <a href="/" style="color:inherit;font-weight:800;text-decoration:none;">${escapeHtml(APP_NAME)}</a>
      <nav style="display:flex;gap:16px;align-items:center;font-size:14px;color:#9aa4b2;">
        <span>${escapeHtml(session.displayName)}</span><a href="/logout" style="color:#5b8def;">Logout</a>
      </nav>
    </header>
  ` : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} | ${escapeHtml(APP_NAME)}</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; background: #10141c; color: #e6e9ef; }
    .shell { width: min(560px, calc(100% - 32px)); margin: 64px auto; }
    .panel { background: #171c26; border: 1px solid #2a3140; border-radius: 12px; padding: 28px; box-shadow: 0 18px 45px rgba(0,0,0,.45); }
    h1 { margin: 0 0 12px; font-size: 24px; }
    .alert { background: #2c1614; color: #ff9a90; border: 1px solid #4a2320; border-radius: 8px; padding: 12px 14px; line-height: 1.5; margin-bottom: 16px; word-break: break-word; }
    a.secondary { display: inline-block; margin-top: 4px; color: #5b8def; text-decoration: none; font-weight: 700; }
  </style>
</head>
<body>
  ${nav}
  <main class="shell">${body}</main>
</body>
</html>`;
}

function text(name, label, defaultValue = '', required = true, help = '') {
  return { type: 'text', name, label, defaultValue, required, help };
}

function password(name, label, help = '') {
  return { type: 'password', name, label, defaultValue: '', help };
}

function textarea(name, label, defaultValue = '', required = true, help = '') {
  return { type: 'textarea', name, label, defaultValue, required, help };
}

function choice(name, label, options, help = '') {
  return { type: 'choice', name, label, options, defaultValue: options[0], help };
}

function checkbox(name, label, defaultValue, help = '') {
  return { type: 'checkbox', name, label, defaultValue, help };
}

function findJob(id) {
  return jobDefinitions.find((job) => job.id === id);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} environment variable is required`);
  return value;
}

function trimRight(value, char) {
  let output = value;
  while (output.endsWith(char)) output = output.slice(0, -1);
  return output;
}

function trimSlashes(value) {
  return value.replace(/^\/+|\/+$/g, '');
}

function basicAuth() {
  return `Basic ${Buffer.from(`${JENKINS_USER}:${JENKINS_API_TOKEN}`).toString('base64')}`;
}

function requireJenkinsConfig() {
  const missing = [];
  if (!JENKINS_URL) missing.push('JENKINS_URL');
  if (!JENKINS_USER) missing.push('JENKINS_USER');
  if (!JENKINS_API_TOKEN) missing.push('JENKINS_API_TOKEN');
  if (missing.length > 0) {
    throw new Error(`Jenkins is not configured. Missing environment variable(s): ${missing.join(', ')}.`);
  }
}

function parseCookies(header) {
  return header.split(';').reduce((cookies, item) => {
    const [key, ...rest] = item.trim().split('=');
    if (key) cookies[key] = decodeURIComponent(rest.join('=') || '');
    return cookies;
  }, {});
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(new Error('Request body is too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data.trim()) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(new Error(`Invalid JSON request body: ${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const filePath = safeStaticPath(pathname === '/' ? '/index.html' : pathname);
  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return false;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon'
  }[ext] || 'application/octet-stream';

  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

function serveIndex(res) {
  const indexPath = safeStaticPath('/index.html');
  if (indexPath && fs.existsSync(indexPath)) {
    return send(res, 200, fs.readFileSync(indexPath, 'utf8'), 'text/html; charset=utf-8');
  }
  return send(res, 500, renderError(new Error('Angular build output was not found. Run npm run build before starting the server.')), 'text/html; charset=utf-8');
}

function safeStaticPath(pathname) {
  const decoded = decodeURIComponent(pathname.split('?')[0]);
  const resolved = path.resolve(STATIC_DIR, `.${decoded}`);
  if (!resolved.startsWith(path.resolve(STATIC_DIR))) return null;
  return resolved;
}

function send(res, status, body, contentType) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  });
  res.end(body);
}

function sendJson(res, status, body) {
  send(res, status, JSON.stringify(body), 'application/json; charset=utf-8');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function timingSafeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}
