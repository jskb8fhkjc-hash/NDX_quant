import { Redis } from "@upstash/redis";

const redis = new Redis({

url:
process.env.UPSTASH_REDIS_REST_KV_REST_API_URL,

token:
process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN

});

export default async function handler(
req,
res
){

try{

/*
==================================================
ENV
==================================================
*/

const API_KEY =
process.env.ETORO_API_KEY;

const USER_KEY =
process.env.ETORO_USER_KEY;

const BOT_TOKEN =
process.env.TELEGRAM_BOT_TOKEN;

const CHAT_ID =
process.env.TELEGRAM_CHAT_ID;

/*
==================================================
INPUTS
==================================================
*/

const instrumentId =
req.query.instrumentId || "686";

const holding =
req.query.holding || "no";

const leverage =
parseFloat(
req.query.leverage || 1
);

const entryPrice =
parseFloat(
req.query.entryPrice || 0
);

const existingSL =
parseFloat(
req.query.existingSL || 0
);

const existingTP =
parseFloat(
req.query.existingTP || 0
);

const amountInvested =
parseFloat(
req.query.amountInvested || 1000
);

const BASE_URL =
"https://public-api.etoro.com/api/v1";

/*
==================================================
REDIS STATE
==================================================
*/

let state =
await redis.get(
`position-${instrumentId}`
);

if(!state){

state = {

holding:false,

entryPrice:0,

leverage:1,

lastSignal:"NONE",

amountInvested:1000
};
}

/*
==================================================
SYNC FRONTEND STATE
==================================================
*/

/*
========================================
OPTIONAL MANUAL POSITION UPDATE
========================================
*/

if(
req.query.updatePosition==="true"
){

if(holding==="yes"){

state.holding = true;

state.entryPrice =
entryPrice;

state.leverage =
leverage;

state.amountInvested =
amountInvested;
}

if(holding==="no"){

state.holding = false;
}
}

/*
==================================================
FETCH LIVE RATE
==================================================
*/

async function fetchRates(){

const response =
await fetch(

`${BASE_URL}/market-data/instruments/rates?instrumentIds=${instrumentId}`,

{
headers:{
"x-api-key":API_KEY,
"x-user-key":USER_KEY,
"x-request-id":crypto.randomUUID()
}
}
);

const data =
await response.json();

console.log(
"Live Rates:",
JSON.stringify(data)
);

if(
!data.rates ||
data.rates.length===0
){

throw new Error(
"No live rates returned"
);
}

return data.rates[0];
}

/*
==================================================
FETCH CANDLES
==================================================
*/

async function fetchCandles(){

const response =
await fetch(

`${BASE_URL}/market-data/instruments/${instrumentId}/history/candles/desc/OneDay/200`,

{
headers:{
"x-api-key":API_KEY,
"x-user-key":USER_KEY,
"x-request-id":crypto.randomUUID()
}
}
);

const data =
await response.json();

console.log(
"Candle Data:",
JSON.stringify(data)
);

if(
!data.candles ||
data.candles.length===0
){

throw new Error(
"No candle wrapper returned"
);
}

if(
!data.candles[0].candles
){

throw new Error(
"No nested candle array found"
);
}

return data.candles[0].candles;
}

/*
==================================================
EMA
==================================================
*/

function EMA(data,period){

const k =
2/(period+1);

let ema =
data[0];

for(
let i=1;
i<data.length;
i++
){

ema =
data[i]*k +
ema*(1-k);
}

return ema;
}

/*
==================================================
TRUE WILDER RSI
==================================================
*/

function RSI(closes,period=14){

let gains = 0;
let losses = 0;

/*
========================================
INITIAL RSI
========================================
*/

for(
let i=1;
i<=period;
i++
){

const diff =
closes[i]-closes[i-1];

if(diff>=0){

gains += diff;

}else{

losses += Math.abs(diff);
}
}

let avgGain =
gains/period;

let avgLoss =
losses/period;

/*
========================================
WILDER SMOOTHING
========================================
*/

for(
let i=period+1;
i<closes.length;
i++
){

const diff =
closes[i]-closes[i-1];

const gain =
diff>0 ? diff : 0;

const loss =
diff<0 ? Math.abs(diff) : 0;

avgGain =
(
(avgGain*(period-1))
+ gain
)/period;

avgLoss =
(
(avgLoss*(period-1))
+ loss
)/period;
}

if(avgLoss===0){

return 100;
}

const rs =
avgGain/avgLoss;

return 100 -
(100/(1+rs));
}

/*
==================================================
ATR
==================================================
*/

function ATR(candles,period=14){

let trs = [];

for(
let i=1;
i<candles.length;
i++
){

const high =
parseFloat(candles[i].high);

const low =
parseFloat(candles[i].low);

const prevClose =
parseFloat(candles[i-1].close);

const tr =
Math.max(
high-low,
Math.abs(high-prevClose),
Math.abs(low-prevClose)
);

trs.push(tr);
}

const recent =
trs.slice(-period);

return recent.reduce(
(a,b)=>a+b,
0
)/period;
}

/*
==================================================
FETCH MARKET DATA
==================================================
*/

const live =
await fetchRates();

const candles =
await fetchCandles();

/*
==================================================
SORT ASCENDING
==================================================
*/

candles.sort(

(a,b)=>

new Date(a.fromDate) -
new Date(b.fromDate)

);

/*
==================================================
BUILD ARRAYS
==================================================
*/

const closes =
candles.map(c =>
parseFloat(c.close)
);

/*
==================================================
INDICATORS
==================================================
*/

const ema20 =
EMA(
closes.slice(-20),
20
);

const ema50 =
EMA(
closes.slice(-50),
50
);

const ema100 =
EMA(
closes.slice(-100),
100
);

const rsi =
RSI(closes);

const atr =
ATR(candles);

const currentPrice =
parseFloat(
live.lastExecution
);

const ask =
parseFloat(live.ask);

const bid =
parseFloat(live.bid);

const spread =
ask-bid;

/*
==================================================
TREND ENGINE
==================================================
*/

const shortTrend =
currentPrice > ema20
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

/*
==================================================
SIGNAL ENGINE
==================================================
*/

let signal = "HOLD";

let confidence = 50;

if(

shortTrend==="BULLISH" &&
midTrend==="BULLISH" &&
longTrend==="BULLISH" &&
rsi>50 &&
rsi<68

){

signal = "BUY";

confidence += 30;

/*
========================================
ONLY ENTER ONCE
========================================
*/

if(!state.holding){

state.holding = true;

state.entryPrice =
currentPrice;

state.leverage =
leverage;
}
}

if(

shortTrend==="BEARISH" &&
midTrend==="BEARISH" &&
longTrend==="BEARISH" &&
rsi<40

){

signal = "SELL";

confidence += 30;

/*
========================================
ONLY EXIT IF HOLDING
========================================
*/

if(state.holding){

state.holding = false;
}
}

/*
==================================================
TREND DURATION
==================================================
*/

let duration =
"INTRADAY";

if(
midTrend==="BULLISH" &&
longTrend==="BULLISH"
){

duration =
"SWING";
}

if(
Math.abs(ema20-ema100)>600
){

duration =
"POSITION";
}

/*
==================================================
SL / TP
==================================================
*/

const stopLoss =
signal==="BUY"
? currentPrice - atr*1.5
: currentPrice + atr*1.5;

const takeProfit =
signal==="BUY"
? currentPrice + atr*3
: currentPrice - atr*3;

/*
==================================================
RISK ENGINE
==================================================
*/

let riskScore =
Math.round(
40 +
(leverage*5) +
(spread*0.01)
);

riskScore =
Math.min(100,riskScore);

/*
==================================================
POSITION ANALYSIS
==================================================
*/

let pnl = "--";

let exposure = "--";

let positionAdvice =
"NO OPEN POSITION";

if(
state.holding &&
state.entryPrice>0
){

const percentMove =

(
currentPrice -
state.entryPrice
)
/
state.entryPrice;

const pnlValue =

amountInvested *
percentMove *
state.leverage;

pnl =
pnlValue.toFixed(2);

exposure =
(
amountInvested *
state.leverage
).toFixed(2);

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
}

/*
==================================================
TELEGRAM ALERTS
==================================================
*/

let shouldNotify = false;

if(
signal!==state.lastSignal
){

if(
!state.holding &&
signal==="BUY"
){

shouldNotify = true;
}

if(
state.holding &&
signal==="SELL"
){

shouldNotify = true;
}
}

if(shouldNotify){

const message =

`${signal} SIGNAL

Instrument:
${instrumentId}

Price:
${currentPrice.toFixed(2)}

Confidence:
${confidence}%

RSI:
${rsi.toFixed(2)}

EMA20:
${ema20.toFixed(2)}

EMA50:
${ema50.toFixed(2)}

EMA100:
${ema100.toFixed(2)}

Spread:
${spread.toFixed(2)}

Duration:
${duration}

SL:
${stopLoss.toFixed(2)}

TP:
${takeProfit.toFixed(2)}

Leverage:
${state.leverage}x

PnL:
${pnl}
`;

await fetch(

`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,

{
method:"POST",

headers:{
"Content-Type":
"application/json"
},

body:JSON.stringify({

chat_id:CHAT_ID,
text:message
})
}
);

/*
========================================
SAVE LAST SIGNAL
========================================
*/

state.lastSignal = signal;
}

/*
==================================================
SAVE STATE
==================================================
*/

await redis.set(

`position-${instrumentId}`,

state
);

/*
==================================================
RESPONSE
==================================================
*/

res.status(200).json({

signal,

price:
currentPrice.toFixed(2),

ask:
ask.toFixed(2),

bid:
bid.toFixed(2),

spread:
spread.toFixed(2),

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

confidence:
confidence+"%",

duration,

riskScore:
riskScore+"/100",

entry:
currentPrice.toFixed(2),

stopLoss:
stopLoss.toFixed(2),

takeProfit:
takeProfit.toFixed(2),

shortTrend,

midTrend,

longTrend,

holding:
state.holding,

entryPrice:
state.entryPrice,

leverage:
state.leverage,

pnl,

exposure,

positionAdvice
});

}catch(err){

console.log(err);

res.status(500).json({

error:err.message
});
}

}
