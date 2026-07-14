import { randomUUID } from 'node:crypto';

const OWNER = 'Halid-Holland';
const REPO = 'holland-stack-radar';
const FILE = 'automations.json';

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

// ownerToken is a per-automation secret assigned at creation and handed back
// to the creating browser once (stored in localStorage there). It's the only
// thing that proves "this browser may edit/delete this automation" - there's
// no real user accounts, so never let the actual value leave the server in a
// GET response. hasOwner (a plain boolean) is still exposed so clients can
// tell "unclaimed legacy automation" apart from "owned by someone else"
// without learning the secret itself.
function redact(automations) {
  return automations.map(({ ownerToken, ...rest }) => ({ ...rest, hasOwner: !!ownerToken }));
}

export default async function handler(req, res) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN not configured' });

  if (req.method === 'GET') {
    try {
      const file = await getFile(token);
      const automations = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
      return res.status(200).json(redact(automations));
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const { automations: incoming, deletions } = req.body || {};
      if (!Array.isArray(incoming)) return res.status(400).json({ error: 'Expected automations array' });
      const deletionList = Array.isArray(deletions) ? deletions : [];

      const file = await getFile(token);
      const oldAutomations = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
      const oldById = new Map(oldAutomations.map(a => [a.id, a]));

      // Automations saved before this guard existed have no ownerToken - leave
      // them editable by anyone (no regression) until the first edit after this
      // change, at which point they get locked to whoever's browser made it.
      const canAct = (old, presentedToken) => !old.ownerToken || old.ownerToken === presentedToken;

      const deleteIds = new Set(
        deletionList
          .filter(d => oldById.has(d.id) && canAct(oldById.get(d.id), d.ownerToken))
          .map(d => d.id)
      );

      const incomingById = new Map(incoming.map(a => [a.id, a]));
      const finalList = [];
      const newTokens = {};

      for (const [id, old] of oldById) {
        if (deleteIds.has(id)) continue;
        const item = incomingById.get(id);
        if (!item) { finalList.push(old); continue; } // missing without an authorized deletion - keep it

        // Every save round-trips the whole list, so most items here are just
        // being echoed back unchanged (not an edit attempt). Only touch
        // ownership when a field actually differs - otherwise a save
        // triggered by an unrelated automation would silently "claim" every
        // legacy (pre-guard) automation for whoever happens to save first.
        const { ownerToken: _presented, ...itemFields } = item;
        const { ownerToken: _old, ...oldFields } = old;
        if (JSON.stringify(itemFields) === JSON.stringify(oldFields)) { finalList.push(old); continue; }

        if (canAct(old, item.ownerToken)) {
          const ownerToken = old.ownerToken || randomUUID();
          if (!old.ownerToken) newTokens[id] = ownerToken; // first claim of a legacy automation
          finalList.push({ ...item, ownerToken });
        } else {
          finalList.push(old); // wrong/missing token - ignore the attempted edit
        }
      }
      for (const item of incoming) {
        if (!oldById.has(item.id)) {
          const ownerToken = randomUUID();
          finalList.push({ ...item, ownerToken });
          newTokens[item.id] = ownerToken;
        }
      }

      const content = Buffer.from(JSON.stringify(finalList, null, 2)).toString('base64');

      const putRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: 'Update automations',
          content,
          sha: file.sha,
        }),
      });

      if (!putRes.ok) {
        const err = await putRes.json();
        return res.status(500).json({ error: err.message });
      }

      return res.status(200).json({ success: true, newTokens });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
