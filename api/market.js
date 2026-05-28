import { Redis } from "@upstash/redis";

/*
==================================================
UUID GENERATOR
==================================================
*/
function uuidv4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx"
    .replace(/[xy]/g, function (c) {
      const r = Math.random() * 16 | 0;
      const v = c === "x"
        ? r
        : (r & 0x3 | 0x8);

      return v.toString(16);
    });
}

/*
==================================================
REDIS
==================================================
*/
const redis = new Redis({
  url:
    process.env.UPSTASH_REDIS_REST_KV_REST_API_URL,

  token:
    process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN
});

/*
==================================================
FETCH TIMEOUT
==================================================
*/
async function fetchWithTimeout(
  url,
  options = {},
  timeout = 15000
) {

  const controller = new AbortController();

  const id = setTimeout(() => {
    controller.abort();
  }, timeout);

  try {

    const response = await fetch(
      url,
      {
        ...options,
        signal: controller.signal
      }
    );

    return response;

  } finally {

    clearTimeout(id);
  }
}

/*
==================================================
EMA
==================================================
*/
function EMA(data, period) {

  if (!data.length) return 0;

  const k = 2 / (period + 1);

  let ema = data[0];

  for (let i = 1; i < data.length; i++) {

    ema =
      data[i] * k +
      ema * (1 - k);
  }

  return ema;
}

/*
==================================================
RSI
==================================================
*/
function RSI(closes, period = 14) {

  if (closes.length < period + 1) {
    return 50;
  }

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {

    const diff =
      closes[i] - closes[i - 1];

    if (diff >= 0) {
      gains += diff;
    } else {
      losses += Math.abs(diff);
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (
    let i = period + 1;
    i < closes.length;
    i++
  ) {

    const diff =
      closes[i] - closes[i - 1];

    const gain =
      diff > 0 ? diff : 0;

    const loss =
      diff < 0 ? Math.abs(diff) : 0;

    avgGain =
      (
        avgGain * (period - 1) +
        gain
      ) / period;

    avgLoss =
      (
        avgLoss * (period - 1) +
        loss
      ) / period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs =
    avgGain / avgLoss;

  return 100 - (100 / (1 + rs));
}

/*
==================================================
ATR
==================================================
*/
function ATR(candles, period = 14) {

  if (candles.length < period + 1) {
    return 0;
  }

  const trs = [];

  for (let i = 1; i < candles.length; i++) {

    const high =
      parseFloat(candles[i].high);

    const low =
      parseFloat(candles[i].low);

    const prevClose =
      parseFloat(candles[i - 1].close);

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );

    trs.push(tr);
  }

  const recent =
    trs.slice(-period);

  return (
    recent.reduce((a, b) => a + b, 0)
    / period
  );
}

/*
==================================================
MAIN
==================================================
*/
export default async function handler(
  req,
  res
) {

  try {

    const API_KEY =
      process.env.ETORO_API_KEY;

    const USER_KEY =
      process.env.ETORO_USER_KEY;

    const BOT_TOKEN =
      process.env.TELEGRAM_BOT_TOKEN;

    const CHAT_ID =
      process.env.TELEGRAM_CHAT_ID;

    const instrumentId =
      req.query.instrumentId || "686";

    const BASE_URL =
      "https://public-api.etoro.com/api/v1";

    /*
    ==============================================
    LIVE RATES
    ==============================================
    */
    const liveResponse =
      await fetchWithTimeout(

        `${BASE_URL}/market-data/instruments/rates?instrumentIds=${instrumentId}`,

        {
          headers: {
            "x-api-key": API_KEY,
            "x-user-key": USER_KEY,
            "x-request-id": uuidv4()
          }
        }
      );

    if (!liveResponse.ok) {

      const txt =
        await liveResponse.text();

      throw new Error(
        `Rates API ${liveResponse.status} ${txt}`
      );
    }

    const liveData =
      await liveResponse.json();

    const live =
      liveData.rates[0];

    /*
    ==============================================
    CANDLES
    ==============================================
    */
    const candleResponse =
      await fetchWithTimeout(

        `${BASE_URL}/market-data/instruments/${instrumentId}/history/candles/desc/OneDay/200`,

        {
          headers: {
            "x-api-key": API_KEY,
            "x-user-key": USER_KEY,
            "x-request-id": uuidv4()
          }
        }
      );

    if (!candleResponse.ok) {

      const txt =
        await candleResponse.text();

      throw new Error(
        `Candles API ${candleResponse.status} ${txt}`
      );
    }

    const candleData =
      await candleResponse.json();

    const candles =
      candleData.candles[0].candles;

    candles.sort(
      (a, b) =>
        new Date(a.fromDate) -
        new Date(b.fromDate)
    );

    const closes =
      candles.map(c =>
        parseFloat(c.close)
      );

    /*
    ==============================================
    INDICATORS
    ==============================================
    */
    const ema20 =
      EMA(closes.slice(-20), 20);

    const ema50 =
      EMA(closes.slice(-50), 50);

    const ema100 =
      EMA(closes.slice(-100), 100);

    const rsi =
      RSI(closes);

    const atr =
      ATR(candles);

    const currentPrice =
      parseFloat(live.lastExecution);

    /*
    ==============================================
    SIGNAL
    ==============================================
    */
    let signal = "HOLD";

    if (
      currentPrice > ema20 &&
      ema20 > ema50 &&
      ema50 > ema100 &&
      rsi > 50 &&
      rsi < 68
    ) {
      signal = "BUY";
    }

    if (
      currentPrice < ema20 &&
      ema20 < ema50 &&
      ema50 < ema100 &&
      rsi < 40
    ) {
      signal = "SELL";
    }

    /*
    ==============================================
    TELEGRAM
    ==============================================
    */
    try {

      await fetch(

        `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,

        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({
            chat_id: CHAT_ID,
            text:
`${signal}
Price: ${currentPrice}
RSI: ${rsi.toFixed(2)}`
          })
        }
      );

    } catch (e) {

      console.log(
        "Telegram failed",
        e.message
      );
    }

    /*
    ==============================================
    AUDIT LOG
    ==============================================
    */
    await redis.lpush(

      "system-audit-logs",

      `${new Date().toISOString()} | ${signal} | ${currentPrice}`
    );

    await redis.ltrim(
      "system-audit-logs",
      0,
      99
    );

    /*
    ==============================================
    RESPONSE
    ==============================================
    */
    return res.status(200).json({

      signal,

      price:
        currentPrice.toFixed(2),

      ema20:
        ema20.toFixed(2),

      ema50:
        ema50.toFixed(2),

      ema100:
        ema100.toFixed(2),

      rsi:
        rsi.toFixed(2),

      atr:
        atr.toFixed(2)
    });

  } catch (err) {

    console.log(
      "FATAL ERROR:",
      err
    );

    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
}
