require('dotenv').config({ quiet: true });

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db');
const app = require('../src/server');

test('authenticated API returns value lists and enforces them on case and record writes', async () => {
  const caseId = randomUUID();
  const recordId = randomUUID();
  const rows = [
    { listName: 'classification', value: 'Ö' },
    { listName: 'classification', value: 'A' },
    { listName: 'extraClass', value: 'ett' },
    { listName: 'recordType', value: 'Brev' },
  ];
  const references = [
    { TABLE_NAME: 'base_case', COLUMN_NAME: 'classification_ValueList', COLUMN_DEFAULT: 'classification' },
    { TABLE_NAME: 'base_case', COLUMN_NAME: 'extraclass_ValueList', COLUMN_DEFAULT: 'extraClass' },
    { TABLE_NAME: 'case_extraclass', COLUMN_NAME: 'value_ValueList', COLUMN_DEFAULT: 'extraClass' },
    { TABLE_NAME: 'base_record', COLUMN_NAME: 'recordType_ValueList', COLUMN_DEFAULT: 'recordType' },
  ];
  let writes = 0;
  const originalExecute = pool.execute;
  const originalGetConnection = pool.getConnection;
  pool.execute = async (sql) => {
    if (sql.includes('FROM cassis_sessions')) return [[{ id: 'user-id', username: 'test' }]];
    if (sql.includes('FROM cassis_user_roles')) return [[{ value: 'admin' }]];
    if (sql.includes('FROM information_schema.COLUMNS')) return [references];
    if (sql.includes('FROM cassis_valuelists')) return [rows];
    if (sql.includes('FROM base_case c')) return [[{ objectId: caseId }]];
    if (sql.includes('FROM case_extraclass')) return [[]];
    if (sql.includes('FROM base_record r')) return [[{ objectId: recordId, caseId }]];
    throw new Error(`Unexpected query: ${sql}`);
  };
  pool.getConnection = async () => ({
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
    execute: async (sql, params) => {
      if (sql.includes('FROM information_schema.COLUMNS')) return [references];
      if (sql.includes('FROM cassis_valuelists')) return [rows.filter((row) => params.includes(row.listName))];
      if (sql.includes('FROM cassis_objects')) return [[{ objectId: params[0] }]];
      if (sql.includes('SELECT sourceId FROM cassis_relations')) return [[{ sourceId: caseId }]];
      writes++;
      return [{ affectedRows: 1 }];
    },
  });
  let server;
  try {
    server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const base = `http://127.0.0.1:${server.address().port}/api`;
    async function request(path, method = 'GET', body) {
      const response = await fetch(base + path, {
        method,
        headers: { Authorization: `Bearer ${'a'.repeat(64)}`, 'Content-Type': 'application/json' },
        body: body && JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    }
    const lists = await request('/value-lists');
    assert.equal(lists.status, 200);
    assert.deepEqual(lists.body.filter((row) => row.listName === 'classification').map((row) => row.value), ['A', 'Ö']);
    const bindings = await request('/value-list-bindings');
    assert.deepEqual(bindings.body, {
      base_case: { classification: 'classification', extraclass: 'extraClass' },
      base_record: { recordType: 'recordType' },
    });
    const caseData = { diaryNumber: '1', classification: 'A', caseSentence: 'Ärende', extraclass: ['ett'] };
    const recordData = { caseId, name: 'Handling', description: '', recordType: 'Brev' };
    for (const [path, method, data] of [
      ['/cases', 'POST', { ...caseData, classification: 'gammalt' }],
      [`/cases/${caseId}`, 'PUT', { ...caseData, extraclass: ['ett', 'gammalt'] }],
      ['/records', 'POST', { ...recordData, recordType: 'gammalt' }],
      [`/records/${recordId}`, 'PUT', { ...recordData, recordType: 'gammalt' }],
    ]) {
      writes = 0;
      const result = await request(path, method, data);
      assert.equal(result.status, 400);
      assert.match(result.body.error, /must contain only values from/);
      assert.equal(writes, 0);
    }
    assert.equal((await request('/cases', 'POST', caseData)).status, 201);
    assert.equal((await request(`/cases/${caseId}`, 'PUT', { ...caseData, extraclass: [] })).status, 200);
    assert.equal((await request('/records', 'POST', recordData)).status, 201);
    assert.equal((await request(`/records/${recordId}`, 'PUT', recordData)).status, 200);
  } finally {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    pool.execute = originalExecute;
    pool.getConnection = originalGetConnection;
    await pool.end();
  }
});
