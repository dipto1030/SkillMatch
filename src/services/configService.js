const db = require('../config/database');

const platformConfig = {};

function parseValue(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  const num = Number(value);
  if (!isNaN(num) && value.trim() !== '') return num;
  return value;
}

const configService = {
  async loadConfig() {
    try {
      const { rows } = await db.query('SELECT key, value FROM platform_config');
      for (const row of rows) {
        platformConfig[row.key] = parseValue(row.value);
      }
    } catch (err) {
      console.warn('Could not load platform_config (table may not exist yet):', err.message);
    }
  },

  get(key, fallback) {
    return platformConfig[key] !== undefined ? platformConfig[key] : fallback;
  },

  getAll() {
    return { ...platformConfig };
  },

  async set(key, value, adminId) {
    const oldValue = platformConfig[key];
    await db.transaction(async (client) => {
      await client.query(
        `INSERT INTO platform_config (key, value, updated_at, updated_by)
         VALUES ($1, $2, NOW(), $3)
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW(), updated_by = $3`,
        [key, String(value), adminId]
      );
      await client.query(
        `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, payload)
         VALUES ($1, 'CONFIG_UPDATE', 'config', 0, $2)`,
        [adminId, JSON.stringify({ key, old_value: oldValue, new_value: value })]
      );
    });
    platformConfig[key] = parseValue(String(value));
  },
};

module.exports = configService;
