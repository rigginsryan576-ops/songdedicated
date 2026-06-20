// api/status.js  — simple health check
export default function handler(req, res) {
  res.json({ status: 'ok', service: 'SongDedicated', time: new Date().toISOString() });
}
