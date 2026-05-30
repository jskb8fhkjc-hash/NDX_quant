import { Redis } from "@upstash/redis";

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

/*
==================================================
REDIS
==================================================
*/
const redis = new Redis({
  url:
    process.env.UPSTASH_REDIS_REST_KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL,

  token:
    process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN
});

const TELEGRAM_COOLDOWN_MS =
  1000 * 60 * 60 * 4;

const MAX_SPREAD_PERCENT =
  0.15;

const MIN_ATR_PERCENT =
  0.25;

const MAX_ATR_PERCENT =
  6;

const MIN_RISK_REWARD =
  1.5;

const TRAILING_ATR_MULTIPLIER =
  2;

const MIN_SIGNAL_SCORE =
  70;

/*
==================================================
FETCH WITH TIMEOUT
==================================================
*/
async function fetchWithTimeout(
  url,
  options = {},
  timeout = 15000
){
  const controller = new AbortController();

  const id = setTimeout(() => {
    controller.abort();
  }, timeout);

  try {

    const response =
      await fetch(
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

/*
==================================================
RSI
==================================================
*/
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
    } else {
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

/*
==================================================
ATR
==================================================
*/
function ATR(candles, period=14){

  if(candles.length < period+1){
    return 0;
  }

  const trs = [];

  for(let i=1;i<candles.length;i++){

    const high =
      parseFloat(candles[i].high);

    const low =
      parseFloat(candles[i].low);

    const prevClose =
      parseFloat(candles[i-1].close);

    const tr = Math.max(
      high-low,
      Math.abs(high-prevClose),
      Math.abs(low-prevClose)
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
      ...candle,
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

function analyzeTimeframe(candles){
  const closes =
    candles.map(c => c.close);

  const ema20 =
    EMA(closes.slice(-20),20);

  const ema50 =
    EMA(closes.slice(-50),50);

  const ema100 =
    EMA(closes.slice(-100),100);

  const lastClose =
    closes[closes.length - 1] || 0;

  const shortTrend =
    lastClose > ema20
    ? "BULLISH"
    : "BEARISH";

  const midTrend =
    ema20 > ema50
    ? "BULLISH"
    : "BEARISH";

  const longTrend =
    ema50 > ema100
    ? "BULLISH"
    : "BEARISH";

  const alignedTrend =
    shortTrend === midTrend &&
    midTrend === longTrend
    ? shortTrend
    : "MIXED";

  return {
    ema20,
    ema50,
    ema100,
    shortTrend,
    midTrend,
    longTrend,
    alignedTrend
  };
}

function isCooldownActive(lastSentAt){
  if(!lastSentAt){
    return false;
  }

  return Date.now() - Number(lastSentAt) < TELEGRAM_COOLDOWN_MS;
}

function buildSignalScore({
  direction,
  oneHourTrend,
  fourHourTrend,
  oneDayTrend,
  rsi,
  atrPercent,
  spreadPercent,
  riskRewardRatio
}){
  const factors = [];
  let score = 0;

  function addFactor(name, points, passed){
    factors.push({
      name,
      points:
        passed ? points : 0,
      maxPoints:
        points,
      passed
    });

    if(passed){
      score += points;
    }
  }

  addFactor(
    "1H trend aligned",
    15,
    oneHourTrend.alignedTrend === direction
  );

  addFactor(
    "4H trend aligned",
    20,
    fourHourTrend.alignedTrend === direction
  );

  addFactor(
    "Daily trend aligned",
    25,
    oneDayTrend.alignedTrend === direction
  );

  addFactor(
    "RSI in signal zone",
    15,
    direction === "BUY"
    ? rsi > 50 && rsi < 68
    : rsi < 40
  );

  addFactor(
    "ATR tradable",
    10,
    atrPercent >= MIN_ATR_PERCENT &&
    atrPercent <= MAX_ATR_PERCENT
  );

  addFactor(
    "Spread acceptable",
    10,
    spreadPercent <= MAX_SPREAD_PERCENT
  );

  addFactor(
    "Risk/reward acceptable",
    5,
    riskRewardRatio >= MIN_RISK_REWARD
  );

  return {
    score,
    direction,
    factors,
    passed:
      score >= MIN_SIGNAL_SCORE
  };
}

/*
==================================================
MAIN HANDLER
==================================================
*/
export default async function handler(req,res){

  try {

    /*
    ==============================================
    ENVIRONMENT VARIABLES
    ==============================================
    */
    const API_KEY =
      process.env.ETORO_API_KEY;

    const USER_KEY =
      process.env.ETORO_USER_KEY;

    const BOT_TOKEN =
      process.env.TELEGRAM_BOT_TOKEN;

    const CHAT_ID =
      process.env.TELEGRAM_CHAT_ID;

    if(!API_KEY){
      throw new Error("Missing ETORO_API_KEY");
    }

    if(!USER_KEY){
      throw new Error("Missing ETORO_USER_KEY");
    }

    /*
    ==============================================
    INPUTS
    ==============================================
    */
    const instrumentId =
      req.query.instrumentId || "686";

    const updatePosition =
      req.query.updatePosition === "true";

    const loadSavedPosition =
      req.query.loadSavedPosition === "true";

    const positionStateKey =
      `position-state-${instrumentId}`;

    const savedPosition =
      await redis.get(positionStateKey);

    let holding =
      req.query.holding || "no";

    let leverage =
      parseFloat(req.query.leverage || 1);

    let entryPrice =
      parseFloat(req.query.entryPrice || 0);

    let amountInvested =
      parseFloat(req.query.amountInvested || 1000);

    let existingSL =
      parseFloat(req.query.existingSL || 0);

    let existingTP =
      parseFloat(req.query.existingTP || 0);

    if(
      loadSavedPosition &&
      savedPosition
    ){

      holding =
        savedPosition.holding || holding;

      leverage =
        parseFloat(savedPosition.leverage || leverage);

      entryPrice =
        parseFloat(savedPosition.entryPrice || entryPrice);

      amountInvested =
        parseFloat(savedPosition.amountInvested || amountInvested);

      existingSL =
        parseFloat(savedPosition.existingSL || existingSL);

      existingTP =
        parseFloat(savedPosition.existingTP || existingTP);
    }

    if(updatePosition){

      await redis.set(
        positionStateKey,
        {
          holding,
          leverage,
          entryPrice,
          amountInvested,
          existingSL,
          existingTP
        }
      );
    }

    const BASE_URL =
      "https://public-api.etoro.com/api/v1";

    /*
    ==============================================
    TELEGRAM SIGNAL STATE
    ==============================================
    */
    const signalStateKey =`signal-state-${instrumentId}`;
    const trailingStopStateKey =
      `trailing-stop-state-${instrumentId}`;

    let signalState =await redis.get(signalStateKey);
    if(!signalState){
      signalState = {
        lastTelegramSignal:"NONE",
        lastTelegramAt:0
      };
    }
    /*
    ==============================================
    PARALLEL API FETCHING
    ==============================================
    */
    const ratesUrl =
      `${BASE_URL}/market-data/instruments/rates?instrumentIds=${instrumentId}`;

    const oneHourCandlesUrl =
      `${BASE_URL}/market-data/instruments/${instrumentId}/history/candles/desc/OneHour/200`;

    const fourHourCandlesUrl =
      `${BASE_URL}/market-data/instruments/${instrumentId}/history/candles/desc/FourHours/200`;

    const oneDayCandlesUrl =
      `${BASE_URL}/market-data/instruments/${instrumentId}/history/candles/desc/OneDay/200`;

    const [
      liveResponse,
      oneHourCandleResponse,
      fourHourCandleResponse,
      oneDayCandleResponse
    ] = await Promise.all([

      fetchWithTimeout(
        ratesUrl,
        {
          headers:{
            "x-api-key": API_KEY,
            "x-user-key": USER_KEY,
            "x-request-id": uuidv4()
          }
        }
      ),

      fetchWithTimeout(
        oneHourCandlesUrl,
        {
          headers:{
            "x-api-key": API_KEY,
            "x-user-key": USER_KEY,
            "x-request-id": uuidv4()
          }
        }
      ),

      fetchWithTimeout(
        fourHourCandlesUrl,
        {
          headers:{
            "x-api-key": API_KEY,
            "x-user-key": USER_KEY,
            "x-request-id": uuidv4()
          }
        }
      ),

      fetchWithTimeout(
        oneDayCandlesUrl,
        {
          headers:{
            "x-api-key": API_KEY,
            "x-user-key": USER_KEY,
            "x-request-id": uuidv4()
          }
        }
      )

    ]);

    /*
    ==============================================
    VALIDATE RESPONSES
    ==============================================
    */
    if(!liveResponse.ok){

      const txt =
        await liveResponse.text();

      throw new Error(
        `Rates API ${liveResponse.status} ${txt}`
      );
    }

    if(!oneHourCandleResponse.ok){

      const txt =
        await oneHourCandleResponse.text();

      throw new Error(
        `OneHour Candles API ${oneHourCandleResponse.status} ${txt}`
      );
    }

    if(!fourHourCandleResponse.ok){

      const txt =
        await fourHourCandleResponse.text();

      throw new Error(
        `FourHours Candles API ${fourHourCandleResponse.status} ${txt}`
      );
    }

    if(!oneDayCandleResponse.ok){

      const txt =
        await oneDayCandleResponse.text();

      throw new Error(
        `OneDay Candles API ${oneDayCandleResponse.status} ${txt}`
      );
    }

    /*
    ==============================================
    PARSE JSON
    ==============================================
    */
    const [
      liveData,
      oneHourCandleData,
      fourHourCandleData,
      oneDayCandleData
    ] = await Promise.all([
      liveResponse.json(),
      oneHourCandleResponse.json(),
      fourHourCandleResponse.json(),
      oneDayCandleResponse.json()
    ]);

    /*
    ==============================================
    VALIDATE DATA
    ==============================================
    */
    if(
      !liveData ||
      !liveData.rates ||
      !liveData.rates.length
    ){
      throw new Error("No live rates returned");
    }

    const oneHourCandles =
      getCandlesFromResponse(oneHourCandleData);

    const fourHourCandles =
      getCandlesFromResponse(fourHourCandleData);

    const oneDayCandles =
      getCandlesFromResponse(oneDayCandleData);

    if(!oneHourCandles.length){
      throw new Error("Invalid OneHour candles structure");
    }

    if(!fourHourCandles.length){
      throw new Error("Invalid FourHours candles structure");
    }

    if(!oneDayCandles.length){
      throw new Error("Invalid OneDay candles structure");
    }

    const live =
      liveData.rates[0];

    const closes =
      oneDayCandles.map(
        c => c.close
      );

    /*
    ==============================================
    INDICATORS
    ==============================================
    */
    const oneHourTrend =
      analyzeTimeframe(oneHourCandles);

    const fourHourTrend =
      analyzeTimeframe(fourHourCandles);

    const oneDayTrend =
      analyzeTimeframe(oneDayCandles);

    const ema20 =
      oneDayTrend.ema20;

    const ema50 =
      oneDayTrend.ema50;

    const ema100 =
      oneDayTrend.ema100;

    const rsi =
      RSI(closes);

    const atr =
      ATR(oneDayCandles);

    /*
    ==============================================
    MARKET DATA
    ==============================================
    */
    const currentPrice =
      parseFloat(live.lastExecution);

    const ask =
      parseFloat(live.ask);

    const bid =
      parseFloat(live.bid);

    const spread =
      ask - bid;

    const spreadPercent =
      currentPrice > 0
      ? (spread / currentPrice) * 100
      : 0;

    const atrPercent =
      currentPrice > 0
      ? (atr / currentPrice) * 100
      : 0;

    /*
    ==============================================
    TRENDS
    ==============================================
    */
    const shortTrend =
      oneDayTrend.shortTrend;

    const midTrend =
      oneDayTrend.midTrend;

    const longTrend =
      oneDayTrend.longTrend;

    const multiTimeframeTrend =
      oneHourTrend.alignedTrend === fourHourTrend.alignedTrend &&
      fourHourTrend.alignedTrend === oneDayTrend.alignedTrend
      ? oneDayTrend.alignedTrend
      : "MIXED";

    const multiTimeframeConfirmed =
      multiTimeframeTrend !== "MIXED";

    /*
    ==============================================
    SIGNAL ENGINE
    ==============================================
    */
    let signal = "HOLD";
    let confidence = 50;
    const signalWarnings = [];

    if(
      shortTrend==="BULLISH" &&
      midTrend==="BULLISH" &&
      longTrend==="BULLISH" &&
      multiTimeframeTrend==="BULLISH" &&
      rsi>50 &&
      rsi<68
    ){
      signal = "BUY";
      confidence += 30;
    }

    if(
      shortTrend==="BEARISH" &&
      midTrend==="BEARISH" &&
      longTrend==="BEARISH" &&
      multiTimeframeTrend==="BEARISH" &&
      rsi<40
    ){
      signal = "SELL";
      confidence += 30;
    }

    if(!multiTimeframeConfirmed){
      signalWarnings.push("TIMEFRAMES NOT ALIGNED");
    }

    const spreadOk =
      spreadPercent <= MAX_SPREAD_PERCENT;

    const atrOk =
      atrPercent >= MIN_ATR_PERCENT &&
      atrPercent <= MAX_ATR_PERCENT;

    if(!spreadOk){
      signalWarnings.push("SPREAD TOO WIDE");
    }

    if(!atrOk){
      signalWarnings.push("ATR OUTSIDE RANGE");
    }

    if(
      signal !== "HOLD" &&
      (!spreadOk || !atrOk)
    ){
      confidence =
        Math.max(35, confidence - 25);
    }
    /*
    ==============================================
    RESET DUPLICATE LOCK
    ==============================================
    */
    if(
      signal === "HOLD" &&
      signalState.lastTelegramSignal !== "NONE"
    ){
      signalState.lastTelegramSignal =
        "NONE";
      await redis.set(
        signalStateKey,

        signalState
      );
    }
    /*
    ==============================================
    DURATION
    ==============================================
    */
    let duration = "INTRADAY";

    if(
      midTrend==="BULLISH" &&
      longTrend==="BULLISH"
    ){
      duration = "SWING";
    }

    if(
      Math.abs(ema20-ema100)>600
    ){
      duration = "POSITION";
    }

    /*
    ==============================================
    RISK ENGINE
    ==============================================
    */
    const tradePlanDirection =
      signal !== "HOLD"
      ? signal
      : multiTimeframeTrend === "BEARISH"
      ? "SELL"
      : "BUY";

    const stopLoss =
      tradePlanDirection==="BUY"
      ? currentPrice - atr*1.5
      : currentPrice + atr*1.5;

    const takeProfit =
      tradePlanDirection==="BUY"
      ? currentPrice + atr*3
      : currentPrice - atr*3;

    const riskDistance =
      Math.abs(currentPrice - stopLoss) + spread;

    const rewardDistance =
      Math.abs(takeProfit - currentPrice);

    const riskRewardRatio =
      riskDistance > 0
      ? rewardDistance / riskDistance
      : 0;

    const buySignalScore =
      buildSignalScore({
        direction:"BULLISH",
        oneHourTrend,
        fourHourTrend,
        oneDayTrend,
        rsi,
        atrPercent,
        spreadPercent,
        riskRewardRatio
      });

    const sellSignalScore =
      buildSignalScore({
        direction:"BEARISH",
        oneHourTrend,
        fourHourTrend,
        oneDayTrend,
        rsi,
        atrPercent,
        spreadPercent,
        riskRewardRatio
      });

    const signalScore =
      buySignalScore.score >= sellSignalScore.score
      ? buySignalScore
      : sellSignalScore;

    signal =
      signalScore.passed
      ? signalScore.direction === "BULLISH"
        ? "BUY"
        : "SELL"
      : "HOLD";

    confidence =
      signalScore.score;

    if(!signalScore.passed){
      signalWarnings.push("SCORE BELOW THRESHOLD");
    }

    if(
      signal !== "HOLD" &&
      riskRewardRatio < MIN_RISK_REWARD
    ){
      signalWarnings.push("RISK/REWARD TOO LOW");
      signal = "HOLD";
      confidence =
        Math.max(35, confidence - 20);
    }

    let riskScore =
      Math.round(
        40 + leverage*5 + spread*0.01
      );

    riskScore =
      Math.min(100,riskScore);

    /*
    ==============================================
    TRAILING STOP LOSS
    ==============================================
    */
    let trailingStopLoss = "--";
    let trailingStopAdvice =
      "NO OPEN POSITION";

    if(
      holding==="yes" &&
      entryPrice>0 &&
      currentPrice>0 &&
      atr>0
    ){

      const previousTrailingState =
        await redis.get(trailingStopStateKey);

      const previousBestPrice =
        parseFloat(previousTrailingState?.bestPrice || entryPrice);

      const previousTrailingStop =
        parseFloat(previousTrailingState?.trailingStopLoss || 0);

      const bestPrice =
        Math.max(
          previousBestPrice,
          currentPrice,
          entryPrice
        );

      const calculatedTrailingStop =
        bestPrice - atr * TRAILING_ATR_MULTIPLIER;

      const protectedTrailingStop =
        Math.max(
          previousTrailingStop,
          existingSL || 0,
          calculatedTrailingStop
        );

      trailingStopLoss =
        protectedTrailingStop.toFixed(2);

      trailingStopAdvice =
        currentPrice <= protectedTrailingStop
        ? "TRAILING STOP HIT"
        : "TRAILING STOP ACTIVE";

      await redis.set(
        trailingStopStateKey,
        {
          bestPrice,
          trailingStopLoss:
            protectedTrailingStop,
          updatedAt:
            new Date().toISOString()
        }
      );

    } else {

      await redis.del(trailingStopStateKey);

    }

    /*
    ==============================================
    POSITION ANALYSIS
    ==============================================
    */
    let pnl = "--";
    let exposure = "--";
    let positionAdvice =
      "NO OPEN POSITION";

    if(
      holding==="yes" &&
      entryPrice>0
    ){

      const percentMove =
        (currentPrice-entryPrice)/entryPrice;

      const pnlValue =
        amountInvested *
        percentMove *
        leverage;

      pnl =
        pnlValue.toFixed(2);

      exposure =
        (amountInvested*leverage).toFixed(2);

      positionAdvice =
        signal==="SELL"
        ? "CONSIDER EXIT"
        : "HOLD POSITION";

      if(
        existingTP>0 &&
        currentPrice>=existingTP
      ){
        positionAdvice =
          "TAKE PROFIT HIT";
      }

      if(
        existingSL>0 &&
        currentPrice<=existingSL
      ){
        positionAdvice =
          "STOP LOSS BREACHED";
      }

      if(trailingStopAdvice === "TRAILING STOP HIT"){
        positionAdvice =
          "TRAILING STOP HIT";
      }
    }

    /*
    ==============================================
    SMART TELEGRAM ALERT ENGINE
    ==============================================
    */

    let shouldSendTelegram = false;
    const telegramCooldownActive =
      isCooldownActive(signalState.lastTelegramAt);

    /*
    NOT HOLDING
    BUY -> SEND
    SELL -> IGNORE
    */
    if(

      holding === "no" &&
      signal === "BUY"
    ){
      shouldSendTelegram = true;
    }

    /*
    HOLDING
    SELL -> SEND
    BUY -> IGNORE
    */
    if(

      holding === "yes" &&
      signal === "SELL"
    ){
      shouldSendTelegram = true;
    }

    /*
    PREVENT DUPLICATES
    */
    if(

      signalState.lastTelegramSignal === signal
    ){
      shouldSendTelegram = false;
    }

    if(telegramCooldownActive){
      shouldSendTelegram = false;
    }

    if(
      shouldSendTelegram &&
      BOT_TOKEN &&
      CHAT_ID
    ){
      try {
        await fetch(
          `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    
          {
            method:"POST",
            headers:{
              "Content-Type":"application/json"
            },
            body:JSON.stringify({
              chat_id:CHAT_ID,
              text:
                `${signal} SIGNAL
                Instrument: ${instrumentId}
                Price: ${currentPrice.toFixed(2)}
                RSI: ${rsi.toFixed(2)}
                Trend:
                Short ${shortTrend}
                Mid ${midTrend}
                Long ${longTrend}
                Multi-timeframe ${multiTimeframeTrend}
                Duration:${duration}
                Confidence:${confidence}%
                Trailing Stop:${trailingStopLoss}`
  
            })
          }
        );

        signalState.lastTelegramSignal =
          signal;

        signalState.lastTelegramAt =
          Date.now();

        await redis.set(signalStateKey,signalState);
      } catch(e){

        console.log("Telegram Error:",e.message);}
    }
    /*
    ==============================================
    AUDIT LOGGING
    ==============================================
    */
    const logEntry =
`${new Date().toISOString()} | ${signal} | ${currentPrice.toFixed(2)} | RSI ${rsi.toFixed(2)} | MTF ${multiTimeframeTrend} | Spread ${spreadPercent.toFixed(3)}% | ATR ${atrPercent.toFixed(3)}% | RR ${riskRewardRatio.toFixed(2)} | TSL ${trailingStopLoss}`;

    const signalHistoryEntry = {
      time:
        new Date().toISOString(),

      instrumentId,
      signal,
      confidence:
        confidence+"%",

      price:
        currentPrice.toFixed(2),

      rsi:
        rsi.toFixed(2),

      spreadPercent:
        spreadPercent.toFixed(3),

      atrPercent:
        atrPercent.toFixed(3),

      riskRewardRatio:
        riskRewardRatio.toFixed(2),

      multiTimeframeTrend,

      trailingStopLoss,

      signalScore:
        signalScore.score,

      warnings:
        signalWarnings
    };

    await Promise.all([
      redis.lpush(
        "system-audit-logs",
        logEntry
      ),

      redis.ltrim(
        "system-audit-logs",
        0,
        99
      ),

      redis.lpush(
        `signal-history-${instrumentId}`,
        signalHistoryEntry
      ),

      redis.ltrim(
        `signal-history-${instrumentId}`,
        0,
        49
      )
    ]);

    /*
    ==============================================
    RESPONSE
    ==============================================
    */
    return res.status(200).json({

      signal,

      confidence:
        confidence+"%",

      signalScore:
        signalScore.score+"/100",

      signalScoreFactors:
        signalScore.factors,

      duration,

      shortTrend,
      midTrend,
      longTrend,

      oneHourTrend:
        oneHourTrend.alignedTrend,

      fourHourTrend:
        fourHourTrend.alignedTrend,

      oneDayTrend:
        oneDayTrend.alignedTrend,

      multiTimeframeTrend,

      multiTimeframeConfirmed,

      price:
        currentPrice.toFixed(2),

      ask:
        ask.toFixed(2),

      bid:
        bid.toFixed(2),

      spread:
        spread.toFixed(2),

      spreadPercent:
        spreadPercent.toFixed(3)+"%",

      ema20:
        ema20.toFixed(2),

      ema50:
        ema50.toFixed(2),

      ema100:
        ema100.toFixed(2),

      rsi:
        rsi.toFixed(2),

      atr:
        atr.toFixed(2),

      atrPercent:
        atrPercent.toFixed(3)+"%",

      entry:
        currentPrice.toFixed(2),

      stopLoss:
        stopLoss.toFixed(2),

      takeProfit:
        takeProfit.toFixed(2),

      tradePlanDirection,

      riskScore:
        riskScore+"/100",

      riskRewardRatio:
        riskRewardRatio.toFixed(2),

      signalQuality:
        signalWarnings.length
        ? signalWarnings.join(", ")
        : "OK",

      telegramCooldown:
        telegramCooldownActive,

      trailingStopLoss,

      trailingStopAdvice,

      pnl,
      exposure,
      positionAdvice,

      holding:
        holding==="yes",

      entryPrice,
      leverage,
      amountInvested,
      existingSL,
      existingTP

    });

  } catch(err){

    console.error(
      "FATAL ERROR:",
      err
    );

    /*
    ==============================================
    ERROR LOGGING
    ==============================================
    */
    try {

      const errorLog =
`${new Date().toISOString()} | ERROR | ${err.message}`;

      await redis.lpush(
        "system-audit-logs",
        errorLog
      );

      await redis.ltrim(
        "system-audit-logs",
        0,
        99
      );

    } catch(e){}

    return res.status(500).json({
      success:false,
      error:err.message
    });
  }
}
