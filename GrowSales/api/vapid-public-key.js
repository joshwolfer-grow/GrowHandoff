export default function handler(req, res) {
  res.status(200).json({ key: process.env.VAPID_PUBLIC_KEY });
}
