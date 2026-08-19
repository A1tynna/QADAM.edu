const state = {
  token: localStorage.getItem('qadam_token'),
  user: null,
  route: location.hash.slice(1) || 'dashboard',
  data: {},
  meta: null,
  search: '',
  pendingVerificationEmail: sessionStorage.getItem('qadam_verification_email') || '',
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const content = $('#content');
const modalRoot = $('#modalRoot');
const roleNames = { admin: 'Администратор', teacher: 'Учитель', student: 'Ученик' };
const audienceNames = { all: 'Для всех', teacher: 'Для учителей', student: 'Для учеников' };
const dayNames = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
const monthNames = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

const navItems = [
  { route: 'dashboard', label: 'Главная', icon: '⌂', roles: ['admin', 'teacher', 'student'] },
  { route: 'schedule', label: 'Расписание', icon: '▦', roles: ['admin', 'teacher', 'student'] },
  { route: 'grades', label: 'Электронный журнал', icon: '✓', roles: ['admin', 'teacher', 'student'] },
  { route: 'materials', label: 'Материалы', icon: '◇', roles: ['admin', 'teacher', 'student'] },
  { route: 'news', label: 'Новости', icon: '◌', roles: ['admin', 'teacher', 'student'] },
  { route: 'users', label: 'Пользователи', icon: '♙', roles: ['admin'] },
];

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function initials(name = '') {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

function formatTime(value = '') { return String(value).slice(0, 5); }
function formatDate(value, options = {}) {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: options.year ? 'numeric' : undefined }).format(new Date(value));
}

function toast(message, type = 'success') {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  $('#toastRoot').append(node);
  setTimeout(() => node.remove(), 3500);
}

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch(`/api${url}`, { ...options, headers });
  if (response.status === 401 && !url.includes('/auth/')) {
    logout(false);
    throw new Error('Сессия истекла');
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(payload.error || 'Не удалось выполнить запрос');
    error.code = payload.code;
    error.email = payload.email;
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

function setButtonLoading(button, loading) {
  if (!button) return;
  if (loading) {
    button.dataset.label = button.innerHTML;
    button.innerHTML = '<span>Подождите…</span>';
    button.disabled = true;
  } else {
    button.innerHTML = button.dataset.label || button.innerHTML;
    button.disabled = false;
  }
}

function showAuth() {
  $('#authView').hidden = false;
  $('#appView').hidden = true;
}

function showAuthPane(name) {
  $('#loginPane').hidden = name !== 'login';
  $('#registerPane').hidden = name !== 'register';
  $('#verifyPane').hidden = name !== 'verify';
}

function showVerification(email) {
  state.pendingVerificationEmail = email;
  sessionStorage.setItem('qadam_verification_email', email);
  $('#verifyEmail').textContent = email;
  showAuthPane('verify');
  setTimeout(() => $('#verifyForm [name="code"]')?.focus(), 50);
}

function showApp() {
  $('#authView').hidden = true;
  $('#appView').hidden = false;
  $('#sidebarName').textContent = state.user.name;
  $('#sidebarRole').textContent = roleNames[state.user.role];
  $('#sidebarAvatar').textContent = initials(state.user.name);
  $('#topAvatar').textContent = initials(state.user.name);
  buildNav();
  navigate(state.route, false);
}

function buildNav() {
  const available = navItems.filter((item) => item.roles.includes(state.user.role));
  $('#mainNav').innerHTML = `
    <span class="nav-label">Рабочее пространство</span>
    ${available.map((item) => `<a href="#${item.route}" class="nav-item" data-route="${item.route}"><span class="nav-icon">${item.icon}</span>${item.label}</a>`).join('')}
  `;
}

function logout(notify = true) {
  localStorage.removeItem('qadam_token');
  state.token = null;
  state.user = null;
  state.meta = null;
  location.hash = '';
  showAuth();
  showAuthPane('login');
  if (notify) toast('Вы вышли из аккаунта');
}

async function ensureMeta() {
  if (!state.meta) state.meta = await api('/meta');
  return state.meta;
}

function loading() {
  content.innerHTML = '<div class="loading"><div><div class="spinner"></div>Загружаем данные…</div></div>';
}

function emptyState(title, text, icon = '◇') {
  return `<div class="empty"><div><div class="empty__icon">${icon}</div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p></div></div>`;
}

function setPage(kicker, title) {
  $('#pageKicker').textContent = kicker;
  $('#pageTitle').textContent = title;
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.route === state.route));
}

async function navigate(route, updateHash = true) {
  const allowed = navItems.some((item) => item.route === route && item.roles.includes(state.user.role));
  state.route = allowed ? route : 'dashboard';
  state.search = '';
  $('#globalSearch').value = '';
  if (updateHash && location.hash !== `#${state.route}`) location.hash = state.route;
  closeSidebar();
  loading();
  const renderers = { dashboard: renderDashboard, schedule: renderSchedule, grades: renderGrades, materials: renderMaterials, news: renderNews, users: renderUsers };
  try { await renderers[state.route](); } catch (error) { content.innerHTML = emptyState('Не удалось загрузить раздел', error.message, '!'); toast(error.message, 'error'); }
}

function greeting() {
  const hour = new Date().getHours();
  return hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер';
}

async function renderDashboard() {
  setPage('Обзор', 'Главная');
  const [stats, schedule, news] = await Promise.all([api('/dashboard'), api('/schedule'), api('/announcements')]);
  state.data.dashboard = { stats, schedule, news };
  $('#newsBadge').hidden = !news.length;
  const roleCopy = {
    admin: 'Управляйте командой и учебным процессом из единого рабочего пространства.',
    teacher: 'Сегодня отличный день, чтобы помочь ученикам сделать ещё один шаг к цели.',
    student: 'Ваш прогресс уже заметен. Сохраняйте темп и двигайтесь дальше.',
  }[state.user.role];
  const firstName = state.user.name.split(' ')[0];
  const metrics = state.user.role === 'admin'
    ? [
      ['♙', stats.users, 'Активных пользователей', '+ в системе'], ['▦', stats.lessons, 'Занятий в неделю', 'по расписанию'],
      ['◇', stats.materials, 'Учебных материалов', 'доступно'], ['◌', stats.announcements, 'Объявлений', 'опубликовано'],
    ] : state.user.role === 'teacher'
      ? [['▦', stats.lessons, 'Занятий в неделю', 'в расписании'], ['✓', stats.grades, 'Выставлено оценок', 'в журнале'], ['◇', stats.materials, 'Моих материалов', 'для учеников'], ['◌', stats.announcements, 'Объявлений', 'для вас']]
      : [['◫', stats.average ?? '—', 'Средний балл', stats.average ? 'из 10' : 'пока нет оценок'], ['✓', stats.grades, 'Оценок получено', 'в журнале'], ['▦', stats.lessons, 'Занятий в неделю', state.user.className || 'ваш класс'], ['◇', stats.materials, 'Материалов', 'доступно']];
  const today = new Date().getDay() || 7;
  const todayLessons = schedule.filter((lesson) => Number(lesson.weekday) === today).slice(0, 4);
  const shownLessons = todayLessons.length ? todayLessons : schedule.slice(0, 3);
  content.innerHTML = `
    <section class="welcome">
      <div class="welcome__copy"><span>${new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())}</span><h2>${greeting()}, ${escapeHtml(firstName)}!</h2><p>${roleCopy}</p></div>
      <div class="welcome__symbol">↗</div>
    </section>
    <div class="metric-grid">${metrics.map(([icon, value, label, trend]) => `<article class="metric"><div class="metric__top"><span class="metric__icon">${icon}</span><span class="metric__trend">${escapeHtml(trend)}</span></div><strong>${escapeHtml(value)}</strong><small>${escapeHtml(label)}</small></article>`).join('')}</div>
    <div class="dashboard-grid">
      <article class="card">
        <header class="card__head"><div><h3>${todayLessons.length ? 'Сегодняшние занятия' : 'Ближайшие занятия'}</h3><p>Ваш учебный ритм</p></div><button class="link-button" data-route="schedule">Всё расписание →</button></header>
        <div class="today-list">${shownLessons.length ? shownLessons.map(todayLesson).join('') : emptyState('Занятий пока нет', 'Расписание появится здесь после публикации', '▦')}</div>
      </article>
      <article class="card">
        <header class="card__head"><div><h3>Последние новости</h3><p>Важное в MyQadam</p></div><button class="link-button" data-route="news">Все →</button></header>
        <div class="news-mini">${news.slice(0, 3).map((item) => `<div class="news-mini__item"><span class="news-mini__icon">${item.pinned ? '★' : '◌'}</span><div><b>${escapeHtml(item.title)}</b><span>${formatDate(item.published_at)}</span></div></div>`).join('') || emptyState('Новостей нет', 'Новые объявления появятся здесь', '◌')}</div>
      </article>
    </div>`;
}

function todayLesson(lesson) {
  return `<div class="today-item"><div class="today-item__time"><b>${formatTime(lesson.starts_at)}</b><span>${formatTime(lesson.ends_at)}</span></div><i class="lesson-color ${escapeHtml(lesson.color)}"></i><div class="today-item__name"><b>${escapeHtml(lesson.subject)}</b><span>${escapeHtml(lesson.teacher_name)} · ${escapeHtml(lesson.class_name)}</span></div><span class="tag">${escapeHtml(lesson.room)}</span></div>`;
}

async function renderSchedule() {
  setPage('Учебный процесс', 'Расписание');
  const lessons = await api('/schedule');
  state.data.schedule = lessons;
  const canEdit = state.user.role === 'admin';
  content.innerHTML = `
    <div class="section-head"><div><h2>Расписание занятий</h2><p>${state.user.role === 'student' ? `Класс ${escapeHtml(state.user.className)}` : 'Актуальное расписание школы'}</p></div>${canEdit ? '<button class="button button--primary" data-action="add-lesson">+ Добавить занятие</button>' : ''}</div>
    <div class="toolbar"><div class="segmented"><button class="active">Эта неделя</button><button disabled>Следующая</button></div></div>
    ${lessons.length ? `<div class="schedule-grid">${dayNames.map((day, index) => scheduleDay(day, index + 1, lessons, canEdit)).join('')}</div>` : emptyState('Расписание пока пусто', 'Администратор ещё не добавил занятия', '▦')}`;
}

function scheduleDay(day, weekday, lessons, canEdit) {
  const items = lessons.filter((lesson) => Number(lesson.weekday) === weekday);
  const today = (new Date().getDay() || 7) === weekday;
  return `<section class="day-column ${today ? 'today' : ''}"><header class="day-column__head"><b>${day}</b><span>${items.length} ${items.length === 1 ? 'занятие' : 'зан.'}</span></header>${items.map((lesson) => `<article class="lesson-card ${escapeHtml(lesson.color)}"><time>${formatTime(lesson.starts_at)} — ${formatTime(lesson.ends_at)}</time><b>${escapeHtml(lesson.subject)}</b><span>${escapeHtml(lesson.class_name)} · ${escapeHtml(lesson.teacher_name)}</span><span>${escapeHtml(lesson.room)}</span>${canEdit ? `<div class="lesson-card__actions row-actions"><button data-action="delete-lesson" data-id="${lesson.id}" title="Удалить">×</button></div>` : ''}</article>`).join('') || '<div class="empty" style="min-height:100px;padding:15px"><div><p>Нет занятий</p></div></div>'}</section>`;
}

async function renderGrades() {
  setPage('Учебный процесс', state.user.role === 'student' ? 'Мои оценки' : 'Электронный журнал');
  const grades = await api('/grades');
  state.data.grades = grades;
  const canEdit = ['admin', 'teacher'].includes(state.user.role);
  drawGrades(grades, canEdit);
}

function drawGrades(grades, canEdit) {
  const query = state.search.toLowerCase();
  const filtered = grades.filter((grade) => [grade.student_name, grade.subject, grade.comment].some((value) => String(value || '').toLowerCase().includes(query)));
  const average = filtered.length ? (filtered.reduce((sum, item) => sum + Number(item.grade), 0) / filtered.length).toFixed(1) : '—';
  content.innerHTML = `
    <div class="section-head"><div><h2>${state.user.role === 'student' ? 'Ваши результаты' : 'Электронный журнал'}</h2><p>${filtered.length} записей · средний балл ${average}</p></div>${canEdit ? '<button class="button button--primary" data-action="add-grade">+ Выставить оценку</button>' : ''}</div>
    ${filtered.length ? `<div class="table-card"><table class="data-table"><thead><tr>${state.user.role !== 'student' ? '<th>Ученик</th>' : ''}<th>Предмет</th><th>Оценка</th><th>Работа / комментарий</th><th>Дата</th><th>Учитель</th>${canEdit ? '<th></th>' : ''}</tr></thead><tbody>${filtered.map((grade) => `<tr>${state.user.role !== 'student' ? `<td><b>${escapeHtml(grade.student_name)}</b><small>${escapeHtml(grade.class_name)}</small></td>` : ''}<td><b>${escapeHtml(grade.subject)}</b></td><td><span class="grade-pill ${grade.grade < 5 ? 'low' : grade.grade < 8 ? 'mid' : ''}">${grade.grade}</span></td><td>${escapeHtml(grade.comment || '—')}</td><td>${formatDate(grade.graded_at)}</td><td>${escapeHtml(grade.teacher_name)}</td>${canEdit ? `<td><div class="row-actions"><button data-action="delete-grade" data-id="${grade.id}" title="Удалить">×</button></div></td>` : ''}</tr>`).join('')}</tbody></table></div>` : emptyState('Оценок не найдено', query ? 'Измените поисковый запрос' : 'Новые оценки появятся в журнале', '✓')}`;
}

async function renderMaterials() {
  setPage('Библиотека', 'Учебные материалы');
  const materials = await api('/materials');
  state.data.materials = materials;
  drawMaterials(materials);
}

function drawMaterials(materials) {
  const query = state.search.toLowerCase();
  const filtered = materials.filter((item) => [item.title, item.subject, item.class_name, item.description].some((value) => String(value || '').toLowerCase().includes(query)));
  const canEdit = ['admin', 'teacher'].includes(state.user.role);
  content.innerHTML = `<div class="section-head"><div><h2>Библиотека знаний</h2><p>Конспекты, презентации, файлы и полезные ссылки</p></div>${canEdit ? '<button class="button button--primary" data-action="add-material">+ Загрузить материал</button>' : ''}</div>
    ${filtered.length ? `<div class="materials-grid">${filtered.map((item) => `<article class="material-card"><div class="material-card__top"><span class="file-icon">${item.kind === 'file' ? '▤' : '↗'}</span>${canEdit ? `<div class="row-actions"><button data-action="delete-material" data-id="${item.id}" title="Удалить">×</button></div>` : ''}</div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.description || 'Учебный материал по предмету')}</p><div class="material-card__meta"><span>${escapeHtml(item.subject)} · ${escapeHtml(item.class_name)}<br>${escapeHtml(item.teacher_name)}</span><a href="${escapeHtml(item.file_path || item.url)}" target="_blank" rel="noreferrer">Открыть →</a></div></article>`).join('')}</div>` : emptyState('Материалы не найдены', query ? 'Попробуйте другой запрос' : 'Учитель скоро добавит материалы', '◇')}`;
}

async function renderNews() {
  setPage('Школьная жизнь', 'Новости и объявления');
  const news = await api('/announcements');
  state.data.news = news;
  drawNews(news);
}

function drawNews(news) {
  const query = state.search.toLowerCase();
  const filtered = news.filter((item) => [item.title, item.body, item.author_name].some((value) => String(value || '').toLowerCase().includes(query)));
  const canEdit = state.user.role === 'admin';
  content.innerHTML = `<div class="section-head"><div><h2>Будьте в курсе</h2><p>События, изменения и важные напоминания</p></div>${canEdit ? '<button class="button button--primary" data-action="add-news">+ Новое объявление</button>' : ''}</div>
    ${filtered.length ? `<div class="news-list">${filtered.map((item) => { const date = new Date(item.published_at); return `<article class="news-card ${item.pinned ? 'pinned' : ''}"><div class="news-card__date"><b>${date.getDate()}</b><span>${monthNames[date.getMonth()]}</span></div><div><h3>${item.pinned ? '★ ' : ''}${escapeHtml(item.title)}</h3><p>${escapeHtml(item.body)}</p><div class="news-card__meta"><span>${escapeHtml(audienceNames[item.audience])}</span><span>Автор: ${escapeHtml(item.author_name)}</span></div></div>${canEdit ? `<div class="row-actions"><button data-action="delete-news" data-id="${item.id}" title="Удалить">×</button></div>` : ''}</article>`; }).join('')}</div>` : emptyState('Объявлений не найдено', query ? 'Попробуйте другой запрос' : 'Новости появятся здесь', '◌')}`;
}

async function renderUsers() {
  setPage('Администрирование', 'Пользователи');
  const users = await api('/users');
  state.data.users = users;
  drawUsers(users);
}

function drawUsers(users) {
  const query = state.search.toLowerCase();
  const filtered = users.filter((user) => [user.name, user.email, roleNames[user.role], user.className, user.subject].some((value) => String(value || '').toLowerCase().includes(query)));
  content.innerHTML = `<div class="section-head"><div><h2>Команда и ученики</h2><p>${filtered.filter((u) => u.active).length} активных из ${filtered.length} пользователей</p></div><button class="button button--primary" data-action="add-user">+ Добавить пользователя</button></div>
    ${filtered.length ? `<div class="table-card"><table class="data-table"><thead><tr><th>Пользователь</th><th>Роль</th><th>Класс / предмет</th><th>Статус</th><th>Создан</th><th></th></tr></thead><tbody>${filtered.map((user) => `<tr><td><b>${escapeHtml(user.name)}</b><small>${escapeHtml(user.email)}</small></td><td><span class="role-pill">${roleNames[user.role]}</span></td><td>${escapeHtml(user.className || user.subject || '—')}</td><td><span class="status ${user.active ? '' : 'off'}">${user.active ? 'Активен' : 'Заблокирован'}</span></td><td>${formatDate(user.createdAt)}</td><td><div class="row-actions"><button data-action="toggle-user" data-id="${user.id}" data-active="${user.active}" title="${user.active ? 'Заблокировать' : 'Активировать'}">${user.active ? '⊘' : '✓'}</button>${user.id !== state.user.id ? `<button data-action="delete-user" data-id="${user.id}" title="Удалить">×</button>` : ''}</div></td></tr>`).join('')}</tbody></table></div>` : emptyState('Пользователи не найдены', 'Попробуйте другой запрос', '♙')}`;
}

function showModal(title, body, submitLabel = 'Сохранить') {
  modalRoot.innerHTML = `<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}"><header class="modal__head"><h2>${escapeHtml(title)}</h2><button class="icon-button" data-close-modal aria-label="Закрыть">×</button></header><form id="modalForm"><div class="modal__body">${body}</div><footer class="modal__actions"><button type="button" class="button button--light" data-close-modal>Отмена</button><button type="submit" class="button button--primary">${escapeHtml(submitLabel)}</button></footer></form></div></div>`;
  setTimeout(() => $('input, select, textarea', modalRoot)?.focus(), 50);
  return $('#modalForm');
}

function closeModal() { modalRoot.innerHTML = ''; }
function formJson(form) { return Object.fromEntries(new FormData(form).entries()); }

async function openLessonModal() {
  const meta = await ensureMeta();
  const form = showModal('Новое занятие', `<div class="form-stack"><div class="field-row"><label class="field"><span>Предмет</span><input name="subject" placeholder="Математика" required></label><label class="field"><span>Класс</span><input name="className" list="classes" placeholder="11-А" required><datalist id="classes">${meta.classes.map((item) => `<option value="${escapeHtml(item)}">`).join('')}</datalist></label></div><label class="field"><span>Преподаватель</span><select name="teacherId" required><option value="">Выберите преподавателя</option>${meta.teachers.map((teacher) => `<option value="${teacher.id}">${escapeHtml(teacher.name)} — ${escapeHtml(teacher.subject || '')}</option>`).join('')}</select></label><div class="field-row"><label class="field"><span>День недели</span><select name="weekday" required>${dayNames.map((day, index) => `<option value="${index + 1}">${day}</option>`).join('')}</select></label><label class="field"><span>Кабинет</span><input name="room" placeholder="Кабинет 204" required></label></div><div class="field-row"><label class="field"><span>Начало</span><input name="startsAt" type="time" required></label><label class="field"><span>Окончание</span><input name="endsAt" type="time" required></label></div><label class="field"><span>Цвет</span><select name="color"><option value="blue">Голубой</option><option value="violet">Фиолетовый</option><option value="amber">Оранжевый</option><option value="green">Лаймовый</option></select></label></div>`, 'Добавить занятие');
  form.onsubmit = async (event) => submitModal(event, '/schedule', 'Занятие добавлено');
}

async function openGradeModal() {
  const meta = await ensureMeta();
  const form = showModal('Выставить оценку', `<div class="form-stack"><label class="field"><span>Ученик</span><select name="studentId" required><option value="">Выберите ученика</option>${meta.students.map((student) => `<option value="${student.id}">${escapeHtml(student.name)} · ${escapeHtml(student.class_name || '')}</option>`).join('')}</select></label><div class="field-row"><label class="field"><span>Предмет</span><input name="subject" value="${escapeHtml(state.user.subject || '')}" placeholder="Математика" required></label><label class="field"><span>Оценка (1–10)</span><input name="grade" type="number" min="1" max="10" required></label></div><label class="field"><span>Работа / комментарий</span><input name="comment" placeholder="Домашняя работа"></label><label class="field"><span>Дата</span><input name="gradedAt" type="date" value="${new Date().toISOString().slice(0, 10)}"></label></div>`, 'Выставить оценку');
  form.onsubmit = async (event) => submitModal(event, '/grades', 'Оценка выставлена');
}

function openMaterialModal() {
  const form = showModal('Новый материал', `<div class="form-stack"><label class="field"><span>Название</span><input name="title" placeholder="Конспект по теме…" required></label><div class="field-row"><label class="field"><span>Предмет</span><input name="subject" value="${escapeHtml(state.user.subject || '')}" required></label><label class="field"><span>Класс</span><input name="className" placeholder="11-А" required></label></div><label class="field"><span>Описание</span><textarea name="description" placeholder="Что найдёт ученик в материале"></textarea></label><label class="field"><span>Файл (до 15 МБ)</span><input name="file" type="file" accept=".pdf,.ppt,.pptx,.doc,.docx,.xls,.xlsx,.zip"></label><label class="field"><span>Или внешняя ссылка</span><input name="url" type="url" placeholder="https://…"></label></div>`, 'Загрузить материал');
  form.onsubmit = async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    if (!data.get('file')?.size && !data.get('url')) return toast('Выберите файл или укажите ссылку', 'error');
    const button = $('button[type="submit"]', form);
    setButtonLoading(button, true);
    try { await api('/materials', { method: 'POST', body: data }); closeModal(); toast('Материал добавлен'); await navigate('materials', false); } catch (error) { toast(error.message, 'error'); setButtonLoading(button, false); }
  };
}

function openNewsModal() {
  const form = showModal('Новое объявление', `<div class="form-stack"><label class="field"><span>Заголовок</span><input name="title" placeholder="Важная информация" required></label><label class="field"><span>Текст</span><textarea name="body" placeholder="Расскажите подробнее…" required></textarea></label><label class="field"><span>Аудитория</span><select name="audience"><option value="all">Все пользователи</option><option value="student">Только ученики</option><option value="teacher">Только учителя</option></select></label><label class="field" style="display:flex;grid-template-columns:auto 1fr;align-items:center"><input name="pinned" type="checkbox" style="width:18px;min-height:18px"><span>Закрепить объявление</span></label></div>`, 'Опубликовать');
  form.onsubmit = async (event) => { event.preventDefault(); const data = formJson(form); data.pinned = new FormData(form).has('pinned'); await submitModalRequest(form, '/announcements', data, 'Объявление опубликовано'); };
}

function openUserModal() {
  const form = showModal('Новый пользователь', `<div class="form-stack"><label class="field"><span>Имя и фамилия</span><input name="name" required></label><div class="field-row"><label class="field"><span>Email</span><input name="email" type="email" required></label><label class="field"><span>Временный пароль</span><input name="password" minlength="10" placeholder="10+ символов, Aa1!" required></label></div><label class="field"><span>Роль</span><select name="role" id="newUserRole"><option value="student">Ученик</option><option value="teacher">Учитель</option><option value="admin">Администратор</option></select></label><div class="field-row"><label class="field"><span>Класс (для ученика)</span><input name="className" placeholder="11-А"></label><label class="field"><span>Предмет (для учителя)</span><input name="subject" placeholder="Математика"></label></div></div>`, 'Создать аккаунт');
  form.onsubmit = async (event) => submitModal(event, '/users', 'Пользователь создан');
}

async function submitModal(event, endpoint, message) {
  event.preventDefault();
  await submitModalRequest(event.currentTarget, endpoint, formJson(event.currentTarget), message);
}

async function submitModalRequest(form, endpoint, data, message) {
  const button = $('button[type="submit"]', form);
  setButtonLoading(button, true);
  try { await api(endpoint, { method: 'POST', body: JSON.stringify(data) }); closeModal(); state.meta = null; toast(message); await navigate(state.route, false); } catch (error) { toast(error.message, 'error'); setButtonLoading(button, false); }
}

async function confirmDelete(endpoint, message) {
  if (!confirm('Удалить эту запись? Действие нельзя отменить.')) return;
  try { await api(endpoint, { method: 'DELETE' }); toast(message); await navigate(state.route, false); } catch (error) { toast(error.message, 'error'); }
}

function openSidebar() { $('#sidebar').classList.add('open'); $('#sidebarOverlay').classList.add('show'); }
function closeSidebar() { $('#sidebar').classList.remove('open'); $('#sidebarOverlay').classList.remove('show'); }

document.addEventListener('click', async (event) => {
  const routeTrigger = event.target.closest('[data-route]');
  if (routeTrigger) { event.preventDefault(); navigate(routeTrigger.dataset.route); return; }
  if (event.target.closest('[data-close-modal]') || (event.target.classList.contains('modal-backdrop'))) { closeModal(); return; }
  const action = event.target.closest('[data-action]');
  if (!action) return;
  const { action: type, id } = action.dataset;
  if (type === 'add-lesson') await openLessonModal();
  if (type === 'add-grade') await openGradeModal();
  if (type === 'add-material') openMaterialModal();
  if (type === 'add-news') openNewsModal();
  if (type === 'add-user') openUserModal();
  if (type === 'delete-lesson') await confirmDelete(`/schedule/${id}`, 'Занятие удалено');
  if (type === 'delete-grade') await confirmDelete(`/grades/${id}`, 'Оценка удалена');
  if (type === 'delete-material') await confirmDelete(`/materials/${id}`, 'Материал удалён');
  if (type === 'delete-news') await confirmDelete(`/announcements/${id}`, 'Объявление удалено');
  if (type === 'delete-user') await confirmDelete(`/users/${id}`, 'Пользователь удалён');
  if (type === 'toggle-user') {
    try {
      await api(`/users/${id}`, { method: 'PATCH', body: JSON.stringify({ active: action.dataset.active !== 'true' }) });
      state.meta = null;
      toast(action.dataset.active === 'true' ? 'Пользователь заблокирован' : 'Пользователь активирован');
      await navigate('users', false);
    } catch (error) { toast(error.message, 'error'); }
  }
});

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('button[type="submit"]', event.currentTarget);
  setButtonLoading(button, true);
  try {
    const payload = await api('/auth/login', { method: 'POST', body: JSON.stringify(formJson(event.currentTarget)) });
    state.token = payload.token; state.user = payload.user; localStorage.setItem('qadam_token', payload.token); showApp(); toast(`Добро пожаловать, ${state.user.name.split(' ')[0]}!`);
  } catch (error) {
    if (error.code === 'EMAIL_NOT_VERIFIED') showVerification(error.email || event.currentTarget.email.value);
    toast(error.message, 'error');
  } finally { setButtonLoading(button, false); }
});

$('#registerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const checks = getPasswordChecks(event.currentTarget.password.value);
  if (!Object.values(checks).every(Boolean)) return toast('Пароль должен соответствовать всем требованиям', 'error');
  const button = $('button[type="submit"]', event.currentTarget);
  setButtonLoading(button, true);
  try {
    const payload = await api('/auth/register', { method: 'POST', body: JSON.stringify(formJson(event.currentTarget)) });
    showVerification(payload.email);
    toast('Код подтверждения отправлен на почту');
  } catch (error) { toast(error.message, 'error'); } finally { setButtonLoading(button, false); }
});

$('#verifyForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const code = String(new FormData(form).get('code') || '').replace(/\D/g, '').slice(0, 6);
  const email = state.pendingVerificationEmail
    || sessionStorage.getItem('qadam_verification_email')
    || $('#verifyEmail').textContent.trim();
  if (code.length !== 6) return toast('Введите все 6 цифр из письма', 'error');
  if (!email) {
    showAuthPane('login');
    return toast('Адрес регистрации потерян. Войдите снова, чтобы продолжить подтверждение', 'error');
  }
  const button = $('button[type="submit"]', form);
  setButtonLoading(button, true);
  try {
    const payload = await api('/auth/verify-email', { method: 'POST', body: JSON.stringify({ email, code }) });
    state.token = payload.token;
    state.user = payload.user;
    localStorage.setItem('qadam_token', payload.token);
    sessionStorage.removeItem('qadam_verification_email');
    state.pendingVerificationEmail = '';
    form.reset();
    showApp();
    toast('Почта подтверждена. Добро пожаловать!');
  } catch (error) { toast(error.message, 'error'); } finally { setButtonLoading(button, false); }
});

$('#resendCode').onclick = async () => {
  const button = $('#resendCode');
  setButtonLoading(button, true);
  try {
    const payload = await api('/auth/resend-verification', { method: 'POST', body: JSON.stringify({ email: state.pendingVerificationEmail }) });
    toast(payload.message || 'Новый код отправлен');
  } catch (error) { toast(error.message, 'error'); } finally { setButtonLoading(button, false); }
};

function getPasswordChecks(value) {
  return {
    length: value.length >= 10,
    upper: /\p{Lu}/u.test(value),
    lower: /\p{Ll}/u.test(value),
    number: /\d/.test(value),
    special: /[^\p{L}\p{N}\s]/u.test(value),
    spaces: !/\s/.test(value),
  };
}

function updatePasswordStrength() {
  const value = $('#registerPassword').value;
  const checks = getPasswordChecks(value);
  Object.entries(checks).forEach(([rule, valid]) => $(`[data-rule="${rule}"]`)?.classList.toggle('valid', valid));
  const validCount = Object.values(checks).filter(Boolean).length;
  const score = value ? Math.min(4, Math.ceil((validCount / Object.keys(checks).length) * 4)) : 0;
  $('#passwordStrength').dataset.score = score;
  $('#strengthLabel').textContent = !value ? 'Пароль ещё не введён' : score < 2 ? 'Слабый пароль' : score < 4 ? 'Можно сделать надёжнее' : 'Надёжный пароль';
}

function updateRegistrationRole() {
  const teacher = $('#registerForm [name="role"]:checked').value === 'teacher';
  $('#studentRegistrationFields').hidden = teacher;
  $('#teacherRegistrationFields').hidden = !teacher;
  $('#registerForm [name="classNumber"]').required = !teacher;
  $('#registerForm [name="classLetter"]').required = !teacher;
  $('#registerForm [name="subject"]').required = teacher;
}

$('#registerPassword').addEventListener('input', updatePasswordStrength);
$$('#registerForm [name="role"]').forEach((radio) => radio.addEventListener('change', updateRegistrationRole));
$('#registerForm [name="classLetter"]').addEventListener('input', (event) => { event.target.value = event.target.value.replace(/[^\p{L}]/gu, '').slice(0, 1).toUpperCase(); });
$('#verifyForm [name="code"]').addEventListener('input', (event) => { event.target.value = event.target.value.replace(/\D/g, '').slice(0, 6); });
$('#showRegister').onclick = () => showAuthPane('register');
$('#showLogin').onclick = () => showAuthPane('login');
$('#verificationBack').onclick = () => showAuthPane('login');
$$('.show-password').forEach((button) => button.onclick = () => { const input = button.parentElement.querySelector('input'); input.type = input.type === 'password' ? 'text' : 'password'; });
$('#logoutButton').onclick = () => logout();
$('#openSidebar').onclick = openSidebar;
$('#closeSidebar').onclick = closeSidebar;
$('#sidebarOverlay').onclick = closeSidebar;
window.addEventListener('hashchange', () => { if (state.user) navigate(location.hash.slice(1) || 'dashboard', false); });

let searchTimer;
$('#globalSearch').addEventListener('input', (event) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = event.target.value.trim();
    if (state.route === 'grades') drawGrades(state.data.grades || [], ['admin', 'teacher'].includes(state.user.role));
    if (state.route === 'materials') drawMaterials(state.data.materials || []);
    if (state.route === 'news') drawNews(state.data.news || []);
    if (state.route === 'users') drawUsers(state.data.users || []);
  }, 150);
});

document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { closeModal(); closeSidebar(); } });

(async function init() {
  if (!state.token) {
    showAuth();
    if (state.pendingVerificationEmail) showVerification(state.pendingVerificationEmail);
    else showAuthPane('login');
    return;
  }
  try { state.user = await api('/me'); showApp(); } catch {
    showAuth();
    if (state.pendingVerificationEmail) showVerification(state.pendingVerificationEmail);
    else showAuthPane('login');
  }
})();
