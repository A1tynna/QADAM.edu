require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'qadam-local-development-secret';
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://qadam:qadam_password@localhost:5432/qadam_lms';
const VERIFICATION_TTL_MINUTES = Math.max(5, Number(process.env.VERIFICATION_TTL_MINUTES) || 15);
const pool = new Pool({ connectionString: DATABASE_URL });
const uploadsDir = path.join(__dirname, 'uploads');
const smtpConfigured = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.SMTP_FROM);
const mailer = smtpConfigured ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: String(process.env.SMTP_SECURE).toLowerCase() === 'true',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
}, { disableFileAccess: true, disableUrlAccess: true }) : null;

fs.mkdirSync(uploadsDir, { recursive: true });

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(uploadsDir));
app.use(express.static(path.join(__dirname, 'public')));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Zа-яА-ЯёЁ0-9._-]/g, '-');
    cb(null, `${Date.now()}-${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['.pdf', '.ppt', '.pptx', '.doc', '.docx', '.xls', '.xlsx', '.zip'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(allowed.includes(ext) ? null : new Error('Разрешены PDF, Office-документы и ZIP'), allowed.includes(ext));
  },
});

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

function publicUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    className: row.class_name,
    subject: row.subject,
    active: row.active,
    emailVerified: row.email_verified,
    createdAt: row.created_at,
  };
}

function signToken(user) {
  return jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
}

function passwordProblems(password) {
  const value = String(password || '');
  const problems = [];
  if (value.length < 10) problems.push('не менее 10 символов');
  if (!/\p{Lu}/u.test(value)) problems.push('заглавная буква');
  if (!/\p{Ll}/u.test(value)) problems.push('строчная буква');
  if (!/\d/.test(value)) problems.push('цифра');
  if (!/[^\p{L}\p{N}\s]/u.test(value)) problems.push('специальный символ');
  if (/\s/.test(value)) problems.push('без пробелов');
  return problems;
}

function verificationHash(code) {
  return crypto.createHash('sha256').update(`${code}:${JWT_SECRET}`).digest('hex');
}

function createVerificationCode() {
  return String(crypto.randomInt(100000, 1000000));
}

async function sendVerificationEmail({ email, name, code }) {
  if (!mailer) {
    const error = new Error('Почтовая служба пока не настроена');
    error.status = 503;
    throw error;
  }
  try {
    await mailer.sendMail({
      from: process.env.SMTP_FROM,
      to: email,
      subject: `${code} — подтверждение почты Qadam.edu`,
      text: `Здравствуйте, ${name}! Код подтверждения Qadam.edu: ${code}. Он действует ${VERIFICATION_TTL_MINUTES} минут. Если вы не регистрировались, проигнорируйте письмо.`,
      html: `<div style="max-width:560px;margin:auto;padding:32px;font-family:Arial,sans-serif;color:#17211c"><div style="font-size:22px;font-weight:800;color:#173f31">QADAM<span style="color:#7b9813">.edu</span></div><h1 style="margin:32px 0 12px;font-size:28px">Подтвердите вашу почту</h1><p style="color:#65716a;line-height:1.6">Здравствуйте, ${String(name).replace(/[<>&]/g, '')}! Введите этот код на странице регистрации:</p><div style="margin:28px 0;padding:20px;border-radius:14px;background:#eff8c9;color:#173f31;text-align:center;font-size:36px;font-weight:800;letter-spacing:10px">${code}</div><p style="color:#65716a;font-size:13px">Код действует ${VERIFICATION_TTL_MINUTES} минут. Если вы не создавали аккаунт, просто проигнорируйте письмо.</p></div>`,
    });
  } catch (error) {
    console.error('SMTP delivery failed:', error.message);
    const deliveryError = new Error('Не удалось отправить письмо. Проверьте адрес или попробуйте позже');
    deliveryError.status = 502;
    throw deliveryError;
  }
}

const auth = asyncRoute(async (req, res, next) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Необходимо войти в систему' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1 AND active = true', [payload.id]);
    if (!rows[0]) return res.status(401).json({ error: 'Пользователь не найден или заблокирован' });
    req.user = rows[0];
    next();
  } catch {
    res.status(401).json({ error: 'Сессия истекла. Войдите снова' });
  }
});

const allow = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Недостаточно прав' });
  next();
};

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      email VARCHAR(180) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'teacher', 'student')),
      class_name VARCHAR(40),
      subject VARCHAR(120),
      active BOOLEAN NOT NULL DEFAULT true,
      email_verified BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT true;

    CREATE TABLE IF NOT EXISTS email_verifications (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      code_hash CHAR(64) NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      resend_after TIMESTAMPTZ NOT NULL,
      attempts SMALLINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS lessons (
      id SERIAL PRIMARY KEY,
      subject VARCHAR(120) NOT NULL,
      class_name VARCHAR(40) NOT NULL,
      teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      weekday SMALLINT NOT NULL CHECK (weekday BETWEEN 1 AND 7),
      starts_at TIME NOT NULL,
      ends_at TIME NOT NULL,
      room VARCHAR(80) NOT NULL,
      color VARCHAR(20) NOT NULL DEFAULT 'blue',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS grades (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subject VARCHAR(120) NOT NULL,
      grade SMALLINT NOT NULL CHECK (grade BETWEEN 1 AND 10),
      comment VARCHAR(300),
      graded_at DATE NOT NULL DEFAULT CURRENT_DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS materials (
      id SERIAL PRIMARY KEY,
      title VARCHAR(180) NOT NULL,
      subject VARCHAR(120) NOT NULL,
      class_name VARCHAR(40) NOT NULL,
      teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      description VARCHAR(500),
      kind VARCHAR(20) NOT NULL CHECK (kind IN ('file', 'link')),
      file_name VARCHAR(220),
      file_path VARCHAR(300),
      url VARCHAR(500),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS announcements (
      id SERIAL PRIMARY KEY,
      title VARCHAR(180) NOT NULL,
      body TEXT NOT NULL,
      audience VARCHAR(20) NOT NULL DEFAULT 'all' CHECK (audience IN ('all', 'teacher', 'student')),
      author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      pinned BOOLEAN NOT NULL DEFAULT false,
      published_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const existing = await pool.query('SELECT COUNT(*)::int AS count FROM users');
  if (existing.rows[0].count > 0) return;

  const password = await bcrypt.hash('qadam123', 10);
  const users = await pool.query(`
    INSERT INTO users (name, email, password_hash, role, class_name, subject) VALUES
      ('Алия Садыкова', 'admin@qadam.edu', $1, 'admin', NULL, NULL),
      ('Мақпал Хакимовна', 'teacher@qadam.edu', $1, 'teacher', NULL, 'Математика'),
      ('Ануар Дауренбек', 'history@qadam.edu', $1, 'teacher', NULL, 'История Казахстана'),
      ('Айлин Нурова', 'student@qadam.edu', $1, 'student', '11-А', NULL),
      ('Данияр Сеитов', 'daniyar@qadam.edu', $1, 'student', '11-А', NULL),
      ('София Ким', 'sofia@qadam.edu', $1, 'student', '10-Б', NULL)
    RETURNING id, email
  `, [password]);

  const byEmail = Object.fromEntries(users.rows.map((user) => [user.email, user.id]));
  await pool.query(`
    INSERT INTO lessons (subject, class_name, teacher_id, weekday, starts_at, ends_at, room, color) VALUES
      ('Математика', '11-А', $1, 1, '09:00', '10:20', 'Кабинет 204', 'violet'),
      ('История Казахстана', '11-А', $2, 1, '10:40', '12:00', 'Кабинет 112', 'amber'),
      ('Математика', '10-Б', $1, 2, '15:00', '16:20', 'Онлайн', 'blue'),
      ('Математика', '11-А', $1, 3, '09:00', '10:20', 'Кабинет 204', 'violet'),
      ('История Казахстана', '11-А', $2, 4, '10:40', '12:00', 'Кабинет 112', 'amber'),
      ('Пробный ЕНТ', '11-А', $1, 6, '10:00', '12:30', 'Актовый зал', 'green')
  `, [byEmail['teacher@qadam.edu'], byEmail['history@qadam.edu']]);

  await pool.query(`
    INSERT INTO grades (student_id, teacher_id, subject, grade, comment, graded_at) VALUES
      ($1, $2, 'Математика', 9, 'Квадратные уравнения', CURRENT_DATE - 12),
      ($1, $2, 'Математика', 8, 'Домашняя работа', CURRENT_DATE - 7),
      ($1, $3, 'История Казахстана', 10, 'Казахское ханство', CURRENT_DATE - 5),
      ($1, $2, 'Математика', 9, 'Пробный тест', CURRENT_DATE - 2),
      ($4, $2, 'Математика', 7, 'Домашняя работа', CURRENT_DATE - 3)
  `, [byEmail['student@qadam.edu'], byEmail['teacher@qadam.edu'], byEmail['history@qadam.edu'], byEmail['daniyar@qadam.edu']]);

  await pool.query(`
    INSERT INTO materials (title, subject, class_name, teacher_id, description, kind, url) VALUES
      ('Формулы сокращённого умножения', 'Математика', '11-А', $1, 'Конспект и задания для самостоятельной практики', 'link', 'https://example.com/math-formulas'),
      ('Казахское ханство: хронология', 'История Казахстана', '11-А', $2, 'Интерактивная хронология ключевых событий', 'link', 'https://example.com/khanate'),
      ('Разбор пробного ЕНТ №4', 'Математика', '11-А', $1, 'Видеоразбор сложных заданий пробного теста', 'link', 'https://example.com/ent-4')
  `, [byEmail['teacher@qadam.edu'], byEmail['history@qadam.edu']]);

  await pool.query(`
    INSERT INTO announcements (title, body, audience, author_id, pinned, published_at) VALUES
      ('Пробный ЕНТ в эту субботу', 'Начало в 10:00. Возьмите удостоверение личности, ручку и калькулятор. Результаты появятся в журнале в понедельник.', 'student', $1, true, NOW() - INTERVAL '1 day'),
      ('Обновили библиотеку материалов', 'Добавили новые конспекты по математике и истории Казахстана. Они уже доступны в разделе «Материалы».', 'all', $1, false, NOW() - INTERVAL '3 days'),
      ('Педагогический совет', 'В пятницу в 17:30 состоится общая встреча преподавателей в кабинете 201.', 'teacher', $1, false, NOW() - INTERVAL '4 days')
  `, [byEmail['admin@qadam.edu']]);
}

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  const user = rows[0];
  if (!user || !user.active || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Неверный email или пароль' });
  }
  if (!user.email_verified) {
    return res.status(403).json({ error: 'Сначала подтвердите адрес электронной почты', code: 'EMAIL_NOT_VERIFIED', email: user.email });
  }
  res.json({ token: signToken(user), user: publicUser(user) });
}));

app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const { name, email, password, role, classNumber, classLetter, subject } = req.body;
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const normalizedRole = String(role || 'student');
  if (!name || !normalizedEmail || !password || !['student', 'teacher'].includes(normalizedRole)) {
    return res.status(400).json({ error: 'Заполните все обязательные поля' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) return res.status(400).json({ error: 'Введите корректный email' });
  const problems = passwordProblems(password);
  if (problems.length) return res.status(400).json({ error: `Пароль недостаточно надёжный: ${problems.join(', ')}` });
  let className = null;
  let normalizedSubject = null;
  if (normalizedRole === 'student') {
    const number = Number(classNumber);
    const letter = String(classLetter || '').trim().toUpperCase();
    if (!Number.isInteger(number) || number < 1 || number > 11 || !/^\p{L}$/u.test(letter)) {
      return res.status(400).json({ error: 'Укажите номер класса от 1 до 11 и одну букву' });
    }
    className = `${number}-${letter}`;
  } else {
    normalizedSubject = String(subject || '').trim();
    if (normalizedSubject.length < 2) return res.status(400).json({ error: 'Укажите предмет преподавателя' });
  }
  if (!smtpConfigured) return res.status(503).json({ error: 'Регистрация временно недоступна: администратор не настроил отправку писем' });
  const hash = await bcrypt.hash(password, 10);
  const code = createVerificationCode();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO users (name, email, password_hash, role, class_name, subject, email_verified)
       VALUES ($1, $2, $3, $4, $5, $6, false) RETURNING *`,
      [String(name).trim(), normalizedEmail, hash, normalizedRole, className, normalizedSubject]
    );
    await client.query(
      `INSERT INTO email_verifications (user_id, code_hash, expires_at, resend_after)
       VALUES ($1, $2, NOW() + ($3::int * INTERVAL '1 minute'), NOW() + INTERVAL '60 seconds')`,
      [rows[0].id, verificationHash(code), VERIFICATION_TTL_MINUTES]
    );
    await sendVerificationEmail({ email: normalizedEmail, name: rows[0].name, code });
    await client.query('COMMIT');
    res.status(201).json({ requiresVerification: true, email: normalizedEmail, expiresInMinutes: VERIFICATION_TTL_MINUTES });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') return res.status(409).json({ error: 'Этот email уже зарегистрирован' });
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/api/auth/verify-email', asyncRoute(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const code = String(req.body.code || '').replace(/\D/g, '');
  if (!email) return res.status(400).json({ error: 'Не найден адрес регистрации. Войдите снова и повторите подтверждение' });
  if (code.length !== 6) return res.status(400).json({ error: 'Введите все 6 цифр из письма' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT u.*, v.code_hash, v.expires_at, v.attempts
       FROM users u JOIN email_verifications v ON v.user_id = u.id
       WHERE u.email = $1 FOR UPDATE`,
      [email]
    );
    const user = rows[0];
    if (!user) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Заявка на подтверждение не найдена' }); }
    if (new Date(user.expires_at) < new Date()) { await client.query('ROLLBACK'); return res.status(410).json({ error: 'Код истёк. Запросите новый' }); }
    if (user.attempts >= 5) { await client.query('ROLLBACK'); return res.status(429).json({ error: 'Слишком много попыток. Запросите новый код' }); }
    const actual = Buffer.from(verificationHash(code), 'hex');
    const expected = Buffer.from(user.code_hash, 'hex');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      await client.query('UPDATE email_verifications SET attempts = attempts + 1 WHERE user_id = $1', [user.id]);
      await client.query('COMMIT');
      return res.status(400).json({ error: 'Неверный код подтверждения' });
    }
    await client.query('UPDATE users SET email_verified = true WHERE id = $1', [user.id]);
    await client.query('DELETE FROM email_verifications WHERE user_id = $1', [user.id]);
    await client.query('COMMIT');
    user.email_verified = true;
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/api/auth/resend-verification', asyncRoute(async (req, res) => {
  if (!smtpConfigured) return res.status(503).json({ error: 'Почтовая служба пока не настроена' });
  const email = String(req.body.email || '').trim().toLowerCase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT u.id, u.name, u.email, u.email_verified, v.resend_after
       FROM users u JOIN email_verifications v ON v.user_id = u.id WHERE u.email = $1 FOR UPDATE`,
      [email]
    );
    const user = rows[0];
    if (!user || user.email_verified) {
      await client.query('ROLLBACK');
      return res.json({ message: 'Если аккаунт ожидает подтверждения, письмо отправлено' });
    }
    if (user.resend_after && new Date(user.resend_after) > new Date()) {
      const seconds = Math.ceil((new Date(user.resend_after) - new Date()) / 1000);
      await client.query('ROLLBACK');
      return res.status(429).json({ error: `Повторная отправка будет доступна через ${seconds} сек.` });
    }
    const code = createVerificationCode();
    await client.query(
      `UPDATE email_verifications SET code_hash = $2, expires_at = NOW() + ($3::int * INTERVAL '1 minute'), resend_after = NOW() + INTERVAL '60 seconds', attempts = 0 WHERE user_id = $1`,
      [user.id, verificationHash(code), VERIFICATION_TTL_MINUTES]
    );
    await sendVerificationEmail({ email: user.email, name: user.name, code });
    await client.query('COMMIT');
    res.json({ message: 'Новый код отправлен' });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}));

app.get('/api/me', auth, (req, res) => res.json(publicUser(req.user)));

app.get('/api/dashboard', auth, asyncRoute(async (req, res) => {
  let lessonWhere = '';
  let gradeWhere = '';
  let materialWhere = '';
  let lessonParams = [];
  let gradeParams = [];
  let materialParams = [];
  if (req.user.role === 'teacher') {
    lessonWhere = 'WHERE l.teacher_id = $1';
    gradeWhere = 'WHERE g.teacher_id = $1';
    materialWhere = 'WHERE m.teacher_id = $1';
    lessonParams = [req.user.id];
    gradeParams = [req.user.id];
    materialParams = [req.user.id];
  } else if (req.user.role === 'student') {
    lessonWhere = 'WHERE l.class_name = $1';
    gradeWhere = 'WHERE g.student_id = $1';
    materialWhere = 'WHERE m.class_name = $1';
    lessonParams = [req.user.class_name];
    gradeParams = [req.user.id];
    materialParams = [req.user.class_name];
  }
  const newsQuery = req.user.role === 'admin'
    ? pool.query('SELECT COUNT(*)::int AS count FROM announcements')
    : pool.query(`SELECT COUNT(*)::int AS count FROM announcements WHERE audience IN ('all', $1)`, [req.user.role]);
  const [lessons, grades, materials, news, users] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS count FROM lessons l ${lessonWhere}`, lessonParams),
    pool.query(`SELECT COUNT(*)::int AS count, ROUND(AVG(grade), 1) AS average FROM grades g ${gradeWhere}`, gradeParams),
    pool.query(`SELECT COUNT(*)::int AS count FROM materials m ${materialWhere}`, materialParams),
    newsQuery,
    req.user.role === 'admin' ? pool.query('SELECT COUNT(*)::int AS count FROM users WHERE active = true') : Promise.resolve({ rows: [{ count: 0 }] }),
  ]);
  res.json({
    lessons: lessons.rows[0].count,
    grades: grades.rows[0].count,
    average: grades.rows[0].average ? Number(grades.rows[0].average) : null,
    materials: materials.rows[0].count,
    announcements: news.rows[0].count,
    users: users.rows[0].count,
  });
}));

app.get('/api/users', auth, allow('admin'), asyncRoute(async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM users ORDER BY created_at DESC');
  res.json(rows.map(publicUser));
}));

app.post('/api/users', auth, allow('admin'), asyncRoute(async (req, res) => {
  const { name, email, password, role, className, subject } = req.body;
  if (!name || !email || !password || !['admin', 'teacher', 'student'].includes(role)) {
    return res.status(400).json({ error: 'Проверьте обязательные поля' });
  }
  const problems = passwordProblems(password);
  if (problems.length) return res.status(400).json({ error: `Пароль недостаточно надёжный: ${problems.join(', ')}` });
  const hash = await bcrypt.hash(password, 10);
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, class_name, subject)
       VALUES ($1, LOWER($2), $3, $4, $5, $6) RETURNING *`,
      [String(name).trim(), String(email).trim(), hash, role, className || null, subject || null]
    );
    res.status(201).json(publicUser(rows[0]));
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Этот email уже используется' });
    throw error;
  }
}));

app.patch('/api/users/:id', auth, allow('admin'), asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id && req.body.active === false) return res.status(400).json({ error: 'Нельзя заблокировать свой аккаунт' });
  const { rows } = await pool.query(
    `UPDATE users SET
      name = COALESCE($2, name), active = COALESCE($3, active),
      class_name = COALESCE($4, class_name), subject = COALESCE($5, subject)
     WHERE id = $1 RETURNING *`,
    [id, req.body.name || null, typeof req.body.active === 'boolean' ? req.body.active : null, req.body.className || null, req.body.subject || null]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Пользователь не найден' });
  res.json(publicUser(rows[0]));
}));

app.delete('/api/users/:id', auth, allow('admin'), asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'Нельзя удалить свой аккаунт' });
  await pool.query('DELETE FROM users WHERE id = $1', [id]);
  res.status(204).end();
}));

app.get('/api/schedule', auth, asyncRoute(async (req, res) => {
  const clauses = [];
  const params = [];
  if (req.user.role === 'teacher') { params.push(req.user.id); clauses.push(`l.teacher_id = $${params.length}`); }
  if (req.user.role === 'student') { params.push(req.user.class_name); clauses.push(`l.class_name = $${params.length}`); }
  if (req.query.className && req.user.role === 'admin') { params.push(req.query.className); clauses.push(`l.class_name = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(`
    SELECT l.*, u.name AS teacher_name FROM lessons l
    JOIN users u ON u.id = l.teacher_id ${where}
    ORDER BY l.weekday, l.starts_at
  `, params);
  res.json(rows);
}));

app.post('/api/schedule', auth, allow('admin'), asyncRoute(async (req, res) => {
  const { subject, className, teacherId, weekday, startsAt, endsAt, room, color } = req.body;
  if (!subject || !className || !teacherId || !weekday || !startsAt || !endsAt || !room) return res.status(400).json({ error: 'Заполните все поля занятия' });
  const { rows } = await pool.query(
    `INSERT INTO lessons (subject, class_name, teacher_id, weekday, starts_at, ends_at, room, color)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [subject, className, teacherId, weekday, startsAt, endsAt, room, color || 'blue']
  );
  res.status(201).json(rows[0]);
}));

app.delete('/api/schedule/:id', auth, allow('admin'), asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM lessons WHERE id = $1', [req.params.id]);
  res.status(204).end();
}));

app.get('/api/grades', auth, asyncRoute(async (req, res) => {
  const clauses = [];
  const params = [];
  if (req.user.role === 'student') { params.push(req.user.id); clauses.push(`g.student_id = $${params.length}`); }
  if (req.user.role === 'teacher') { params.push(req.user.id); clauses.push(`g.teacher_id = $${params.length}`); }
  if (req.query.studentId && req.user.role !== 'student') { params.push(req.query.studentId); clauses.push(`g.student_id = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(`
    SELECT g.*, s.name AS student_name, s.class_name, t.name AS teacher_name
    FROM grades g JOIN users s ON s.id = g.student_id JOIN users t ON t.id = g.teacher_id
    ${where} ORDER BY g.graded_at DESC, g.id DESC
  `, params);
  res.json(rows);
}));

app.post('/api/grades', auth, allow('teacher', 'admin'), asyncRoute(async (req, res) => {
  const { studentId, subject, grade, comment, gradedAt } = req.body;
  const numericGrade = Number(grade);
  if (!studentId || !subject || numericGrade < 1 || numericGrade > 10) return res.status(400).json({ error: 'Проверьте ученика, предмет и оценку' });
  const teacherId = req.user.role === 'teacher' ? req.user.id : (req.body.teacherId || req.user.id);
  const { rows } = await pool.query(
    `INSERT INTO grades (student_id, teacher_id, subject, grade, comment, graded_at)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6::date,CURRENT_DATE)) RETURNING *`,
    [studentId, teacherId, subject, numericGrade, comment || null, gradedAt || null]
  );
  res.status(201).json(rows[0]);
}));

app.delete('/api/grades/:id', auth, allow('teacher', 'admin'), asyncRoute(async (req, res) => {
  const params = [req.params.id];
  const owner = req.user.role === 'teacher' ? ' AND teacher_id = $2' : '';
  if (owner) params.push(req.user.id);
  await pool.query(`DELETE FROM grades WHERE id = $1${owner}`, params);
  res.status(204).end();
}));

app.get('/api/materials', auth, asyncRoute(async (req, res) => {
  const clauses = [];
  const params = [];
  if (req.user.role === 'student') { params.push(req.user.class_name); clauses.push(`m.class_name = $${params.length}`); }
  if (req.query.subject) { params.push(req.query.subject); clauses.push(`m.subject = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(`
    SELECT m.*, u.name AS teacher_name FROM materials m JOIN users u ON u.id = m.teacher_id
    ${where} ORDER BY m.created_at DESC
  `, params);
  res.json(rows);
}));

app.post('/api/materials', auth, allow('teacher', 'admin'), upload.single('file'), asyncRoute(async (req, res) => {
  const { title, subject, className, description, url } = req.body;
  if (!title || !subject || !className || (!req.file && !url)) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Укажите название, предмет, класс и файл или ссылку' });
  }
  const kind = req.file ? 'file' : 'link';
  const { rows } = await pool.query(
    `INSERT INTO materials (title, subject, class_name, teacher_id, description, kind, file_name, file_path, url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [title, subject, className, req.user.id, description || null, kind, req.file?.originalname || null, req.file ? `/uploads/${req.file.filename}` : null, url || null]
  );
  res.status(201).json(rows[0]);
}));

app.delete('/api/materials/:id', auth, allow('teacher', 'admin'), asyncRoute(async (req, res) => {
  const params = [req.params.id];
  const owner = req.user.role === 'teacher' ? ' AND teacher_id = $2' : '';
  if (owner) params.push(req.user.id);
  const { rows } = await pool.query(`DELETE FROM materials WHERE id = $1${owner} RETURNING file_path`, params);
  if (rows[0]?.file_path) fs.unlink(path.join(__dirname, rows[0].file_path), () => {});
  res.status(204).end();
}));

app.get('/api/announcements', auth, asyncRoute(async (req, res) => {
  const params = [];
  let where = '';
  if (req.user.role !== 'admin') { params.push(req.user.role); where = `WHERE a.audience IN ('all', $1)`; }
  const { rows } = await pool.query(`
    SELECT a.*, u.name AS author_name FROM announcements a JOIN users u ON u.id = a.author_id
    ${where} ORDER BY a.pinned DESC, a.published_at DESC
  `, params);
  res.json(rows);
}));

app.post('/api/announcements', auth, allow('admin'), asyncRoute(async (req, res) => {
  const { title, body, audience, pinned } = req.body;
  if (!title || !body || !['all', 'teacher', 'student'].includes(audience)) return res.status(400).json({ error: 'Заполните объявление' });
  const { rows } = await pool.query(
    `INSERT INTO announcements (title, body, audience, author_id, pinned) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [title, body, audience, req.user.id, Boolean(pinned)]
  );
  res.status(201).json(rows[0]);
}));

app.delete('/api/announcements/:id', auth, allow('admin'), asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM announcements WHERE id = $1', [req.params.id]);
  res.status(204).end();
}));

app.get('/api/meta', auth, asyncRoute(async (_req, res) => {
  if (_req.user.role === 'student') {
    return res.json({ teachers: [], students: [], classes: [_req.user.class_name].filter(Boolean) });
  }
  const { rows } = await pool.query(`SELECT id, name, email, role, class_name, subject FROM users WHERE active = true ORDER BY name`);
  res.json({
    teachers: rows.filter((u) => u.role === 'teacher'),
    students: rows.filter((u) => u.role === 'student'),
    classes: [...new Set(rows.map((u) => u.class_name).filter(Boolean))].sort(),
  });
}));

app.get('/api/health', asyncRoute(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok' });
}));

app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  next();
});

app.use((error, _req, res, _next) => {
  console.error(error);
  if (error instanceof multer.MulterError) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Файл больше 15 МБ' : error.message });
  if (error.message?.startsWith('Разрешены')) return res.status(400).json({ error: error.message });
  res.status(error.status || 500).json({ error: error.status ? error.message : 'Внутренняя ошибка сервера' });
});

async function start() {
  try {
    await initDatabase();
    app.listen(PORT, () => console.log(`Qadam LMS: http://localhost:${PORT}`));
  } catch (error) {
    console.error('Не удалось подключиться к PostgreSQL:', error.message);
    process.exit(1);
  }
}

start();

module.exports = { app, pool };
