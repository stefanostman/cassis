require('dotenv').config({ quiet: true });

const pool = require('./db');
const { ensureParentRelation, PARENT_RELATION_TYPE } = require('./parent-relations');

async function migrate() {
  const connection = await pool.getConnection();
  try {
    const [columns] = await connection.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'base_record' AND COLUMN_NAME = 'caseId'`,
    );
    if (!columns.length) {
      console.log('The base_record.caseId column has already been removed.');
      return;
    }

    await connection.beginTransaction();
    try {
      const [records] = await connection.query('SELECT objectId, caseId FROM base_record FOR UPDATE');
      for (const record of records) {
        await ensureParentRelation(connection, record.caseId, record.objectId);
      }
      const [invalid] = await connection.execute(
        `SELECT b.objectId FROM base_record b
         LEFT JOIN cassis_relations p ON p.id = b.objectId AND p.targetId = b.objectId
           AND p.sourceId = b.caseId AND p.relationType = ?
         LEFT JOIN base_case c ON c.objectId = p.sourceId
         WHERE p.id IS NULL OR c.objectId IS NULL LIMIT 1`,
        [PARENT_RELATION_TYPE],
      );
      if (invalid.length) throw new Error(`Record ${invalid[0].objectId} has no matching parent relation`);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }

    const [keys] = await connection.query(
      `SELECT DISTINCT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'base_record'
         AND COLUMN_NAME = 'caseId' AND REFERENCED_TABLE_NAME IS NOT NULL`,
    );
    if (keys.length > 1) throw new Error('Multiple foreign keys use base_record.caseId; migration stopped');
    const dropKey = keys.length ? `DROP FOREIGN KEY \`${keys[0].CONSTRAINT_NAME.replace(/`/g, '``')}\`, ` : '';
    await connection.query(`ALTER TABLE base_record ${dropKey}DROP COLUMN caseId`);
    console.log('Parent relations verified; base_record.caseId removed.');
  } finally {
    connection.release();
  }
}

migrate().catch((error) => {
  console.error('Record relation migration failed:', error.message);
  process.exitCode = 1;
}).finally(() => pool.end());
