export function calculateRiskSizing({ amountInvested, leverage, currentPrice, atr, volatility }) {
  const riskPercent = (volatility === "EXPANDING" || volatility === "EXTREME") ? 0.5 : 1.0;
  const riskCapital = amountInvested * (riskPercent / 100);
  const riskDistance = atr > 0 ? atr * 1.5 : currentPrice * 0.02;
  const stopDistancePercent = currentPrice > 0 ? (riskDistance / currentPrice) : 0.02;
  
  const recommendedPositionValue = stopDistancePercent > 0 ? (riskCapital / stopDistancePercent) : amountInvested;
  const maxExposure = amountInvested * leverage;
  const finalPositionValue = Math.min(recommendedPositionValue, maxExposure);

  return {
    riskPercent,
    riskCapital,
    stopDistancePercent: stopDistancePercent * 100,
    recommendedPositionValue: finalPositionValue,
    recommendedInvestment: leverage > 0 ? finalPositionValue / leverage : finalPositionValue,
    recommendedUnits: currentPrice > 0 ? finalPositionValue / currentPrice : 0
  };
}
