// Ambient types for the linked @ai4a11y/toolkit package. The package ships
// generated declarations (toolkit/types/), but they export none of the named
// types this app reads (AbilityModel, Need, Librarian, Datastore…), so this
// file types the slice of the public API the app calls — shapes transcribed
// from toolkit/core/ability.js, toolkit/core/librarian.js and
// toolkit/sync/blob.js at commit a71b34a of
// AI-for-Accessibility-Collective/AI-for-Accessibility-Toolkit, and exercised
// against the real package by the unit tests. The toolkit itself is never
// modified from here (docs/PLAN.md ground rule 2).

declare module '@ai4a11y/toolkit' {
  export interface Need {
    dimension: string;
    value: unknown;
    strength: 'floor' | 'preference' | 'hint';
    unit?: string;
    confidence?: number;
    source?: string;
  }

  // getAbilityModel() returns the full view; the app passes on only the
  // structured fields (src/toolkit/host.ts), so every field is optional here.
  export interface AbilityModel {
    schemaVersion?: number;
    supportAreas?: string[];
    freeText?: string;
    language?: string;
    readingLevel?: string | number | null;
    confidence?: number | null;
    needs?: Need[];
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
    // The stored profile record (toolkit/core/ability.js ProfileRecord); the
    // app reads only its last-write stamp.
    getProfile(): Promise<{ updatedAt?: number | null; [k: string]: unknown }>;
    setProfileField(path: string, value: unknown): Promise<unknown>;
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

  export function createToolkit(ports: {
    kv: KVStore;
    clock?: { now(): number };
    scheduler?: { every(id: string, periodMinutes: number, handler: () => void): void; debounce(id: string, delayMs: number, handler: () => void): void };
    taxonomy?: object;
    toolsRegistry?: object | null;
    builtinSkills?: unknown[];
  }): { datastore: Datastore; librarian: Librarian };

  export function normalizeNeed(n: unknown): Need | null;
  export function toAbilityModel(profile: unknown): AbilityModel;
  export function validateProfileBlob(blob: unknown): boolean;
  export function buildProfileBlob(profile: unknown, abilityModel: unknown, now: number): ProfileBlob;
  export const BLOB_KIND: string;
  export const BLOB_VERSION: number;
  export const noopScheduler: { every(): void; debounce(): void };
  export default createToolkit;
}
