/**
 * Maps Shamcash currencyId to currency code.
 * currencyId 1 = EUR, 2 = USD, 3 = SYP
 */
const CURRENCY_ID_MAP = { 1: 'EUR', 2: 'USD', 3: 'SYP' };

function getCurrencyFromBalance(b, defaultVal = 'SYP') {
  return b.currencyName || b.currency || b.name ||
    (b.currencyId != null ? CURRENCY_ID_MAP[b.currencyId] : null) || defaultVal;
}

module.exports = { CURRENCY_ID_MAP, getCurrencyFromBalance };
