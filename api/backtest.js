import { Redis } from "@upstash/redis";

const redis = new Redis({
  url:
    process.env.UPSTASH_REDIS_REST_KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL,

  token:
    process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN
});

/*
==================================================
UUID
==================================================
*/
function uuidv4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx"
    .replace(/[xy]/g, function(c){
      const r = Math.random() * 16 | 0;
      const v =
        c === "x"
        ? r
        : (r & 0x3 | 0x8);

      return v.toString(16);
    });
}

const DEFAULT_MIN_SIGNAL_SCORE =
  70;

const LIMITED_HISTORY_MIN_SIGNAL_SCORE =
  60;

const MIN_ATR_PERCENT =
  0.25;

const MAX_ATR_PERCENT =
  6;

const MAX_SPREAD_PERCENT =
  0.15;

const MIN_RISK_REWARD =
  1.5;

const MAX_ACCEPTABLE_DRAWDOWN =
  -25;

const SCORE_THRESHOLDS =
  [60,70,80,90];

async function fetchWithTimeout(
  url,
  options = {},
  timeout = 15000
){
  const controller = new AbortController();

  const id = setTimeout(() => {
    controller.abort();
  }, timeout);

  try{
    return await fetch(
      url,
      {
        ...options,
        signal: controller.signal
      }
    );
  }finally{
    clearTimeout(id);
  }
}

function EMA(data, period){
  if(!data.length){
    return 0;
  }

  const k = 2 / (period + 1);
  let ema = data[0];

  for(let i=1;i<data.length;i++){
    ema =
      data[i] * k +
      ema * (1-k);
  }

  return ema;
}

function RSI(closes, period=14){
  if(closes.length < period+1){
    return 50;
  }

  let gains = 0;
  let losses = 0;

  for(let i=1;i<=period;i++){
    const diff =
      closes[i] - closes[i-1];

    if(diff >= 0){
      gains += diff;
    }else{
      losses += Math.abs(diff);
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for(let i=period+1;i<closes.length;i++){
    const diff =
      closes[i] - closes[i-1];

    const gain =
      diff > 0 ? diff : 0;

    const loss =
      diff < 0 ? Math.abs(diff) : 0;

    avgGain =
      (avgGain * (period-1) + gain) / period;

    avgLoss =
      (avgLoss * (period-1) + loss) / period;
  }

  if(avgLoss === 0){
    return 100;
  }

  const rs = avgGain / avgLoss;

  return 100 - (100/(1+rs));
}

function ATR(candles, period=14){
  if(candles.length < period+1){
    return 0;
  }

  const trs = [];

  for(let i=1;i<candles.length;i++){
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i-1].close),
      Math.abs(candles[i].low - candles[i-1].close)
    );

    trs.push(tr);
  }

  const recent = trs.slice(-period);

  return recent.reduce((a,b)=>a+b,0)/period;
}

function getCandlesFromResponse(candleData){
  if(
    !candleData ||
    !candleData.candles ||
    !candleData.candles.length ||
    !candleData.candles[0].candles
  ){
    return [];
  }

  return candleData.candles[0].candles
    .map(candle => ({
      fromDate:
        candle.fromDate,
      open:
        parseFloat(candle.open),
      high:
        parseFloat(candle.high),
      low:
        parseFloat(candle.low),
      close:
        parseFloat(candle.close)
    }))
    .sort(
      (a,b)=>
        new Date(a.fromDate) -
        new Date(b.fromDate)
    );
}

function analyzeDailySetup(
  candles,
  spreadPercent,
  minSignalScore
){
  const closes =
    candles.map(c => c.close);

  const currentPrice =
    closes[closes.length - 1] || 0;

  const ema20 =
    EMA(closes.slice(-20),20);

  const ema50 =
    EMA(closes.slice(-50),50);

  const hasEma100 =
    closes.length >= 100;

  const ema100 =
    hasEma100
    ? EMA(closes.slice(-100),100)
    : null;

  const rsi =
    RSI(closes);

  const atr =
    ATR(candles);

  const atrPercent =
    currentPrice > 0
    ? (atr / currentPrice) * 100
    : 0;

  const bullishTrend =
    currentPrice > ema20 &&
    ema20 > ema50 &&
    (
      !hasEma100 ||
      ema50 > ema100
    );

  const bearishTrend =
    currentPrice < ema20 &&
    ema20 < ema50 &&
    (
      !hasEma100 ||
      ema50 < ema100
    );

  const momentumUp =
    closes[closes.length - 1] >
    closes[closes.length - 6];

  const momentumDown =
    closes[closes.length - 1] <
    closes[closes.length - 6];

  const riskDistance =
    atr * 1.5 +
    currentPrice * (spreadPercent / 100);

  const rewardDistance =
    atr * 3;

  const riskRewardRatio =
    riskDistance > 0
    ? rewardDistance / riskDistance
    : 0;

  const trendStrengthPercent =
    currentPrice > 0
    ? (
      Math.abs(
        ema20 - (hasEma100 ? ema100 : ema50)
      ) / currentPrice
    ) * 100
    : 0;

  const recentCloses =
    closes.slice(-20);

  const recentRangePercent =
    currentPrice > 0
    ? (
      (
        Math.max(...recentCloses) -
        Math.min(...recentCloses)
      ) / currentPrice
    ) * 100
    : 0;

  const regimeTradable =
    atrPercent <= MAX_ATR_PERCENT &&
    trendStrengthPercent >= 0.6 &&
    recentRangePercent >= 1;

  const base = {
    currentPrice,
    rsi,
    atrPercent,
    riskRewardRatio
  };

  const buyScore =
    scoreDirection({
      ...base,
      trendOk:bullishTrend,
      momentumOk:
        momentumUp &&
        regimeTradable,
      rsiOk:
        rsi > 50 &&
        rsi < 68,
      spreadPercent
    });

  const sellScore =
    scoreDirection({
      ...base,
      trendOk:bearishTrend,
      momentumOk:
        momentumDown &&
        regimeTradable,
      rsiOk:
        rsi < 40,
      spreadPercent
    });

  if(
    buyScore >= sellScore &&
    buyScore >= minSignalScore
  ){
    return {
      signal:"BUY",
      score:buyScore,
      ...base
    };
  }

  if(sellScore >= minSignalScore){
    return {
      signal:"SELL",
      score:sellScore,
      ...base
    };
  }

  return {
    signal:"HOLD",
    score:
      Math.max(buyScore,sellScore),
    ...base
  };
}

function scoreDirection({
  trendOk,
  momentumOk,
  rsiOk,
  atrPercent,
  spreadPercent,
  riskRewardRatio
}){
  let score = 0;

  if(trendOk){
    score += 35;
  }

  if(rsiOk){
    score += 20;
  }

  if(momentumOk){
    score += 15;
  }

  if(
    atrPercent >= MIN_ATR_PERCENT &&
    atrPercent <= MAX_ATR_PERCENT
  ){
    score += 15;
  }

  if(spreadPercent <= MAX_SPREAD_PERCENT){
    score += 10;
  }

  if(riskRewardRatio >= MIN_RISK_REWARD){
    score += 5;
  }

  return score;
}

function getMaxDrawdown(equityCurve){
  let peak = 0;
  let maxDrawdown = 0;

  for(const equity of equityCurve){
    peak =
      Math.max(peak,equity);

    maxDrawdown =
      Math.min(maxDrawdown,equity - peak);
  }

  return maxDrawdown;
}

function summarizeTrades({
  trades,
  equityCurve,
  cumulativeReturn
}){
  const wins =
    trades.filter(
      trade => parseFloat(trade.returnPercent) > 0
    ).length;

  const losses =
    trades.length - wins;

  const returns =
    trades.map(
      trade => parseFloat(trade.returnPercent)
    );

  const avgReturn =
    returns.length
    ? returns.reduce((a,b)=>a+b,0) / returns.length
    : 0;

  const maxDrawdownValue =
    getMaxDrawdown(equityCurve) * 100;

  return {
    totalSignals:
      trades.length,
    buySignals:
      trades.filter(trade => trade.signal === "BUY").length,
    sellSignals:
      trades.filter(trade => trade.signal === "SELL").length,
    wins,
    losses,
    winRate:
      trades.length
      ? ((wins / trades.length) * 100).toFixed(1)+"%"
      : "0.0%",
    averageReturn:
      avgReturn.toFixed(2)+"%",
    cumulativeReturn:
      (cumulativeReturn * 100).toFixed(2)+"%",
    maxDrawdown:
      maxDrawdownValue.toFixed(2)+"%",
    maxDrawdownValue,
    drawdownGuardActive:
      maxDrawdownValue <= MAX_ACCEPTABLE_DRAWDOWN
  };
}

function runBacktest({
  candles,
  horizonDays,
  spreadPercent,
  minSignalScore,
  warmupCandles
}){
  const trades = [];
  const equityCurve = [0];
  let cumulativeReturn = 0;

  for(
    let i=warmupCandles;
    i<candles.length - horizonDays;
    i++
  ){
    const setupCandles =
      candles.slice(0,i+1);

    const setup =
      analyzeDailySetup(
        setupCandles,
        spreadPercent,
        minSignalScore
      );

    if(setup.signal === "HOLD"){
      continue;
    }

    const entryPrice =
      candles[i].close;

    const exitPrice =
      candles[i+horizonDays].close;

    const grossReturn =
      setup.signal === "BUY"
      ? (exitPrice - entryPrice) / entryPrice
      : (entryPrice - exitPrice) / entryPrice;

    const netReturn =
      grossReturn -
      spreadPercent / 100;

    cumulativeReturn += netReturn;
    equityCurve.push(cumulativeReturn);

    trades.push({
      date:
        candles[i].fromDate,
      signal:
        setup.signal,
      score:
        setup.score,
      entry:
        entryPrice.toFixed(2),
      exit:
        exitPrice.toFixed(2),
      returnPercent:
        (netReturn * 100).toFixed(2),
      rsi:
        setup.rsi.toFixed(2),
      atrPercent:
        setup.atrPercent.toFixed(3)
    });
  }

  return {
    trades,
    ...summarizeTrades({
      trades,
      equityCurve,
      cumulativeReturn
    })
  };
}

export default async function handler(req,res){
  try{
    const API_KEY =
      process.env.ETORO_API_KEY;

    const USER_KEY =
      process.env.ETORO_USER_KEY;

    if(!API_KEY){
      throw new Error("Missing ETORO_API_KEY");
    }

    if(!USER_KEY){
      throw new Error("Missing ETORO_USER_KEY");
    }

    const instrumentId =
      req.query.instrumentId || "686";

    const horizonDays =
      Math.max(
        1,
        Math.min(20,parseInt(req.query.horizonDays || "5",10))
      );

    const spreadPercent =
      parseFloat(req.query.spreadPercent || "0.05");

    const BASE_URL =
      "https://public-api.etoro.com/api/v1";

    const candlesUrl =
      `${BASE_URL}/market-data/instruments/${instrumentId}/history/candles/desc/OneDay/1000`;

    const candleResponse =
      await fetchWithTimeout(
        candlesUrl,
        {
          headers:{
            "x-api-key": API_KEY,
            "x-user-key": USER_KEY,
            "x-request-id": uuidv4()
          }
        }
      );

    if(!candleResponse.ok){
      const txt =
        await candleResponse.text();

      throw new Error(
        `Backtest candles API ${candleResponse.status} ${txt}`
      );
    }

    const candleData =
      await candleResponse.json();

    const candles =
      getCandlesFromResponse(candleData);

    const minimumCandles =
      60 + horizonDays;

    if(candles.length < minimumCandles){
      return res.status(200).json({
        success:true,
        instrumentId,
        horizonDays,
        candlesTested:
          candles.length,
        totalSignals:0,
        buySignals:0,
        sellSignals:0,
        wins:0,
        losses:0,
        winRate:"0.0%",
        averageReturn:"0.00%",
        cumulativeReturn:"0.00%",
        maxDrawdown:"0.00%",
        drawdownGuard:"OK",
        bestThreshold:"--",
        thresholdResults:[],
        dataWarning:
          `Only ${candles.length} daily candles returned. Need at least ${minimumCandles} to run even a reduced backtest.`,
        recentTrades:[]
      });
    }

    const hasFullHistory =
      candles.length >= 140 + horizonDays;

    const warmupCandles =
      hasFullHistory
      ? 120
      : Math.max(
        50,
        Math.min(
          80,
          candles.length - horizonDays - 10
        )
      );

    const minSignalScore =
      hasFullHistory
      ? DEFAULT_MIN_SIGNAL_SCORE
      : LIMITED_HISTORY_MIN_SIGNAL_SCORE;

    const dataWarning =
      hasFullHistory
      ? null
      : `Limited history mode: ${candles.length} daily candles returned, so the backtest used EMA20/EMA50 with a lower score threshold. Treat this as weaker evidence.`;

    const primaryBacktest =
      runBacktest({
        candles,
        horizonDays,
        spreadPercent,
        minSignalScore,
        warmupCandles
      });

    const thresholdResults =
      SCORE_THRESHOLDS.map(threshold => {
        const result =
          runBacktest({
            candles,
            horizonDays,
            spreadPercent,
            minSignalScore:threshold,
            warmupCandles
          });

        return {
          threshold,
          totalSignals:
            result.totalSignals,
          winRate:
            result.winRate,
          averageReturn:
            result.averageReturn,
          cumulativeReturn:
            result.cumulativeReturn,
          maxDrawdown:
            result.maxDrawdown,
          drawdownGuardActive:
            result.drawdownGuardActive
        };
      });

    const bestThreshold =
      thresholdResults
        .filter(result => !result.drawdownGuardActive)
        .sort(
          (a,b)=>
            parseFloat(b.averageReturn) -
            parseFloat(a.averageReturn)
        )[0] ||
      thresholdResults
        .sort(
          (a,b)=>
            parseFloat(b.maxDrawdown) -
            parseFloat(a.maxDrawdown)
        )[0];

    const summaryForRedis = {
      instrumentId,
      horizonDays,
      minSignalScore,
      totalSignals:
        primaryBacktest.totalSignals,
      winRate:
        primaryBacktest.winRate,
      averageReturn:
        primaryBacktest.averageReturn,
      cumulativeReturn:
        primaryBacktest.cumulativeReturn,
      maxDrawdown:
        primaryBacktest.maxDrawdown,
      drawdownGuardActive:
        primaryBacktest.drawdownGuardActive,
      bestThreshold:
        bestThreshold?.threshold || minSignalScore,
      updatedAt:
        new Date().toISOString()
    };

    await redis.set(
      `backtest-summary-${instrumentId}`,
      summaryForRedis
    );

    return res.status(200).json({
      success:true,
      instrumentId,
      horizonDays,
      candlesTested:
        candles.length,
      warmupCandles,
      minSignalScore,
      dataWarning,
      totalSignals:
        primaryBacktest.totalSignals,
      buySignals:
        primaryBacktest.buySignals,
      sellSignals:
        primaryBacktest.sellSignals,
      wins:
        primaryBacktest.wins,
      losses:
        primaryBacktest.losses,
      winRate:
        primaryBacktest.winRate,
      averageReturn:
        primaryBacktest.averageReturn,
      cumulativeReturn:
        primaryBacktest.cumulativeReturn,
      maxDrawdown:
        primaryBacktest.maxDrawdown,
      drawdownGuard:
        primaryBacktest.drawdownGuardActive
        ? "ACTIVE"
        : "OK",
      bestThreshold:
        bestThreshold?.threshold || minSignalScore,
      thresholdResults,
      recentTrades:
        primaryBacktest.trades.slice(-10).reverse()
    });

  }catch(err){
    console.error(
      "BACKTEST ERROR:",
      err
    );

    return res.status(500).json({
      success:false,
      error:err.message
    });
  }
}
