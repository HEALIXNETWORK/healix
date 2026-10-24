// Doctor directory, patient consultations, and the doctor workspace. Uses helpers from app.js.

const STATUS_LABELS = {
  pending_verification: 'Pending verification',
  verified: 'Verified',
  rejected: 'Changes requested',
  revoked: 'Verification revoked',
  requested: 'Awaiting doctor',
  accepted: 'Accepted',
  declined: 'Declined',
  cancelled: 'Cancelled',
  completed: 'Completed',
  submitted: 'Under review',
  approved: 'Approved',
  suspended: 'Suspended'
};

function statusPill(status) {
  return h('span', { class: `status-pill status-${status}`, text: STATUS_LABELS[status] || status });
}

function detail(label, value) {
  return value ? h('p', { class: 'card-detail' }, h('b', { text: `${label}: ` }), value) : null;
}

// --- Directory ------------------------------------------------------------------------------------

const DEPARTMENT_ICONS = {
  'General Medicine': '✚', Cardiology: '♥', Dermatology: '◐', Pediatrics: '☺', 'Obstetrics & Gynecology': '♀',
  Orthopedics: '⊥', Neurology: '✺', Psychiatry: '❋', 'ENT (Ear, Nose & Throat)': '◖', Ophthalmology: '◉',
  Gastroenterology: '◒', Pulmonology: '≋', Endocrinology: '⬡', Nephrology: '◗', Urology: '◇', Oncology: '✧',
  Dentistry: '◡', Physiotherapy: '↻', Other: '•'
};
const directory = { doctors: [], view: 'department', department: null };

function doctorCard(doctor) {
  const actions = h('div', { class: 'appointment-actions' });
  if (doctor.id !== state.user.id) {
    const request = h('button', { type: 'button', class: 'button button-primary button-small', disabled: !doctor.acceptingConsultations,
      text: doctor.acceptingConsultations ? 'Request consultation' : 'Not accepting requests' });
    request.addEventListener('click', () => requestConsultation(doctor));
    const report = h('button', { type: 'button', class: 'delete-appointment', text: 'Report listing' });
    report.addEventListener('click', () => openFormDialog({
      eyebrow: 'REPORT A LISTING',
      title: `Report ${doctor.name}`,
      intro: 'Tell the HEALIX administrators what looks wrong with this listing.',
      submitLabel: 'Send report',
      fields: [{ name: 'reason', label: 'Describe the problem', type: 'textarea', required: true, maxLength: 1000 }],
      onSubmit: async (values) => {
        await api('/api/reports', { method: 'POST', body: JSON.stringify({ targetType: 'doctor', targetId: doctor.id, reason: values.reason }) });
        showToast('Thank you. Your report was sent to the administrators.');
      }
    }));
    actions.append(request, report);
  }
  // The section heading already names the department or hospital, so the card shows the other one.
  const subtitle = directory.view === 'hospital' ? doctor.specialization : (doctor.clinicName || 'Independent practice');
  return h('article', { class: 'panel doctor-card' },
    h('div', { class: 'doctor-card-top' },
      h('span', { class: 'avatar', text: doctor.name.slice(0, 1).toUpperCase() }),
      h('div', {}, h('h3', { text: doctor.name }), h('p', { class: 'doctor-specialty', text: subtitle })),
      statusPill('verified')),
    detail('Qualifications', doctor.qualifications),
    detail('Experience', doctor.yearsExperience !== null ? `${doctor.yearsExperience} years` : ''),
    detail('Address', doctor.clinicAddress),
    detail('Availability', doctor.availabilityNote),
    doctor.bio ? h('p', { class: 'doctor-bio', text: doctor.bio }) : null,
    h('p', { class: 'small-muted', text: `Registered with ${doctor.registrationAuthority}, ${doctor.registrationCountry}. Verified ${formatDateTime(doctor.verifiedAt, { dateStyle: 'medium' })}.` }),
    actions);
}

function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function countLabel(count) {
  return `${count} doctor${count === 1 ? '' : 's'}`;
}

function renderDepartmentGrid() {
  const grid = $('#department-grid');
  grid.replaceChildren();
  grid.classList.toggle('is-hidden', directory.view !== 'department');
  const counts = groupBy(directory.doctors, (doctor) => doctor.specialization);
  for (const department of state.config.departments || []) {
    const count = counts.get(department)?.length || 0;
    const selected = directory.department === department;
    const tile = h('button', { type: 'button', class: `department-tile${selected ? ' active' : ''}${count ? '' : ' empty'}`, 'aria-pressed': String(selected) },
      h('span', { class: 'department-icon', 'aria-hidden': 'true', text: DEPARTMENT_ICONS[department] || '•' }),
      h('b', { text: department }),
      h('small', { text: count ? countLabel(count) : 'No doctors yet' }));
    tile.addEventListener('click', () => {
      directory.department = selected ? null : department;
      renderDirectory();
    });
    grid.append(tile);
  }
}

function renderDirectory() {
  $$('[data-directory-view]').forEach((button) => {
    const active = button.dataset.directoryView === directory.view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  $('#clear-department').classList.toggle('is-hidden', !(directory.view === 'department' && directory.department));
  renderDepartmentGrid();

  const list = $('#doctor-list');
  list.replaceChildren();
  const query = $('#doctor-query').value.trim();
  const doctors = directory.view === 'department' && directory.department
    ? directory.doctors.filter((doctor) => doctor.specialization === directory.department)
    : directory.doctors;
  if (!doctors.length) {
    let message = 'No verified doctors are listed yet. Doctors appear here only after an administrator verifies their registration.';
    if (query) message = 'No verified doctors match your search.';
    else if (directory.department) message = `No verified doctors in ${directory.department} yet.`;
    list.append(h('p', { class: 'panel empty-state doctor-empty', text: message }));
    return;
  }

  let groups;
  if (directory.view === 'hospital') {
    const independent = 'Independent practice';
    groups = [...groupBy(doctors, (doctor) => doctor.clinicName || independent)]
      .sort(([a], [b]) => (a === independent) - (b === independent) || a.localeCompare(b));
  } else {
    const order = state.config.departments || [];
    const rank = (name) => (order.includes(name) ? order.indexOf(name) : order.length);
    groups = [...groupBy(doctors, (doctor) => doctor.specialization || 'Other')]
      .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
  }

  for (const [name, members] of groups) {
    let summary = '';
    if (directory.view === 'hospital') {
      const addresses = [...new Set(members.map((doctor) => doctor.clinicAddress).filter(Boolean))].join(' / ');
      const departments = [...new Set(members.map((doctor) => doctor.specialization))].join(' · ');
      summary = [addresses, departments].filter(Boolean).join(' — ');
    }
    list.append(h('section', { class: 'directory-section', 'aria-label': name },
      h('div', { class: 'directory-section-heading' },
        h('span', { class: 'department-icon', 'aria-hidden': 'true', text: directory.view === 'hospital' ? '⌂' : (DEPARTMENT_ICONS[name] || '•') }),
        h('div', {}, h('h2', { text: name }), summary ? h('p', { class: 'small-muted', text: summary }) : null),
        h('span', { class: 'status-pill', text: countLabel(members.length) })),
      h('div', { class: 'doctor-grid' }, members.map(doctorCard))));
  }
}

async function loadDoctors() {
  try {
    const query = $('#doctor-query').value.trim();
    const data = await api(`/api/doctors${query ? `?q=${encodeURIComponent(query)}` : ''}`);
    directory.doctors = data.doctors;
    renderDirectory();
  } catch (error) {
    if (error.status !== 401) showToast(error.message);
  }
}

$$('[data-directory-view]').forEach((button) => button.addEventListener('click', () => {
  directory.view = button.dataset.directoryView;
  directory.department = null;
  renderDirectory();
}));
$('#clear-department').addEventListener('click', () => {
  directory.department = null;
  renderDirectory();
});

function requestConsultation(doctor) {
  openFormDialog({
    eyebrow: 'REQUEST A CONSULTATION',
    title: doctor.name,
    intro: 'The doctor sees your name and what you write here. Keep it brief; you can share more after they accept.',
    submitLabel: 'Send request',
    fields: [
      { name: 'reason', label: 'Reason for consultation', type: 'textarea', required: true, maxLength: 1000 },
      { name: 'preferredTime', label: 'Preferred times', optional: true, maxLength: 120, placeholder: 'e.g. Weekday evenings' }
    ],
    onSubmit: async (values) => {
      await api('/api/consultations', { method: 'POST', body: JSON.stringify({ doctorId: doctor.id, ...values }) });
      showToast('Request sent. You will be notified when the doctor responds.');
      showScreen('appointments');
    }
  });
}

$('#doctor-search').addEventListener('submit', (event) => {
  event.preventDefault();
  loadDoctors();
});

// --- Patient consultations ------------------------------------------------------------------------

async function loadConsultations() {
  const list = $('#consultations-list');
  try {
    const data = await api('/api/consultations');
    list.replaceChildren();
    if (!data.consultations.length) {
      list.append(h('article', { class: 'panel appointment-card empty-state', text: 'No consultation requests yet. Find a verified doctor to send one.' }));
      return;
    }
    for (const consultation of data.consultations) {
      const actions = h('div', { class: 'appointment-actions' });
      if (consultation.status === 'accepted') {
        const share = h('button', { type: 'button', text: 'Share an AI conversation' });
        share.addEventListener('click', () => shareConversation(consultation));
        actions.append(share);
      }
      if (['requested', 'accepted'].includes(consultation.status)) {
        const cancel = h('button', { type: 'button', class: 'delete-appointment', text: 'Cancel request' });
        cancel.addEventListener('click', async () => {
          if (!window.confirm('Cancel this consultation? Any records you shared will no longer be visible to the doctor.')) return;
          try {
            await api(`/api/consultations/${encodeURIComponent(consultation.id)}/cancel`, { method: 'POST' });
            showToast('Consultation cancelled.');
            loadConsultations();
          } catch (error) {
            showToast(error.message);
          }
        });
        actions.append(cancel);
      }
      const shares = consultation.shares.length && consultation.status === 'accepted'
        ? h('div', { class: 'share-list' }, h('b', { text: 'Shared with this doctor' }), consultation.shares.map((shareItem) => {
          const revoke = h('button', { type: 'button', class: 'text-button', text: 'Stop sharing' });
          revoke.addEventListener('click', async () => {
            try {
              await api(`/api/consultations/${encodeURIComponent(consultation.id)}/shares/${encodeURIComponent(shareItem.id)}`, { method: 'DELETE' });
              showToast('The doctor can no longer view that conversation.');
              loadConsultations();
            } catch (error) {
              showToast(error.message);
            }
          });
          return h('div', { class: 'share-row' }, h('span', { text: shareItem.title || 'Deleted conversation' }), revoke);
        }))
        : null;
      list.append(h('article', { class: 'panel appointment-card' },
        h('div', { class: 'appointment-card-top' }, h('h3', { text: consultation.doctorName }), statusPill(consultation.status)),
        consultation.specialization ? h('p', { class: 'doctor-specialty', text: consultation.specialization }) : null,
        consultation.scheduledAt ? h('time', { datetime: consultation.scheduledAt, text: formatDateTime(consultation.scheduledAt, { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }) : null,
        detail('Reason', consultation.reason),
        detail('Preferred time', consultation.preferredTime),
        detail('Note from doctor', consultation.doctorNote),
        shares,
        actions));
    }
  } catch (error) {
    if (error.status !== 401) showToast(error.message);
  }
}

async function shareConversation(consultation) {
  try {
    const data = await api('/api/conversations');
    if (!data.conversations.length) {
      showToast('You have no AI conversations to share yet.');
      return;
    }
    openFormDialog({
      eyebrow: 'SHARE WITH YOUR DOCTOR',
      title: `Share with ${consultation.doctorName}`,
      intro: 'The doctor will be able to read this whole conversation (not the attached files) while the consultation is open. You can stop sharing at any time.',
      submitLabel: 'Share conversation',
      fields: [{ name: 'conversationId', label: 'Conversation', type: 'select', required: true,
        options: data.conversations.map((conversation) => ({ value: conversation.id, label: conversation.title })) }],
      onSubmit: async (values) => {
        await api(`/api/consultations/${encodeURIComponent(consultation.id)}/shares`, { method: 'POST', body: JSON.stringify(values) });
        showToast('Conversation shared.');
        loadConsultations();
      }
    });
  } catch (error) {
    showToast(error.message);
  }
}

// --- Doctor workspace -----------------------------------------------------------------------------

const DOCTOR_NOTICES = {
  pending_verification: 'Your profile is not visible to patients yet. Complete your professional details and submit them for verification. An administrator will review them against your registration authority.',
  verified: 'Your credentials are verified. Turn on "Accept consultation requests" to appear as available in the directory.',
  rejected: 'An administrator asked for changes before your profile can be verified. Review the note below, update your details, and resubmit.',
  revoked: 'Your verification was revoked. Contact the HEALIX administrators, update your details if needed, and resubmit.'
};

async function loadDoctorWorkspace() {
  try {
    const data = await api('/api/doctor/profile');
    const { profile, verification } = data;
    state.doctorStatus = profile.verificationStatus;
    $('#doctor-status-pill').replaceWith(Object.assign(statusPill(profile.verificationStatus), { id: 'doctor-status-pill' }));
    const notice = $('#doctor-status-notice');
    notice.textContent = DOCTOR_NOTICES[profile.verificationStatus] || '';
    notice.className = `notice ${profile.verificationStatus === 'verified' ? 'notice-info' : 'notice-warn'}`;

    const form = $('#doctor-profile-form');
    const departmentSelect = form.elements.namedItem('specialization');
    const departments = [...(state.config.departments || [])];
    if (profile.specialization && !departments.includes(profile.specialization)) departments.push(profile.specialization);
    departmentSelect.replaceChildren(h('option', { value: '', text: 'Choose a department' }),
      ...departments.map((department) => h('option', { value: department, text: department })));
    for (const [key, value] of Object.entries(profile)) {
      const input = form.elements.namedItem(key);
      if (!input) continue;
      if (input.type === 'checkbox') input.checked = Boolean(value);
      else input.value = value ?? '';
    }

    const summary = $('#verification-summary');
    summary.replaceChildren();
    if (verification) {
      summary.append(h('div', {},
        h('div', { class: 'appointment-card-top' }, h('b', { text: 'Latest request' }), statusPill(verification.status)),
        h('p', { class: 'small-muted', text: `Submitted ${formatDateTime(verification.submittedAt)}${verification.reviewedAt ? ` · Reviewed ${formatDateTime(verification.reviewedAt)}` : ''}` }),
        detail('Document', verification.credentialName || 'None attached'),
        detail('Reviewer note', verification.reviewerNotes)));
    } else {
      summary.append(h('p', { class: 'small-muted', text: 'You have not submitted your credentials yet.' }));
    }
    const awaiting = verification?.status === 'submitted';
    $('#verification-submit').disabled = awaiting || profile.verificationStatus === 'verified';
    $('#verification-submit').textContent = awaiting ? 'Awaiting review' : profile.verificationStatus === 'verified' ? 'Verified' : 'Submit for verification';
    $('#credential-file').disabled = $('#verification-submit').disabled;

    await loadDoctorConsultations();
  } catch (error) {
    if (error.status !== 401) showToast(error.message);
  }
}

async function loadDoctorConsultations() {
  const list = $('#doctor-consultations');
  list.replaceChildren();
  if (state.doctorStatus !== 'verified') {
    list.append(h('article', { class: 'panel appointment-card empty-state', text: 'Consultation requests become available after your credentials are verified.' }));
    return;
  }
  try {
    const data = await api('/api/doctor/consultations');
    if (!data.consultations.length) {
      list.append(h('article', { class: 'panel appointment-card empty-state', text: 'No consultation requests yet.' }));
      return;
    }
    for (const consultation of data.consultations) {
      const actions = h('div', { class: 'appointment-actions' });
      const respond = (action, fields, label) => {
        const button = h('button', { type: 'button', class: action === 'decline' ? 'delete-appointment' : '', text: label });
        button.addEventListener('click', () => openFormDialog({
          eyebrow: 'CONSULTATION',
          title: `${label}: ${consultation.patientName}`,
          submitLabel: label,
          fields,
          onSubmit: async (values) => {
            const body = { action, note: values.note || '' };
            if (values.scheduledAt) body.scheduledAt = new Date(values.scheduledAt).toISOString();
            await api(`/api/doctor/consultations/${encodeURIComponent(consultation.id)}/respond`, { method: 'POST', body: JSON.stringify(body) });
            showToast('The patient has been notified.');
            loadDoctorConsultations();
          }
        }));
        return button;
      };
      const noteField = { name: 'note', label: 'Note to the patient', type: 'textarea', optional: true, maxLength: 1000 };
      if (consultation.status === 'requested') {
        actions.append(
          respond('accept', [
            { name: 'scheduledAt', label: 'Date and time', type: 'datetime-local', required: true, value: localDateTime() },
            { ...noteField, hint: 'Explain how the consultation will take place (for example, at your clinic or by phone).' }
          ], 'Accept'),
          respond('decline', [noteField], 'Decline'));
      } else if (consultation.status === 'accepted') {
        actions.append(respond('complete', [noteField], 'Mark complete'));
      }
      const shares = consultation.shares.length
        ? h('div', { class: 'share-list' }, h('b', { text: 'Shared by the patient' }), consultation.shares.map((shareItem) => {
          const view = h('button', { type: 'button', class: 'text-button', text: 'View' });
          view.addEventListener('click', () => viewSharedRecord(consultation, shareItem));
          return h('div', { class: 'share-row' }, h('span', { text: shareItem.title || 'Conversation' }), view);
        }))
        : null;
      list.append(h('article', { class: 'panel appointment-card' },
        h('div', { class: 'appointment-card-top' }, h('h3', { text: consultation.patientName }), statusPill(consultation.status)),
        consultation.scheduledAt ? h('time', { datetime: consultation.scheduledAt, text: formatDateTime(consultation.scheduledAt, { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }) : null,
        detail('Reason', consultation.reason),
        detail('Preferred time', consultation.preferredTime),
        detail('Your note', consultation.doctorNote),
        h('p', { class: 'small-muted', text: `Requested ${formatDateTime(consultation.createdAt)}` }),
        shares,
        actions));
    }
  } catch (error) {
    if (error.status !== 401) showToast(error.message);
  }
}

async function viewSharedRecord(consultation, shareItem) {
  try {
    const data = await api(`/api/doctor/consultations/${encodeURIComponent(consultation.id)}/shares/${encodeURIComponent(shareItem.id)}`);
    const body = h('div', { class: 'shared-conversation' },
      h('p', { class: 'notice notice-info', text: `Shared by ${consultation.patientName}. These are AI-generated health-education replies, not clinical notes. This view is recorded in the audit log.` }),
      data.conversation.messages.map((message) => {
        const bubble = h('div', { class: 'message-bubble' });
        if (message.role === 'assistant') {
          bubble.classList.add('rich-text');
          renderRichText(bubble, message.content);
        } else {
          bubble.textContent = message.content;
        }
        return h('div', { class: `message ${message.role}` },
          h('div', { class: 'message-body' },
            h('small', { class: 'message-time', text: `${message.role === 'user' ? 'Patient' : 'HEALIX AI'} · ${formatDateTime(message.createdAt)}${message.attachmentCount ? ` · ${message.attachmentCount} attachment(s) not shared` : ''}` }),
            bubble));
      }));
    openViewer({ eyebrow: 'SHARED CONVERSATION', title: data.conversation.title, body });
  } catch (error) {
    showToast(error.message);
    loadDoctorConsultations();
  }
}

$('#doctor-profile-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const feedback = $('#doctor-profile-feedback');
  feedback.textContent = '';
  const body = {};
  for (const element of form.elements) {
    if (!element.name) continue;
    if (element.type === 'checkbox') body[element.name] = element.checked;
    else if (element.name === 'yearsExperience') body[element.name] = element.value === '' ? null : Number(element.value);
    else body[element.name] = element.value.trim();
  }
  try {
    const data = await api('/api/doctor/profile', { method: 'PUT', body: JSON.stringify(body) });
    feedback.textContent = data.requiresReview
      ? 'Saved. Because you changed your registration details, your profile must be verified again before it is listed.'
      : 'Your professional profile has been saved.';
    await loadDoctorWorkspace();
  } catch (error) {
    feedback.textContent = error.message;
  }
});

$('#verification-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const feedback = $('#verification-feedback');
  feedback.textContent = '';
  const submit = $('#verification-submit');
  submit.disabled = true;
  try {
    let credentialAttachmentId = null;
    const file = $('#credential-file').files[0];
    if (file) credentialAttachmentId = (await uploadFile(file, 'credential')).id;
    await api('/api/doctor/verification', { method: 'POST', body: JSON.stringify({ credentialAttachmentId }) });
    $('#verification-form').reset();
    feedback.textContent = 'Submitted. You will be notified when an administrator has reviewed your credentials.';
    await loadDoctorWorkspace();
  } catch (error) {
    feedback.textContent = error.message;
    submit.disabled = false;
  }
});

$('#refresh-doctor-consultations').addEventListener('click', () => loadDoctorConsultations());

screenLoaders.doctors = () => loadDoctors();
screenLoaders.doctor = () => loadDoctorWorkspace();
