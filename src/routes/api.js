/**
 * Public API endpoint — /api/v1
 *
 * Single API key (from .env) + account_address for segregation.
 *
 * Supported actions:
 *   resource=shamcash & action=logs      → transaction history
 *   resource=shamcash & action=balance   → account balances
 *   resource=shamcash & action=find_tx   → find transaction by ID
 */

const store = require('../lib/store');
const shamcashClient = require('../lib/shamcashClient');
const { getCurrencyFromBalance } = require('../lib/currency');

const API_KEY = process.env.API_KEY || '';

/**
 * Build credentials for shamcashClient from stored credentials.
 */
function buildCredsForClient(credentials) {
  const candidates = [credentials.token, credentials.authToken, credentials.accessToken].filter(Boolean);
  const token = candidates.find(t => t.startsWith('eyJ')) || candidates[0] || null;
  const accessToken = credentials.accessToken || credentials.token || token;
  const forge = credentials.forge || (Array.isArray(credentials.cookies) && credentials.cookies.find(c => c?.name === 'forge'))?.value;
  return { token, accessToken, forge };
}

function setupRoutes(app) {
  app.get('/api/v1', async (req, res) => {
    const { resource, action, api_key, account_address, tx } = req.query;

    // ── Validate API key ────────────────────────────────────────────────
    if (!api_key || api_key !== API_KEY) {
      return res.status(401).json({ success: false, error: 'Invalid or missing api_key.' });
    }

    // ── Validate resource ───────────────────────────────────────────────
    if (resource !== 'shamcash') {
      return res.status(400).json({ success: false, error: 'Invalid resource. Supported: shamcash' });
    }

    // ── Validate action ───────────────────────────────────────────────
    if (!action) {
      return res.status(400).json({ success: false, error: 'action is required. Supported: logs, balance, find_tx' });
    }

    // ── Validate account_address ────────────────────────────────────────
    if (!account_address) {
      return res.status(400).json({ success: false, error: 'account_address is required.' });
    }

    // ── Get stored credentials ──────────────────────────────────────────
    const credentials = await store.getAccountCredentials(account_address);
    if (!credentials) {
      return res.status(404).json({ success: false, error: 'Account not found. Add it via admin dashboard first.' });
    }
    const creds = buildCredsForClient(credentials);

    try {
      switch (action) {
        // ── action=logs ───────────────────────────────────────────────
        case 'logs': {
          const data = await shamcashClient.transactionHistoryLogs(creds, {});
          const logs = Array.isArray(data?.data) ? data.data : (data?.data?.log || []);
          const fmtFromTo = (t) => {
            const account = t.userName || t.accountNumber || '';
            const peer = t.peerUserName || t.peerAccountNumber || '';
            const isOutgoing = t.tranKind === 2;
            return { from: isOutgoing ? account : peer, to: isOutgoing ? peer : account };
          };
          const fmtDateTime = (t) => {
            if (t.tranDate && t.tranTime) return t.tranDate + ' ' + t.tranTime;
            return t.dateTime || t.datetime || t.tranDate || t.tranTime || t.date || '';
          };
          const items = logs.map(t => {
            const { from, to } = fmtFromTo(t);
            return {
              tran_id: Number(t.tranId || t.id) || 0,
              from_name: from,
              to_name: to,
              currency: t.currencyName || t.currency || 'SYP',
              amount: Number(t.amount) || 0,
              datetime: fmtDateTime(t),
              account: t.peerAccountAddress || '',
              note: t.note || t.description || '',
            };
          });
          return res.json({
            success: true,
            data: { account_address, items },
          });
        }

        // ── action=balance ────────────────────────────────────────────
        case 'balance': {
          const data = await shamcashClient.accountBalances(creds);
          const rawBalances = data?.data?.balances || data?.data || data?.balances || [];
          let balances;
          if (Array.isArray(rawBalances)) {
            balances = rawBalances.map(b => ({
              currency: getCurrencyFromBalance(b),
              balance: b.balance ?? b.amount ?? 0,
            }));
          } else if (typeof rawBalances === 'object') {
            balances = Object.entries(rawBalances).map(([k, v]) => ({
              currency: k,
              balance: typeof v === 'number' ? v : (v?.balance ?? 0),
            }));
          } else {
            balances = [];
          }
          return res.json({
            success: true,
            data: { account_address, balances },
          });
        }

        // ── action=find_tx ────────────────────────────────────────────
        case 'find_tx': {
          if (!tx) {
            return res.status(400).json({ success: false, error: 'tx parameter is required for find_tx action.' });
          }
          if (!/^\d{3,30}$/.test(tx)) {
            return res.status(400).json({ success: false, error: 'tx must be 3-30 digits only.' });
          }
          try {
            const result = await shamcashClient.transactionById(creds, tx);
            const t = result?.data || result;
            const isOutgoing = t.tranKind === 2;
            const from = isOutgoing ? (t.userName || t.accountNumber || '') : (t.peerUserName || t.peerAccountNumber || '');
            const to = isOutgoing ? (t.peerUserName || t.peerAccountNumber || '') : (t.userName || t.accountNumber || '');
            const datetime = (t.tranDate && t.tranTime) ? t.tranDate + ' ' + t.tranTime : (t.dateTime || t.datetime || t.tranDate || t.tranTime || t.date || '');
            return res.json({
              success: true,
              data: {
                found: true,
                transaction: {
                  tran_id: Number(t.tranId || t.id || tx) || 0,
                  from_name: from,
                  to_name: to,
                  currency: t.currencyName || t.currency || 'SYP',
                  amount: Number(t.amount) || 0,
                  datetime,
                  account: t.peerAccountAddress || '',
                  note: t.note || t.description || '',
                },
                account: { account_address },
              },
            });
          } catch (e) {
            if (e.status === 404) {
              return res.json({
                success: true,
                data: {
                  found: false,
                  tran_id: Number(tx) || tx,
                  account: { account_address },
                },
              });
            }
            throw e;
          }
        }

        default:
          return res.status(400).json({
            success: false,
            error: 'Invalid action. Supported: logs, balance, find_tx',
          });
      }
    } catch (e) {
      console.error(`[api/v1] action=${action} address=${account_address} error:`, e.message);
      res.status(e.status || 500).json({ success: false, error: e.message });
    }
  });
}

module.exports = { setupRoutes };
