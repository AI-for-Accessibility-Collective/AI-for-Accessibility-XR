// Ambient types for the linked @ai4a11y/toolkit package. The package ships
// generated declarations (toolkit/types/), but they export none of the named
// types this app reads (AbilityModel, Need, Proposal, Librarian, Datastore,
// ConsentPort…), so this file types the slice of the public API the app
// calls — shapes transcribed from toolkit/core/ability.js,
// toolkit/core/librarian.js, toolkit/sync/grants.js and toolkit/sync/blob.js
// at commit a71b34a of AI-for-Accessibility-Collective/AI-for-Accessibility-
// Toolkit, and exercised against the real package by the unit tests. The
// toolkit itself is never modified from here (docs/PLAN.md ground rule 2).

declare module '@ai4a11y/toolkit' {
  export interface Need {
    dimension: string;
    value: unknown;
    strength: 'floor' | 'preference' | 'hint';
    unit?: string;
    confidence?: number;
    source?: string;
  }

  // getAbilityModel() returns the full view; exportAbilityModel() returns the
  // scope-filtered projection, so every field is optional here.
  export interface AbilityModel {
    schemaVersion?: number;
    supportAreas?: string[];
    freeText?: string;
    language?: string;
    readingLevel?: string | number | null;
    confidence?: number | null;
    needs?: Need[];
  }

  export interface Proposal {
    id: string;
    status: 'pending' | 'accepted' | 'declined' | 'suppressed';
    aspect: string;
    aspectLabel: string;
    rationale: string;
    change?: { op: string; [k: string]: unknown };
  }

  export interface Grant {
    id: string | null;
    appId: string;
    appLabel?: string;
    scopes: string[];
  }

  export interface ProfileBlob {
    kind: 'aa-profile-blob';
    v: number;
    exportedAt: number;
    abilityModel: AbilityModel | null;
    profile: {
      supportAreas: string[];
      freeText: string;
      fields: { needs?: Need[]; readingLevel?: unknown; confidence?: unknown };
      metaPreferences: { language: string };
      updatedAt: number | null;
    };
  }

  export interface Librarian {
    getAbilityModel(): Promise<Required<Pick<AbilityModel, 'supportAreas' | 'freeText' | 'language' | 'needs'>> & AbilityModel>;
    setProfileField(path: string, value: unknown): Promise<unknown>;
    requestGrant(
      appId: string,
      scopes: string[],
      opts?: { appLabel?: string; rationale?: string },
    ): Promise<{ ok: boolean; proposalId?: string; reason?: string }>;
    listGrants(): Promise<Grant[]>;
    revokeGrant(appId: string): Promise<unknown>;
    exportAbilityModel(appId: string): Promise<{ ok: boolean; abilityModel?: AbilityModel; reason?: string }>;
    importInsight(
      sourceAppId: string,
      insight: {
        kind: string;
        confidence?: number;
        label?: string;
        rationale?: string;
        change: { op: 'profile-set'; path: string; value: unknown } | { op: 'add-memory'; record: object };
      },
    ): Promise<{ ok: boolean; proposalId?: string; reason?: string }>;
    listProposals(status?: string): Promise<Proposal[]>;
    respondToProposal(id: string, response: 'accept' | 'declineOnce' | 'suppress'): Promise<{ ok: boolean; reason?: string }>;
    exportProfileBlob(): Promise<ProfileBlob>;
    importProfileBlob(blob: ProfileBlob): Promise<{ ok: boolean; merged?: boolean; reason?: string }>;
    setActingUser(id: string, opts?: object): Promise<unknown>;
    getActingUser(): { id: string };
    setGeminiCaller(fn: (prompt: string) => Promise<string>): void;
    [k: string]: unknown;
  }

  export interface Datastore {
    runMigrations(): Promise<void>;
    [k: string]: unknown;
  }

  export interface KVStore {
    get(area: string, key: string): Promise<unknown>;
    set(area: string, key: string, value: unknown): Promise<void>;
    getAll(area: string): Promise<Record<string, unknown>>;
  }

  export interface ConsentPort {
    notifyPending(count: number): void | Promise<void>;
    present?(item: { type: 'proposal' | 'grant-request' | 'cross-app-insight'; proposal: Proposal }): Promise<void>;
    capture?(proposalId: string): Promise<'accept' | 'declineOnce' | 'suppress' | null>;
  }

  export function createToolkit(ports: {
    kv: KVStore;
    clock?: { now(): number };
    scheduler?: { every(id: string, periodMinutes: number, handler: () => void): void; debounce(id: string, delayMs: number, handler: () => void): void };
    consent?: ConsentPort;
    demo?: { isOn(): boolean; trace(diagram: string, region: string, label: string): void };
    taxonomy?: object;
    toolsRegistry?: object | null;
    builtinSkills?: unknown[];
  }): { datastore: Datastore; librarian: Librarian };

  export function normalizeNeed(n: unknown): Need | null;
  export function toAbilityModel(profile: unknown): AbilityModel;
  export function validateProfileBlob(blob: unknown): boolean;
  export function buildProfileBlob(profile: unknown, abilityModel: unknown, now: number): ProfileBlob;
  export const GRANT_SCOPES: string[];
  export const BLOB_KIND: string;
  export const BLOB_VERSION: number;
  export const noopScheduler: { every(): void; debounce(): void };
  export const noopConsent: ConsentPort;
  export default createToolkit;
}
