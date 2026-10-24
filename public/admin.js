// Administration workspace. The server enforces the admin role on every /api/admin route;
// this file only renders what those routes return.

let adminTab = 'overview';

function adminTable(headers, rows) {
  if (!rows.length) return h('p', { class: 'empty-state', text: 'Nothing to show.' });
  return h('div', { class: 'table-wrap' },
    h('table', { class: 'data-table' },
      h('thead', {}, h('tr', {}, headers.map((label) => h('th', { scope: 'col', text: label })))),
      h('tbody', {}, rows.map((cells) => h('tr', {}, cells.map((cell) => h('td', {}, cell)))))));
}

function actionButton(label, onClick, className = 'text-button') {
  const button = h('button', { type: 'button', class: className, text: label });
  button.addEventListener('click', onClick);
  return button;
}

function filterSelect(options, current, onChange) {
  const select = h('select', { class: 'filter-select', 'aria-label': 'Filter by status' },
    options.map(([value, label]) => h('option', { value, selected: value === current, text: label })));
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

const adminViews = {
  async overview(panel) {
    const data = await api('/api/admin/overview');
    const stat = (label, value) => h('div', { class: 'panel stat-card' }, h('small', { text: label }), h('strong', { text: String(value) }));
    panel.append(
      h('div', { class: 'stat-grid' },
        stat('Accounts', data.counts.users),
        stat('Pending verifications', data.counts.pendingVerifications),
        stat('Verified doctors', data.counts.verifiedDoctors),
        stat('Open reports', data.counts.openReports),
        stat('Suspended accounts', data.counts.suspendedUsers),
        stat('Active sessions', data.counts.activeSessions)),
      h('div', { class: 'panel admin-section' },
        h('h3', { text: 'Application health' }),
        adminTable(['Check', 'Status'], [
          ['Database integrity', data.database.integrity === 'ok' ? 'OK' : String(data.database.integrity)],
          ['Database size', formatBytes(data.database.sizeBytes)],
          ['Applied migrations', data.database.migrations.map((migration) => migration.name).join(', ')],
          ['AI provider', data.ai.configured ? 'Configured' : 'Not configured (AI_API_KEY missing)'],
          ['AI image input', data.ai.images ? 'Enabled' : 'Disabled'],
          ['AI PDF input', data.ai.documents ? 'Enabled' : 'Disabled'],
          ['Server uptime', `${Math.floor(data.uptimeSeconds / 3600)} h ${Math.floor((data.uptimeSeconds % 3600) / 60)} min`],
          ['Memory use', `${data.memoryMb} MB`],
          ['Node.js', data.nodeVersion]
        ])));
  },

  async verifications(panel, filter = 'submitted') {
    const data = await api(`/api/admin/verifications${filter ? `?status=${filter}` : ''}`);
    panel.append(h('div', { class: 'admin-toolbar' },
      h('p', { class: 'small-muted', text: 'Check each registration number with the issuing authority before approving. An uploaded document alone is not proof.' }),
      filterSelect([['submitted', 'Awaiting review'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['', 'All']], filter,
        (value) => renderAdmin('verifications', value))));
    if (!data.verifications.length) {
      panel.append(h('p', { class: 'empty-state', text: 'No verification requests in this view.' }));
    }
    for (const item of data.verifications) {
      const actions = h('div', { class: 'appointment-actions' });
      if (item.hasCredential) {
        actions.append(h('a', { class: 'text-button', href: `/api/admin/verifications/${encodeURIComponent(item.id)}/credential`, target: '_blank', rel: 'noopener', text: 'Open submitted document' }));
      }
      if (item.status === 'submitted') {
        const decide = (decision) => () => openFormDialog({
          eyebrow: 'DOCTOR VERIFICATION',
          title: `${decision === 'approve' ? 'Approve' : 'Reject'} ${item.doctorName}`,
          intro: decision === 'approve'
            ? 'Approve only after confirming the registration details with the issuing authority.'
            : 'The doctor will see this note and can correct their details and resubmit.',
          submitLabel: decision === 'approve' ? 'Approve' : 'Reject',
          fields: [{ name: 'notes', label: decision === 'approve' ? 'How you verified the registration' : 'What needs to change', type: 'textarea', required: decision === 'reject', optional: decision === 'approve', maxLength: 1000 }],
          onSubmit: async (values) => {
            await api(`/api/admin/verifications/${encodeURIComponent(item.id)}/decision`, { method: 'POST', body: JSON.stringify({ decision, notes: values.notes }) });
            showToast(decision === 'approve' ? 'Doctor verified.' : 'Verification rejected.');
            renderAdmin('verifications', filter);
          }
        });
        actions.append(actionButton('Approve', decide('approve'), 'button button-primary button-small'), actionButton('Reject', decide('reject'), 'button button-danger button-small'));
      }
      if (item.profileStatus === 'verified' && item.status === 'approved') {
        actions.append(actionButton('Revoke verification', () => openFormDialog({
          eyebrow: 'REVOKE VERIFICATION',
          title: item.doctorName,
          intro: 'The doctor is removed from the directory immediately and loses access to shared patient records.',
          submitLabel: 'Revoke',
          fields: [{ name: 'notes', label: 'Reason', type: 'textarea', required: true, maxLength: 1000 }],
          onSubmit: async (values) => {
            await api(`/api/admin/doctors/${encodeURIComponent(item.doctorId)}/revoke`, { method: 'POST', body: JSON.stringify(values) });
            showToast('Verification revoked.');
            renderAdmin('verifications', filter);
          }
        }), 'delete-appointment'));
      }
      panel.append(h('article', { class: 'panel admin-card' },
        h('div', { class: 'appointment-card-top' }, h('h3', { text: item.doctorName }), statusPill(item.status)),
        h('p', { class: 'small-muted', text: `${item.doctorEmail} · submitted ${formatDateTime(item.submittedAt)}${item.accountStatus !== 'active' ? ' · account suspended' : ''}` }),
        detail('Specialization', item.specialization),
        detail('Qualifications', item.qualifications),
        detail('Registration', `${item.registrationNumber} — ${item.registrationAuthority}, ${item.registrationCountry}`),
        detail('Experience', item.yearsExperience !== null ? `${item.yearsExperience} years` : ''),
        detail('Practice', [item.clinicName, item.clinicAddress].filter(Boolean).join(', ')),
        detail('Reviewer note', item.reviewerNotes ? `${item.reviewerNotes}${item.reviewerName ? ` (${item.reviewerName})` : ''}` : ''),
        actions));
    }
  },

  async users(panel, query = '') {
    const data = await api(`/api/admin/users${query ? `?q=${encodeURIComponent(query)}` : ''}`);
    const search = h('form', { class: 'search-row', role: 'search' },
      h('input', { type: 'search', name: 'q', maxlength: 80, placeholder: 'Search by name or email', value: query, 'aria-label': 'Search users' }),
      h('button', { class: 'button button-primary', type: 'submit', text: 'Search' }));
    search.addEventListener('submit', (event) => {
      event.preventDefault();
      renderAdmin('users', search.elements.q.value.trim());
    });
    panel.append(search, adminTable(['Name', 'Email', 'Roles', 'Status', 'Joined', ''], data.users.map((user) => {
      const suspended = user.status === 'suspended';
      const self = user.id === state.user.id;
      const toggle = self ? h('span', { class: 'small-muted', text: 'You' }) : actionButton(suspended ? 'Reinstate' : 'Suspend', () => openFormDialog({
        eyebrow: 'ACCOUNT STATUS',
        title: `${suspended ? 'Reinstate' : 'Suspend'} ${user.name}`,
        intro: suspended ? 'The person will be able to sign in again.' : 'The person is signed out everywhere and cannot sign in until reinstated. Their data is kept.',
        submitLabel: suspended ? 'Reinstate' : 'Suspend',
        fields: [{ name: 'reason', label: 'Reason', type: 'textarea', required: !suspended, optional: suspended, maxLength: 500 }],
        onSubmit: async (values) => {
          await api(`/api/admin/users/${encodeURIComponent(user.id)}/status`, { method: 'POST', body: JSON.stringify({ status: suspended ? 'active' : 'suspended', reason: values.reason }) });
          showToast(suspended ? 'Account reinstated.' : 'Account suspended.');
          renderAdmin('users', query);
        }
      }), suspended ? 'text-button' : 'delete-appointment');
      return [
        user.name,
        user.email,
        user.roles.join(', ') + (user.doctorStatus ? ` (${STATUS_LABELS[user.doctorStatus] || user.doctorStatus})` : ''),
        suspended ? h('span', { title: user.statusReason || '' }, statusPill('suspended')) : 'Active',
        formatDateTime(user.createdAt, { dateStyle: 'medium' }),
        toggle
      ];
    })));
  },

  async reports(panel, filter = 'open') {
    const data = await api(`/api/admin/reports${filter ? `?status=${filter}` : ''}`);
    panel.append(h('div', { class: 'admin-toolbar' },
      h('p', { class: 'small-muted', text: 'Reports of AI responses include only the reported response text, never the user\'s question or conversation.' }),
      filterSelect([['open', 'Open'], ['reviewing', 'Reviewing'], ['resolved', 'Resolved'], ['dismissed', 'Dismissed'], ['', 'All']], filter,
        (value) => renderAdmin('reports', value))));
    if (!data.reports.length) panel.append(h('p', { class: 'empty-state', text: 'No reports in this view.' }));
    for (const report of data.reports) {
      const update = actionButton('Update status', () => openFormDialog({
        eyebrow: 'REPORT',
        title: 'Update report',
        submitLabel: 'Save',
        fields: [
          { name: 'status', label: 'Status', type: 'select', value: report.status, options: [['open', 'Open'], ['reviewing', 'Reviewing'], ['resolved', 'Resolved'], ['dismissed', 'Dismissed']].map(([value, label]) => ({ value, label })) },
          { name: 'note', label: 'Resolution note', type: 'textarea', optional: true, maxLength: 1000, value: report.resolutionNote }
        ],
        onSubmit: async (values) => {
          await api(`/api/admin/reports/${encodeURIComponent(report.id)}`, { method: 'PUT', body: JSON.stringify(values) });
          showToast('Report updated.');
          renderAdmin('reports', filter);
        }
      }), 'button button-outline button-small');
      const snapshot = report.snapshot ? h('details', { class: 'report-snapshot' }, h('summary', { text: 'Reported AI response' }), h('p', { text: report.snapshot })) : null;
      panel.append(h('article', { class: 'panel admin-card' },
        h('div', { class: 'appointment-card-top' },
          h('h3', { text: report.targetType === 'doctor' ? `Doctor listing: ${report.targetName || 'deleted account'}` : 'AI response' }),
          h('span', { class: 'status-pill', text: report.status })),
        h('p', { class: 'small-muted', text: `Reported by ${report.reporterName || 'deleted account'} · ${formatDateTime(report.createdAt)}` }),
        detail('Reason', report.reason),
        snapshot,
        detail('Resolution', report.resolutionNote),
        h('div', { class: 'appointment-actions' }, update)));
    }
  },

  async content(panel) {
    const data = await api('/api/admin/content');
    const edit = (item = null) => openFormDialog({
      eyebrow: 'HEALTH CONTENT',
      title: item ? 'Edit article' : 'New article',
      intro: 'Published articles appear in every user\'s Relaxation screen. Use "## " for headings and "- " for lists.',
      submitLabel: 'Save article',
      fields: [
        { name: 'title', label: 'Title', required: true, maxLength: 160, value: item?.title },
        { name: 'category', label: 'Category', type: 'select', value: item?.category || 'relaxation', options: [{ value: 'relaxation', label: 'Relaxation' }, { value: 'education', label: 'Health education' }] },
        { name: 'summary', label: 'Summary', optional: true, maxLength: 300, value: item?.summary },
        { name: 'body', label: 'Article', type: 'textarea', rows: 8, required: true, maxLength: 8000, value: item?.body },
        { name: 'status', label: 'Status', type: 'select', value: item?.status || 'draft', options: [{ value: 'draft', label: 'Draft (not visible)' }, { value: 'published', label: 'Published' }] }
      ],
      onSubmit: async (values) => {
        await api(item ? `/api/admin/content/${encodeURIComponent(item.id)}` : '/api/admin/content', { method: item ? 'PUT' : 'POST', body: JSON.stringify(values) });
        showToast('Article saved.');
        renderAdmin('content');
      }
    });
    panel.append(h('div', { class: 'admin-toolbar' },
      h('p', { class: 'small-muted', text: 'Only publish content that has been reviewed by a qualified person.' }),
      actionButton('New article', () => edit(), 'button button-primary')));
    panel.append(adminTable(['Title', 'Category', 'Status', 'Updated', ''], data.content.map((item) => [
      item.title,
      item.category === 'relaxation' ? 'Relaxation' : 'Health education',
      h('span', { class: 'status-pill', text: item.status }),
      formatDateTime(item.updatedAt),
      h('span', { class: 'table-actions' },
        actionButton('Edit', () => edit(item)),
        actionButton('Delete', async () => {
          if (!window.confirm(`Delete "${item.title}"?`)) return;
          try {
            await api(`/api/admin/content/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
            renderAdmin('content');
          } catch (error) {
            showToast(error.message);
          }
        }, 'delete-appointment'))
    ])));
  },

  async audit(panel, before = '') {
    const data = await api(`/api/admin/audit-logs${before ? `?before=${encodeURIComponent(before)}` : ''}`);
    panel.append(adminTable(['Time', 'Actor', 'Action', 'Target', 'Details', 'IP'], data.logs.map((log) => [
      formatDateTime(log.createdAt),
      log.actorName || (log.ipAddress === 'cli' ? 'Server CLI' : '—'),
      log.action,
      log.targetType ? `${log.targetType} ${String(log.targetId || '').slice(0, 8)}` : '—',
      Object.keys(log.details).length ? JSON.stringify(log.details) : '—',
      log.ipAddress || '—'
    ])));
    if (data.logs.length === 100) {
      panel.append(actionButton('Older entries', () => renderAdmin('audit', data.logs.at(-1).createdAt), 'button button-outline'));
    }
  },

  async settings(panel) {
    const data = await api('/api/admin/settings');
    const form = h('form', { class: 'panel admin-section settings-form' },
      h('label', { class: 'toggle-row' }, h('span', {}, h('b', { text: 'Allow new registrations' }), h('small', { text: 'Existing accounts can always sign in.' })),
        h('input', { type: 'checkbox', name: 'registrationOpen', checked: data.settings.registration_open !== 'false' })),
      h('label', { class: 'toggle-row' }, h('span', {}, h('b', { text: 'Allow doctor registrations' }), h('small', { text: 'New doctor accounts always start unverified.' })),
        h('input', { type: 'checkbox', name: 'doctorRegistrationOpen', checked: data.settings.doctor_registration_open !== 'false' })),
      h('label', { class: 'form-field' }, 'Announcement banner', h('textarea', { name: 'announcement', rows: 2, maxlength: 500 }),
        h('small', { text: 'Shown to everyone, including on the sign-in page. Leave empty to hide.' })),
      h('p', { class: 'form-feedback', 'aria-live': 'polite' }),
      h('button', { class: 'button button-primary', type: 'submit', text: 'Save settings' }));
    form.elements.announcement.value = data.settings.announcement || '';
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const feedback = form.querySelector('.form-feedback');
      try {
        await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({
          registrationOpen: form.elements.registrationOpen.checked,
          doctorRegistrationOpen: form.elements.doctorRegistrationOpen.checked,
          announcement: form.elements.announcement.value.trim()
        }) });
        feedback.textContent = 'Settings saved.';
        loadConfig();
      } catch (error) {
        feedback.textContent = error.message;
      }
    });
    panel.append(form);
  }
};

async function renderAdmin(tab = adminTab, argument) {
  adminTab = tab;
  $$('[data-admin-tab]').forEach((button) => {
    const active = button.dataset.adminTab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  const panel = $('#admin-panel');
  panel.replaceChildren(h('p', { class: 'empty-state', text: 'Loading…' }));
  try {
    const content = h('div');
    await adminViews[tab](content, argument);
    panel.replaceChildren(...content.childNodes);
  } catch (error) {
    panel.replaceChildren(h('p', { class: 'notice notice-warn', text: error.message }));
  }
}

$$('[data-admin-tab]').forEach((button) => button.addEventListener('click', () => renderAdmin(button.dataset.adminTab)));
screenLoaders.admin = () => renderAdmin();
