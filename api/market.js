export default async function handler(req, res) {

    const API_KEY = process.env.TWELVE_DATA_KEY;

    try {

        const response = await fetch(
            `https://api.twelvedata.com/time_series?symbol=QQQ&interval=1day&outputsize=250&apikey=${API_KEY}`
        );

        const data = await response.json();

        res.status(200).json(data);

    } catch (err) {

        res.status(500).json({
            error: err.message
        });
    }
}