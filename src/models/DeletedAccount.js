/**
 * DeletedAccount model — soft-deleted accounts moved here.
 * Preserves all original data plus deletion timestamp.
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const DeletedAccount = sequelize.define('DeletedAccount', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    account_address: {
      type: DataTypes.STRING(128),
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING(256),
      allowNull: true,
    },
    email: {
      type: DataTypes.STRING(256),
      allowNull: true,
    },
    credentials: {
      type: DataTypes.JSON,
      allowNull: false,
    },
    session_id: {
      type: DataTypes.STRING(512),
      allowNull: true,
    },
    label: {
      type: DataTypes.STRING(256),
      allowNull: true,
    },
    original_created_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    deleted_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  }, {
    tableName: 'deleted_accounts',
    timestamps: false,
  });

  return DeletedAccount;
};
