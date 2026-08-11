const ALLOWED_ORIGIN = 'https://markcqhsu.github.io';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
  };
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function fetchForex() {
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

// TWSE returns "-" (not empty/absent) for z/y before a stock's first trade
// of the day, e.g. pre-market. "-" is truthy, so a plain !quote.z check
// misses it, and Number("-") is NaN — silently producing a "null" price
// downstream instead of a clear error.
function isValidQuoteNumber(v) {
  return v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v));
}

async function fetchRealtimeQuote(exCh) {
  // TWSE's own official realtime quote system (same one twstock's
  // realtime module and TWSE's own website widgets use). Gives same-day
  // price/change well before the OpenAPI/FMTQIK mirrors publish.
  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${exCh}&_=${Date.now()}`;
  const json = await fetchJson(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Referer: 'https://mis.twse.com.tw/stock/index.jsp',
    },
  });
  const quote = json.msgArray?.[0];
  if (json.rtcode !== '0000' || !quote || !isValidQuoteNumber(quote.z) || !isValidQuoteNumber(quote.y)) {
    throw new Error(`mis.twse.com.tw 沒有 ${exCh} 的即時資料`);
  }
  return quote;
}

function priceChange(quote) {
  return Math.round((Number(quote.z) - Number(quote.y)) * 100) / 100;
}

async function fetchMarket() {
  const quote = await fetchRealtimeQuote('tse_t00.tw');
  // The realtime index quote has no market-wide turnover figure, so
  // trade_value still comes from FMTQIK and keeps its own (often older) date.
  const rows = await fetchJson('https://openapi.twse.com.tw/v1/exchangeReport/FMTQIK');
  const latestFmtqik = rows[rows.length - 1];
  return {
    date: quote.d,
    taiex: Number(quote.z),
    change: priceChange(quote),
    trade_value: Number(latestFmtqik.TradeValue),
    trade_value_date: latestFmtqik.Date,
  };
}

async function fetchHonChuan() {
  const quote = await fetchRealtimeQuote('tse_9939.tw');
  return {
    date: quote.d,
    close: Number(quote.z),
    change: priceChange(quote),
    volume: Number(quote.v) * 1000, // "v" is in 張 (board lots of 1000 shares)
  };
}

async function fetchOil(token) {
  const headers = { Authorization: `Token ${token}` };
  const [wti, brent] = await Promise.all([
    fetchJson('https://api.oilpriceapi.com/v1/prices/latest?by_code=WTI_USD', { headers }),
    fetchJson('https://api.oilpriceapi.com/v1/prices/latest?by_code=BRENT_CRUDE_USD', { headers }),
  ]);
  return {
    wti: {
      price: wti.data.price,
      change: wti.data.changes?.['24h']?.amount ?? null,
      as_of: wti.data.as_of,
    },
    brent: {
      price: brent.data.price,
      change: brent.data.changes?.['24h']?.amount ?? null,
      as_of: brent.data.as_of,
    },
  };
}

async function fetchDowJones() {
  // No range/interval params: Yahoo defaults to range=1d, which gives the
  // actual previous trading day's close via meta.previousClose. Adding
  // range=5d shifts chartPreviousClose to the close from ~5 days back
  // instead of yesterday, producing a wildly wrong "daily" change.
  const data = await fetchJson('https://query1.finance.yahoo.com/v8/finance/chart/%5EDJI', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  const meta = data.chart.result[0].meta;
  const prevClose = meta.previousClose ?? meta.chartPreviousClose;
  return {
    price: meta.regularMarketPrice,
    prev_close: prevClose,
    change: Math.round((meta.regularMarketPrice - prevClose) * 100) / 100,
    as_of: new Date(meta.regularMarketTime * 1000).toISOString(),
  };
}

// Human-readable label per source, used to prefix that source's error message
// so a failure in one (e.g. TWSE's realtime system being down) is attributed
// to the right line instead of reading as a generic, unexplained failure.
const SOURCE_LABELS = {
  forex: '匯率',
  market: '大盤指數',
  honchuan: '宏全股價',
  oil: '原油期貨',
  us_market: '美股道瓊',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      // Promise.allSettled (not Promise.all) so one source failing — e.g.
      // mis.twse.com.tw having no data outside trading hours — doesn't wipe
      // out the other four sources that fetched fine.
      const keys = ['forex', 'market', 'honchuan', 'oil', 'us_market'];
      const settled = await Promise.allSettled([
        fetchForex(),
        fetchMarket(),
        fetchHonChuan(),
        fetchOil(env.OILPRICEAPI_TOKEN),
        fetchDowJones(),
      ]);

      const result = { generated_at: new Date().toISOString() };
      const errors = {};
      settled.forEach((outcome, i) => {
        const key = keys[i];
        if (outcome.status === 'fulfilled') {
          result[key] = outcome.value;
        } else {
          errors[key] = `${SOURCE_LABELS[key]}：${outcome.reason.message}`;
        }
      });
      if (Object.keys(errors).length) result.errors = errors;

      return new Response(JSON.stringify(result, null, 2), { headers: corsHeaders() });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 502,
        headers: corsHeaders(),
      });
    }
  },
};
