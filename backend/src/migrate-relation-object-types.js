require('dotenv').config({ quiet: true });

const pool = require('./db');

async function migrate(connection) {
  const [columns] = await connection.query(
    `SELECT DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cassis_relations' AND COLUMN_NAME = 'objectTypes'`,
  );
  if (!columns.length) {
    await connection.query('ALTER TABLE cassis_relations ADD COLUMN objectTypes VARCHAR(101) NULL');
  } else if (columns[0].DATA_TYPE !== 'varchar' || columns[0].CHARACTER_MAXIMUM_LENGTH !== 101) {
    throw new Error('Existing cassis_relations.objectTypes has an unexpected definition');
  }
  await connection.query(
    `UPDATE cassis_relations r
     JOIN cassis_objects s ON s.objectId = r.sourceId
     JOIN cassis_objects t ON t.objectId = r.targetId
     SET r.objectTypes = CONCAT(s.objectType, '-', t.objectType)
     WHERE r.objectTypes IS NULL`,
  );
  const [invalid] = await connection.query(
    `SELECT r.id FROM cassis_relations r
     LEFT JOIN cassis_objects s ON s.objectId = r.sourceId
     LEFT JOIN cassis_objects t ON t.objectId = r.targetId
     WHERE s.objectId IS NULL OR t.objectId IS NULL OR r.objectTypes IS NULL
       OR BINARY r.objectTypes <> BINARY CONCAT(s.objectType, '-', t.objectType) LIMIT 1`,
  );
  if (invalid.length) throw new Error(`Relation ${invalid[0].id} has missing objects or inconsistent object types`);
  if (!columns.length || columns[0].IS_NULLABLE === 'YES') {
    await connection.query('ALTER TABLE cassis_relations MODIFY COLUMN objectTypes VARCHAR(101) NOT NULL');
  }
  console.log('Relation object types are ready.');
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
    console.error('Relation object type migration failed:', error.message);
    process.exitCode = 1;
  }).finally(() => pool.end());
}

module.exports = { migrate };
