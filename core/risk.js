export function calculateRiskSizing({ amountInvested, leverage, currentPrice, atr, volatility }) {
  // Base Risk is 1%. Cut risk in half if volatility is expanding.
  const riskPercent = (volatility === "EXPANDING" || volatility === "EXTREME") ? 0.5 : 1.0;
  
  const riskCapital = Math.max(0, amountInvested) * (riskPercent / 100);
  
  // Target Stop Loss = 2x ATR
  const riskDistance = atr * 2; 
  const stopDistancePercent = currentPrice > 0 ? (riskDistance / currentPrice) : 0;
  
  const uncappedPositionValue = stopDistancePercent > 0 ? riskCapital / stopDistancePercent : 0;
  const maxExposure = Math.max(0, amountInvested) * Math.max(1, leverage);
  
  const recommendedPositionValue = Math.min(uncappedPositionValue, maxExposure);
  
  return {
    riskPercent,
    riskCapital,
    stopDistancePercent: stopDistancePercent * 100,
    recommendedPositionValue,
    recommendedInvestment: leverage > 0 ? recommendedPositionValue / leverage : recommendedPositionValue,
    recommendedUnits: currentPrice > 0 ? recommendedPositionValue / currentPrice : 0
  };
}
