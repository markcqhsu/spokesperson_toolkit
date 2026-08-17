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

async function fetchText(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.text();
}

// Upstream sources (e.g. so.cnyes.com) intermittently return Cloudflare 520s
// (edge-to-edge hiccups between our Worker and the target's own
// Cloudflare-fronted host) even though the same request succeeds seconds
// later from a plain client. Retry a couple of times before surfacing the
// failure to the user.
async function withRetry(fn, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw lastErr;
}

function fetchJsonWithRetry(url, opts) {
  return withRetry(() => fetchJson(url, opts));
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

// 富果（Fugle）行情 API 的 intraday quote 端點同時支援個股（EQUITY）跟指數
// （INDEX），一次就能拿到報價、漲跌、當天累計成交值/量，不用再像以前那樣拼
// mis.twse.com.tw（即時報價，無成交值）加 FMTQIK（成交值，常常延後一個交易
// 日才公布）兩個來源——這也是為什麼以前加權指數是今天、成交量卻是前幾天的
// 落差在這個資料源就不會發生了。IX0001 是「發行量加權股價指數」的代碼。
async function fetchFugleQuote(symbol, env) {
  const json = await fetchJsonWithRetry(`https://api.fugle.tw/marketdata/v1.0/stock/intraday/quote/${symbol}`, {
    headers: { 'X-API-KEY': env.FUGLE_API_KEY },
  });
  if (!Number.isFinite(json.closePrice) || !Number.isFinite(json.change) || !json.total) {
    throw new Error(`Fugle 沒有 ${symbol} 的即時資料`);
  }
  return json;
}

async function fetchMarket(env) {
  const quote = await fetchFugleQuote('IX0001', env);
  return {
    date: quote.date.replace(/-/g, ''),
    taiex: quote.closePrice,
    change: quote.change,
    trade_value: quote.total.tradeValue,
  };
}

async function fetchHonChuan(env) {
  const quote = await fetchFugleQuote('9939', env);
  return {
    date: quote.date.replace(/-/g, ''),
    close: quote.closePrice,
    change: quote.change,
    // Fugle 的 tradeVolume 是「張」，乘 1000 存成「股」，跟資料層原本的單位慣例一致。
    volume: quote.total.tradeVolume * 1000,
  };
}

// 經濟部能源署官方每日原油參考價（路透社資料）。oilpriceapi 的 /latest 實測會卡在
// 舊快照好幾個小時不動，看起來即時實則不準；能源署這份本來就是每日更新一次的
// 參考價，SurDate 就是實際報價日期，不用假裝是即時報價。
async function fetchOilMoe() {
  const form = new FormData();
  form.append('unit', 'day');
  const json = await fetchJsonWithRetry('https://www2.moeaea.gov.tw/oil111/CrudeOil/CrudeOil/load', {
    method: 'POST',
    body: form,
  });
  const rows = json.data?.crudeoil;
  if (!Array.isArray(rows) || rows.length < 2) {
    throw new Error('能源署原油資料筆數不足，無法算漲跌');
  }
  const [latest, prev] = rows;
  const round2 = (n) => Math.round(n * 100) / 100;
  const asOf = latest.SurDate.replace(/\//g, '-');
  return {
    wti: { price: latest.WestT, change: round2(latest.WestT - prev.WestT), as_of: asOf },
    brent: { price: latest.Burant, change: round2(latest.Burant - prev.Burant), as_of: asOf },
  };
}

// 鉅亨網的期貨走勢圖頁（so.cnyes.com/JavascriptGraphic/chartstudy.aspx）沒有獨立
// 的資料 API，是把整年每日 OHLCV 直接以 `globalData.push([...])` 內嵌在頁面的
// <script> 裡回傳；每一列格式是
// [x座標, y座標, '日期YYYYMMDD', 開, 高, 低, 收, 量, 0, 圖表最大值, 圖表最小值,]。
// 發言人習慣核對鉅亨網的報價，所以跟能源署的數字並列顯示，而不是互相取代——
// 兩者都是每日收盤一次更新，不是逐秒跳動的即時報價。
async function fetchCnyesDaily(code) {
  const html = await withRetry(() =>
    fetchText(`https://so.cnyes.com/JavascriptGraphic/chartstudy.aspx?country=future&market=future&code=${code}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Referer: `https://www.cnyes.com/futures/html5chart/${code}.html`,
      },
    }),
  );
  const rows = [...html.matchAll(/globalData\.push\(\[([^\]]*)\]\)/g)].map((m) => m[1].split(','));
  if (rows.length < 2) throw new Error(`cnyes ${code} 沒有足夠的每日資料`);
  const parseRow = (r) => ({ date: r[2].replace(/'/g, ''), close: Number(r[6]) });
  const latest = parseRow(rows[rows.length - 1]);
  const prev = parseRow(rows[rows.length - 2]);
  const round2 = (n) => Math.round(n * 100) / 100;
  return {
    price: latest.close,
    change: round2(latest.close - prev.close),
    as_of: `${latest.date.slice(0, 4)}-${latest.date.slice(4, 6)}-${latest.date.slice(6, 8)}`,
  };
}

async function fetchOilCnyes() {
  const [wti, brent] = await Promise.all([fetchCnyesDaily('CLCON'), fetchCnyesDaily('IBCON')]);
  return { wti, brent };
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
// so a failure in one (e.g. Fugle being down) is attributed to the right
// line instead of reading as a generic, unexplained failure.
const SOURCE_LABELS = {
  forex: '匯率',
  market: '大盤指數',
  honchuan: '宏全股價',
  oil_moe: '原油現貨（能源署）',
  oil_cnyes: '原油期貨（鉅亨網）',
  us_market: '美股道瓊',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      // Promise.allSettled (not Promise.all) so one source failing — e.g.
      // Fugle having no data outside trading hours — doesn't wipe out the
      // other five sources that fetched fine.
      const keys = ['forex', 'market', 'honchuan', 'oil_moe', 'oil_cnyes', 'us_market'];
      const settled = await Promise.allSettled([
        fetchForex(),
        fetchMarket(env),
        fetchHonChuan(env),
        fetchOilMoe(),
        fetchOilCnyes(),
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
