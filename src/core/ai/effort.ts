import { type CatalogModel, modelKey } from './catalogTrim'

/** How much a reasoning model thinks before it answers, in the AI SDK's own scale; unset, the model's default. */
export type AiEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Every level, weakest first: the order the settings list them in. */
export const EFFORTS: readonly AiEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

const LMH: readonly AiEffort[] = ['low', 'medium', 'high']
const LMHX: readonly AiEffort[] = ['low', 'medium', 'high', 'xhigh']
const LMHXM: readonly AiEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * What each maker's API accepts, by model id with `.` folded to `-` and any date suffix dropped; first match wins.
 * From the makers' docs: Anthropic's `effort` (a thinking budget before Claude 4.6, which the SDK derives from the
 * level), OpenAI's `reasoning.effort`, Gemini's `thinkingLevel` (a thinking budget on 2.5). A model not listed here
 * gets no effort: guessing would risk a request the API refuses.
 */
const LEVELS: Readonly<Record<string, readonly [RegExp, readonly AiEffort[]][]>> = {
  anthropic: [
    [/^claude-(fable|mythos)-5(-1)?$|^claude-mythos-preview$|^claude-(opus|sonnet)-5(-5)?$|^claude-haiku-5-5$/, LMHXM],
    [/^claude-opus-4-[78]$/, LMHXM],
    [/^claude-(opus|sonnet)-4-6$/, ['low', 'medium', 'high', 'max']],
    [/^claude-(opus|sonnet|haiku)-4-5$|^claude-opus-4-1$|^claude-(opus|sonnet)-4$/, LMH],
  ],
  openai: [
    [/^gpt-6-(sol|luna)$|^gpt-5-6(-(sol|luna|terra))?$/, ['none', ...LMHXM]],
    [/^gpt-6(-\d+)?-(sol|luna|astra)$/, LMHXM],
    [/^gpt-5-[2-5]-pro$/, ['medium', 'high', 'xhigh']],
    [/^gpt-5-[2-5](-mini|-nano)?$/, ['none', ...LMHX]],
    [/^gpt-5-[2-9]-codex$|^gpt-5-1-codex-max$/, LMHX],
    [/^gpt-5(-1)?-codex(-mini)?$/, LMH],
    [/^gpt-5-1$/, ['none', ...LMH]],
    [/^gpt-5(-mini|-nano)?$/, ['minimal', ...LMH]],
    [/^(o1|o3|o3-mini|o3-pro|o4-mini)$/, LMH],
  ],
  google: [
    [/^gemini-4-argon$/, LMH],
    [/^gemini-3-pro(-preview)?$/, ['low', 'high']],
    [/^gemini-3-1-pro(-preview)?(-customtools)?$/, LMH],
    [/^gemini-3-[7-9]-flash(-preview)?$/, LMH],
    [/^gemini-3(-[1-6])?-flash(-lite)?(-preview)?$/, ['minimal', ...LMH]],
    [/^gemini-2-5-(pro|flash|flash-lite)$/, LMH],
  ],
}

/** OpenRouter's `reasoning.effort` takes these and maps them onto each maker's own parameter. */
const OPENROUTER: ReadonlySet<AiEffort> = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'])

function makerLevels(maker: string, modelId: string): readonly AiEffort[] {
  const id = modelKey(modelId.replace(/:.*$/, '')).replace(/-\d{8}$|-\d{4}-\d{2}-\d{2}$/, '')
  return LEVELS[maker]?.find(([re]) => re.test(id))?.[1] ?? []
}

/**
 * The levels this model takes through this provider, weakest first; empty when it takes none, and then the control
 * is hidden and nothing is sent. Only the makers' own APIs and OpenRouter (`maker/model`) get one: another server
 * speaking the same protocol may refuse a parameter it does not know.
 */
export function effortLevels(providerId: string, modelId: string): readonly AiEffort[] {
  if (providerId === 'openrouter') {
    const slash = modelId.indexOf('/')
    if (slash < 0) return []
    return makerLevels(modelId.slice(0, slash), modelId.slice(slash + 1)).filter((l) => OPENROUTER.has(l))
  }
  return makerLevels(providerId, modelId)
}

/** The levels offered for a catalog model: none unless its listing says it reasons. */
export function modelEfforts(providerId: string, info: Pick<CatalogModel, 'id' | 'capabilities'>): readonly AiEffort[] {
  return info.capabilities.reasoning === true ? effortLevels(providerId, info.id) : []
}

/** The saved level when the model takes it, else nothing: the model's default applies. */
export function usableEffort(effort: AiEffort | undefined, levels: readonly AiEffort[]): AiEffort | undefined {
  return effort !== undefined && levels.includes(effort) ? effort : undefined
}
