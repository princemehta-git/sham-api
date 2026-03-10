/**
 * Expected MySQL table schema. On startup we ensure DB/tables exist and add any missing columns.
 * Format: { tableName: [ { name, type, nullable, default } ] }
 * type is used in ALTER TABLE ADD COLUMN (e.g. VARCHAR(512), JSON, BIGINT, TEXT).
 */

const SCHEMA = {
  pending_sessions: [
    { name: 'session_id', type: 'VARCHAR(512)', nullable: false, key: 'PRI' },
    { name: 'public_key', type: 'VARCHAR(512)', nullable: true },
    { name: 'info_device', type: 'JSON', nullable: true },
    { name: 'enc_payload', type: 'TEXT', nullable: true },
    { name: 'aes_key_enc', type: 'TEXT', nullable: true },
    { name: 'created_at', type: 'BIGINT', nullable: false },
  ],
  api_keys: [
    { name: 'id', type: 'INT', nullable: false, key: 'PRI', extra: 'auto_increment' },
    { name: 'api_key', type: 'VARCHAR(128)', nullable: false, unique: true },
    { name: 'session_id', type: 'VARCHAR(512)', nullable: true },
    { name: 'credentials', type: 'JSON', nullable: false },
    { name: 'email', type: 'VARCHAR(256)', nullable: true },
    { name: 'label', type: 'VARCHAR(256)', nullable: true },
    { name: 'created_at', type: 'BIGINT', nullable: false },
  ],
};

module.exports = { SCHEMA };
