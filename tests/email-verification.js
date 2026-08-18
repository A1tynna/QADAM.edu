const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const base = process.env.TEST_BASE_URL || 'http://localhost:3000/api';
const databaseUrl = process.env.TEST_DATABASE_URL || 'postgres://qadam:qadam_password@localhost:5432/qadam_lms';
const jwtSecret = process.env.TEST_JWT_SECRET || 'docker-development-secret-change-in-production';
const pool = new Pool({ connectionString: databaseUrl });

async function request(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  return { response, data };
}

async function main() {
  const email = `verify-${Date.now()}@example.com`;
  const password = 'StrongPass1!';
  const code = '246810';
  const codeHash = crypto.createHash('sha256').update(`${code}:${jwtSecret}`).digest('hex');
  const passwordHash = await bcrypt.hash(password, 10);
  let userId;

  try {
    const user = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, class_name, email_verified)
       VALUES ('Email Verification Test', $1, $2, 'student', '11-А', false) RETURNING id`,
      [email, passwordHash]
    );
    userId = user.rows[0].id;
    await pool.query(
      `INSERT INTO email_verifications (user_id, code_hash, expires_at, resend_after)
       VALUES ($1, $2, NOW() + INTERVAL '15 minutes', NOW() - INTERVAL '1 minute')`,
      [userId, codeHash]
    );

    const blockedLogin = await request('/auth/login', { email, password });
    assert.equal(blockedLogin.response.status, 403);
    assert.equal(blockedLogin.data.code, 'EMAIL_NOT_VERIFIED');

    const wrongCode = await request('/auth/verify-email', { email, code: '111111' });
    assert.equal(wrongCode.response.status, 400);

    const verified = await request('/auth/verify-email', { email, code });
    assert.equal(verified.response.status, 200);
    assert.equal(verified.data.user.emailVerified, true);
    assert.ok(verified.data.token);

    const login = await request('/auth/login', { email, password });
    assert.equal(login.response.status, 200);
    console.log('Email verification test passed: blocked login, invalid code, confirmation, verified login');
  } finally {
    if (userId) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
