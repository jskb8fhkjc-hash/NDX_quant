import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
});

export default async function handler(req, res){
  try{
    const instrumentId = req.query.instrumentId || "28";

    const rawHistory = await redis.lrange(`signal-history-${instrumentId}`, 0, 19);
    
    // FIX: Parse raw Redis strings into objects, silently dropping malformed legacy rows
    const parsedHistory = (rawHistory || []).map(item => {
      if (typeof item === "string") {
        try { return JSON.parse(item); } catch(e) { return null; }
      }
      return item;
    }).filter(Boolean);

    return res.status(200).json({
      success: true,
      history: parsedHistory
    });

  }catch(err){
    console.error(err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
