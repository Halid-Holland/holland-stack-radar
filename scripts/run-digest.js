import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LAST_RUN_PATH = join(__dirname, '..', 'last-run.json');
const AUTOMATIONS_PATH = join(__dirname, '..', 'automations.json');
const VENDORS_PATH = join(__dirname, '..', 'vendors.json');
const IS_SCHEDULED_RUN = process.env.GITHUB_EVENT_NAME === 'schedule';

const RUN_MODE = process.env.RUN_MODE || 'mock'; // mock | test | production

// Caps on how many AI analyses / automations run at once. Concurrency instead
// of dead-sequential processing is what keeps one job from ballooning in
// runtime as automations/vendors pile up (see isDue's catch-up design) — but
// still capped so a big pileup doesn't blow through AI/Graph rate limits.
const VENDOR_CONCURRENCY = 4;
const AUTOMATION_CONCURRENCY = 3;

const ENTRA_CLIENT_ID     = process.env.ENTRA_CLIENT_ID;
const ENTRA_TENANT_ID     = process.env.ENTRA_TENANT_ID;
const ENTRA_CLIENT_SECRET = process.env.ENTRA_CLIENT_SECRET;
const MAIL_FROM           = process.env.MAIL_FROM;
const MAIL_TO             = process.env.MAIL_TO;

const VALID_TAGS = [
  'security','automation','compliance','billing','IT-admin',
  'upgrade-required','new-feature','deprecation','performance',
  'integration','HOS','AI',
];

// Static company context so the AI can judge relevance concretely instead of
// reasoning about a generic "Holland 1916" name it has no grounding for.
const HOLLAND_CONTEXT = `Holland 1916 is a manufacturing holding company (North Kansas City, MO) with three operating companies:
- Holland Nameplate Products (HNP): industrial nameplates, labels, control panels, enclosures
- Holland Interface Solutions (HIS): membrane switches, touchscreens, keypads, graphic overlays
- Holland RFID (HRFID): ruggedized RFID tags/readers for harsh environments (oil & gas, mining, rigging)

The Holland Operating System (HOS) is their custom Salesforce-based platform (built with Apex, Flows, and Skuid) that runs the full order lifecycle — sales quoting, order entry, manufacturing execution, and shipping — in one system. Because HOS is built directly on Salesforce, any Salesforce platform change (API deprecations, Flow/Apex limits, UI changes) can directly affect HOS and deserves extra scrutiny.

Tech stack includes Salesforce, Microsoft 365, Atlassian, Cloudflare, and AccountingSeed. They operate ISO 9001 / ISO 13485 quality environments.`;

// Placeholder for future recipient-group interest profiles (e.g. "IT Team cares
// about security/integrations", "Finance cares about billing/compliance").
// Returns '' today since recipient groups aren't built yet - this function exists
// so wiring that in later is a one-line change inside here, not a prompt redesign.
function buildGroupContextBlock(vendor) {
  return '';
}

// ─── Mock data ───────────────────────────────────────────────────────────────
// `sources` here are stale/illustrative placeholder links (not live-fetched),
// matching the stale placeholder summary text — same idea, just for the link too.

const MOCK_RESULTS = {
  default: {
    summary: 'A recent platform update introduced stability and performance improvements. Holland 1916 IT should review release notes to confirm compatibility with current integrations.',
    tags: ['IT-admin', 'new-feature'],
    relevance_score: 6,
    action_needed: false,
    sources: [],
  },
  salesforce: {
    summary: "Salesforce Spring '25 adds parallel stage execution to Flow Orchestration and raises the Apex CPU limit for async processes by 50%. These changes directly improve HOS workflow reliability and open broader automation options.",
    tags: ['automation', 'HOS', 'new-feature'],
    relevance_score: 9,
    action_needed: false,
    sources: ['https://help.salesforce.com/s/articleView?id=release-notes.salesforce_release_notes.htm'],
  },
  microsoft365: {
    summary: 'Microsoft is removing Basic Authentication from Exchange Online on September 1, 2026 — any integrations still using basic auth will stop working. IT must audit and migrate affected connectors before the deadline.',
    tags: ['security', 'IT-admin', 'upgrade-required'],
    relevance_score: 10,
    action_needed: true,
    sources: ['https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-basic-authentication-exchange-online'],
  },
  atlassian: {
    summary: 'Atlassian released Jira Product Discovery updates and improved Confluence AI search. No breaking changes — standard update cadence.',
    tags: ['new-feature', 'AI'],
    relevance_score: 5,
    action_needed: false,
    sources: ['https://www.atlassian.com/software/jira/product-discovery/release-notes'],
  },
  cloudflare: {
    summary: "Cloudflare expanded its AI Gateway and rolled out new DDoS mitigation rules. Holland 1916's DNS and web properties continue to be protected with no action required.",
    tags: ['security', 'performance'],
    relevance_score: 6,
    action_needed: false,
    sources: ['https://blog.cloudflare.com/'],
  },
  anthropic: {
    summary: 'Anthropic released Claude 4 with significantly improved reasoning and tool-use capabilities. Relevant to any Holland 1916 AI automation initiatives currently using Claude.',
    tags: ['AI', 'new-feature'],
    relevance_score: 7,
    action_needed: false,
    sources: ['https://www.anthropic.com/news'],
  },
  github: {
    summary: 'GitHub Copilot now supports multi-file edits and added new security scanning features to Actions. Holland 1916 repos will benefit from improved automated vulnerability detection.',
    tags: ['security', 'automation', 'new-feature'],
    relevance_score: 7,
    action_needed: false,
    sources: ['https://github.blog/changelog/'],
  },
};

// ─── Timeframe ───────────────────────────────────────────────────────────────

function getTimeframe() {
  if (RUN_MODE !== 'production' || !existsSync(LAST_RUN_PATH)) {
    return '30 days';
  }
  const { lastRun } = JSON.parse(readFileSync(LAST_RUN_PATH, 'utf8'));
  const days = Math.max(1, Math.round((Date.now() - new Date(lastRun).getTime()) / 86400000));
  return `${days} day${days > 1 ? 's' : ''}`;
}

function recordRun() {
  writeFileSync(LAST_RUN_PATH, JSON.stringify({ lastRun: new Date().toISOString() }, null, 2));
}

// ─── Automation scheduling ─────────────────────────────────────────────────────

const CT_ZONE = 'America/Chicago';

function ctParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CT_ZONE, hour12: false, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(date);
  const get = type => parts.find(p => p.type === type).value;
  return {
    year: Number(get('year')), month: Number(get('month')), day: Number(get('day')),
    hour: Number(get('hour')) % 24, minute: Number(get('minute')), weekday: get('weekday'),
  };
}

function bucketOf(hour, minute) {
  return hour * 4 + Math.floor(minute / 15);
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

// isDue is intentionally a "has the target time passed today (and not yet sent)"
// check rather than an exact 15-minute-bucket match. GitHub Actions can silently
// delay or skip ticks on schedules more frequent than hourly (documented behavior
// under load), so requiring an exact window match means a single skipped tick
// causes a missed send for the whole day. This version catches up on whichever
// tick runs next, as long as it's still the same qualifying day.
function isDue(automation, now) {
  if (automation.paused) return false;

  const cur = ctParts(now);
  const [tH, tM] = (automation.time || '09:00').split(':').map(Number);
  const curMinutes = cur.hour * 60 + cur.minute;
  const targetMinutes = tH * 60 + tM;
  if (curMinutes < targetMinutes) return false; // target time hasn't happened yet today

  const created = new Date(automation.createdAt);
  if (isNaN(created.getTime())) return false;
  const anchorWeekday = created.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
  const anchorDay = created.getUTCDate();
  const anchorMonth = created.getUTCMonth() + 1;

  const effectiveAnchorDay = Math.min(anchorDay, daysInMonth(cur.year, anchorMonth));

  switch (automation.schedule) {
    case 'Daily':
      return true;
    case 'Weekly':
      return cur.weekday === anchorWeekday;
    case 'Monthly':
      return cur.day === Math.min(anchorDay, daysInMonth(cur.year, cur.month));
    case 'Quarterly': {
      const monthsSinceAnchor = (cur.month - anchorMonth + 12) % 12;
      return monthsSinceAnchor % 3 === 0 && cur.day === effectiveAnchorDay;
    }
    default:
      return false;
  }
}

function alreadySentToday(automation, now) {
  if (!automation.lastSent) return false;
  const last = ctParts(new Date(automation.lastSent));
  const cur = ctParts(now);
  return last.year === cur.year && last.month === cur.month && last.day === cur.day;
}

// ─── AI analysis ─────────────────────────────────────────────────────────────

async function analyzeVendorMock(vendorId) {
  return MOCK_RESULTS[vendorId] || MOCK_RESULTS.default;
}

function buildPrompt(vendor, timeframe) {
  const recipientGroup = vendor.recipientGroup || '';
  const audience = recipientGroup ? `the ${recipientGroup} at Holland 1916` : 'Holland 1916';
  const focus = (vendor.focus || '').trim();

  const focusBlock = focus
    ? `\nThe user has specifically asked you to prioritize this angle if relevant: "${focus}"\nIf there is a real, recent update matching that focus, lead the summary with it and score relevance based on how much it matters to Holland 1916.\nIf there is no recent news matching that focus, say so explicitly at the start of the summary (e.g. "No recent news on ${focus}.") and then report the single most important general ${vendor.name} update instead.\n`
    : '';

  const groupContextBlock = buildGroupContextBlock(vendor);

  return `${HOLLAND_CONTEXT}
${groupContextBlock}
Search for the most important ${vendor.name} update in the last ${timeframe} relevant to ${audience}. Base this strictly on what you find via web search right now, not on general prior knowledge about this vendor, which may be outdated. If no significant update occurred in this timeframe, say so plainly (e.g. "No significant ${vendor.name} updates in the last ${timeframe}.") rather than stretching a minor or unrelated item to fill the summary.
${focusBlock}
Reply with ONLY this JSON, no extra text:
{"summary":"One sentence: what changed. One sentence: why it matters to ${recipientGroup || 'Holland 1916'}.","tags":["tag1"],"relevance_score":7,"action_needed":false,"sources":["https://..."]}

tags: pick 1-2 from: ${VALID_TAGS.join(', ')}
relevance_score: 1-10${focus ? ' — if a focus was specified and matched, weight relevance according to how important that specific angle is to Holland 1916' : ''}
action_needed: default to false. Only set true if the source states a specific, concrete deadline or breaking change - not general urgency, hype, or marketing language.
sources: 1-3 URLs of the actual pages you used via web search to find this update. Only include URLs you are confident are real — never fabricate one. If you have no real source URL, return an empty array.
If you are not fully confident a detail is accurate, hedge it explicitly (e.g. "reportedly," "appears to") rather than stating it as settled fact.`;
}

async function analyzeVendorAI(vendor, timeframe) {
  // Swap this import at the top once the API key is confirmed working
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  const prompt = buildPrompt(vendor, timeframe);

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
    sources: Array.isArray(parsed.sources)
      ? parsed.sources.filter(u => typeof u === 'string' && /^https?:\/\//i.test(u)).slice(0, 3)
      : [],
  };
}

async function analyzeVendor(vendor, timeframe) {
  // 'automations' is the manual test lever for the due-automation path (see main()) -
  // mock it too so testing scheduling logic doesn't depend on a working AI key.
  if (RUN_MODE === 'mock' || RUN_MODE === 'automations') return analyzeVendorMock(vendor.id);
  return analyzeVendorAI(vendor, timeframe);
}

// ─── Email HTML formatter ─────────────────────────────────────────────────────

function scoreColor(score) {
  if (score >= 8) return '#EF4444';
  if (score >= 5) return '#F97316';
  return '#10B981';
}

function buildEmailHTML(results, mode) {
  const date = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  const actionCount = results.filter(r => r.result.action_needed).length;
  const modeLabel = mode !== 'production' ? ` [${mode.toUpperCase()}]` : '';
  const subject = `Holland Newsletter Automator: Weekly Digest${modeLabel} — ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}` +
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

    const sources = Array.isArray(result.sources) ? result.sources : [];
    const sourceLinks = sources.length
      ? `<div style="margin-top:8px;">${sources.map((url, i) =>
          `<a href="${url.replace(/"/g, '&quot;')}" style="font-size:11px;color:#0070BA;text-decoration:none;margin-right:12px;">Source${sources.length > 1 ? ` ${i + 1}` : ''} &rarr;</a>`
        ).join('')}</div>`
      : '';

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
      ${sourceLinks}
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

// ─── Microsoft Graph email sender ─────────────────────────────────────────────

async function sendEmail(subject, html, recipients) {
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
          toRecipients: recipients.map(address => ({ emailAddress: { address } })),
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

// ─── Shared vendor-analysis loop ──────────────────────────────────────────────

function placeholderResult(vendor) {
  return {
    summary: `AI analysis is temporarily unavailable for ${vendor.name}. This is stale placeholder text — no real update information is being shown right now.`,
    tags: ['IT-admin'],
    relevance_score: 1,
    action_needed: false,
    placeholder: true,
    sources: [],
  };
}

// Runs `items` through `fn` with at most `limit` in flight at once, preserving
// output order. This is what lets several vendors/automations be analyzed at
// the same time instead of one at a time, capped so we don't blow through
// AI/Graph rate limits when a lot of work piles up in a single tick.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function analyzeVendors(vendors, timeframe, label = '') {
  const prefix = label ? `[${label}] ` : '';
  return mapWithConcurrency(vendors, VENDOR_CONCURRENCY, async vendor => {
    try {
      console.log(`  ${prefix}Analyzing ${vendor.name}...`);
      const result = await analyzeVendor(vendor, timeframe);
      console.log(`  ${prefix}✓ ${vendor.name} — score ${result.relevance_score}`);
      return { vendor, result };
    } catch (err) {
      console.error(`  ${prefix}✗ ${vendor.name} failed: ${err.message} — using placeholder text instead`);
      return { vendor, result: placeholderResult(vendor) };
    }
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function runGlobalDigest() {
  console.log(`RUN_MODE: ${RUN_MODE}`);

  const allVendors = JSON.parse(readFileSync(VENDORS_PATH, 'utf8'));
  let vendors = allVendors.filter(v => v.active);

  if (RUN_MODE === 'test') {
    vendors = vendors.slice(0, 1);
    console.log('Test mode: limiting to 1 vendor');
  }

  const timeframe = getTimeframe();
  console.log(`Timeframe: last ${timeframe}`);
  console.log(`Running digest for ${vendors.length} vendor(s)...`);

  const results = await analyzeVendors(vendors, timeframe);

  if (results.length === 0) {
    console.error('No results — aborting, no email sent.');
    process.exit(1);
  }

  const { html, subject } = buildEmailHTML(results, RUN_MODE);
  console.log(`\nSending digest to ${MAIL_TO}...`);
  await sendEmail(subject, html, [MAIL_TO]);
  console.log('Done. Digest sent.');

  if (RUN_MODE === 'production') recordRun();
}

async function runDueAutomations() {
  const now = new Date();
  const allVendors = JSON.parse(readFileSync(VENDORS_PATH, 'utf8'));
  const automations = JSON.parse(readFileSync(AUTOMATIONS_PATH, 'utf8'));

  const due = automations.filter(a => isDue(a, now) && !alreadySentToday(a, now));

  if (due.length === 0) {
    console.log('No automations due right now.');
    return;
  }

  console.log(`${due.length} automation(s) due.`);

  // Union of every vendor any due automation needs. A vendor object is the
  // same regardless of which automation references it (focus/recipientGroup
  // live on the vendor, not the automation), so if several automations share
  // a vendor (e.g. everyone tracks Salesforce), analyze it once per run
  // instead of once per automation.
  const neededVendorIds = new Set();
  for (const automation of due) {
    for (const id of automation.tools) neededVendorIds.add(id);
  }
  const neededVendors = allVendors.filter(v => neededVendorIds.has(v.id));

  console.log(`Analyzing ${neededVendors.length} unique vendor(s) across ${due.length} automation(s)...`);
  const sharedResults = await analyzeVendors(neededVendors, '30 days');
  const resultByVendorId = new Map(sharedResults.map(r => [r.vendor.id, r]));

  // Each automation is wrapped in its own try/catch so one failure (bad Graph
  // token, no vendors configured, etc.) can't kill the whole batch and skip
  // writing back the automations that succeeded alongside it. lastStatus/
  // lastError give the UI something concrete to show instead of a send just
  // silently not happening with no visible reason.
  const changedFlags = await mapWithConcurrency(due, AUTOMATION_CONCURRENCY, async automation => {
    console.log(`\n[${automation.name}] Running (${automation.schedule} @ ${automation.time})...`);
    try {
      const results = automation.tools.map(id => resultByVendorId.get(id)).filter(Boolean);

      if (results.length === 0) {
        console.log(`  [${automation.name}] No vendors configured, skipping.`);
        automation.lastStatus = 'failed';
        automation.lastError = 'No vendors configured for this automation.';
        return true;
      }

      const recipients = automation.recipients && automation.recipients.length > 0
        ? automation.recipients
        : [MAIL_TO];

      const { html, subject } = buildEmailHTML(results, 'production');
      await sendEmail(subject, html, recipients);
      console.log(`  [${automation.name}] Sent to ${recipients.join(', ')}`);

      automation.lastSent = now.toISOString();
      automation.lastStatus = 'success';
      automation.lastError = null;
      return true;
    } catch (err) {
      console.error(`  [${automation.name}] Failed: ${err.message}`);
      automation.lastStatus = 'failed';
      automation.lastError = err.message;
      return true;
    }
  });

  if (changedFlags.some(Boolean)) {
    writeFileSync(AUTOMATIONS_PATH, JSON.stringify(automations, null, 2));
    console.log('\nUpdated automations.json with lastSent timestamps.');
  }
}

async function main() {
  if (IS_SCHEDULED_RUN || RUN_MODE === 'automations') {
    await runDueAutomations();
  } else {
    await runGlobalDigest();
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
