import { Redis } from "@upstash/redis";

function uuidv4(){
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx"
  .replace(/[xy]/g,function(c){
    const r = Math.random()*16|0;
    const v = c==="x" ? r : (r&0x3|0x8);
    return v.toString(16);
  });
}

/*
==================================================
REDIS INITIALIZATION
==================================================
*/
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
});

/*
==================================================
FETCH WITH TIMEOUT
==================================================
*/
async function fetchWithTimeout(url, options = {}, timeout = 15000){
  const controller = new AbortController();
  const id = setTimeout(() => { controller.abort(); }, timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(id);
  }
}

/*
==================================================
TECHNICAL INDICATORS (EMA, RSI, ATR)
==================================================
*/
function EMA(data, period){
  if(data.length===0) return 0;
  const k = 2 / (period + 1);
  let ema = data[0];
  for(let i=1; i<data.length; i++){
    ema = data[i]*k + ema*(1-k);
  }
  return ema;
}

function RSI(closes, period=14){
  if(closes.length < period+1) return 50;
  let gains = 0;
  let losses = 0;
  for(let i=1; i<=period; i++){
    const diff = closes[i]-closes[i-1];
    if(diff>=0) gains += diff; else losses += Math.abs(diff);
  }
  let avgGain = gains/period;
  let avgLoss = losses/period;

  for(let i=period+1; i<closes.length; i++){
    const diff = closes[i]-closes[i-1];
    const gain = diff>0 ? diff : 0;
    const loss = diff<0 ? Math.abs(diff) : 0;
    avgGain = (avgGain*(period-1) + gain)/period;
    avgLoss = (avgLoss*(period-1) + loss)/period;
  }
  if(avgLoss===0) return 100;
  const rs = avgGain/avgLoss;
  return 100 - (100/(1+rs));
}

function ATR(candles, period=14){
  if(candles.length < period+1) return 0;
  const trs = [];
  for(let i=1; i<candles.length; i++){
    const high = parseFloat(candles[i].high);
    const low = parseFloat(candles[i].low);
    const prevClose = parseFloat(candles[i-1].close);
    const tr = Math.max(high-low, Math.abs(high-prevClose), Math.abs(low-prevClose));
    trs.push(tr);
  }
  const recent = trs.slice(-period);
  return recent.reduce((a,b)=>a+b, 0)/period;
}

/*
==================================================
MAIN HANDLER
==================================================
*/
export default async function handler(req, res){
  /*
  ==================================================
  SECURITY / CONTEXT CHECK
  ==================================================
  */
  const isCronTrigger = req.headers['x-vercel-cron'] === '1';
  const hasValidSecret = req.query.secret === "MY_SUPER_SECRET_PASSWORD";

  if (!isCronTrigger && !hasValidSecret && !req.headers['referer'] && !req.headers['host']?.includes('localhost')) {
  return res.status(401).json({ success: false, error: "Unauthorized access attempt" });
  }

  // Track the execution's Telegram status for our audit logging list
  let telegramLogStatus = "SKIPPED (No Signal Change)";

  try {
    const API_KEY = process.env.ETORO_API_KEY;
    const USER_KEY = process.env.ETORO_USER_KEY;
    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
    const BASE_URL = "https://public-api.etoro.com/api/v1";

    const instrumentId = req.query.instrumentId || "686";
    const holding = req.query.holding || "no";
    const leverage = parseFloat(req.query.leverage || 1);
    const entryPrice = parseFloat(req.query.entryPrice || 0);
    const existingSL = parseFloat(req.query.existingSL || 0);
    const existingTP = parseFloat(req.query.existingTP || 0);
    const amountInvested = parseFloat(req.query.amountInvested || 1000);
    const updatePosition = req.query.updatePosition === "true";

    /*
    ==================================================
    LOAD STATE FROM UPSTASH
    ==================================================
    */
    let state = await redis.get(`position-${instrumentId}`);

    if (typeof state === "string") {
      try { state = JSON.parse(state); } catch(e) { state = null; }
    }

    if(!state){
      state = {
        holding: false,
        entryPrice: 0,
        leverage: 1,
        amountInvested: 1000,
        existingSL: 0,
        existingTP: 0,
        lastSignal: "NONE"
      };
    }

    if (state.existingSL === undefined) state.existingSL = 0;
    if (state.existingTP === undefined) state.existingTP = 0;
    if (state.lastSignal === undefined) state.lastSignal = "NONE";

    /*
    ==================================================
    DATABASE POSITION STATE SYNC & BUGFIX RESET
    ==================================================
    */
    if(updatePosition){
      if(holding==="yes"){
        state.holding = true;
        state.entryPrice = entryPrice;
        state.leverage = leverage;
        state.amountInvested = amountInvested;
        state.existingSL = existingSL;
        state.existingTP = existingTP;
      } else {
        state.holding = false;
        state.entryPrice = 0;
        state.leverage = 1;
        state.amountInvested = 0;
        state.existingSL = 0;
        state.existingTP = 0;
      }
      
      // FIX: Force reset the saved signal memory context when position parameters shift.
      // This allows immediate generation of a new signal message upon subsequent runs.
      state.lastSignal = "NONE";
      
      await redis.set(`position-${instrumentId}`, state);
    }

    /*
    ==================================================
    FETCH LIVE DATA & MARKET DEPTH
    ==================================================
    */
    const liveResponse = await fetchWithTimeout(
      `${BASE_URL}/market-data/instruments/rates?instrumentIds=${instrumentId}`,
      {
        headers: {
          "x-api-key": API_KEY,
          "x-user-key": USER_KEY,
          "x-request-id": uuidv4()
        }
      }
    );

    if(!liveResponse.ok){
      const errorText = await liveResponse.text();
      throw new Error(`Rates API failed ${liveResponse.status} - ${errorText}`);
    }

    const liveData = await liveResponse.json();
    if(!liveData.rates || liveData.rates.length===0){
      throw new Error("No rates returned");
    }

    const live = liveData.rates[0];

    /*
    ==================================================
    FETCH HISTORICAL CANDLES
    ==================================================
    */
    const candleResponse = await fetchWithTimeout(
      `${BASE_URL}/market-data/instruments/${instrumentId}/history/candles/desc/OneDay/200`,
      {
        headers: {
          "x-api-key": API_KEY,
          "x-user-key": USER_KEY,
          "x-request-id": uuidv4()
        }
      }
    );

    if(!candleResponse.ok){
      throw new Error(`Candles API failed ${candleResponse.status}`);
    }

    const candleData = await candleResponse.json();
    if(!candleData.candles || candleData.candles.length===0 || !candleData.candles[0].candles){
      throw new Error("Invalid candle matrix dataset structure returned");
    }

    const candles = candleData.candles[0].candles;
    candles.sort((a,b) => new Date(a.fromDate) - new Date(b.fromDate));
    const closes = candles.map(c => parseFloat(c.close));

    /*
    ==================================================
    CALCULATE TECHNICAL ENGINE VARIABLES
    ==================================================
    */
    const ema20 = EMA(closes.slice(-20), 20);
    const ema50 = EMA(closes.slice(-50), 50);
    const ema100 = EMA(closes.slice(-100), 100);
    const rsi = RSI(closes);
    const atr = ATR(candles);

    const currentPrice = parseFloat(live.lastExecution);
    const ask = parseFloat(live.ask);
    const bid = parseFloat(live.bid);
    const spread = ask-bid;

    const shortTrend = currentPrice > ema20 ? "BULLISH" : "BEARISH";
    const midTrend = ema20 > ema50 ? "BULLISH" : "BEARISH";
    const longTrend = ema50 > ema100 ? "BULLISH" : "BEARISH";

    /*
    ==================================================
    SIGNAL STRATEGY INTERFACE
    ==================================================
    */
    let signal = "HOLD";
    let confidence = 50;

    if(shortTrend==="BULLISH" && midTrend==="BULLISH" && longTrend==="BULLISH" && rsi>50 && rsi<68){
      signal = "BUY";
      confidence += 30;
    }

    if(shortTrend==="BEARISH" && midTrend==="BEARISH" && longTrend==="BEARISH" && rsi<40){
      signal = "SELL";
      confidence += 30;
    }

    let duration = "INTRADAY";
    if(midTrend==="BULLISH" && longTrend==="BULLISH") duration = "SWING";
    if(Math.abs(ema20-ema100)>600) duration = "POSITION";

    /*
    ==================================================
    DYNAMIC RISK MANAGEMENT TARGET VALUES
    ==================================================
    */
    let stopLoss = 0;
    let takeProfit = 0;

    if (signal === "BUY") {
      stopLoss = currentPrice - (atr * 1.5);
      takeProfit = currentPrice + (atr * 3);
    } else if (signal === "SELL") {
      stopLoss = currentPrice + (atr * 1.5);
      takeProfit = currentPrice - (atr * 3);
    } else {
      stopLoss = currentPrice - (atr * 2);
      takeProfit = currentPrice + (atr * 2);
    }

    const activeLeverage = state.holding ? state.leverage : leverage;
    let riskScore = Math.min(100, Math.round(40 + (activeLeverage*5) + (spread*0.01)));

    /*
    ==================================================
    ACTIVE OPEN POSITION EVALUATOR
    ==================================================
    */
    let pnl = "--";
    let exposure = "--";
    let positionAdvice = "NO OPEN POSITION";

    if(state.holding && state.entryPrice>0){
      const percentMove = (currentPrice - state.entryPrice) / state.entryPrice;
      const pnlValue = state.amountInvested * percentMove * state.leverage;
      pnl = pnlValue.toFixed(2);
      exposure = (state.amountInvested * state.leverage).toFixed(2);
      positionAdvice = signal==="SELL" ? "CONSIDER EXIT" : "HOLD POSITION";

      if(state.existingTP>0 && currentPrice>=state.existingTP) positionAdvice = "TAKE PROFIT HIT";
      if(state.existingSL>0 && currentPrice<=state.existingSL) positionAdvice = "STOP LOSS BREACHED";
    }

    /*
    ==================================================
    TELEGRAM EXECUTOR WEBHOOK (FIXED CONDITIONAL)
    ==================================================
    */
    let shouldNotify = false;
    
    // FIX: Optimized state processing logic to confirm signals transition smoothly
    if(signal !== state.lastSignal){
      if(!state.holding && signal==="BUY") shouldNotify = true;
      if(state.holding && signal==="SELL") shouldNotify = true;
      
      // Update our persistent state signature tracking token
      state.lastSignal = signal;
    }

    if(shouldNotify){
      const message = `${signal} SIGNAL GENERATED\n\nAsset ID: ${instrumentId}\nExecution Price: ${currentPrice.toFixed(2)}\nConfidence Match: ${confidence}%\nLive RSI: ${rsi.toFixed(2)}\nEMA20: ${ema20.toFixed(2)}\nEMA50: ${ema50.toFixed(2)}\nEMA100: ${ema100.toFixed(2)}\nDuration Target: ${duration}\nSuggested SL: ${stopLoss.toFixed(2)}\nSuggested TP: ${takeProfit.toFixed(2)}\nActive Position Profit: ${pnl}`;
      try {
        const tgRes = await fetchWithTimeout(
          `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: CHAT_ID, text: message })
          }
        );
        if(tgRes.ok) {
          telegramLogStatus = "SUCCESSFULLY SIGNALED";
        } else {
          telegramLogStatus = `FAILED (Status Code: ${tgRes.status})`;
        }
      } catch (tgErr) {
        telegramLogStatus = `CRITICAL TELEGRAM ERROR: ${tgErr.message}`;
      }
    }

    // Save state back to Upstash Redis
    await redis.set(`position-${instrumentId}`, state);

    /*
    ==================================================
    💾 HISTORICAL SYSTEM AUDIT LOGGING (REDIS LIST)
    ==================================================
    */
    const logEntry = {
      timestamp: new Date().toISOString(),
      trigger: isCronTrigger ? "AUTOMATED_CRON" : "MANUAL_DASHBOARD",
      instrumentId,
      price: currentPrice.toFixed(2),
      rsi: rsi.toFixed(2),
      signal,
      telegramStatus: telegramLogStatus
    };

    // Save data object into the 'system-audit-logs' list array
    await redis.lpush("system-audit-logs", JSON.stringify(logEntry));
    // Prune data stack to only preserve top 100 historical entries
    await redis.ltrim("system-audit-logs", 0, 99);

    /*
    ==================================================
    CLIENT RESPONSES JSON OBJECT OUT
    ==================================================
    */
    return res.status(200).json({
      signal,
      price: currentPrice.toFixed(2),
      ask: ask.toFixed(2),
      bid: bid.toFixed(2),
      spread: spread.toFixed(2),
      ema20: ema20.toFixed(2),
      ema50: ema50.toFixed(2),
      ema100: ema100.toFixed(2),
      rsi: rsi.toFixed(2),
      atr: atr.toFixed(2),
      confidence: confidence+"%",
      duration,
      riskScore: riskScore+"/100",
      entry: currentPrice.toFixed(2),
      stopLoss: stopLoss.toFixed(2),
      takeProfit: takeProfit.toFixed(2),
      shortTrend,
      midTrend,
      longTrend,
      holding: state.holding,
      entryPrice: state.entryPrice,
      leverage: state.leverage,
      amountInvested: state.amountInvested,
      existingSL: state.existingSL,
      existingTP: state.existingTP,
      pnl,
      exposure,
      positionAdvice
    });

  } catch(err) {
    console.error("Fatal Runtime Error:", err);
    
    // Attempt log fallback configuration injection if primary pipeline errors out
    try {
      await redis.lpush("system-audit-logs", JSON.stringify({
        timestamp: new Date().toISOString(),
        trigger: isCronTrigger ? "AUTOMATED_CRON" : "MANUAL_DASHBOARD",
        signal: "ERROR",
        telegramStatus: "CRITICAL FAILURE",
        errorDetails: err.message
      }));
    } catch(e) {}

    return res.status(500).json({ success: false, error: err.message });
  }
}
