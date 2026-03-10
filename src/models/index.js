/**
 * Model registry — initializes all Sequelize models.
 */

let Account, DeletedAccount, PendingSession;

function init(sequelize) {
  Account = require('./Account')(sequelize);
  DeletedAccount = require('./DeletedAccount')(sequelize);
  PendingSession = require('./PendingSession')(sequelize);
}

function getModels() {
  return { Account, DeletedAccount, PendingSession };
}

module.exports = { init, getModels };
