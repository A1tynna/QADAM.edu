const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const base = process.env.TEST_BASE_URL || 'http://localhost:3000/api';
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL || 'postgres://qadam:qadam_password@localhost:5432/qadam_lms' });

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${base}${path}`, { ...options, headers });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  return { response, data };
}

async function login(email, password) {
  const { response, data } = await request('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200, `login failed for ${email}`);
  return data;
}

async function main() {
  const unique = Date.now();
  const password = 'SmokePass1!';
  const emails = {
    admin: `qa-admin-${unique}@example.com`,
    teacher: `qa-teacher-${unique}@example.com`,
    student: `qa-student-${unique}@example.com`,
  };
  const passwordHash = await bcrypt.hash(password, 10);
  await pool.query(
    `INSERT INTO users (name, email, password_hash, role, class_name, subject, active, email_verified) VALUES
      ('QA Admin', $1, $4, 'admin', NULL, NULL, true, true),
      ('QA Teacher', $2, $4, 'teacher', NULL, 'QA test', true, true),
      ('QA Student', $3, $4, 'student', 'QA-А', NULL, true, true)`,
    [emails.admin, emails.teacher, emails.student, passwordHash]
  );

  try {
    const sessions = {
      admin: await login(emails.admin, password),
      teacher: await login(emails.teacher, password),
      student: await login(emails.student, password),
    };

  for (const [role, session] of Object.entries(sessions)) {
    assert.equal(session.user.role, role);
    for (const endpoint of ['/dashboard', '/schedule', '/grades', '/materials', '/announcements', '/meta']) {
      const { response } = await request(endpoint, { token: session.token });
      assert.equal(response.status, 200, `${role} cannot GET ${endpoint}`);
    }
  }

  const forbidden = await request('/schedule', {
    method: 'POST',
    token: sessions.student.token,
    body: JSON.stringify({}),
  });
  assert.equal(forbidden.response.status, 403);

  const meta = (await request('/meta', { token: sessions.admin.token })).data;
  const teacher = meta.teachers[0];
  const student = meta.students[0];

  const lesson = await request('/schedule', {
    method: 'POST', token: sessions.admin.token,
    body: JSON.stringify({ subject: 'QA test', className: student.class_name, teacherId: teacher.id, weekday: 2, startsAt: '18:00', endsAt: '18:30', room: 'Test', color: 'blue' }),
  });
  assert.equal(lesson.response.status, 201);
  assert.equal((await request(`/schedule/${lesson.data.id}`, { method: 'DELETE', token: sessions.admin.token })).response.status, 204);

  const grade = await request('/grades', {
    method: 'POST', token: sessions.teacher.token,
    body: JSON.stringify({ studentId: student.id, subject: 'QA test', grade: 10, comment: 'Smoke test' }),
  });
  assert.equal(grade.response.status, 201);
  assert.equal((await request(`/grades/${grade.data.id}`, { method: 'DELETE', token: sessions.teacher.token })).response.status, 204);

  const materialForm = new FormData();
  materialForm.set('title', 'QA test');
  materialForm.set('subject', 'QA test');
  materialForm.set('className', student.class_name);
  materialForm.set('url', 'https://example.com/test');
  const material = await request('/materials', { method: 'POST', token: sessions.teacher.token, body: materialForm });
  assert.equal(material.response.status, 201);
  assert.equal((await request(`/materials/${material.data.id}`, { method: 'DELETE', token: sessions.teacher.token })).response.status, 204);

  const announcement = await request('/announcements', {
    method: 'POST', token: sessions.admin.token,
    body: JSON.stringify({ title: 'QA test', body: 'Smoke test', audience: 'all', pinned: false }),
  });
  assert.equal(announcement.response.status, 201);
  assert.equal((await request(`/announcements/${announcement.data.id}`, { method: 'DELETE', token: sessions.admin.token })).response.status, 204);

  const user = await request('/users', {
    method: 'POST',
    token: sessions.admin.token,
    body: JSON.stringify({ name: 'Тестовый ученик', email: `qa-${unique}@example.com`, password: 'StrongPass1!', role: 'student', className: 'QA' }),
  });
  assert.equal(user.response.status, 201);
  assert.equal((await request(`/users/${user.data.id}`, { method: 'DELETE', token: sessions.admin.token })).response.status, 204);

  const weakRegistration = await request('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Тест', email: `weak-${unique}@example.com`, password: 'test123', role: 'student', classNumber: 11, classLetter: 'А' }),
  });
  assert.equal(weakRegistration.response.status, 400);

  console.log('Smoke test passed: auth, roles, password policy, schedule, grades, materials, news, users');
  } finally {
    await pool.query('DELETE FROM users WHERE email = ANY($1::text[])', [Object.values(emails)]);
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
