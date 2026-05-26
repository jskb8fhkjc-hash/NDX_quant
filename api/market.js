let lastSignal = "NONE";

export default async function handler(
req,
res
){

try{

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

const holding =
req.query.holding || "no";

const leverage =
parseFloat(req.query.leverage || 1);

const entryPrice =
parseFloat(req.query.entryPrice || 0);

const existingSL =
parseFloat(req.query.existingSL || 0);

const existingTP =
parseFloat(req.query.existingTP || 0);

const BASE_URL =
"https://public-api.etoro.com/api/v1";

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
FETCH REAL HISTORICAL CANDLES
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
RSI
==================================================
*/

function RSI(closes,period=14){

let gains = 0;
let losses = 0;

for(
let i=
closes.length-period;

i<closes.length-1;

i++
){

const diff =
closes[i+1]-closes[i];

if(diff>0){

gains += diff;

}else{

losses += Math.abs(diff);
}
}

const avgGain =
gains/period;

const avgLoss =
losses/period;

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

trs.push(high-low);
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
MAIN
==================================================
*/

const live =
await fetchRates();

const candles =
await fetchCandles();

/*
==================================================
SORT CANDLES ASCENDING
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

const highs =
candles.map(c =>
parseFloat(c.high)
);

const lows =
candles.map(c =>
parseFloat(c.low)
);

const volumes =
candles.map(c =>
parseFloat(c.volume || 0)
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

const spread =
parseFloat(live.ask) -
parseFloat(live.bid);

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
}

if(

shortTrend==="BEARISH" &&
midTrend==="BEARISH" &&
longTrend==="BEARISH" &&
rsi<40

){

signal = "SELL";

confidence += 30;
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
holding==="yes" &&
entryPrice>0
){

const pnlValue =
(
currentPrice-entryPrice
)*leverage;

pnl =
pnlValue.toFixed(2);

exposure =
(
currentPrice*leverage
).toFixed(2);

if(signal==="BUY"){

positionAdvice =
"HOLD POSITION";
}

if(signal==="SELL"){

positionAdvice =
"CONSIDER EXIT";
}

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

if(signal!==lastSignal){

if(
holding==="no" &&
signal==="BUY"
){

shouldNotify = true;
}

if(
holding==="yes" &&
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

Short:
${shortTrend}

Mid:
${midTrend}

Long:
${longTrend}

Duration:
${duration}

SL:
${stopLoss.toFixed(2)}

TP:
${takeProfit.toFixed(2)}

Leverage:
${leverage}x
`;

const telegramResponse =
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

const telegramData =
await telegramResponse.json();

console.log(
"Telegram:",
telegramData
);
}

lastSignal = signal;

/*
==================================================
RESPONSE
==================================================
*/

res.status(200).json({

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
atr.toFixed(2),

spread:
spread.toFixed(2),

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
