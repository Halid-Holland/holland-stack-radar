const OWNER = 'Halid-Holland';
const REPO = 'holland-stack-radar';
const FILE = 'vendors.json';

async function getFile(token) {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (!res.ok) throw new Error(`GitHub GET failed: ${res.status}`);
  return res.json();
}

export default async function handler(req, res) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN not configured' });

  if (req.method === 'GET') {
    try {
      const file = await getFile(token);
      const vendors = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
      return res.status(200).json(vendors);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const vendors = req.body;
      if (!Array.isArray(vendors)) return res.status(400).json({ error: 'Expected array' });

      const file = await getFile(token);
      const content = Buffer.from(JSON.stringify(vendors, null, 2)).toString('base64');

      const putRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: 'Update vendor selection',
          content,
          sha: file.sha,
        }),
      });

      if (!putRes.ok) {
        const err = await putRes.json();
        return res.status(500).json({ error: err.message });
      }

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
