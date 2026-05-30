import { Redis } from "@upstash/redis";

const redis = new Redis({
  url:
    process.env.UPSTASH_REDIS_REST_KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL,

  token:
    process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN
});

export default async function handler(req, res){
  try{
    const instrumentId =
      req.query.instrumentId || "686";

    const history =
      await redis.lrange(
        `signal-history-${instrumentId}`,
        0,
        19
      );

    return res.status(200).json({
      success:true,
      history:history || []
    });

  }catch(err){
    console.error(err);

    return res.status(500).json({
      success:false,
      error:err.message
    });
  }
}
