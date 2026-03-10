/**
 * PendingSession model — QR login sessions waiting to be scanned.
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const PendingSession = sequelize.define('PendingSession', {
    session_id: {
      type: DataTypes.STRING(512),
      primaryKey: true,
      allowNull: false,
    },
    public_key: {
      type: DataTypes.STRING(512),
      allowNull: true,
    },
    info_device: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    enc_payload: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    aes_key_enc: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    created_at: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
  }, {
    tableName: 'pending_sessions',
    timestamps: false,
  });

  return PendingSession;
};
