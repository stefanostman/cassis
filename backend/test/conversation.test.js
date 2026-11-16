require('dotenv').config({ quiet: true });

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const pool = require('../src/db');
const app = require('../src/server');
const { createUser, rolePermissions } = require('../src/roles');

test('case conversations enforce ownership and follow the case lifecycle', async () => {
  const suffix = randomBytes(6).toString('hex');
  const password = randomBytes(16).toString('hex');
  const caseId = randomUUID();
  const otherCaseId = randomUUID();
  const userIds = [];
  const originalPermissions = rolePermissions.Beslutsfattare;
  let server;
  try {
    const authorName = `author_${suffix}`;
    const author = await createUser(pool, authorName, password, ['Handläggare']);
    const other = await createUser(pool, `other_${suffix}`, password, ['Koordinator']);
    const reader = await createUser(pool, `reader_${suffix}`, password, ['Beslutsfattare']);
    userIds.push(author.id, other.id, reader.id);
    for (const id of [caseId, otherCaseId]) {
      await pool.execute('INSERT INTO cassis_objects VALUES (?, ?, UTC_TIMESTAMP(3), ?, UTC_TIMESTAMP(3), ?)',
        [id, 'base_case', authorName, authorName]);
      await pool.execute('INSERT INTO base_case (objectId, diaryNumber, classification, caseSentence) VALUES (?, ?, ?, ?)',
        [id, 'CONV-TEST', '', '']);
    }
    server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const base = `http://127.0.0.1:${server.address().port}/api`;
    async function login(username) {
      const response = await fetch(`${base}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
      });
      assert.equal(response.status, 200);
      return (await response.json()).token;
    }
    const authorToken = await login(authorName);
    const otherToken = await login(`other_${suffix}`);
    const readerToken = await login(`reader_${suffix}`);
    rolePermissions.Beslutsfattare = ['read'];
    async function request(token, path, method = 'GET', body) {
      const response = await fetch(base + path, {
        method,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body && JSON.stringify(body),
      });
      return { status: response.status, body: response.status === 204 ? null : await response.json() };
    }
    const path = `/cases/${caseId}/conversation`;
    assert.equal((await request('', path)).status, 401);
    assert.deepEqual((await request(authorToken, path)).body, []);
    assert.equal((await request(authorToken, `/cases/${randomUUID()}/conversation`)).status, 404);
    assert.equal((await request(readerToken, path, 'POST', { body: 'Nekat' })).status, 403);
    for (const body of ['', '  ', 'a'.repeat(4001)]) {
      assert.equal((await request(authorToken, path, 'POST', { body })).status, 400);
    }
    assert.equal((await request(authorToken, path, 'POST', { body: 'Text', authorName: 'annan' })).status, 400);
    const created = await request(authorToken, path, 'POST', { body: 'Hej!\nDokument 📄' });
    assert.equal(created.status, 201);
    assert.equal(created.body.authorName, authorName);
    assert.equal(created.body.body, 'Hej!\nDokument 📄');
    assert.equal(created.body.isOwn, true);
    assert.match(created.body.created, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/);
    assert.deepEqual((await request(otherToken, `/cases/${otherCaseId}/conversation`)).body, []);
    assert.equal((await request(otherToken, path)).body[0].isOwn, false);
    assert.equal((await request(readerToken, path)).body[0].body, created.body.body);
    const postPath = `${path}/${created.body.id}`;
    assert.equal((await request(otherToken, postPath, 'PUT', { body: 'ändring' })).status, 403);
    assert.equal((await request(readerToken, postPath, 'PUT', { body: 'ändring' })).status, 403);
    assert.equal((await request(authorToken, `/cases/${otherCaseId}/conversation/${created.body.id}`, 'PUT', { body: 'ändring' })).status, 404);
    const edited = await request(authorToken, postPath, 'PUT', { body: 'Ändrat' });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.body, 'Ändrat');
    assert.equal(edited.body.created, created.body.created);
    await pool.execute('DELETE FROM cassis_users WHERE id = ?', [author.id]);
    userIds.splice(userIds.indexOf(author.id), 1);
    const replacement = await createUser(pool, authorName, password, ['Handläggare']);
    userIds.push(replacement.id);
    const replacementToken = await login(authorName);
    assert.equal((await request(replacementToken, path)).body[0].authorName, authorName);
    assert.equal((await request(replacementToken, path)).body[0].isOwn, false);
    assert.equal((await request(replacementToken, postPath, 'PUT', { body: 'Kapad' })).status, 403);
    assert.equal((await request(otherToken, `/cases/${caseId}`, 'DELETE')).status, 204);
    const [remaining] = await pool.execute('SELECT id FROM case_conversation_posts WHERE caseId = ?', [caseId]);
    assert.deepEqual(remaining, []);
    assert.equal((await request(otherToken, path)).status, 404);
  } finally {
    rolePermissions.Beslutsfattare = originalPermissions;
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await pool.execute('DELETE FROM cassis_objects WHERE objectId IN (?, ?)', [caseId, otherCaseId]);
    for (const userId of userIds) await pool.execute('DELETE FROM cassis_users WHERE id = ?', [userId]);
    await pool.end();
  }
});
