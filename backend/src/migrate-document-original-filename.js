require('dotenv').config({ quiet: true });

const pool = require('./db');

async function migrate(connection) {
  const [tables] = await connection.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'base_document'`,
  );
  if (!tables.length) throw new Error('base_document is missing; run npm run setup first');
  const [columns] = await connection.query(
    `SELECT DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, CHARACTER_SET_NAME, IS_NULLABLE
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'base_document' AND COLUMN_NAME = 'originalFilename'`,
  );
  if (!columns.length) {
    await connection.query(
      'ALTER TABLE base_document ADD COLUMN originalFilename VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL',
    );
  } else if (columns[0].DATA_TYPE !== 'varchar' || columns[0].CHARACTER_MAXIMUM_LENGTH !== 255
      || columns[0].CHARACTER_SET_NAME !== 'utf8mb4' || columns[0].IS_NULLABLE !== 'YES') {
    throw new Error('Existing base_document.originalFilename has an unexpected definition');
  }
  console.log('Document original filenames are ready.');
}

async function main() {
  const connection = await pool.getConnection();
  try {
    await migrate(connection);
  } finally {
    connection.release();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Document original filename migration failed:', error.message);
    process.exitCode = 1;
  }).finally(() => pool.end());
}

module.exports = { migrate };
