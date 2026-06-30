export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { to_email, subject, message } = req.body;
  if (!to_email || !subject || !message) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const { ENTRA_CLIENT_ID, ENTRA_TENANT_ID, ENTRA_CLIENT_SECRET, MAIL_FROM } = process.env;

  try {
    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: ENTRA_CLIENT_ID,
          client_secret: ENTRA_CLIENT_SECRET,
          scope: 'https://graph.microsoft.com/.default',
        }),
      }
    );

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error('Token error:', tokenData);
      return res.status(500).json({ error: 'Failed to obtain access token' });
    }

    const mailRes = await fetch(
      `https://graph.microsoft.com/v1.0/users/${MAIL_FROM}/sendMail`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            subject,
            body: { contentType: 'HTML', content: message },
            toRecipients: [{ emailAddress: { address: to_email } }],
          },
          saveToSentItems: false,
        }),
      }
    );

    if (mailRes.status === 202) {
      return res.status(200).json({ success: true });
    }

    const errData = await mailRes.json().catch(() => ({}));
    console.error('Graph error:', errData);
    return res.status(500).json({ error: errData?.error?.message || 'Failed to send email' });
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}
