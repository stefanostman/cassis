require('dotenv').config({ quiet: true });

const fs = require('node:fs/promises');
const path = require('node:path');
const pool = require('./db');
const { seedValueLists } = require('./seed-value-lists');

async function setup() {
  const [existing] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cassis_valuelists'`,
  );
  if (existing.length && !existing.some((column) => column.COLUMN_NAME === 'objectId')) {
    throw new Error('Existing value lists require npm run migrate-value-list-objects before setup');
  }
  const [relationColumns] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cassis_relations'`,
  );
  if (relationColumns.length && !relationColumns.some((column) => column.COLUMN_NAME === 'objectTypes')) {
    throw new Error('Existing relations require npm run migrate-relation-object-types before setup');
  }
  const sql = await fs.readFile(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  for (const statement of sql.split(';').map((part) => part.trim()).filter(Boolean)) {
    await pool.query(statement);
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await seedValueLists(connection);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  console.log('Database tables are ready.');
}

setup().catch((error) => {
  console.error('Database setup failed:', error.message);
  process.exitCode = 1;
}).finally(() => pool.end());
