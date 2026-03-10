/**
 * Sequelize connection setup.
 * Creates the database if it doesn't exist, then connects with sync({ alter: true }).
 */

const { Sequelize } = require('sequelize');

const MYSQL_HOST = process.env.MYSQL_HOST || 'localhost';
const MYSQL_PORT = parseInt(process.env.MYSQL_PORT || '3306', 10);
const MYSQL_USER = process.env.MYSQL_USER || 'root';
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || '';
const MYSQL_DATABASE = process.env.MYSQL_DATABASE || 'shamcash_api';

let sequelize = null;

async function init() {
  // Create database if not exists using a temporary connection
  const tempSeq = new Sequelize('', MYSQL_USER, MYSQL_PASSWORD, {
    host: MYSQL_HOST,
    port: MYSQL_PORT,
    dialect: 'mysql',
    logging: false,
  });
  await tempSeq.query(`CREATE DATABASE IF NOT EXISTS \`${MYSQL_DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await tempSeq.close();

  // Connect to the actual database
  sequelize = new Sequelize(MYSQL_DATABASE, MYSQL_USER, MYSQL_PASSWORD, {
    host: MYSQL_HOST,
    port: MYSQL_PORT,
    dialect: 'mysql',
    logging: false,
    pool: { max: 10, min: 0, acquire: 30000, idle: 10000 },
  });

  await sequelize.authenticate();

  // Import and init models
  const models = require('../models');
  models.init(sequelize);

  // Sync all models (creates/alters tables automatically)
  await sequelize.sync({ alter: true });

  return sequelize;
}

function getSequelize() {
  return sequelize;
}

module.exports = { init, getSequelize };
