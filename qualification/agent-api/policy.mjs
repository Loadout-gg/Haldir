export function workPolicy({ asset, budget, vendors }) {
  if (typeof asset !== 'string' || asset.length === 0 || asset.length > 256)
    throw new TypeError('asset');
  if (typeof budget !== 'string' || !/^[1-9][0-9]{0,77}$/.test(budget))
    throw new TypeError('budget');
  if (!Array.isArray(vendors) || vendors.length === 0 || vendors.length > 256 ||
      new Set(vendors).size !== vendors.length ||
      vendors.some(v => typeof v !== 'string' || v.length < 2 || v.length > 64 ||
        !/^(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/.test(v)))
    throw new TypeError('vendors');
  return {
    frozen: false,
    actions: ['transfer'],
    confidential: false,
    owner_approval: false,
    assets: [asset],
    limits: { per_transaction: { [asset]: budget }, monthly: { [asset]: budget } },
    max_actions_per_hour: null,
    destinations: {
      mode: 'only',
      list: vendors.map(address => ({ action: 'transfer', address, confidential: false })),
    },
    budget: { daily_usd: null, weekly_usd: null, monthly_usd: null },
    timelock_ms: 0,
  };
}
