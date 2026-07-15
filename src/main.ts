import { CommonModule } from '@angular/common';
import { Component, ElementRef, HostListener, OnInit, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { bootstrapApplication } from '@angular/platform-browser';

type Field = {
  type: 'text' | 'password' | 'textarea' | 'choice' | 'checkbox';
  name: string;
  label: string;
  defaultValue?: string | boolean;
  required?: boolean;
  help?: string;
  options?: string[];
};

type Job = {
  id: string;
  category: string;
  title: string;
  description: string;
  jobName: string;
  configuredUrl: string;
  discoveryEnabled: boolean;
  fields: Field[];
};

type Role = 'admin' | 'developer';

type User = {
  username: string;
  displayName: string;
  role: Role;
  disabled?: boolean;
};

type JenkinsProgress = {
  state: string;
  percent: number;
  label: string;
  message: string;
  queueUrl?: string;
  buildUrl?: string;
  buildNumber?: number;
  durationMs?: number;
  estimatedDurationMs?: number;
  result?: string;
};

type JenkinsResult = {
  status: number;
  queueUrl?: string;
  jobUrl?: string;
  progress?: JenkinsProgress | null;
};

type Toast = {
  id: number;
  type: 'success' | 'error' | 'info';
  message: string;
};

type Theme = 'light' | 'dark';

type HistoryEntry = {
  id: string;
  jobId: string;
  jobTitle: string;
  category: string;
  requestedBy: string;
  requestId: string;
  submittedAt: number;
  status: string;
  label: string;
  queueUrl: string;
  buildUrl: string;
  jobUrl: string;
  values: Record<string, string>;
  decidedBy?: string | null;
  decidedAt?: number | null;
  declineReason?: string | null;
};

type ConfirmDialog = {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  items?: [string, string | boolean][];
  input?: { label: string; type: 'text' | 'password'; placeholder?: string };
  action: (inputValue: string) => void;
};

const CATEGORY_ACCENTS: Record<string, string> = {
  Applications: 'cat-blue',
  Kubernetes: 'cat-purple',
  Networking: 'cat-teal',
  Security: 'cat-red',
  Access: 'cat-amber'
};

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html'
})
class AppComponent implements OnInit {
  @ViewChild('searchInput') searchInputRef?: ElementRef<HTMLInputElement>;

  user: User | null = null;
  jobs: Job[] = [];
  selectedJob: Job | null = null;
  values: Record<string, string | boolean> = {};
  submittedValues: Record<string, string | boolean> = {};
  result: JenkinsResult | null = null;
  progress: JenkinsProgress | null = null;
  login = { username: '', password: '' };
  loading = true;
  submitting = false;
  polling = false;
  error = '';
  searchQuery = '';
  activeCategory: string | null = null;
  confirmDialog: ConfirmDialog | null = null;
  theme: Theme = 'light';
  toasts: Toast[] = [];
  showHistory = false;
  historyEntries: HistoryEntry[] = [];
  historyFilter: 'all' | 'pending' = 'all';
  historyLoading = false;
  expandedHistoryId: string | null = null;
  readonly historyRetentionDays = 7;
  sidebarOpen = false;

  pendingApproval = false;
  declined = false;
  declineReason = '';

  showApprovals = false;
  approvals: HistoryEntry[] = [];
  approvalsLoading = false;
  pendingApprovalsCount = 0;
  myPendingCount = 0;

  showUsers = false;
  adminUsers: User[] = [];
  usersLoading = false;
  newUser: { username: string; displayName: string; password: string; role: Role } = {
    username: '',
    displayName: '',
    password: '',
    role: 'developer'
  };
  creatingUser = false;

  confirmInputValue = '';

  private statusTimer: number | null = null;
  private toastSeq = 0;
  private terminalNotified = false;
  private historyId: string | null = null;
  private idleTimer: number | null = null;
  private idleWarningTimer: number | null = null;
  private lastActivityAt = 0;
  private readonly idleTimeoutMs = 15 * 60 * 1000;
  private readonly idleWarningLeadMs = 60 * 1000;
  private adminPollTimer: number | null = null;
  private myPendingPollTimer: number | null = null;

  async ngOnInit(): Promise<void> {
    this.initTheme();
    await this.loadSession();
  }

  @HostListener('window:mousemove')
  @HostListener('window:mousedown')
  @HostListener('window:keydown')
  @HostListener('window:touchstart')
  @HostListener('window:scroll')
  onUserActivity(): void {
    if (!this.user) return;
    const now = Date.now();
    if (now - this.lastActivityAt < 5000) return;
    this.lastActivityAt = now;
    this.resetIdleTimer();
  }

  @HostListener('window:keydown.escape')
  onEscape(): void {
    if (this.confirmDialog) {
      this.cancelConfirmDialog();
      return;
    }
    if (this.selectedJob || this.showHistory || this.showApprovals || this.showUsers) {
      this.back();
    }
  }

  @HostListener('window:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (this.user && !this.selectedJob && !this.showHistory && !this.showApprovals && !this.showUsers) {
      event.preventDefault();
      this.searchInputRef?.nativeElement.focus();
    }
  }

  initTheme(): void {
    const current = document.documentElement.getAttribute('data-theme');
    if (current === 'light' || current === 'dark') {
      this.theme = current;
      return;
    }
    const stored = localStorage.getItem('ss-theme');
    if (stored === 'light' || stored === 'dark') {
      this.theme = stored;
    } else {
      this.theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    this.applyTheme();
  }

  toggleTheme(): void {
    this.theme = this.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('ss-theme', this.theme);
    this.applyTheme();
  }

  private applyTheme(): void {
    document.documentElement.setAttribute('data-theme', this.theme);
  }

  async loadSession(): Promise<void> {
    this.loading = true;
    this.error = '';
    try {
      const response = await fetch('/api/me', { credentials: 'same-origin' });
      const data = await response.json();
      this.user = data.user;
      if (this.user) {
        await this.loadJobs();
        this.resetIdleTimer();
        this.startAdminPolling();
        this.startMyPendingPolling();
      }
    } catch (error) {
      this.notifyError(error);
    } finally {
      this.loading = false;
    }
  }

  async signIn(): Promise<void> {
    this.error = '';
    this.loading = true;
    try {
      const response = await this.api('/api/login', {
        method: 'POST',
        body: JSON.stringify(this.login)
      });
      const data = await response.json();
      this.user = data.user;
      this.login.password = '';
      await this.loadJobs();
      this.resetIdleTimer();
      this.startAdminPolling();
      this.startMyPendingPolling();
    } catch (error) {
      this.error = this.messageFrom(error);
    } finally {
      this.loading = false;
    }
  }

  async logout(): Promise<void> {
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
    this.clearIdleTimers();
    this.stopAdminPolling();
    this.stopMyPendingPolling();
    this.sidebarOpen = false;
    this.user = null;
    this.jobs = [];
    this.selectedJob = null;
    this.showHistory = false;
    this.showApprovals = false;
    this.showUsers = false;
    this.historyEntries = [];
    this.approvals = [];
    this.adminUsers = [];
    this.pendingApprovalsCount = 0;
    this.myPendingCount = 0;
    this.result = null;
    this.progress = null;
    this.searchQuery = '';
    this.activeCategory = null;
    this.stopPolling();
  }

  async loadJobs(): Promise<void> {
    const response = await this.api('/api/jobs');
    const data = await response.json();
    this.jobs = data.jobs;
  }

  categories(): string[] {
    const seen = new Set<string>();
    for (const job of this.jobs) seen.add(job.category);
    return Array.from(seen);
  }

  categoryClass(category: string): string {
    return CATEGORY_ACCENTS[category] || 'cat-blue';
  }

  setCategory(category: string | null): void {
    this.activeCategory = category;
  }

  filteredJobs(): Job[] {
    const query = this.searchQuery.trim().toLowerCase();
    return this.jobs.filter((job) => {
      if (this.activeCategory && job.category !== this.activeCategory) return false;
      if (!query) return true;
      return job.title.toLowerCase().includes(query)
        || job.description.toLowerCase().includes(query)
        || job.category.toLowerCase().includes(query);
    });
  }

  toggleSidebar(): void {
    this.sidebarOpen = !this.sidebarOpen;
  }

  closeSidebar(): void {
    this.sidebarOpen = false;
  }

  goDashboard(category: string | null = null): void {
    this.back();
    this.activeCategory = category;
  }

  isDashboardHome(): boolean {
    return !this.selectedJob && !this.showHistory && !this.showApprovals && !this.showUsers && !this.activeCategory;
  }

  isCategoryActive(category: string): boolean {
    return !this.selectedJob && !this.showHistory && !this.showApprovals && !this.showUsers && this.activeCategory === category;
  }

  isAdmin(): boolean {
    return this.user?.role === 'admin';
  }

  openHistory(): void {
    this.selectedJob = null;
    this.showApprovals = false;
    this.showUsers = false;
    this.result = null;
    this.progress = null;
    this.confirmDialog = null;
    this.sidebarOpen = false;
    this.stopPolling();
    this.error = '';
    this.showHistory = true;
    this.historyFilter = 'all';
    this.expandedHistoryId = null;
    this.loadHistory();
  }

  openApprovals(): void {
    this.selectedJob = null;
    this.showHistory = false;
    this.showUsers = false;
    this.result = null;
    this.progress = null;
    this.confirmDialog = null;
    this.sidebarOpen = false;
    this.stopPolling();
    this.error = '';
    this.showApprovals = true;
    this.loadApprovals();
  }

  openUsers(): void {
    this.selectedJob = null;
    this.showHistory = false;
    this.showApprovals = false;
    this.result = null;
    this.progress = null;
    this.confirmDialog = null;
    this.sidebarOpen = false;
    this.stopPolling();
    this.error = '';
    this.showUsers = true;
    this.loadUsersAdmin();
  }

  async loadApprovals(): Promise<void> {
    this.approvalsLoading = true;
    try {
      const response = await this.api('/api/approvals');
      const data = await response.json();
      this.approvals = data.approvals;
      this.pendingApprovalsCount = this.approvals.length;
    } catch (error) {
      this.notifyError(error);
    } finally {
      this.approvalsLoading = false;
    }
  }

  approveApproval(entry: HistoryEntry): void {
    this.confirmDialog = {
      title: 'Approve this request?',
      message: `"${entry.jobTitle}" requested by ${entry.requestedBy} will be sent to Jenkins immediately.`,
      confirmLabel: 'Approve & run',
      items: this.historyValueEntries(entry),
      action: () => this.decideApproval(entry.id, 'approve')
    };
  }

  declineApproval(entry: HistoryEntry): void {
    this.confirmDialog = {
      title: 'Decline this request?',
      message: `"${entry.jobTitle}" requested by ${entry.requestedBy} will be cancelled and will not run in Jenkins.`,
      confirmLabel: 'Decline request',
      danger: true,
      input: { label: 'Reason (optional)', type: 'text', placeholder: 'e.g. Wrong environment' },
      action: (reason) => this.decideApproval(entry.id, 'decline', reason)
    };
  }

  private async decideApproval(id: string, decision: 'approve' | 'decline', reason?: string): Promise<void> {
    try {
      await this.api(`/api/approvals/${id}/${decision}`, {
        method: 'POST',
        body: decision === 'decline' ? JSON.stringify({ reason: reason || '' }) : undefined
      });
      this.approvals = this.approvals.filter((item) => item.id !== id);
      this.pendingApprovalsCount = this.approvals.length;
      this.pushToast(
        decision === 'approve' ? 'success' : 'info',
        decision === 'approve' ? 'Request approved and sent to Jenkins.' : 'Request declined.'
      );
    } catch (error) {
      this.notifyError(error);
    }
  }

  async loadUsersAdmin(): Promise<void> {
    this.usersLoading = true;
    try {
      const response = await this.api('/api/admin/users');
      const data = await response.json();
      this.adminUsers = data.users;
    } catch (error) {
      this.notifyError(error);
    } finally {
      this.usersLoading = false;
    }
  }

  async createUser(): Promise<void> {
    if (!this.newUser.username.trim() || !this.newUser.password) {
      this.pushToast('error', 'Username and password are required.');
      return;
    }
    this.creatingUser = true;
    try {
      await this.api('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify(this.newUser)
      });
      this.pushToast('success', `User ${this.newUser.username} created.`);
      this.newUser = { username: '', displayName: '', password: '', role: 'developer' };
      await this.loadUsersAdmin();
    } catch (error) {
      this.notifyError(error);
    } finally {
      this.creatingUser = false;
    }
  }

  changeUserPassword(targetUser: User): void {
    this.confirmDialog = {
      title: `Change password for ${targetUser.username}`,
      message: 'Set a new password for this user. They will need it on their next sign-in.',
      confirmLabel: 'Update password',
      input: { label: 'New password', type: 'password', placeholder: 'At least 8 characters' },
      action: (password) => this.submitPasswordChange(targetUser.username, password)
    };
  }

  private async submitPasswordChange(username: string, password: string): Promise<void> {
    if (!password || password.length < 8) {
      this.pushToast('error', 'Password must be at least 8 characters.');
      return;
    }
    try {
      await this.api(`/api/admin/users/${encodeURIComponent(username)}/password`, {
        method: 'POST',
        body: JSON.stringify({ password })
      });
      this.pushToast('success', `Password updated for ${username}.`);
    } catch (error) {
      this.notifyError(error);
    }
  }

  toggleUserDisabled(targetUser: User): void {
    const nextDisabled = !targetUser.disabled;
    this.confirmDialog = {
      title: nextDisabled ? `Disable ${targetUser.username}?` : `Enable ${targetUser.username}?`,
      message: nextDisabled
        ? `${targetUser.username} will be immediately signed out and unable to sign in until re-enabled.`
        : `${targetUser.username} will be able to sign in again.`,
      confirmLabel: nextDisabled ? 'Disable user' : 'Enable user',
      danger: nextDisabled,
      action: () => this.submitUserDisabled(targetUser.username, nextDisabled)
    };
  }

  private async submitUserDisabled(username: string, disabled: boolean): Promise<void> {
    try {
      await this.api(`/api/admin/users/${encodeURIComponent(username)}/${disabled ? 'disable' : 'enable'}`, { method: 'POST' });
      await this.loadUsersAdmin();
      this.pushToast('success', `${username} ${disabled ? 'disabled' : 'enabled'}.`);
    } catch (error) {
      this.notifyError(error);
    }
  }

  deleteUserPrompt(targetUser: User): void {
    this.confirmDialog = {
      title: `Delete ${targetUser.username}?`,
      message: 'This permanently removes the user account. This cannot be undone.',
      confirmLabel: 'Delete user',
      danger: true,
      action: () => this.submitDeleteUser(targetUser.username)
    };
  }

  private async submitDeleteUser(username: string): Promise<void> {
    try {
      await this.api(`/api/admin/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
      this.adminUsers = this.adminUsers.filter((item) => item.username !== username);
      this.pushToast('success', `${username} deleted.`);
    } catch (error) {
      this.notifyError(error);
    }
  }

  private async refreshPendingApprovalsCount(): Promise<void> {
    if (!this.isAdmin()) return;
    try {
      const response = await this.api('/api/approvals');
      const data = await response.json();
      this.pendingApprovalsCount = (data.approvals as HistoryEntry[]).length;
    } catch {
      // Best-effort badge count; ignore transient errors.
    }
  }

  private startAdminPolling(): void {
    if (!this.isAdmin()) return;
    this.stopAdminPolling();
    this.refreshPendingApprovalsCount();
    this.adminPollTimer = window.setInterval(() => this.refreshPendingApprovalsCount(), 30000);
  }

  private stopAdminPolling(): void {
    if (this.adminPollTimer) {
      window.clearInterval(this.adminPollTimer);
      this.adminPollTimer = null;
    }
  }

  private async refreshMyPendingCount(): Promise<void> {
    if (this.isAdmin()) return;
    try {
      const response = await this.api('/api/history');
      const data = await response.json();
      this.myPendingCount = (data.history as HistoryEntry[]).filter((entry) => entry.status === 'pending_approval').length;
    } catch {
      // Best-effort badge count; ignore transient errors.
    }
  }

  private startMyPendingPolling(): void {
    if (this.isAdmin()) return;
    this.stopMyPendingPolling();
    this.refreshMyPendingCount();
    this.myPendingPollTimer = window.setInterval(() => this.refreshMyPendingCount(), 30000);
  }

  private stopMyPendingPolling(): void {
    if (this.myPendingPollTimer) {
      window.clearInterval(this.myPendingPollTimer);
      this.myPendingPollTimer = null;
    }
  }

  async loadHistory(): Promise<void> {
    this.historyLoading = true;
    try {
      const response = await this.api('/api/history');
      const data = await response.json();
      this.historyEntries = data.history;
      if (!this.isAdmin()) {
        this.myPendingCount = this.historyEntries.filter((entry) => entry.status === 'pending_approval').length;
      }
    } catch (error) {
      this.notifyError(error);
    } finally {
      this.historyLoading = false;
    }
  }

  clearHistory(): void {
    if (this.historyEntries.length === 0) return;
    this.confirmDialog = {
      title: 'Clear run history',
      message: 'This permanently deletes all of your stored run history. This cannot be undone.',
      confirmLabel: 'Clear history',
      danger: true,
      action: async () => {
        try {
          await this.api('/api/history', { method: 'DELETE' });
          this.historyEntries = [];
          this.pushToast('info', 'Run history cleared.');
        } catch (error) {
          this.notifyError(error);
        }
      }
    };
  }

  async deleteHistoryEntry(id: string): Promise<void> {
    try {
      await this.api(`/api/history/${id}`, { method: 'DELETE' });
      this.historyEntries = this.historyEntries.filter((entry) => entry.id !== id);
    } catch (error) {
      this.notifyError(error);
    }
  }

  filteredHistoryEntries(): HistoryEntry[] {
    if (this.historyFilter === 'pending') {
      return this.historyEntries.filter((entry) => entry.status === 'pending_approval');
    }
    return this.historyEntries;
  }

  historyValueEntries(entry: HistoryEntry): [string, string][] {
    return Object.entries(entry.values).filter(([, value]) => value !== '');
  }

  toggleHistoryDetails(id: string): void {
    this.expandedHistoryId = this.expandedHistoryId === id ? null : id;
  }

  formatDate(ms: number): string {
    return new Date(ms).toLocaleString();
  }

  openJob(job: Job): void {
    this.selectedJob = job;
    this.showHistory = false;
    this.showApprovals = false;
    this.showUsers = false;
    this.sidebarOpen = false;
    this.result = null;
    this.progress = null;
    this.pendingApproval = false;
    this.declined = false;
    this.declineReason = '';
    this.confirmDialog = null;
    this.terminalNotified = false;
    this.historyId = null;
    this.stopPolling();
    this.error = '';
    this.values = {};
    for (const field of job.fields) {
      this.values[field.name] = field.defaultValue ?? (field.type === 'checkbox' ? false : '');
    }
  }

  fieldVisible(field: Field): boolean {
    if (this.selectedJob?.id !== 'route53-record') return true;
    const configureNginx = this.valueAsBoolean('CONFIGURE_NGINX');
    const action = this.valueAsString('ACTION');
    const nginxFields = ['NGINX_DOMAIN', 'NGINX_PROXY_HOST', 'NGINX_PROXY_PORT', 'NGINX_SITE_FILE', 'RUN_CERTBOT'];
    if (!nginxFields.includes(field.name)) return true;
    if (!configureNginx) return false;
    if (action === 'delete' && ['NGINX_PROXY_HOST', 'NGINX_PROXY_PORT', 'RUN_CERTBOT'].includes(field.name)) return false;
    return true;
  }

  back(): void {
    this.selectedJob = null;
    this.showHistory = false;
    this.showApprovals = false;
    this.showUsers = false;
    this.sidebarOpen = false;
    this.result = null;
    this.progress = null;
    this.confirmDialog = null;
    this.stopPolling();
    this.error = '';
  }

  isDestructive(job: Job | null): boolean {
    if (!job) return false;
    if (job.id.startsWith('remove-')) return true;
    if (job.id === 'route53-record' && this.valueAsString('ACTION') === 'delete') return true;
    return false;
  }

  requestSubmit(): void {
    if (!this.selectedJob) return;
    const errors = this.validationErrors();
    if (errors.length > 0) {
      this.error = errors.join(' ');
      return;
    }
    this.error = '';
    if (this.isDestructive(this.selectedJob)) {
      this.confirmDialog = {
        title: 'This request is destructive',
        message: `"${this.selectedJob.title}" will remove or revoke access. Double-check the values below before continuing.`,
        confirmLabel: 'Yes, submit request',
        danger: true,
        items: this.currentValueEntries(),
        action: () => this.submit()
      };
      return;
    }
    this.submit();
  }

  cancelConfirmDialog(): void {
    this.confirmDialog = null;
    this.confirmInputValue = '';
  }

  runConfirmed(): void {
    const dialog = this.confirmDialog;
    const inputValue = this.confirmInputValue;
    this.confirmDialog = null;
    this.confirmInputValue = '';
    dialog?.action(inputValue);
  }

  async submit(): Promise<void> {
    if (!this.selectedJob) return;
    this.submitting = true;
    this.error = '';
    this.result = null;
    this.progress = null;
    this.pendingApproval = false;
    this.declined = false;
    this.declineReason = '';
    this.terminalNotified = false;
    this.historyId = null;
    this.stopPolling();
    try {
      const response = await this.api(`/api/jobs/${this.selectedJob.id}`, {
        method: 'POST',
        body: JSON.stringify({ values: this.values })
      });
      const data = await response.json();
      this.submittedValues = data.values;
      this.historyId = data.historyId ?? null;
      if (data.pendingApproval) {
        this.pendingApproval = true;
        this.progress = {
          state: 'pending_approval',
          percent: 0,
          label: 'Pending Approval',
          message: 'Waiting for an admin to approve this request.'
        };
        this.pushToast('info', 'Request sent for admin approval.');
      } else {
        this.result = data.result;
        this.progress = data.result.progress ?? null;
        this.pushToast('success', 'Request submitted to Jenkins.');
      }
      this.startStatusPolling();
    } catch (error) {
      this.notifyError(error);
    } finally {
      this.submitting = false;
    }
  }

  fieldId(field: Field): string {
    return `field-${field.name}`;
  }

  fieldOptions(field: Field): string[] {
    return field.options ?? [];
  }

  visibleSubmittedValues(): [string, string | boolean][] {
    return Object.entries(this.submittedValues);
  }

  currentValueEntries(): [string, string | boolean][] {
    if (!this.selectedJob) return [];
    return this.selectedJob.fields
      .filter((field) => field.type !== 'password')
      .map((field) => [field.label, this.values[field.name]] as [string, string | boolean])
      .filter(([, value]) => value !== '' && value !== undefined && value !== null && value !== false);
  }

  validationErrors(): string[] {
    if (!this.selectedJob) return [];
    const errors: string[] = [];

    for (const field of this.selectedJob.fields) {
      if (!this.fieldVisible(field) || field.required === false || field.type === 'checkbox') continue;
      const value = this.values[field.name];
      if (value === undefined || value === null || String(value).trim() === '') {
        errors.push(`${field.label} is required.`);
      }
    }

    if (this.selectedJob.id === 'route53-record') {
      const action = this.valueAsString('ACTION');
      const configureNginx = this.valueAsBoolean('CONFIGURE_NGINX');
      const ttl = Number(this.valueAsString('TTL'));
      const port = Number(this.valueAsString('NGINX_PROXY_PORT'));

      if (!Number.isInteger(ttl) || ttl < 30 || ttl > 86400) {
        errors.push('TTL must be a number between 30 and 86400.');
      }

      if (configureNginx && ['create', 'update'].includes(action)) {
        if (!this.valueAsString('NGINX_PROXY_HOST')) {
          errors.push('Backend IP/Host is required when Configure Nginx is enabled.');
        }
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          errors.push('Backend Port must be between 1 and 65535.');
        }
      }
    }

    if (this.selectedJob.id === 'app-deployment') {
      const nodePort = Number(this.valueAsString('NODE_PORT'));
      if (!Number.isInteger(nodePort) || nodePort < 30000 || nodePort > 32767) {
        errors.push('NodePort must be in the Kubernetes NodePort range, usually 30000-32767.');
      }
    }

    return errors;
  }

  canSubmit(): boolean {
    return !this.submitting && this.validationErrors().length === 0;
  }

  progressPercent(): number {
    return Math.max(0, Math.min(100, Math.round(this.progress?.percent ?? 0)));
  }

  progressClass(): string {
    return this.stateClass(this.progress?.state || '');
  }

  stateClass(state: string): string {
    if (state === 'success') return 'success';
    if (['failure', 'failed', 'aborted', 'cancelled', 'unstable', 'declined'].includes(state)) return 'failed';
    if (state === 'building') return 'building';
    if (state === 'pending_approval') return 'pending';
    return 'queued';
  }

  isTerminalProgress(): boolean {
    const state = this.progress?.state || '';
    return ['success', 'failure', 'failed', 'aborted', 'cancelled', 'unstable', 'completed', 'declined'].includes(state);
  }

  async copyText(value: string): Promise<void> {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      this.pushToast('info', 'Copied to clipboard.');
    } catch {
      this.pushToast('error', 'Could not copy to clipboard.');
    }
  }

  pushToast(type: Toast['type'], message: string): void {
    const id = ++this.toastSeq;
    this.toasts.push({ id, type, message });
    window.setTimeout(() => this.dismissToast(id), 5000);
  }

  dismissToast(id: number): void {
    this.toasts = this.toasts.filter((toast) => toast.id !== id);
  }

  private notifyError(error: unknown): void {
    this.error = this.messageFrom(error);
    this.pushToast('error', this.error);
  }

  private resetIdleTimer(): void {
    this.clearIdleTimers();
    if (!this.user) return;
    this.idleWarningTimer = window.setTimeout(() => {
      this.pushToast('info', 'You will be signed out in 1 minute due to inactivity.');
    }, this.idleTimeoutMs - this.idleWarningLeadMs);
    this.idleTimer = window.setTimeout(() => this.handleIdleLogout(), this.idleTimeoutMs);
  }

  private clearIdleTimers(): void {
    if (this.idleWarningTimer) {
      window.clearTimeout(this.idleWarningTimer);
      this.idleWarningTimer = null;
    }
    if (this.idleTimer) {
      window.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async handleIdleLogout(): Promise<void> {
    this.clearIdleTimers();
    await this.logout();
    this.pushToast('info', 'You were signed out due to inactivity.');
  }

  private startStatusPolling(): void {
    if (!this.historyId) return;
    if (!this.pendingApproval && !this.result?.queueUrl && !this.progress?.buildUrl) return;
    this.polling = true;
    this.pollStatus();
    this.statusTimer = window.setInterval(() => this.pollStatus(), 5000);
  }

  private stopPolling(): void {
    if (this.statusTimer) {
      window.clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    this.polling = false;
  }

  private async pollStatus(): Promise<void> {
    if (!this.historyId) return;
    const queueUrl = encodeURIComponent(this.result?.queueUrl || '');
    const buildUrl = encodeURIComponent(this.progress?.buildUrl || '');
    try {
      const response = await this.api(`/api/jenkins/status?queueUrl=${queueUrl}&buildUrl=${buildUrl}&historyId=${encodeURIComponent(this.historyId)}`);
      const data = await response.json();
      this.progress = data.status;

      if (data.queueUrl || data.jobUrl) {
        this.result = {
          status: 200,
          queueUrl: data.queueUrl || this.result?.queueUrl || '',
          jobUrl: data.jobUrl || this.result?.jobUrl || '',
          progress: this.progress
        };
      } else if (this.result) {
        this.result = { ...this.result, progress: this.progress };
      }

      if (this.progress?.state === 'pending_approval') {
        this.pendingApproval = true;
      } else if (this.progress?.state === 'declined') {
        this.pendingApproval = false;
        this.declined = true;
        this.declineReason = this.progress.message || '';
        this.stopPolling();
        this.pushToast('error', 'Your request was declined by an admin.');
      } else {
        if (this.pendingApproval) {
          this.pendingApproval = false;
          this.pushToast('success', 'Approved — request sent to Jenkins.');
        }
        if (this.isTerminalProgress()) {
          this.stopPolling();
          this.notifyTerminalResult();
        }
      }
    } catch (error) {
      this.progress = {
        state: 'unknown',
        percent: this.progressPercent(),
        label: 'Status unavailable',
        message: this.messageFrom(error)
      };
      this.stopPolling();
    }
  }

  private notifyTerminalResult(): void {
    if (this.terminalNotified) return;
    this.terminalNotified = true;
    const cls = this.progressClass();
    if (cls === 'success') {
      this.pushToast('success', 'Jenkins build finished successfully.');
    } else if (cls === 'failed') {
      this.pushToast('error', 'Jenkins build finished with a failure.');
    }
  }

  private valueAsString(name: string): string {
    const value = this.values[name];
    return typeof value === 'string' ? value.trim() : '';
  }

  private valueAsBoolean(name: string): boolean {
    return this.values[name] === true || this.values[name] === 'true';
  }

  private async api(url: string, options: RequestInit = {}): Promise<Response> {
    const response = await fetch(url, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...options
    });
    if (!response.ok) {
      let message = `Request failed with HTTP ${response.status}`;
      try {
        const data = await response.json();
        message = data.error || message;
      } catch {
        message = await response.text();
      }
      throw new Error(message);
    }
    return response;
  }

  private messageFrom(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

bootstrapApplication(AppComponent).catch((error) => console.error(error));
