// bootToolkit / ensureGrant / readModel / proposeInsight — the app's whole
// surface onto the AI for Accessibility Toolkit (docs/PLAN.md §3.1).
//
// The toolkit is consumed AS-IS from the linked sibling checkout of
// github.com/AI-for-Accessibility-Collective/AI-for-Accessibility-Toolkit:
// public API only, and only through this file. The node file store
// (`fileKV`) is the package's own, from its `platforms/node/kv.js` subpath.

import { createToolkit, type ConsentPort, type Librarian, type Datastore, type AbilityModel, type Proposal } from '@ai4a11y/toolkit';
import { fileKV } from '@ai4a11y/toolkit/platforms/node/kv.js';

export { fileKV };

export const APP_ID = 'wearable-extension';
export const APP_LABEL = 'Appliance Guide';

// ALL scopes the render + prompt block read. Without reading.level/language
// the exported model silently lacks readingLevel/language and video 2's
// dimension vanishes (independent-review fix #2).
export const APP_SCOPES = ['ability.categories', 'settings.text', 'reading.level', 'language'];

export interface GuideToolkit {
  librarian: Librarian;
  datastore: Datastore;
  consent: ConsentPort;
}

export async function bootToolkit(opts: {
  dataDir: string; // APP_DATA_DIR — NEVER the onboarding service's DATA_DIR (single-writer stores)
  consent?: ConsentPort; // consent-audio.ts's port; defaults to a silent no-op
  actingUser?: string; // whose partition the glasses read (default 'margaret')
  // Rehearsal only: passes the toolkit's demo port, which lifts the
  // 3-proposals-per-week cap so consent loops can run all afternoon. NEVER
  // for the filmed take — reset-take.mjs is the retake button there.
  rehearsal?: boolean;
}): Promise<GuideToolkit> {
  const consent: ConsentPort = opts.consent ?? { notifyPending() {} };
  const { librarian, datastore } = createToolkit({
    kv: fileKV(opts.dataDir),
    clock: { now: () => Date.now() },
    consent,
    ...(opts.rehearsal ? { demo: { isOn: () => true, trace: () => {} } } : {}),
  });
  await datastore.runMigrations();
  await librarian.setActingUser(opts.actingUser ?? 'margaret');
  return { librarian, datastore, consent };
}

// The consent beat (docs/DESIGN.md §4, 1:03–1:15): ask for the grant, present
// it in the host's accessible modality (spoken + panel card), capture the
// answer, respond. Everything through the toolkit's own proposal machinery —
// nothing is ever minted silently.
export async function hasGrant(tk: GuideToolkit): Promise<boolean> {
  const grants = await tk.librarian.listGrants();
  return grants.some((g) => g.appId === APP_ID && APP_SCOPES.every((s) => g.scopes.includes(s)));
}

export async function isPending(tk: GuideToolkit, proposalId: string): Promise<boolean> {
  return (await tk.librarian.listProposals('pending')).some((p) => p.id === proposalId);
}

export async function ensureGrant(tk: GuideToolkit): Promise<'granted' | 'declined' | 'pending'> {
  if (await hasGrant(tk)) return 'granted';

  const req = await tk.librarian.requestGrant(APP_ID, APP_SCOPES, {
    appLabel: APP_LABEL,
    rationale:
      'Appliance Guide would like to read your accessibility profile — your needs, speech, and reading level — so its guidance fits how you like to be spoken to.',
  });
  if (!req.ok) {
    if (req.reason === 'already-granted') return 'granted';
    // suppressed / cooldown / weekly cap: the consent machinery said "not
    // now". Surface it honestly rather than retrying — reset-take.mjs is how
    // a take gets a fresh store (PLAN §3.7).
    return 'declined';
  }

  const proposals = await tk.librarian.listProposals('pending');
  const proposal = proposals.find((p) => p.id === req.proposalId);
  if (!proposal) return 'declined';

  if (!tk.consent.present || !tk.consent.capture) return 'pending'; // headless host: leave it pending
  await tk.consent.present({ type: 'grant-request', proposal });
  // The wearer may answer WHILE the question is still being spoken — a panel
  // tap, or a "yes" that lands before capture starts listening — and that path
  // resolves the proposal directly. Listening anyway would swallow their next
  // real sentence as a non-answer; reporting 'pending' would make the caller
  // discard a grant that was just minted.
  if (!(await isPending(tk, proposal.id))) return (await hasGrant(tk)) ? 'granted' : 'declined';
  const answer = await tk.consent.capture(proposal.id);
  if (answer != null && (await isPending(tk, proposal.id))) {
    await tk.librarian.respondToProposal(proposal.id, answer);
  }
  // Read "still pending" BEFORE the grant: the toolkit's accept writes the
  // grant first and closes the proposal second, so this order can never see
  // a concurrent accept as "closed but no grant" and misreport it as declined.
  const stillPending = await isPending(tk, proposal.id);
  if (await hasGrant(tk)) return 'granted';
  return stillPending ? 'pending' : 'declined';
}

// The granted AbilityModel slice, or null when there is no grant — the caller
// falls back to defaults (which IS baseline behavior).
export async function readModel(tk: GuideToolkit): Promise<AbilityModel | null> {
  const res = await tk.librarian.exportAbilityModel(APP_ID);
  return res.ok && res.abilityModel ? res.abilityModel : null;
}

// The learning loop's write half (docs/DESIGN.md §7.3): the app noticed
// something (two repeats of the same step) and CONTRIBUTES it as a consent
// proposal — never a silent write. Returns the pending proposal so the host
// can present it, or null when the machinery declined to draft (dedup,
// cooldown, weekly cap, no grant).
export async function proposeInsight(
  tk: GuideToolkit,
  kind: string,
  change: { op: 'profile-set'; path: string; value: unknown },
  rationale: string,
  label?: string,
): Promise<Proposal | null> {
  const res = await tk.librarian.importInsight(APP_ID, {
    kind,
    confidence: 0.7,
    label,
    rationale,
    change,
  });
  if (!res.ok || !res.proposalId) return null;
  const pending = await tk.librarian.listProposals('pending');
  return pending.find((p) => p.id === res.proposalId) ?? null;
}
