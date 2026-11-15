require('dotenv').config({ quiet: true });

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../src/migrate-document-original-filename');

function connectionFor(tables, columns) {
  const statements = [];
  return {
    statements,
    async query(sql) {
      statements.push(sql);
      if (sql.includes('information_schema.TABLES')) return [tables];
      if (sql.includes('information_schema.COLUMNS')) return [columns];
      return [[]];
    },
  };
}

test('adds a nullable UTF-8 original filename column and can be run again', async () => {
  const missing = connectionFor([{}], []);
  await migrate(missing);
  assert.ok(missing.statements.some((sql) => sql.includes('ADD COLUMN originalFilename VARCHAR(255) CHARACTER SET utf8mb4')));
  const existing = connectionFor([{}], [{
    DATA_TYPE: 'varchar', CHARACTER_MAXIMUM_LENGTH: 255, CHARACTER_SET_NAME: 'utf8mb4', IS_NULLABLE: 'YES',
  }]);
  await migrate(existing);
  assert.equal(existing.statements.some((sql) => sql.includes('ALTER TABLE')), false);
});

test('rejects a missing table or an incompatible existing column', async () => {
  await assert.rejects(migrate(connectionFor([], [])), /base_document is missing/);
  const incompatible = connectionFor([{}], [{
    DATA_TYPE: 'varchar', CHARACTER_MAXIMUM_LENGTH: 50, CHARACTER_SET_NAME: 'utf8mb4', IS_NULLABLE: 'YES',
  }]);
  await assert.rejects(migrate(incompatible), /unexpected definition/);
  assert.equal(incompatible.statements.some((sql) => sql.includes('ALTER TABLE')), false);
});
