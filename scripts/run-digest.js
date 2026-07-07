import { GoogleGenAI } from '@google/genai';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const GEMINI_API_KEY   = process.env.GEMINI_API_KEY;
const ANTHROPIC_KEY    = process.env.ANTHROPIC_API_KEY; // swap later
const ENTRA_CLIENT_ID  = process.env.ENTRA_CLIENT_ID;
const ENTRA_TENANT_ID  = process.env.ENTRA_TENANT_ID;
const ENTRA_CLIENT_SECRET = process.env.ENTRA_CLIENT_SECRET;
const MAIL_FROM        = process.env.MAIL_FROM;
const MAIL_TO          = process.env.MAIL_TO;

const VALID_TAGS = [
  'security','automation','compliance','billing','IT-admin',
  'upgrade-required','new-feature','deprecation','performance',
  'integration','HOS','AI',
];

// ─── AI analysis ────────────────────────────────────────────────────────────

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

async function analyzeVendor(vendorName) {
  const prompt = `Search for the single most important ${vendorName} update from the past 30 days relevant to a manufacturing company's IT team. Be brief.

Reply with ONLY this JSON, no extra text:
{"summary":"One sentence: what changed. One sentence: why it matters to IT.","tags":["tag1"],"relevance_score":7,"action_needed":false}

tags: pick 1-2 from: ${VALID_TAGS.join(', ')}
relevance_score: 1-10
action_needed: true only if action is required before a deadline`;

  const result = await ai.models.generateContent({
    model: 'gemini-2.0-flash',
    contents: prompt,
    tools: [{ googleSearch: {} }],
  });

  const text = result.response.text().trim();
  const jsonStr = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  const parsed = JSON.parse(jsonStr);

  return {
    summary: String(parsed.summary || ''),
    tags: Array.isArray(parsed.tags) ? parsed.tags.filter(t => VALID_TAGS.includes(t)) : [],
    relevance_score: Math.min(10, Math.max(1, Number(parsed.relevance_score) || 5)),
    action_needed: Boolean(parsed.action_needed),
  };
}

// ─── Email HTML formatter ────────────────────────────────────────────────────

function scoreColor(score) {
  if (score >= 8) return '#EF4444';
  if (score >= 5) return '#F97316';
  return '#10B981';
}

function buildEmailHTML(results) {
  const date = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  const actionCount = results.filter(r => r.result.action_needed).length;
  const subject = `Holland Newsletter Automator: Weekly Digest — ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}` +
    (actionCount > 0 ? ` (${actionCount} action${actionCount > 1 ? 's' : ''} needed)` : '');

  const tocRows = results.map((r, i) =>
    (i % 3 === 0 && i > 0 ? '</tr><tr>' : '') +
    `<td style="padding:3px 8px 3px 0;width:33%;"><span style="color:${r.vendor.color};font-size:13px;font-weight:600;">&#8226; ${r.vendor.name}</span></td>`
  ).join('');

  const cards = results.map(r => {
    const { vendor, result } = r;
    const tagPills = result.tags.map(tag =>
      `<span style="display:inline-block;background:#F3F4F6;color:#555;font-size:10px;font-weight:600;padding:2px 7px;border-radius:4px;margin:2px 3px 2px 0;text-transform:uppercase;letter-spacing:0.04em;">${tag}</span>`
    ).join('');

    return `
    <div style="border:1px solid ${result.action_needed ? '#FECACA' : '#E5E7EB'};border-radius:8px;padding:16px;margin-bottom:12px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:10px;">
        <tr>
          <td>
            <span style="background:${vendor.color};color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;text-transform:uppercase;">${vendor.name}</span>
            ${result.action_needed ? '<span style="background:#FEE2E2;color:#EF4444;font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;margin-left:6px;text-transform:uppercase;">ACTION REQUIRED</span>' : ''}
          </td>
          <td align="right">
            <span style="font-size:12px;font-weight:700;color:${scoreColor(result.relevance_score)};">&#9679; ${result.relevance_score}/10</span>
          </td>
        </tr>
      </table>
      <p style="margin:0 0 10px;font-size:13px;color:#333;line-height:1.55;">${result.summary}</p>
      <div>${tagPills}</div>
    </div>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#F9FAFB;font-family:Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:24px;">
    <div style="background:#E05020;border-radius:10px;padding:20px 24px;margin-bottom:20px;">
      <p style="margin:0;font-size:18px;color:#fff;font-weight:700;">Holland Newsletter Automator</p>
      <p style="margin:4px 0 0;color:rgba(255,255,255,0.75);font-size:12px;">Holland 1916 &middot; ${date}</p>
    </div>
    <div style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:8px;padding:16px 20px;margin-bottom:24px;">
      <p style="margin:0 0 12px;font-size:11px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:0.07em;">In This Issue</p>
      <table width="100%" cellpadding="0" cellspacing="0"><tr>${tocRows}</tr></table>
    </div>
    ${cards}
    <p style="text-align:center;margin-top:20px;color:#AAA;font-size:11px;">Holland 1916 IT &middot; Automated weekly digest</p>
  </div>
</body>
</html>`;

  return { html, subject };
}

// ─── Microsoft Graph email sender ────────────────────────────────────────────

async function sendEmail(subject, html) {
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

  const { access_token } = await tokenRes.json();
  if (!access_token) throw new Error('Failed to get Graph access token');

  const mailRes = await fetch(
    `https://graph.microsoft.com/v1.0/users/${MAIL_FROM}/sendMail`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: 'HTML', content: html },
          toRecipients: [{ emailAddress: { address: MAIL_TO } }],
        },
        saveToSentItems: false,
      }),
    }
  );

  if (mailRes.status !== 202) {
    const err = await mailRes.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Graph sendMail failed: ${mailRes.status}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const vendorsPath = join(__dirname, '..', 'vendors.json');
  const allVendors = JSON.parse(readFileSync(vendorsPath, 'utf8'));
  let vendors = allVendors.filter(v => v.active);
  if (process.env.TEST_MODE === 'true') {
    vendors = vendors.slice(0, 1);
    console.log('TEST_MODE: limiting to 1 vendor');
  }

  console.log(`Running digest for ${vendors.length} vendors...`);

  const results = [];

  for (const vendor of vendors) {
    try {
      console.log(`  Analyzing ${vendor.name}...`);
      const result = await analyzeVendor(vendor.name);
      results.push({ vendor, result });
      console.log(`  ✓ ${vendor.name} — score ${result.result?.relevance_score ?? result.relevance_score}`);
    } catch (err) {
      console.error(`  ✗ ${vendor.name} failed: ${err.message}`);
    }
  }

  if (results.length === 0) {
    console.error('No results — aborting, no email sent.');
    process.exit(1);
  }

  const { html, subject } = buildEmailHTML(results);
  console.log(`\nSending digest to ${MAIL_TO}...`);
  await sendEmail(subject, html);
  console.log('Done. Digest sent.');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
