/**
 * Account model — stores linked ShamCash accounts.
 * account_address (hex code from GET /account/qr) is the primary key.
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Account = sequelize.define('Account', {
    account_address: {
      type: DataTypes.STRING(128),
      primaryKey: true,
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
  }, {
    tableName: 'accounts',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  return Account;
};
