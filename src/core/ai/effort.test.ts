import { describe, expect, test } from 'bun:test'
import { type AiConfig, effortKey, savedEffort, withEffort } from './config'
import { type AiEffort, effortLevels, modelEfforts, usableEffort } from './effort'

describe('effort levels', () => {
  test('a Claude model offers the levels Anthropic lists for it', () => {
    const all: AiEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
    expect(effortLevels('anthropic', 'claude-opus-5-5')).toEqual(all)
    expect(effortLevels('anthropic', 'claude-fable-5-1')).toEqual(all)
    expect(effortLevels('anthropic', 'claude-haiku-5-5')).toEqual(all)
    expect(effortLevels('anthropic', 'claude-opus-4-7')).toEqual(all)
    // Claude 4.6 has `max` without `xhigh`; before it, a thinking budget the SDK derives from three levels.
    expect(effortLevels('anthropic', 'claude-sonnet-4-6')).toEqual(['low', 'medium', 'high', 'max'])
    expect(effortLevels('anthropic', 'claude-opus-4-5-20251101')).toEqual(['low', 'medium', 'high'])
    expect(effortLevels('anthropic', 'claude-haiku-4-5')).toEqual(['low', 'medium', 'high'])
    expect(effortLevels('anthropic', 'claude-3-5-haiku-20241022')).toEqual([])
  })

  test('an OpenAI model offers the reasoning efforts its family takes', () => {
    expect(effortLevels('openai', 'gpt-5')).toEqual(['minimal', 'low', 'medium', 'high'])
    expect(effortLevels('openai', 'gpt-5-2025-08-07')).toEqual(['minimal', 'low', 'medium', 'high'])
    expect(effortLevels('openai', 'gpt-5.1')).toEqual(['none', 'low', 'medium', 'high'])
    expect(effortLevels('openai', 'gpt-5.4-mini')).toEqual(['none', 'low', 'medium', 'high', 'xhigh'])
    expect(effortLevels('openai', 'gpt-5.5-pro')).toEqual(['medium', 'high', 'xhigh'])
    expect(effortLevels('openai', 'gpt-5.3-codex')).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(effortLevels('openai', 'gpt-5.6-luna')).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(effortLevels('openai', 'gpt-6-sol')).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(effortLevels('openai', 'gpt-6.1-sol')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(effortLevels('openai', 'o3')).toEqual(['low', 'medium', 'high'])
    // A single level is no choice; chat and non-reasoning models take none.
    expect(effortLevels('openai', 'gpt-5-pro')).toEqual([])
    expect(effortLevels('openai', 'gpt-5.2-chat-latest')).toEqual([])
    expect(effortLevels('openai', 'gpt-4o')).toEqual([])
  })

  test('a Gemini model offers its thinking levels, three on 2.5', () => {
    expect(effortLevels('google', 'gemini-4-argon')).toEqual(['low', 'medium', 'high'])
    expect(effortLevels('google', 'gemini-3-pro-preview')).toEqual(['low', 'high'])
    expect(effortLevels('google', 'gemini-3.1-pro-preview')).toEqual(['low', 'medium', 'high'])
    expect(effortLevels('google', 'gemini-3-flash-preview')).toEqual(['minimal', 'low', 'medium', 'high'])
    expect(effortLevels('google', 'gemini-3.5-flash-lite')).toEqual(['minimal', 'low', 'medium', 'high'])
    expect(effortLevels('google', 'gemini-3.8-flash')).toEqual(['low', 'medium', 'high'])
    expect(effortLevels('google', 'gemini-2.5-pro')).toEqual(['low', 'medium', 'high'])
    expect(effortLevels('google', 'gemini-3-pro-image-preview')).toEqual([])
  })

  test('OpenRouter offers the maker’s levels its own scale has', () => {
    expect(effortLevels('openrouter', 'anthropic/claude-opus-4.6')).toEqual(['low', 'medium', 'high'])
    expect(effortLevels('openrouter', 'anthropic/claude-opus-4.7')).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(effortLevels('openrouter', 'google/gemini-3-pro-preview')).toEqual(['low', 'high'])
    expect(effortLevels('openrouter', 'openai/gpt-5:free')).toEqual(['minimal', 'low', 'medium', 'high'])
    expect(effortLevels('openrouter', 'deepseek/deepseek-r1')).toEqual([])
    expect(effortLevels('openrouter', 'openrouter/auto')).toEqual([])
  })

  test('only the makers’ APIs and OpenRouter get an effort', () => {
    expect(effortLevels('requesty', 'claude-opus-5-5')).toEqual([])
    expect(effortLevels('groq', 'openai/gpt-5')).toEqual([])
    expect(effortLevels('custom', 'gpt-5')).toEqual([])
  })

  test('a model whose listing does not reason is offered none', () => {
    expect(modelEfforts('openai', { id: 'gpt-5', capabilities: { reasoning: true } })).toHaveLength(4)
    expect(modelEfforts('openai', { id: 'gpt-5', capabilities: {} })).toEqual([])
  })

  test('a saved level the model does not take falls back to its default', () => {
    expect(usableEffort('max', ['low', 'high'])).toBeUndefined()
    expect(usableEffort('high', ['low', 'high'])).toBe('high')
    expect(usableEffort(undefined, ['low', 'high'])).toBeUndefined()
  })
})

describe('effort per model', () => {
  const opus: AiConfig = { language: 'auto', providerId: 'anthropic', modelId: 'claude-opus-5-5' }

  test('each route keeps its own choice', () => {
    const a = withEffort(opus, 'max')
    expect(savedEffort(a)).toBe('max')
    const b = withEffort({ ...a, providerId: 'openai', modelId: 'gpt-5' }, 'minimal')
    expect(b.efforts).toEqual({ 'anthropic/claude-opus-5-5': 'max', 'openai/gpt-5': 'minimal' })
    // Switching back shows that model's own choice; a model never set shows the default.
    expect(savedEffort({ ...b, ...opus })).toBe('max')
    expect(savedEffort({ ...b, providerId: 'google', modelId: 'gemini-2.5-pro' })).toBeUndefined()
  })

  test('the default clears the route’s choice, and nothing is saved without a model', () => {
    const set = withEffort(opus, 'low')
    expect(withEffort(set, undefined)).toEqual(opus)
    const both = withEffort(withEffort(set, 'low'), 'high')
    expect(both.efforts).toEqual({ [effortKey('anthropic', 'claude-opus-5-5')]: 'high' })
    expect(withEffort({ language: 'auto' }, 'high')).toEqual({ language: 'auto' })
    expect(savedEffort({ language: 'auto', efforts: { 'anthropic/x': 'low' } })).toBeUndefined()
  })
})
