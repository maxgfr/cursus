/** Providers whose models.dev entry has `api: null` but which we still call directly. */
export const BASE_URLS: Readonly<Record<string, string>> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  mistral: 'https://api.mistral.ai/v1',
  groq: 'https://api.groq.com/openai/v1',
  xai: 'https://api.x.ai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
}

export function baseUrlFor(providerId: string): string | null {
  return BASE_URLS[providerId] ?? null
}
