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

const BASE_URL =
"https://public-api.etoro.com/api/v1";

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

    const response =
    await fetch(

`${BASE_URL}/market-data/candles?instrumentId=${instrumentId}&timeFrame=1D&limit=120`,

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

    const historical =
    await response.json();

    const candles =
    historical.candles ||
    historical.items ||
    [];

    const closes =
    candles.map(

        c =>
        parseFloat(
            c.close ||
            c.closePrice ||
            c.c
        )
    );

    const currentPrice =
    closes[
    closes.length-1
    ];

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

    const rsi =
    RSI(closes);

    const atr =
    ATR(
        closes.slice(-20)
    );

    const volatility =
    (
        atr/currentPrice
    )*100;

    let signal =
    "HOLD";

    if(
        ema20>ema50 &&
        rsi>45 &&
        rsi<65
    ){

        signal =
        "BUY";
    }

    if(
        ema20<ema50 &&
        rsi<40
    ){

        signal =
        "SELL";
    }

    let stopLoss = null;
    let takeProfit = null;

    if(signal==="BUY"){

        stopLoss =
        currentPrice -
        atr*1.5;

        takeProfit =
        currentPrice +
        atr*3;
    }

    if(signal==="SELL"){

        stopLoss =
        currentPrice +
        atr*1.5;

        takeProfit =
        currentPrice -
        atr*3;
    }

    const riskScore =
    Math.min(
        100,
        Math.round(
            50+volatility+rsi/10
        )
    );

    const confidence =
    Math.min(
        95,
        Math.round(
            55 +
            Math.abs(ema20-ema50)/10
        )
    );

    if(signal!=="HOLD"){

        const message =
`
${signal} SIGNAL

Instrument:
${instrumentId}

Price:
${currentPrice.toFixed(2)}

RSI:
${rsi.toFixed(2)}

EMA20:
${ema20.toFixed(2)}

EMA50:
${ema50.toFixed(2)}

Risk:
${riskScore}/100

Confidence:
${confidence}%

Entry:
${currentPrice.toFixed(2)}

SL:
${stopLoss.toFixed(2)}

TP:
${takeProfit.toFixed(2)}
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

    res.status(200).json({

        signal,

        price:
        currentPrice.toFixed(2),

        ema20:
        ema20.toFixed(2),

        ema50:
        ema50.toFixed(2),

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
        : "--"
    });

}catch(err){

    res.status(500).json({

        error:err.message
    });
}

} 
