export interface Env {
 DB: D1Database; ASSETS?: Fetcher; BOT_TOKEN?: string; WEBHOOK_SECRET?: string;
 OWNER_IDS: string; DEMO_USER_IDS: string; APP_MODE: string; BOT_USERNAME: string; MINI_APP_URL?: string;
}
export interface Identity { id: number; owner: boolean; barberId: string | null; language: 'hy'|'ru' }
export type AppEnv = { Bindings: Env; Variables: { identity: Identity } };
export type Row = Record<string, any>;
