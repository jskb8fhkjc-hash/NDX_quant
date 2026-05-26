export default async function handler(
req,
res
){

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

const entryPrice =
parseFloat(
req.query.entryPrice || 0
);

const leverage =
parseFloat(
req.query.leverage || 1
);

const existingSL =
parseFloat(
req.query.existingSL || 0
);

const existingTP =
parseFloat(
req.query.existingTP || 0
);

const BASE_URL =
"https://public-api.etoro.com/api/v1";

/*
==================================================
FETCH LIVE ETORO RATE
==================================================
*/

async function fetchEtoroLivePrice(){

const response =
await fetch(

`${BASE_URL}/market-data/instruments/rates?instrumentIds=${instrumentId}`,

{
headers:{

"x-api-key":
API_KEY,

"x-user-key":
USER_KEY,

"x-request-id":
crypto.randomUUID()
}
}

);

const data =
await response.json();

if(
!data.rates ||
data.rates.length===0
){

throw new Error(
"No live rates returned"
);
}

const rate =
data.rates[0];

return {

ask:
parseFloat(rate.ask),

bid:
parseFloat(rate.bid),

last:
parseFloat(rate.lastExecution),

spread:
parseFloat(rate.ask) -
parseFloat(rate.bid),

timestamp:
rate.date
};
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

losses +=
Math.abs(diff);
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

function ATR(closes){

let volatility = 0;

for(
let i=1;
i<closes.length;
i++
){

volatility +=
Math.abs(
closes[i]-closes[i-1]
);
}

return volatility /
closes.length;
}

try{

/*
==================================================
SIMULATED HISTORICAL SERIES
==================================================
*/

const historical = [];

let base = 29500;

for(
let i=0;
i<150;
i++
){

base +=
(Math.random()-0.485)*100;

historical.push(base);
}

/*
==================================================
LIVE PRICE
==================================================
*/

const liveRate =
await fetchEtoroLivePrice();

const currentPrice =
liveRate.last;

historical.push(
currentPrice
);

/*
==================================================
TECHNICALS
==================================================
*/

const ema20 =
EMA(
historical.slice(-20),
20
);

const ema50 =
EMA(
historical.slice(-50),
50
);

const ema100 =
EMA(
historical.slice(-100),
100
);

const rsi =
RSI(historical);

const atr =
ATR(
historical.slice(-20)
);

const volatility =
(
atr/currentPrice
)*100;

/*
==================================================
TREND ENGINE
==================================================
*/

let shortTrend =
"NEUTRAL";

let midTrend =
"NEUTRAL";

let longTrend =
"NEUTRAL";

if(currentPrice>ema20){

shortTrend = "BULLISH";

}else{

shortTrend = "BEARISH";
}

if(ema20>ema50){

midTrend = "BULLISH";

}else{

midTrend = "BEARISH";
}

if(ema50>ema100){

longTrend = "BULLISH";

}else{

longTrend = "BEARISH";
}

/*
==================================================
SIGNAL ENGINE
==================================================
*/

let signal =
"HOLD";

let confidence =
50;

if(

shortTrend==="BULLISH" &&
midTrend==="BULLISH" &&
longTrend==="BULLISH" &&
rsi>45 &&
rsi<68

){

signal = "BUY";

confidence += 25;
}

if(

shortTrend==="BEARISH" &&
midTrend==="BEARISH" &&
longTrend==="BEARISH" &&
rsi<40

){

signal = "SELL";

confidence += 25;
}

/*
==================================================
TREND DURATION
==================================================
*/

let duration =
"INTRADAY";

if(

longTrend==="BULLISH" &&
midTrend==="BULLISH"

){

duration =
"SWING (DAYS)";
}

if(

Math.abs(ema20-ema100)>250

){

duration =
"POSITION (WEEKS)";
}

/*
==================================================
SL / TP
==================================================
*/

let stopLoss = null;

let takeProfit = null;

if(signal==="BUY"){

stopLoss =
currentPrice -
atr*1.8;

takeProfit =
currentPrice +
atr*4;
}

if(signal==="SELL"){

stopLoss =
currentPrice +
atr*1.8;

takeProfit =
currentPrice -
atr*4;
}

/*
==================================================
RISK ENGINE
==================================================
*/

let riskScore =
Math.min(
100,
Math.round(
50 +
volatility +
(leverage*4)
)
);

if(
leverage>=10
){

confidence -= 10;

riskScore += 10;
}

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
(currentPrice-entryPrice)
*
leverage
);

pnl =
pnlValue.toFixed(2);

exposure =
(
currentPrice*
leverage
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
CONFIDENCE ENGINE
==================================================
*/

if(
shortTrend===midTrend
){

confidence += 5;
}

if(
midTrend===longTrend
){

confidence += 5;
}

if(
rsi>48 &&
rsi<62
){

confidence += 5;
}

confidence =
Math.min(
95,
Math.max(
40,
confidence
)
);

/*
==================================================
TELEGRAM FILTERING
==================================================
*/

let shouldNotify =
false;

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

/*
==================================================
TELEGRAM MESSAGE
==================================================
*/

if(
shouldNotify
){

const message =

`
${signal} SIGNAL

Instrument:
${instrumentId}

Price:
${currentPrice.toFixed(2)}

Short Trend:
${shortTrend}

Mid Trend:
${midTrend}

Long Trend:
${longTrend}

Expected Duration:
${duration}

RSI:
${rsi.toFixed(2)}

Confidence:
${confidence}%

Risk:
${riskScore}/100

Entry:
${currentPrice.toFixed(2)}

SL:
${stopLoss.toFixed(2)}

TP:
${takeProfit.toFixed(2)}

Leverage:
${leverage}x
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
}

/*
==================================================
RESPONSE
==================================================
*/

res.status(200).json({

signal,

price:
currentPrice.toFixed(2),

bid:
liveRate.bid.toFixed(2),

ask:
liveRate.ask.toFixed(2),

spread:
liveRate.spread.toFixed(2),

timestamp:
liveRate.timestamp,

ema20:
ema20.toFixed(2),

ema50:
ema50.toFixed(2),

ema100:
ema100.toFixed(2),

rsi:
rsi.toFixed(2),

volatility:
volatility.toFixed(2)+"%",

riskScore:
riskScore+"/100",

confidence:
confidence+"%",

entry:
currentPrice.toFixed(2),

stopLoss:
stopLoss
? stopLoss.toFixed(2)
: "--",

takeProfit:
takeProfit
? takeProfit.toFixed(2)
: "--",

shortTrend,

midTrend,

longTrend,

duration,

pnl,

exposure,

positionAdvice
});

}catch(err){

res.status(500).json({

error:err.message
});
}

}
