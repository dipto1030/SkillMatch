require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function runMigrations() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const migrationDir = path.join(__dirname);
    const files = fs.readdirSync(migrationDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      console.log(`Running migration: ${file}`);
      const sql = fs.readFileSync(path.join(migrationDir, file), 'utf8');
      await pool.query(sql);
      console.log(`  ✓ ${file} complete`);
    }

    console.log('All migrations complete.');
  } catch (err) {
    console.error('Migration error:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigrations();
