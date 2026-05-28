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

    const logs =
      await redis.lrange(
        "system-audit-logs",
        0,
        99
      );

    return res.status(200).json({
      success:true,
      logs: logs || []
    });

  }catch(err){

    console.error(err);

    return res.status(500).json({
      success:false,
      error:err.message
    });

  }

}
