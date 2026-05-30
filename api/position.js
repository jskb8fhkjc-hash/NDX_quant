import { Redis } from "@upstash/redis";

const redis = new Redis({
  url:
    process.env.UPSTASH_REDIS_REST_KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL,

  token:
    process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN
});

function getPositionStateKey(instrumentId){
  return `position-state-${instrumentId || "686"}`;
}

function normalizePosition(position = {}){
  return {
    holding:
      position.holding === "yes" ||
      position.holding === true
      ? "yes"
      : "no",

    leverage:
      parseFloat(position.leverage || 1),

    entryPrice:
      parseFloat(position.entryPrice || 0),

    amountInvested:
      parseFloat(position.amountInvested || 1000),

    existingSL:
      parseFloat(position.existingSL || 0),

    existingTP:
      parseFloat(position.existingTP || 0)
  };
}

export default async function handler(req, res){
  try{
    const instrumentId =
      req.query.instrumentId || "686";

    const positionStateKey =
      getPositionStateKey(instrumentId);

    if(req.method === "GET"){
      const position =
        await redis.get(positionStateKey);

      return res.status(200).json({
        success: true,
        position: position || null
      });
    }

    if(req.method === "POST"){
      const position =
        normalizePosition(req.body || {});

      await redis.set(
        positionStateKey,
        position
      );

      return res.status(200).json({
        success: true,
        position
      });
    }

    res.setHeader(
      "Allow",
      "GET, POST"
    );

    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });

  }catch(err){
    console.error(
      "POSITION ERROR:",
      err
    );

    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
}
