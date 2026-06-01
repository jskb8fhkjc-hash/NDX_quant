export function EMA(data, period) {
  if (!data.length) return 0;
  const k = 2 / (period + 1);
  let ema = data[0];
  for (let i = 1; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
  }
  return ema;
}

export function RSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0; let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  let avgGain = gains / period; let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + (avgGain / avgLoss)));
}

export function ATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const high = parseFloat(candles[i].high);
    const low = parseFloat(candles[i].low);
    const prevClose = parseFloat(candles[i - 1].close);
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// Phase 1 Requirement: True Trend Strength
export function ADX(candles, period = 14) {
  if (candles.length < period + 1) return { adx: 0 };
  let tr = [], plusDm = [], minusDm = [];
  
  for (let i = 1; i < candles.length; i++) {
    const upMove = parseFloat(candles[i].high) - parseFloat(candles[i - 1].high);
    const downMove = parseFloat(candles[i - 1].low) - parseFloat(candles[i].low);
    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(
      parseFloat(candles[i].high) - parseFloat(candles[i].low),
      Math.abs(parseFloat(candles[i].high) - parseFloat(candles[i - 1].close)),
      Math.abs(parseFloat(candles[i].low) - parseFloat(candles[i - 1].close))
    ));
  }

  // Wilder's Smoothing
  const smooth = (data) => {
    let sum = data.slice(0, period).reduce((a, b) => a + b, 0);
    const res = [sum];
    for (let i = period; i < data.length; i++) {
      sum = sum - (sum / period) + data[i];
      res.push(sum);
    }
    return res;
  };

  const smoothTr = smooth(tr), smoothPdm = smooth(plusDm), smoothMdm = smooth(minusDm);
  let dx = [];
  for (let i = 0; i < smoothTr.length; i++) {
    const pdi = (smoothPdm[i] / smoothTr[i]) * 100 || 0;
    const mdi = (smoothMdm[i] / smoothTr[i]) * 100 || 0;
    dx.push((Math.abs(pdi - mdi) / (pdi + mdi)) * 100 || 0);
  }

  return { adx: smooth(dx).pop() / period || 0 };
}
