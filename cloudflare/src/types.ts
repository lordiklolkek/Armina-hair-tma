export interface Env {
 DB: D1Database; ASSETS?: Fetcher; BOT_TOKEN?: string; WEBHOOK_SECRET?: string;
 OWNER_IDS?: string; DEMO_USER_IDS?: string; APP_MODE: string; BOT_USERNAME?: string; MINI_APP_URL?: string;
 ADMIN_IDS?: string; APP_URL?: string; CONTACT_VERIFICATION_ENABLED?: string; TELEGRAM_LINKS_ENABLED?: string;
 LEGACY_WEBHOOK_SECRET?: string; LEGACY_CALLBACK_FORWARDING_ENABLED?: string;
}
export interface Identity { id: number; owner: boolean; barberId: string | null; language: 'hy'|'ru' }
export type AppEnv = { Bindings: Env; Variables: { identity: Identity } };
export type Row = Record<string, any>;
