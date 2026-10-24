const state = {
  user: null,
  doctorStatus: null,
  config: { aiConfigured: false, aiImages: false, aiDocuments: false, attachmentMaxBytes: 0 },
  settings: { speechEnabled: false, hydrationGoalMl: 0 },
  conversations: [],
  conversationId: null,
  appointments: [],
  pendingChat: null,
  pendingAttachments: [],
  unreadNotifications: 0,
  authMode: 'login',
  toastTimer: null,
  notificationTimer: null
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

// Small DOM builder. Text is always set through text nodes, never parsed as HTML.
function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2).toLowerCase(), value);
    else element.setAttribute(key, value === true ? '' : value);
  }
  element.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
  return element;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers
    }
  });
  let data;
  try {
    data = response.status === 204 ? {} : await response.json();
  } catch {
    throw new Error('The server returned an invalid response.');
  }
  if (!response.ok) {
    const error = new Error(data.error || 'The request could not be completed.');
    error.status = response.status;
    throw error;
  }
  return data;
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove('visible'), 3200);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function formatDateTime(value, options = { dateStyle: 'medium', timeStyle: 'short' }) {
  return value ? new Intl.DateTimeFormat(undefined, options).format(new Date(value)) : '';
}

function hasRole(role) {
  return Boolean(state.user?.roles?.includes(role));
}

// --- Shared dialogs --------------------------------------------------------------------------------

let formDialogHandler = null;
function openFormDialog({ eyebrow = '', title, intro = '', submitLabel = 'Save', fields, onSubmit }) {
  $('#form-dialog-eyebrow').textContent = eyebrow;
  $('#form-dialog-title').textContent = title;
  $('#form-dialog-intro').textContent = intro;
  $('#form-dialog-intro').classList.toggle('is-hidden', !intro);
  $('#form-dialog-submit').textContent = submitLabel;
  $('#form-dialog-error').textContent = '';
  const container = $('#form-dialog-fields');
  container.replaceChildren();
  for (const field of fields) {
    let input;
    if (field.type === 'textarea') {
      input = h('textarea', { name: field.name, rows: field.rows || 3, maxlength: field.maxLength, required: field.required, placeholder: field.placeholder });
      input.value = field.value || '';
    } else if (field.type === 'select') {
      input = h('select', { name: field.name, required: field.required },
        field.options.map((option) => h('option', { value: option.value, selected: option.value === field.value, text: option.label })));
    } else {
      input = h('input', { name: field.name, type: field.type || 'text', maxlength: field.maxLength, required: field.required, placeholder: field.placeholder, min: field.min });
      input.value = field.value || '';
    }
    container.append(h('label', { class: 'form-field' }, field.label,
      field.optional ? h('span', { class: 'optional-label', text: 'Optional' }) : null, input,
      field.hint ? h('small', { text: field.hint }) : null));
  }
  formDialogHandler = onSubmit;
  $('#form-dialog').showModal();
  container.querySelector('input, textarea, select')?.focus();
}

$('#form-dialog-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!formDialogHandler) return;
  const values = Object.fromEntries(new FormData(event.target).entries());
  const submit = $('#form-dialog-submit');
  submit.disabled = true;
  $('#form-dialog-error').textContent = '';
  try {
    await formDialogHandler(values);
    $('#form-dialog').close();
  } catch (error) {
    $('#form-dialog-error').textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

function openViewer({ eyebrow = '', title, body }) {
  $('#viewer-eyebrow').textContent = eyebrow;
  $('#viewer-title').textContent = title;
  $('#viewer-body').replaceChildren(body);
  $('#viewer-dialog').showModal();
}

$$('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));

// --- Session, roles, and navigation ---------------------------------------------------------------

function setAuthError(message = '') {
  $('#auth-error').textContent = message;
}

function setAuthenticated(data) {
  state.user = data.user;
  state.doctorStatus = data.doctorStatus || null;
  state.settings = { speechEnabled: false, hydrationGoalMl: 0, ...data.settings };
  $('#auth-view').classList.add('is-hidden');
  $('#app-view').classList.remove('is-hidden');
  applyRoles();
  setUnreadCount(data.unreadNotifications || 0);
  updateProfileUI();
  showScreen(hasRole('doctor') && state.doctorStatus !== 'verified' ? 'doctor' : 'dashboard');
  clearInterval(state.notificationTimer);
  state.notificationTimer = setInterval(() => {
    if (document.visibilityState === 'visible') refreshNotificationCount();
  }, 60000);
}

function signedOut() {
  clearInterval(state.notificationTimer);
  state.user = null;
  state.doctorStatus = null;
  state.conversationId = null;
  state.conversations = [];
  state.appointments = [];
  state.pendingChat = null;
  clearPendingAttachments();
  $('#message-list').replaceChildren();
  $('#chat-empty').classList.remove('is-hidden');
  $('#app-view').classList.add('is-hidden');
  $('#auth-view').classList.remove('is-hidden');
  $('#auth-form').reset();
  setAuthMode('login');
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}

function applyRoles() {
  $$('[data-role]').forEach((element) => {
    const allowed = element.dataset.role.split(' ').some((role) => hasRole(role));
    element.classList.toggle('is-hidden', !allowed);
  });
}

function updateProfileUI() {
  const name = state.user?.name || 'Your profile';
  $('#welcome-name').textContent = name.split(/\s+/)[0];
  $('#sidebar-name').textContent = name;
  $('#sidebar-avatar').textContent = name.slice(0, 1).toUpperCase();
  $('#profile-avatar').textContent = name.slice(0, 1).toUpperCase();
  $('#profile-name').value = state.user?.name || '';
  $('#profile-email').value = state.user?.email || '';
  $('#setting-hydration-goal').value = state.settings.hydrationGoalMl || 0;
  $('#setting-speech').checked = Boolean(state.settings.speechEnabled);
  $('#setting-speech').disabled = !('speechSynthesis' in window);
  updateConsentUI();
  $('#today-label').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date());
}

// Other scripts register loaders for their screens here.
const screenLoaders = {
  dashboard: () => loadDashboard(),
  assistant: () => loadConversations().then(() => {
    if (state.conversationId) loadMessages(state.conversationId);
  }).catch((error) => showToast(error.message)),
  hydration: () => loadHydration(),
  appointments: () => loadAppointments(),
  relaxation: () => loadLibrary(),
  notifications: () => loadNotifications(),
  profile: () => updateProfileUI()
};

function showScreen(name) {
  if (!$(`#screen-${name}`)) name = 'dashboard';
  const target = $(`[data-nav="${name}"][data-role]`);
  if (target && target.classList.contains('is-hidden')) name = 'dashboard';
  $$('.screen').forEach((screen) => screen.classList.toggle('active', screen.id === `screen-${name}`));
  $$('[data-nav]').forEach((button) => {
    const isActive = button.dataset.nav === name;
    button.classList.toggle('active', isActive);
    if (isActive) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  $('.mobile-nav .mobile-nav-item.active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  screenLoaders[name]?.();
}

function hydrationUrl() {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `/api/hydration?date=${date}&timezoneOffset=${now.getTimezoneOffset()}`;
}

async function loadConfig() {
  try {
    const config = await api('/api/config');
    state.config = config;
    const notice = $('#ai-config-notice');
    if (!config.aiConfigured) {
      notice.textContent = 'AI responses are not configured yet. The server administrator needs to set AI_API_KEY and restart HEALIX. Your messages will not be sent to an AI provider until it is configured.';
      notice.classList.remove('is-hidden');
    } else {
      notice.classList.add('is-hidden');
    }
    const supported = [config.aiImages && 'images', config.aiDocuments && 'PDF documents'].filter(Boolean);
    $('#attachment-capability').textContent = supported.length
      ? `The configured AI can read ${supported.join(' and ')} (up to ${formatBytes(config.attachmentMaxBytes)} each).`
      : 'Attachments are unavailable because the configured AI provider is not set up to read images or documents.';
    $('#attach-button').disabled = !supported.length;
    $('#camera-button').disabled = !config.aiImages;
    for (const id of ['#auth-announcement', '#app-announcement']) {
      $(id).textContent = config.announcement;
      $(id).classList.toggle('is-hidden', !config.announcement);
    }
    $('input[name="accountType"][value="doctor"]').disabled = !config.doctorRegistrationOpen;
  } catch {
    $('#ai-config-notice').textContent = 'AI configuration status is unavailable. If replies fail, check the server configuration.';
    $('#ai-config-notice').classList.remove('is-hidden');
  }
}

// --- Dashboard, hydration, appointments -----------------------------------------------------------

async function loadDashboard() {
  try {
    const [hydration, appointments] = await Promise.all([api(hydrationUrl()), api('/api/appointments')]);
    $('#dashboard-water').textContent = hydration.totalMl.toLocaleString();
    const goal = state.settings.hydrationGoalMl;
    const progress = goal ? Math.min(100, Math.round(hydration.totalMl / goal * 100)) : 0;
    $('#dashboard-water-progress').value = progress;
    $('#dashboard-goal-label').textContent = goal
      ? `${progress}% of your personal ${goal.toLocaleString()} ml goal`
      : 'Set a personal goal in settings, if useful.';
    const upcoming = appointments.appointments.filter((item) => new Date(item.scheduledAt) >= new Date()).slice(0, 2);
    const container = $('#dashboard-appointments');
    container.replaceChildren();
    if (!upcoming.length) {
      container.append(h('p', { class: 'small-muted', text: 'No upcoming appointments saved.' }));
    } else {
      for (const appointment of upcoming) {
        const date = new Date(appointment.scheduledAt);
        container.append(h('div', { class: 'mini-appointment' },
          h('span', { class: 'mini-date' },
            h('span', { text: new Intl.DateTimeFormat(undefined, { month: 'short' }).format(date).toUpperCase() }),
            h('b', { text: new Intl.DateTimeFormat(undefined, { day: 'numeric' }).format(date) })),
          h('span', { class: 'mini-appointment-copy' },
            h('b', { text: appointment.title }),
            h('small', { text: new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(date) }))));
      }
    }
  } catch (error) {
    if (error.status !== 401) showToast(error.message);
  }
}

async function loadHydration() {
  try {
    const data = await api(hydrationUrl());
    $('#hydration-total').textContent = data.totalMl.toLocaleString();
    const goal = state.settings.hydrationGoalMl;
    const progress = goal ? Math.min(100, Math.round(data.totalMl / goal * 100)) : 0;
    $('#hydration-progress').value = progress;
    $('#hydration-progress-copy').textContent = goal
      ? `${progress}% of your personal ${goal.toLocaleString()} ml goal.`
      : 'Add a personal target in settings to see progress.';

    const records = $('#hydration-records');
    records.replaceChildren();
    if (!data.records.length) {
      records.append(h('p', { class: 'empty-state', text: 'No water entries yet. Add one above whenever you like.' }));
      return;
    }
    for (const record of data.records) {
      const remove = h('button', { class: 'record-delete', type: 'button', text: 'Remove', 'aria-label': `Remove ${record.amountMl} ml water record` });
      remove.addEventListener('click', async () => {
        try {
          await api(`/api/hydration/${encodeURIComponent(record.id)}`, { method: 'DELETE' });
          await loadHydration();
          await loadDashboard();
        } catch (error) {
          showToast(error.message);
        }
      });
      records.append(h('div', { class: 'record-row' },
        h('span', { class: 'record-drop', text: '◉' }),
        h('span', { class: 'record-copy' },
          h('b', { text: `${record.amountMl.toLocaleString()} ml` }),
          h('small', { text: new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(record.recordedAt)) })),
        remove));
    }
  } catch (error) {
    if (error.status !== 401) showToast(error.message);
  }
}

async function loadAppointments() {
  try {
    const data = await api('/api/appointments');
    state.appointments = data.appointments;
    const list = $('#appointments-list');
    list.replaceChildren();
    if (!state.appointments.length) {
      list.append(h('article', { class: 'panel appointment-card empty-state', text: 'No appointments saved yet. Add one to keep it in view.' }));
    }
    for (const appointment of state.appointments) {
      const edit = h('button', { type: 'button', text: 'Edit' });
      edit.addEventListener('click', () => openAppointmentDialog(appointment));
      const remove = h('button', { type: 'button', class: 'delete-appointment', text: 'Delete' });
      remove.addEventListener('click', async () => {
        if (!window.confirm(`Delete "${appointment.title}"?`)) return;
        try {
          await api(`/api/appointments/${encodeURIComponent(appointment.id)}`, { method: 'DELETE' });
          showToast('Appointment deleted.');
          await loadAppointments();
          await loadDashboard();
        } catch (error) {
          showToast(error.message);
        }
      });
      list.append(h('article', { class: 'panel appointment-card' },
        h('div', { class: 'appointment-card-top' }, h('h3', { text: appointment.title })),
        h('time', { datetime: appointment.scheduledAt, text: formatDateTime(appointment.scheduledAt, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) }),
        h('p', { text: appointment.notes || 'No notes added.' }),
        h('div', { class: 'appointment-actions' }, edit, remove)));
    }
  } catch (error) {
    if (error.status !== 401) showToast(error.message);
  }
  if (typeof loadConsultations === 'function') loadConsultations();
}

// --- AI assistant ----------------------------------------------------------------------------------

function renderConversationList() {
  const list = $('#conversation-list');
  list.replaceChildren();
  if (!state.conversations.length) {
    list.append(h('p', { class: 'empty-state', text: 'Your conversations will appear here.' }));
    return;
  }
  for (const conversation of state.conversations) {
    const select = h('button', { type: 'button', class: `conversation-select${conversation.id === state.conversationId ? ' active' : ''}` },
      h('b', { text: conversation.title }),
      h('small', { text: conversation.preview ? conversation.preview.replace(/[#*]+/g, '').trim() : 'No messages yet' }));
    select.addEventListener('click', () => loadMessages(conversation.id));
    const remove = h('button', { type: 'button', class: 'conversation-delete', text: '×', 'aria-label': `Delete conversation: ${conversation.title}` });
    remove.addEventListener('click', async () => {
      if (!window.confirm(`Delete "${conversation.title}" and its messages and attachments?`)) return;
      try {
        await api(`/api/conversations/${encodeURIComponent(conversation.id)}`, { method: 'DELETE' });
        if (state.conversationId === conversation.id) {
          state.conversationId = null;
          state.pendingChat = null;
          $('#message-list').replaceChildren();
          $('#chat-empty').classList.remove('is-hidden');
        }
        await loadConversations();
        showToast('Conversation deleted.');
      } catch (error) {
        showToast(error.message);
      }
    });
    list.append(h('div', { class: 'conversation-row' }, select, remove));
  }
}

async function loadConversations() {
  const data = await api('/api/conversations');
  state.conversations = data.conversations;
  if (state.conversationId && !state.conversations.some((item) => item.id === state.conversationId)) {
    state.conversationId = null;
  }
  renderConversationList();
}

function appendInline(parent, text) {
  for (const part of text.split(/(\*\*[^*]+\*\*)/g)) {
    if (/^\*\*[^*]+\*\*$/.test(part)) parent.append(h('strong', { text: part.slice(2, -2) }));
    else if (part) parent.append(document.createTextNode(part));
  }
}

// Renders the small Markdown subset the assistant is asked to use (headings, lists, bold) without innerHTML.
function renderRichText(container, text) {
  container.replaceChildren();
  let list = null;
  let paragraph = [];
  const flush = () => {
    if (!paragraph.length) return;
    const p = h('p');
    appendInline(p, paragraph.join('\n'));
    container.append(p);
    paragraph = [];
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    const item = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (!line) {
      flush();
      list = null;
    } else if (heading) {
      flush();
      list = null;
      const element = h('h4');
      appendInline(element, heading[1].replace(/\*\*/g, ''));
      container.append(element);
    } else if (item) {
      flush();
      const type = /^\d/.test(line) ? 'ol' : 'ul';
      if (!list || list.tagName.toLowerCase() !== type) {
        list = h(type);
        container.append(list);
      }
      const li = h('li');
      appendInline(li, item[1]);
      list.append(li);
    } else {
      list = null;
      paragraph.push(line);
    }
  }
  flush();
}

function attachmentChip(attachment) {
  const url = `/api/attachments/${encodeURIComponent(attachment.id)}/content`;
  if (attachment.mimeType.startsWith('image/')) {
    return h('a', { class: 'message-attachment image-attachment', href: url, target: '_blank', rel: 'noopener', title: attachment.name },
      h('img', { src: url, alt: attachment.name, loading: 'lazy' }));
  }
  return h('a', { class: 'message-attachment', href: url, rel: 'noopener', text: `▤ ${attachment.name}` });
}

function speak(text) {
  if (!('speechSynthesis' in window)) {
    showToast('Read-aloud is not supported in this browser.');
    return;
  }
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text.replace(/[#*]/g, '')));
}

function messageActions(message) {
  const actions = h('div', { class: 'message-actions' });
  const copy = h('button', { type: 'button', text: 'Copy' });
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      showToast('Response copied.');
    } catch {
      showToast('Copying is not available in this browser.');
    }
  });
  const read = h('button', { type: 'button', text: 'Read aloud', disabled: !('speechSynthesis' in window) });
  read.addEventListener('click', () => speak(message.content));
  const feedbackButtons = [['helpful', 'Helpful'], ['not_helpful', 'Not helpful']].map(([value, label]) => {
    const button = h('button', { type: 'button', class: message.feedback === value ? 'selected' : '', 'aria-pressed': String(message.feedback === value), text: label });
    button.addEventListener('click', async () => {
      const next = message.feedback === value ? null : value;
      try {
        await api(`/api/messages/${encodeURIComponent(message.id)}/feedback`, { method: 'PUT', body: JSON.stringify({ feedback: next }) });
        message.feedback = next;
        actions.replaceWith(messageActions(message));
      } catch (error) {
        showToast(error.message);
      }
    });
    return button;
  });
  const report = h('button', { type: 'button', text: 'Report' });
  report.addEventListener('click', () => openFormDialog({
    eyebrow: 'REPORT A RESPONSE',
    title: 'What is wrong with this response?',
    intro: 'The text of this AI response (not your question) will be shared with HEALIX administrators so they can review it.',
    submitLabel: 'Send report',
    fields: [{ name: 'reason', label: 'Describe the problem', type: 'textarea', required: true, maxLength: 1000 }],
    onSubmit: async (values) => {
      await api('/api/reports', { method: 'POST', body: JSON.stringify({ targetType: 'message', targetId: message.id, reason: values.reason }) });
      showToast('Thank you. Your report was sent to the administrators.');
    }
  }));
  actions.append(copy, read, ...feedbackButtons, report);
  return actions;
}

function appendMessage(message) {
  const list = $('#message-list');
  const row = h('div', { class: `message ${message.role}` });
  if (message.role === 'assistant') row.append(h('span', { class: 'message-avatar', text: '✳' }));
  const body = h('div', { class: 'message-body' });
  const bubble = h('div', { class: 'message-bubble' });
  if (message.role === 'assistant') {
    bubble.classList.add('rich-text');
    renderRichText(bubble, message.content);
  } else {
    bubble.textContent = message.content;
  }
  if (message.attachments?.length) {
    body.append(h('div', { class: 'message-attachments' }, message.attachments.map(attachmentChip)));
  }
  body.append(bubble);
  if (message.role === 'assistant' && message.id) body.append(messageActions(message));
  row.append(body);
  list.append(row);
  list.scrollTop = list.scrollHeight;
}

async function loadMessages(id) {
  try {
    state.conversationId = id;
    state.pendingChat = null;
    hideChatError();
    const data = await api(`/api/conversations/${encodeURIComponent(id)}/messages`);
    const list = $('#message-list');
    list.replaceChildren();
    for (const message of data.messages) appendMessage(message);
    $('#chat-empty').classList.toggle('is-hidden', data.messages.length > 0);
    $('#typing-indicator').classList.add('is-hidden');
    await loadConversations();
  } catch (error) {
    showToast(error.message);
  }
}

async function createConversation() {
  const data = await api('/api/conversations', { method: 'POST', body: '{}' });
  state.conversationId = data.conversation.id;
  state.pendingChat = null;
  $('#message-list').replaceChildren();
  $('#chat-empty').classList.remove('is-hidden');
  hideChatError();
  await loadConversations();
  $('#chat-input').focus();
}

function showChatError(message) {
  $('#chat-error-text').textContent = message;
  $('#chat-error').classList.remove('is-hidden');
}

function hideChatError() {
  $('#chat-error').classList.add('is-hidden');
}

function renderAttachmentTray() {
  const tray = $('#attachment-tray');
  tray.replaceChildren();
  tray.classList.toggle('is-hidden', !state.pendingAttachments.length);
  for (const attachment of state.pendingAttachments) {
    const remove = h('button', { type: 'button', class: 'chip-remove', 'aria-label': `Remove ${attachment.name}`, text: '×' });
    remove.addEventListener('click', async () => {
      state.pendingAttachments = state.pendingAttachments.filter((item) => item !== attachment);
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      renderAttachmentTray();
      try {
        await api(`/api/attachments/${encodeURIComponent(attachment.id)}`, { method: 'DELETE' });
      } catch {
        // Already sent or removed; nothing else to do.
      }
    });
    tray.append(h('span', { class: 'attachment-chip' },
      attachment.previewUrl ? h('img', { src: attachment.previewUrl, alt: '' }) : h('span', { class: 'chip-icon', text: '▤' }),
      h('span', { class: 'chip-name', text: attachment.name }),
      h('small', { text: formatBytes(attachment.sizeBytes) }),
      remove));
  }
}

function clearPendingAttachments() {
  for (const attachment of state.pendingAttachments) {
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  }
  state.pendingAttachments = [];
  renderAttachmentTray();
}

async function uploadFile(file, purpose = 'chat') {
  if (state.config.attachmentMaxBytes && file.size > state.config.attachmentMaxBytes) {
    throw new Error(`${file.name} is larger than ${formatBytes(state.config.attachmentMaxBytes)}.`);
  }
  const response = await fetch(`/api/attachments?purpose=${purpose}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
    body: file
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'The file could not be uploaded.');
  return data.attachment;
}

async function addChatFiles(files) {
  for (const file of files) {
    if (state.pendingAttachments.length >= 4) {
      showToast('You can attach up to 4 files per message.');
      break;
    }
    const isImage = file.type.startsWith('image/');
    if ((isImage && !state.config.aiImages) || (file.type === 'application/pdf' && !state.config.aiDocuments)) {
      showToast(`${isImage ? 'Images' : 'PDF documents'} cannot be read by the configured AI provider.`);
      continue;
    }
    try {
      const attachment = await uploadFile(file);
      state.pendingAttachments.push({ ...attachment, previewUrl: isImage ? URL.createObjectURL(file) : null });
      renderAttachmentTray();
    } catch (error) {
      showToast(error.message);
    }
  }
}

async function sendChat(content, requestId = crypto.randomUUID(), isRetry = false, attachmentList = state.pendingAttachments) {
  const attachmentIds = attachmentList.map((attachment) => attachment.id);
  try {
    if (!state.conversationId) await createConversation();
    state.pendingChat = { content, requestId, attachments: attachmentList };
    if (!isRetry) {
      appendMessage({ role: 'user', content, attachments: attachmentList });
      $('#chat-empty').classList.add('is-hidden');
      state.pendingAttachments = [];
      renderAttachmentTray();
    }
    hideChatError();
    $('#typing-indicator').classList.remove('is-hidden');
    $('#send-message').disabled = true;
    $('#chat-input').disabled = true;
    const data = await api(`/api/conversations/${encodeURIComponent(state.conversationId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content, clientRequestId: requestId, attachmentIds })
    });
    appendMessage(data.message);
    for (const attachment of attachmentList) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
    state.pendingChat = null;
    $('#typing-indicator').classList.add('is-hidden');
    await loadConversations();
    if (state.settings.speechEnabled) speak(data.message.content);
  } catch (error) {
    $('#typing-indicator').classList.add('is-hidden');
    showChatError(error.message);
  } finally {
    $('#send-message').disabled = false;
    $('#chat-input').disabled = false;
    $('#chat-input').focus();
  }
}

// --- Appointments dialog and auth ------------------------------------------------------------------

function localDateTime(value) {
  const date = value ? new Date(value) : new Date(Date.now() + 60 * 60 * 1000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

let editingAppointmentId = null;
function openAppointmentDialog(appointment = null) {
  editingAppointmentId = appointment?.id || null;
  $('#appointment-dialog-title').textContent = appointment ? 'Edit appointment' : 'Add appointment';
  $('#appointment-title').value = appointment?.title || '';
  $('#appointment-date').value = localDateTime(appointment?.scheduledAt);
  $('#appointment-notes').value = appointment?.notes || '';
  $('#appointment-error').textContent = '';
  $('#appointment-dialog').showModal();
  $('#appointment-title').focus();
}

function setAuthMode(mode) {
  state.authMode = mode;
  const registering = mode === 'register';
  $('#auth-title').textContent = registering ? 'Create your account' : 'Welcome to HEALIX';
  $('#auth-subtitle').textContent = registering
    ? 'Create a private account for your health space.'
    : 'Sign in to continue to your health space.';
  $('#auth-eyebrow').textContent = registering ? 'YOUR PRIVATE HEALTH SPACE' : 'YOUR PERSONAL HEALTH SPACE';
  $('#name-field').classList.toggle('is-hidden', !registering);
  $('#account-type-field').classList.toggle('is-hidden', !registering);
  $('#auth-name').required = registering;
  $('#auth-name').autocomplete = registering ? 'name' : 'off';
  $('#auth-password').autocomplete = registering ? 'new-password' : 'current-password';
  $('#auth-submit').replaceChildren(registering ? 'Create account ' : 'Sign in ', h('span', { 'aria-hidden': 'true', text: '→' }));
  $('#auth-switch-text').textContent = registering ? 'Already have an account?' : 'New to HEALIX?';
  $('#auth-switch').textContent = registering ? 'Sign in' : 'Create an account';
  $('#auth-password').minLength = registering ? 12 : 1;
  setAuthError(registering && state.config.registrationOpen === false ? 'New registrations are temporarily closed.' : '');
}

// --- Notifications --------------------------------------------------------------------------------

function setUnreadCount(count) {
  state.unreadNotifications = count;
  $$('.notification-count').forEach((badge) => {
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.classList.toggle('is-hidden', !count);
  });
}

async function refreshNotificationCount() {
  try {
    const data = await api('/api/notifications');
    setUnreadCount(data.unread);
  } catch (error) {
    if (error.status === 401 || error.status === 403) signedOut();
  }
}

async function loadNotifications() {
  try {
    const data = await api('/api/notifications');
    setUnreadCount(data.unread);
    const list = $('#notification-list');
    list.replaceChildren();
    if (!data.notifications.length) {
      list.append(h('p', { class: 'empty-state', text: 'No notifications yet. Updates about consultations and your account will appear here.' }));
      return;
    }
    for (const notification of data.notifications) {
      const open = h('button', { type: 'button', class: 'notification-open' },
        h('b', { text: notification.title }),
        notification.body ? h('span', { text: notification.body }) : null,
        h('small', { text: formatDateTime(notification.createdAt) }));
      open.addEventListener('click', async () => {
        try {
          if (!notification.readAt) await api(`/api/notifications/${encodeURIComponent(notification.id)}/read`, { method: 'POST' });
        } catch (error) {
          showToast(error.message);
        }
        if (notification.screen && $(`#screen-${notification.screen}`)) showScreen(notification.screen);
        else loadNotifications();
      });
      const remove = h('button', { type: 'button', class: 'record-delete', text: 'Dismiss', 'aria-label': `Dismiss notification: ${notification.title}` });
      remove.addEventListener('click', async () => {
        try {
          await api(`/api/notifications/${encodeURIComponent(notification.id)}`, { method: 'DELETE' });
          loadNotifications();
        } catch (error) {
          showToast(error.message);
        }
      });
      list.append(h('div', { class: `notification-row${notification.readAt ? '' : ' unread'}` }, open, remove));
    }
  } catch (error) {
    if (error.status !== 401) showToast(error.message);
  }
}

// --- Relaxation -----------------------------------------------------------------------------------

function breathingExercise({ button, status, circle, startLabel }) {
  let timer = null;
  const stop = (message = '') => {
    clearInterval(timer);
    timer = null;
    button.textContent = startLabel;
    status.textContent = message;
    circle?.classList.remove('inhale', 'hold', 'exhale');
  };
  button.addEventListener('click', () => {
    if (timer) {
      stop();
      return;
    }
    button.textContent = 'End breathing exercise';
    const startedAt = Date.now();
    const update = () => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      if (elapsed >= 60) {
        stop('Exercise complete. Take care.');
        return;
      }
      const phase = elapsed % 14;
      const name = phase < 4 ? 'inhale' : phase < 8 ? 'hold' : 'exhale';
      status.textContent = name === 'inhale' ? `Breathe in · ${4 - phase}` : name === 'hold' ? `Hold gently · ${8 - phase}` : `Breathe out · ${14 - phase}`;
      if (circle && !circle.classList.contains(name)) {
        circle.classList.remove('inhale', 'hold', 'exhale');
        circle.classList.add(name);
      }
    };
    update();
    timer = setInterval(update, 1000);
  });
}

async function loadLibrary() {
  const container = $('#content-library');
  try {
    const data = await api('/api/content');
    container.replaceChildren();
    if (!data.content.length) {
      container.append(h('p', { class: 'empty-state', text: 'No articles have been published by the HEALIX team yet.' }));
      return;
    }
    for (const item of data.content) {
      const open = h('button', { type: 'button', class: 'library-item' },
        h('span', { class: 'status-pill', text: item.category === 'relaxation' ? 'Relaxation' : 'Health education' }),
        h('b', { text: item.title }),
        item.summary ? h('span', { text: item.summary }) : null);
      open.addEventListener('click', () => {
        const body = h('div', { class: 'rich-text' });
        renderRichText(body, item.body);
        openViewer({ eyebrow: 'WELLBEING LIBRARY', title: item.title, body });
      });
      container.append(open);
    }
  } catch (error) {
    if (error.status !== 401) showToast(error.message);
  }
}

// --- Startup and event wiring ---------------------------------------------------------------------

async function initialize() {
  $('#today-label').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date());
  await loadConfig();
  try {
    const data = await api('/api/session');
    setAuthenticated(data);
  } catch (error) {
    if (error.status !== 401) setAuthError(error.message);
    $('#auth-view').classList.remove('is-hidden');
    $('#app-view').classList.add('is-hidden');
  }
}

$$('[data-nav]').forEach((button) => button.addEventListener('click', (event) => {
  event.preventDefault();
  showScreen(button.dataset.nav);
}));

$('#auth-switch').addEventListener('click', () => setAuthMode(state.authMode === 'login' ? 'register' : 'login'));
$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  setAuthError();
  const registering = state.authMode === 'register';
  const body = {
    email: $('#auth-email').value.trim(),
    password: $('#auth-password').value
  };
  if (registering) {
    body.name = $('#auth-name').value.trim();
    body.accountType = $('input[name="accountType"]:checked')?.value || 'patient';
  }
  const submit = $('#auth-submit');
  submit.disabled = true;
  try {
    const data = await api(registering ? '/api/auth/register' : '/api/auth/login', {
      method: 'POST', body: JSON.stringify(body)
    });
    $('#auth-form').reset();
    await loadConfig();
    setAuthenticated(data);
  } catch (error) {
    setAuthError(error.message);
  } finally {
    submit.disabled = false;
  }
});

$('#logout-button').addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST' });
    signedOut();
  } catch (error) {
    showToast(error.message);
  }
});

$('#new-conversation').addEventListener('click', () => createConversation().catch((error) => showToast(error.message)));
$('#refresh-conversations').addEventListener('click', () => loadConversations().catch((error) => showToast(error.message)));
$('#chat-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const content = $('#chat-input').value.trim();
  if ($('#send-message').disabled) return;
  if (!content) {
    if (state.pendingAttachments.length) showChatError('Add a question about your attachment, for example "What does this report say about my cholesterol?"');
    return;
  }
  hideChatError();
  if (!state.settings.aiConsent) {
    requestAiConsent(() => {
      $('#chat-input').value = '';
      sendChat(content);
    });
    return;
  }
  $('#chat-input').value = '';
  sendChat(content);
});

async function setAiConsent(consent) {
  const data = await api('/api/settings/ai-consent', { method: 'PUT', body: JSON.stringify({ consent }) });
  state.settings = { ...state.settings, ...data.settings };
  updateConsentUI();
}

// Asked once per account; the choice is saved and can be changed in Profile & settings.
function requestAiConsent(onAgree) {
  openFormDialog({
    eyebrow: 'BEFORE YOUR FIRST MESSAGE',
    title: 'Share messages with the AI provider?',
    intro: 'To generate replies, HEALIX sends your messages and any attachments to the configured AI provider. Avoid names, contact details, or other identifying information. HEALIX AI gives general health information, not a diagnosis. You can withdraw this in Profile & settings at any time.',
    submitLabel: 'Agree and send',
    fields: [],
    onSubmit: async () => {
      await setAiConsent(true);
      onAgree();
    }
  });
}

function updateConsentUI() {
  const consented = Boolean(state.settings.aiConsent);
  $('#ai-consent-status').textContent = consented
    ? 'Messages and attachments are shared with the configured AI provider to generate replies. Avoid identifying details.'
    : 'You will be asked to agree before your first message is sent to the AI provider.';
  $('#setting-ai-consent').checked = consented;
}
$('#chat-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('#chat-form').requestSubmit();
  }
});
$('#retry-message').addEventListener('click', () => {
  if (state.pendingChat) sendChat(state.pendingChat.content, state.pendingChat.requestId, true, state.pendingChat.attachments);
});
$$('.suggestion').forEach((button) => button.addEventListener('click', () => {
  $('#chat-input').value = button.textContent;
  $('#chat-input').focus();
}));
$('#attach-button').addEventListener('click', () => $('#attach-input').click());
$('#camera-button').addEventListener('click', () => $('#camera-input').click());
for (const id of ['#attach-input', '#camera-input']) {
  $(id).addEventListener('change', async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    await addChatFiles(files);
  });
}

$('#hydration-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const amountMl = Number($('#water-amount').value);
  try {
    await api('/api/hydration', { method: 'POST', body: JSON.stringify({ amountMl }) });
    await loadHydration();
    await loadDashboard();
    showToast('Water entry saved.');
  } catch (error) {
    showToast(error.message);
  }
});

$('#add-appointment').addEventListener('click', () => openAppointmentDialog());
$('#close-appointment').addEventListener('click', () => $('#appointment-dialog').close());
$('#cancel-appointment').addEventListener('click', () => $('#appointment-dialog').close());
$('#appointment-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#appointment-error').textContent = '';
  const date = new Date($('#appointment-date').value);
  if (Number.isNaN(date.getTime())) {
    $('#appointment-error').textContent = 'Choose a valid date and time.';
    return;
  }
  const body = {
    title: $('#appointment-title').value.trim(),
    scheduledAt: date.toISOString(),
    notes: $('#appointment-notes').value.trim()
  };
  const endpoint = editingAppointmentId
    ? `/api/appointments/${encodeURIComponent(editingAppointmentId)}`
    : '/api/appointments';
  try {
    await api(endpoint, { method: editingAppointmentId ? 'PUT' : 'POST', body: JSON.stringify(body) });
    $('#appointment-dialog').close();
    showToast(editingAppointmentId ? 'Appointment updated.' : 'Appointment saved.');
    await loadAppointments();
    await loadDashboard();
  } catch (error) {
    $('#appointment-error').textContent = error.message;
  }
});

$('#profile-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#profile-feedback').textContent = '';
  try {
    const data = await api('/api/profile', { method: 'PUT', body: JSON.stringify({ name: $('#profile-name').value.trim() }) });
    state.user = { ...state.user, ...data.user };
    updateProfileUI();
    $('#profile-feedback').textContent = 'Your profile has been updated.';
  } catch (error) {
    $('#profile-feedback').textContent = error.message;
  }
});

$('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#settings-feedback').textContent = '';
  const settings = {
    speechEnabled: $('#setting-speech').checked,
    hydrationGoalMl: Number($('#setting-hydration-goal').value)
  };
  try {
    const data = await api('/api/settings', { method: 'PUT', body: JSON.stringify(settings) });
    state.settings = data.settings;
    const consent = $('#setting-ai-consent').checked;
    if (consent !== Boolean(state.settings.aiConsent)) await setAiConsent(consent);
    $('#settings-feedback').textContent = 'Your preferences have been saved.';
    await loadDashboard();
    await loadHydration();
  } catch (error) {
    $('#settings-feedback').textContent = error.message;
  }
});

$('#password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#password-feedback').textContent = '';
  try {
    await api('/api/account/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: $('#current-password').value, newPassword: $('#new-password').value })
    });
    $('#password-form').reset();
    $('#password-feedback').textContent = 'Password changed. Other devices have been signed out.';
  } catch (error) {
    $('#password-feedback').textContent = error.message;
  }
});

$('#revoke-sessions').addEventListener('click', async () => {
  try {
    const data = await api('/api/account/sessions/revoke-others', { method: 'POST' });
    $('#password-feedback').textContent = data.revoked
      ? `Signed out ${data.revoked} other session${data.revoked === 1 ? '' : 's'}.`
      : 'No other devices were signed in.';
  } catch (error) {
    $('#password-feedback').textContent = error.message;
  }
});

$('#export-data').addEventListener('click', async () => {
  try {
    const response = await fetch('/api/account/export', { credentials: 'same-origin' });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Your data export could not be prepared.');
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const download = document.createElement('a');
    download.href = url;
    download.download = 'healix-data-export.json';
    download.click();
    URL.revokeObjectURL(url);
    showToast('Your data export has been downloaded.');
  } catch (error) {
    showToast(error.message);
  }
});

$('#delete-account').addEventListener('click', async () => {
  if (!window.confirm('This permanently deletes your account, conversations, attachments, hydration logs, appointments, and consultation history. This cannot be undone. Continue?')) return;
  if (window.prompt('Type DELETE to confirm account deletion.') !== 'DELETE') return;
  try {
    await api('/api/account', { method: 'DELETE' });
    signedOut();
    showToast('Your account and associated data have been deleted.');
  } catch (error) {
    showToast(error.message);
  }
});

$('#read-all-notifications').addEventListener('click', async () => {
  try {
    await api('/api/notifications/read-all', { method: 'POST' });
    loadNotifications();
  } catch (error) {
    showToast(error.message);
  }
});

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SpeechRecognition) {
  $('#voice-button').disabled = true;
  $('#voice-button').title = 'Speech recognition is not supported in this browser. You can type your message instead.';
  $('#voice-status').textContent = 'Voice input unavailable';
}
$('#voice-button').addEventListener('click', () => {
  if (!SpeechRecognition) return;
  const button = $('#voice-button');
  const status = $('#voice-status');
  const recognition = new SpeechRecognition();
  recognition.lang = document.documentElement.lang || 'en-US';
  recognition.interimResults = true;
  recognition.continuous = false;
  button.classList.add('recording');
  button.setAttribute('aria-label', 'Stop voice input');
  status.textContent = 'Listening…';
  recognition.onresult = (event) => {
    const transcript = Array.from(event.results).map((result) => result[0].transcript).join(' ');
    $('#chat-input').value = transcript;
  };
  recognition.onerror = (event) => {
    status.textContent = event.error === 'not-allowed'
      ? 'Microphone permission denied'
      : event.error === 'no-speech' ? 'No speech detected' : 'Voice input unavailable';
    button.classList.remove('recording');
    button.setAttribute('aria-label', 'Use voice input');
  };
  recognition.onend = () => {
    button.classList.remove('recording');
    button.setAttribute('aria-label', 'Use voice input');
    if (status.textContent === 'Listening…') status.textContent = 'Ready to send';
    setTimeout(() => { if (status.textContent === 'Ready to send') status.textContent = ''; }, 3000);
  };
  try {
    recognition.start();
  } catch {
    status.textContent = 'Could not start microphone';
    button.classList.remove('recording');
    button.setAttribute('aria-label', 'Use voice input');
  }
});

breathingExercise({ button: $('#breathing-button'), status: $('#breathing-status'), startLabel: 'Start a breathing pause →' });
breathingExercise({ button: $('#relax-breathing-button'), status: $('#relax-breathing-status'), circle: $('#breath-circle'), startLabel: 'Start breathing exercise' });

// care.js and admin.js load after this file; start once every script has registered its handlers.
document.addEventListener('DOMContentLoaded', initialize);
