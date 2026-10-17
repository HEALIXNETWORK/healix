const state = {
  user: null,
  settings: { speechEnabled: false, hydrationGoalMl: 0 },
  conversations: [],
  conversationId: null,
  appointments: [],
  pendingChat: null,
  authMode: 'login',
  breathingTimer: null,
  toastTimer: null
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

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

function setAuthError(message = '') {
  $('#auth-error').textContent = message;
}

function setAuthenticated(user, settings = state.settings) {
  state.user = user;
  state.settings = { speechEnabled: false, hydrationGoalMl: 0, ...settings };
  $('#auth-view').classList.add('is-hidden');
  $('#app-view').classList.remove('is-hidden');
  updateProfileUI();
  showScreen('dashboard');
  loadDashboard();
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
  $('#today-label').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date());
}

function showScreen(name) {
  $$('.screen').forEach((screen) => screen.classList.toggle('active', screen.id === `screen-${name}`));
  $$('[data-nav]').forEach((button) => {
    const isActive = button.dataset.nav === name;
    button.classList.toggle('active', isActive);
    if (isActive) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  if (name === 'dashboard') loadDashboard();
  if (name === 'assistant') {
    loadConversations().then(() => {
      if (state.conversationId) loadMessages(state.conversationId);
    }).catch((error) => showToast(error.message));
  }
  if (name === 'hydration') loadHydration();
  if (name === 'appointments') loadAppointments();
  if (name === 'profile') updateProfileUI();
}

function hydrationUrl() {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `/api/hydration?date=${date}&timezoneOffset=${now.getTimezoneOffset()}`;
}

async function loadConfig() {
  try {
    const config = await api('/api/config');
    const notice = $('#ai-config-notice');
    if (!config.aiConfigured) {
      notice.textContent = 'AI responses are not configured yet. The server administrator needs to set AI_API_KEY and restart HEALIX. Your messages will not be sent to an AI provider until it is configured.';
      notice.classList.remove('is-hidden');
    } else {
      notice.classList.add('is-hidden');
    }
  } catch {
    $('#ai-config-notice').textContent = 'AI configuration status is unavailable. If replies fail, check the server configuration.';
    $('#ai-config-notice').classList.remove('is-hidden');
  }
}

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
      const empty = document.createElement('p');
      empty.className = 'small-muted';
      empty.textContent = 'No upcoming appointments saved.';
      container.append(empty);
    } else {
      for (const appointment of upcoming) {
        const item = document.createElement('div');
        item.className = 'mini-appointment';
        const date = new Date(appointment.scheduledAt);
        const dateEl = document.createElement('span');
        dateEl.className = 'mini-date';
        const month = document.createElement('span');
        month.textContent = new Intl.DateTimeFormat(undefined, { month: 'short' }).format(date).toUpperCase();
        const day = document.createElement('b');
        day.textContent = new Intl.DateTimeFormat(undefined, { day: 'numeric' }).format(date);
        dateEl.append(month, day);
        const copy = document.createElement('span');
        copy.className = 'mini-appointment-copy';
        const title = document.createElement('b');
        title.textContent = appointment.title;
        const time = document.createElement('small');
        time.textContent = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(date);
        copy.append(title, time);
        item.append(dateEl, copy);
        container.append(item);
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
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = 'No water entries yet. Add one above whenever you like.';
      records.append(empty);
      return;
    }
    for (const record of data.records) {
      const row = document.createElement('div');
      row.className = 'record-row';
      const icon = document.createElement('span');
      icon.className = 'record-drop';
      icon.textContent = '◉';
      const copy = document.createElement('span');
      copy.className = 'record-copy';
      const amount = document.createElement('b');
      amount.textContent = `${record.amountMl.toLocaleString()} ml`;
      const time = document.createElement('small');
      time.textContent = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(record.recordedAt));
      copy.append(amount, time);
      const remove = document.createElement('button');
      remove.className = 'record-delete';
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove ${record.amountMl} ml water record`);
      remove.addEventListener('click', async () => {
        try {
          await api(`/api/hydration/${encodeURIComponent(record.id)}`, { method: 'DELETE' });
          await loadHydration();
          await loadDashboard();
        } catch (error) {
          showToast(error.message);
        }
      });
      row.append(icon, copy, remove);
      records.append(row);
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
      const empty = document.createElement('article');
      empty.className = 'panel appointment-card empty-state';
      empty.textContent = 'No appointments saved yet. Add one to keep it in view.';
      list.append(empty);
      return;
    }
    for (const appointment of state.appointments) {
      const card = document.createElement('article');
      card.className = 'panel appointment-card';
      const top = document.createElement('div');
      top.className = 'appointment-card-top';
      const title = document.createElement('h3');
      title.textContent = appointment.title;
      const date = document.createElement('time');
      date.dateTime = appointment.scheduledAt;
      date.textContent = new Intl.DateTimeFormat(undefined, {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
      }).format(new Date(appointment.scheduledAt));
      top.append(title);
      const notes = document.createElement('p');
      notes.textContent = appointment.notes || 'No notes added.';
      const actions = document.createElement('div');
      actions.className = 'appointment-actions';
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.textContent = 'Edit';
      edit.addEventListener('click', () => openAppointmentDialog(appointment));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'delete-appointment';
      remove.textContent = 'Delete';
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
      actions.append(edit, remove);
      card.append(top, date, notes, actions);
      list.append(card);
    }
  } catch (error) {
    if (error.status !== 401) showToast(error.message);
  }
}

function renderConversationList() {
  const list = $('#conversation-list');
  list.replaceChildren();
  if (!state.conversations.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'Your conversations will appear here.';
    list.append(empty);
    return;
  }
  for (const conversation of state.conversations) {
    const row = document.createElement('div');
    row.className = 'conversation-row';
    const select = document.createElement('button');
    select.type = 'button';
    select.className = `conversation-select${conversation.id === state.conversationId ? ' active' : ''}`;
    const title = document.createElement('b');
    title.textContent = conversation.title;
    const preview = document.createElement('small');
    preview.textContent = conversation.preview || 'No messages yet';
    select.append(title, preview);
    select.addEventListener('click', () => loadMessages(conversation.id));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'conversation-delete';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Delete conversation: ${conversation.title}`);
    remove.addEventListener('click', async () => {
      if (!window.confirm(`Delete "${conversation.title}" and its messages?`)) return;
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
    row.append(select, remove);
    list.append(row);
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

function appendMessage(message) {
  const list = $('#message-list');
  const row = document.createElement('div');
  row.className = `message ${message.role}`;
  if (message.role === 'assistant') {
    const avatar = document.createElement('span');
    avatar.className = 'message-avatar';
    avatar.textContent = '✳';
    row.append(avatar);
  }
  const content = document.createElement('div');
  content.className = 'message-bubble';
  content.textContent = message.content;
  row.append(content);
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

async function sendChat(content, requestId = crypto.randomUUID(), isRetry = false) {
  try {
    if (!state.conversationId) await createConversation();
    state.pendingChat = { content, requestId };
    if (!isRetry) {
      appendMessage({ role: 'user', content });
      $('#chat-empty').classList.add('is-hidden');
    }
    hideChatError();
    $('#typing-indicator').classList.remove('is-hidden');
    $('#send-message').disabled = true;
    $('#chat-input').disabled = true;
    const data = await api(`/api/conversations/${encodeURIComponent(state.conversationId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content, clientRequestId: requestId })
    });
    appendMessage(data.message);
    state.pendingChat = null;
    $('#typing-indicator').classList.add('is-hidden');
    await loadConversations();
    if (state.settings.speechEnabled && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(data.message.content));
    }
  } catch (error) {
    $('#typing-indicator').classList.add('is-hidden');
    showChatError(error.message);
  } finally {
    $('#send-message').disabled = false;
    $('#chat-input').disabled = false;
    $('#chat-input').focus();
  }
}

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
  $('#auth-name').required = registering;
  $('#auth-name').autocomplete = registering ? 'name' : 'off';
  $('#auth-password').autocomplete = registering ? 'new-password' : 'current-password';
  $('#auth-submit').innerHTML = registering ? 'Create account <span aria-hidden="true">→</span>' : 'Sign in <span aria-hidden="true">→</span>';
  $('#auth-switch-text').textContent = registering ? 'Already have an account?' : 'New to HEALIX?';
  $('#auth-switch').textContent = registering ? 'Sign in' : 'Create an account';
  $('#auth-password').minLength = registering ? 12 : 1;
  setAuthError();
}

async function initialize() {
  $('#today-label').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date());
  loadConfig();
  try {
    const data = await api('/api/session');
    setAuthenticated(data.user, data.settings);
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
  if (registering) body.name = $('#auth-name').value.trim();
  const submit = $('#auth-submit');
  submit.disabled = true;
  try {
    const data = await api(registering ? '/api/auth/register' : '/api/auth/login', {
      method: 'POST', body: JSON.stringify(body)
    });
    $('#auth-form').reset();
    setAuthenticated(data.user, data.settings);
    await loadConfig();
  } catch (error) {
    setAuthError(error.message);
  } finally {
    submit.disabled = false;
  }
});

$('#logout-button').addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST' });
    state.user = null;
    state.conversationId = null;
    state.conversations = [];
    state.appointments = [];
    $('#app-view').classList.add('is-hidden');
    $('#auth-view').classList.remove('is-hidden');
    setAuthMode('login');
    $('#auth-form').reset();
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  } catch (error) {
    showToast(error.message);
  }
});

$('#new-conversation').addEventListener('click', () => createConversation().catch((error) => showToast(error.message)));
$('#refresh-conversations').addEventListener('click', () => loadConversations().catch((error) => showToast(error.message)));
$('#chat-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const content = $('#chat-input').value.trim();
  if (!content || $('#send-message').disabled) return;
  if (!$('#ai-consent').checked) {
    showChatError('Please confirm that you are comfortable sharing messages with the configured AI provider.');
    return;
  }
  $('#chat-input').value = '';
  sendChat(content);
});
$('#retry-message').addEventListener('click', () => {
  if (state.pendingChat) sendChat(state.pendingChat.content, state.pendingChat.requestId, true);
});
$$('.suggestion').forEach((button) => button.addEventListener('click', () => {
  $('#chat-input').value = button.textContent;
  $('#chat-input').focus();
}));

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
    $('#settings-feedback').textContent = 'Your preferences have been saved.';
    await loadDashboard();
    await loadHydration();
  } catch (error) {
    $('#settings-feedback').textContent = error.message;
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
  if (!window.confirm('This permanently deletes your account, conversations, hydration logs, and appointments. This cannot be undone. Continue?')) return;
  if (window.prompt('Type DELETE to confirm account deletion.') !== 'DELETE') return;
  try {
    await api('/api/account', { method: 'DELETE' });
    state.user = null;
    state.conversationId = null;
    state.conversations = [];
    state.appointments = [];
    $('#app-view').classList.add('is-hidden');
    $('#auth-view').classList.remove('is-hidden');
    $('#auth-form').reset();
    setAuthMode('login');
    showToast('Your account and associated data have been deleted.');
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

$('#breathing-button').addEventListener('click', () => {
  const button = $('#breathing-button');
  const status = $('#breathing-status');
  if (state.breathingTimer) {
    clearInterval(state.breathingTimer);
    state.breathingTimer = null;
    button.textContent = 'Start a breathing pause →';
    status.textContent = '';
    return;
  }
  button.textContent = 'End breathing pause';
  const startedAt = Date.now();
  const update = () => {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    if (elapsed >= 60) {
      clearInterval(state.breathingTimer);
      state.breathingTimer = null;
      button.textContent = 'Start a breathing pause →';
      status.textContent = 'Pause complete. Take care.';
      return;
    }
    const phase = elapsed % 14;
    status.textContent = phase < 4 ? `Breathe in · ${4 - phase}` : phase < 8 ? `Hold gently · ${8 - phase}` : `Breathe out · ${14 - phase}`;
  };
  update();
  state.breathingTimer = setInterval(update, 1000);
});

initialize();
