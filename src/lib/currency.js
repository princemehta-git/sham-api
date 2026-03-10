/**
 * Maps Shamcash currencyId to currency code.
 * currencyId 1 = USD, 2 = SYP, 3 = EUR
 */
const CURRENCY_ID_MAP = { 1: 'USD', 2: 'SYP', 3: 'EUR' };

function getCurrencyFromBalance(b, defaultVal = 'SYP') {
  return b.currencyName || b.currency || b.name ||
    (b.currencyId != null ? CURRENCY_ID_MAP[b.currencyId] : null) || defaultVal;
}

module.exports = { CURRENCY_ID_MAP, getCurrencyFromBalance };
