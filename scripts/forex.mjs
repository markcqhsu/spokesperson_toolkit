async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

export async function fetchForex() {
  // rter.info only publishes USD-based pairs, so EUR/USD and CNY/TWD are
  // derived by division — an exact identity, not an approximation.
  const data = await fetchJson('https://tw.rter.info/capi.php');
  const usdTwd = data.USDTWD;
  const usdCny = data.USDCNY;
  const usdEur = data.USDEUR;
  if (!usdTwd || !usdCny || !usdEur) {
    throw new Error('rter.info 缺少必要幣別資料 (USDTWD/USDCNY/USDEUR)');
  }
  // Each pair can be refreshed at a slightly different moment; use the
  // oldest of the three so the reported "as of" time holds for all of them.
  const toDate = (utc) => new Date(utc.replace(' ', 'T') + 'Z');
  const oldest = [usdTwd.UTC, usdCny.UTC, usdEur.UTC]
    .map(toDate)
    .reduce((a, b) => (a < b ? a : b));
  return {
    as_of: oldest.toISOString(),
    usd_twd: usdTwd.Exrate,
    eur_usd: 1 / usdEur.Exrate,
    usd_cny: usdCny.Exrate,
    cny_twd: usdTwd.Exrate / usdCny.Exrate,
  };
}
