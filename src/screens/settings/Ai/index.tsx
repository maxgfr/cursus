import { Check, RefreshCw } from 'lucide-react'
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { paths } from '../../../app/routes.ts'
import { useRuntime, useWorkspace } from '../../../app/workspaceContext.tsx'
import {
  type CatalogHit,
  findProvider,
  modelsOf,
  RECOMMENDED_PROVIDERS,
  recommendedModel,
  refreshCatalog,
  searchCatalog,
} from '../../../core/ai/catalog'
import { type Catalog, type CatalogProvider, checkEndpoint } from '../../../core/ai/catalogTrim'
import { createModel } from '../../../core/ai/client'
import { classifyFailure, reachOrigin } from '../../../core/ai/deviceCheck'
import { LOCAL_PROVIDER } from '../../../core/ai/local'
import { usageEvent } from '../../../core/ai/usage'
import { formatDate, formatUsd } from '../../../i18n/format.ts'
import { useLocale, useT } from '../../../i18n/react.tsx'
import { Button } from '../../../ui/components/Button.tsx'
import { Field } from '../../../ui/components/Field.tsx'
import { ListGroup, ListRow } from '../../../ui/components/List.tsx'
import { Segmented } from '../../../ui/components/Segmented.tsx'
import { cx } from '../../../ui/cx.ts'
import { resumeAutoQuestions } from '../../../ui/data/autoQuestions.ts'
import { Screen } from '../../../ui/shell/Screen.tsx'
import styles from '../../Understand/shared/ai.module.css'
import {
  type AiConfig,
  type AiLanguage,
  CUSTOM_PROVIDER,
  customProvider,
  type DeviceChecks,
  effectiveProvider,
  type AiSettings as Loaded,
  loadAiSettings,
  loadKey,
  monthCostOf,
  type RouteStatus,
  recordUsage,
  resolveRoute,
  routeStatus,
  saveCatalog,
  saveCheck,
  saveConfig,
  saveKey,
  useVault,
} from '../../Understand/shared/aiConfig.ts'
import { AutoQuestions } from './AutoQuestions.tsx'
import { localModelName, OnDevice } from './OnDevice.tsx'
import { checkDevice, modelState, pickedLocalModel, releaseEngine, useOnDevice } from './onDeviceStore.ts'

/** Rows rendered at once; the count says how many more a narrower search would reveal. */
const MAX_RESULTS = 60
/** Provider shown first when nothing is set up: a maker's own API, never an aggregator. */
const DEFAULT_PROVIDER = 'anthropic'

const PRESETS = [
  { id: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' },
  { id: 'lmstudio', label: 'LM Studio', baseUrl: 'http://localhost:1234/v1', model: '' },
] as const

export default function AiSettings() {
  const t = useT()
  const vault = useVault()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    let live = true
    loadAiSettings(vault).then(
      (s) => {
        if (live) setLoaded(s)
      },
      (e: unknown) => {
        if (live) setLoadError(e instanceof Error ? e.message : String(e))
      },
    )
    return () => {
      live = false
    }
  }, [vault])

  return (
    <Screen title={t('common.setAi')} back={paths.settings}>
      {loadError && (
        <p className={styles.error} role="alert">
          {t('ai.failed', { reason: loadError })}
        </p>
      )}
      {loaded && <Editor initial={loaded} />}
    </Screen>
  )
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

function Editor({ initial }: { initial: Loaded }) {
  const t = useT()
  const locale = useLocale()
  const vault = useVault()
  const ws = useWorkspace()
  const rt = useRuntime()
  const [config, setConfig] = useState<AiConfig>(initial.config)
  const [catalog, setCatalog] = useState<Catalog>(initial.catalog)
  const [checks, setChecks] = useState<DeviceChecks>(initial.checks)
  const [apiKey, setApiKey] = useState(initial.apiKey)
  const [baseUrl, setBaseUrl] = useState(initial.config.baseUrl ?? '')
  const [customModel, setCustomModel] = useState(
    initial.config.providerId === CUSTOM_PROVIDER ? (initial.config.modelId ?? '') : '',
  )
  const [query, setQuery] = useState('')
  const [browserOnly, setBrowserOnly] = useState(true)
  const [structured, setStructured] = useState(false)
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [languageStatus, setLanguageStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshMsg, setRefreshMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [, setUsageTick] = useState(0)
  const browserId = useId()
  const structuredId = useId()
  const providerSelectId = useId()

  const local = useOnDevice()
  const now = Date.now()
  const providerId = config.providerId ?? DEFAULT_PROVIDER
  const isCustom = providerId === CUSTOM_PROVIDER
  const isLocal = providerId === LOCAL_PROVIDER
  // A stored provider the catalog no longer lists (blocked, or a protocol we no longer speak).
  const orphan = !isCustom && config.providerId !== undefined && !findProvider(catalog, providerId)
  const endpoint = baseUrl.trim() === '' ? 'ok' : checkEndpoint(baseUrl)
  const customName = t('ai.customEndpoint')
  const catalogProvider = isCustom ? undefined : findProvider(catalog, providerId)
  // What the connection form and Test apply to: the chosen route with the base URL as typed.
  const provider: CatalogProvider | undefined = isCustom
    ? customProvider(customName, baseUrl)
    : catalogProvider && effectiveProvider(catalogProvider, baseUrl)
  // On-device models come from llm-models (loaded with the card); the one saved is known from the start.
  const localInfo = (id: string) =>
    local.service?.info(id) ?? (initial.local?.info.id === id ? initial.local.info : undefined)
  const selected = resolveRoute(
    isCustom ? { ...config, modelId: customModel.trim() || undefined, baseUrl } : config,
    catalog,
    customName,
    localInfo,
  )
  const localChoice = local.device.kind === 'ready' ? local.device.choice : undefined
  const selectedLocal = isLocal && config.modelId ? modelState(local, config.modelId).cache : null
  const selectedLocalReady = selectedLocal ? selectedLocal.complete : initial.local?.downloaded === true

  const groups = useMemo(() => {
    if (isCustom && query.trim() === '') return []
    const reachable = (p: CatalogProvider) => {
      if (!browserOnly || p.id === providerId) return true
      const kind = routeStatus(p, checks, Date.now()).kind
      return kind === 'device' || kind === 'server'
    }
    return searchCatalog(catalog, query, { providerId, structured, reachable })
  }, [catalog, query, providerId, structured, browserOnly, checks, isCustom])
  /**
   * The on-device models in the same search: the ones that fit this device (the pick first). Like a
   * catalog provider, a query naming it lists them all; otherwise models whose name matches.
   */
  const localHits = useMemo(() => {
    if (!localChoice) return []
    const all = [localChoice.model, ...localChoice.alternatives].filter((m) => !structured || m.structured_output)
    const ws = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (ws.length === 0) return isLocal ? all : []
    const providerHay = `${t('ai.localProvider')} ${LOCAL_PROVIDER} ${t('ai.localSearchTerms')}`.toLowerCase()
    if (ws.every((w) => providerHay.includes(w))) return all
    return all.filter((m) => {
      const hay = `${providerHay} ${localModelName(m)} ${m.id} ${m.family} ${m.series}`.toLowerCase()
      return ws.every((w) => hay.includes(w))
    })
  }, [localChoice, structured, query, isLocal, t])
  const total = groups.reduce((n, g) => n + g.hits.length, 0) + localHits.length
  const monthCost = monthCostOf(ws, catalog, Date.now())

  const providerOptions = useMemo(() => {
    const recommended = RECOMMENDED_PROVIDERS.flatMap((id) => {
      const p = findProvider(catalog, id)
      return p ? [p] : []
    })
    const others = catalog.providers
      .filter((p) => !RECOMMENDED_PROVIDERS.includes(p.id))
      .sort((a, b) => a.name.localeCompare(b.name, locale))
    return { recommended, others }
  }, [catalog, locale])

  const update = async (next: AiConfig) => {
    setConfig(next)
    await saveConfig(vault, next)
    // Documents waiting for a model (or for this one) get their questions proposed now.
    void resumeAutoQuestions(rt, { model: true })
  }

  /** Switches the route's provider: its own key and URL, and the same model there when it has it. */
  const switchSeq = useRef(0)
  const keyTyped = useRef(false)
  const switchProvider = async (nextId: string, modelId?: string) => {
    setStatus(null)
    if (nextId === config.providerId) {
      if (modelId) await update({ ...config, modelId })
      return
    }
    // The route switches at once, with its own empty base URL: anything typed from now on belongs to it.
    let next: AiConfig
    if (nextId === CUSTOM_PROVIDER) {
      next = { ...config, providerId: nextId, modelId: customModel.trim() || undefined, baseUrl: undefined }
    } else if (nextId === LOCAL_PROVIDER) {
      // Keyless: the model picked for this device unless one was chosen (waiting for the pick if needed).
      const id = modelId ?? localChoice?.model.id ?? (await checkDevice().then(pickedLocalModel))
      next = { ...config, providerId: nextId, modelId: id, baseUrl: undefined }
    } else {
      const current = selected?.info.name
      const same = current ? modelsOf(catalog, nextId).find((h) => h.entry.name === current) : undefined
      const id = modelId ?? same?.route.id ?? recommendedModel(catalog, nextId)?.route.id
      next = { ...config, providerId: nextId, modelId: id, baseUrl: undefined }
    }
    // The saved key loads asynchronously. Until it does the field is empty (the previous provider's key
    // is not this one's), and once the user focuses or types in it, what they enter wins over the load.
    const seq = ++switchSeq.current
    keyTyped.current = false
    setApiKey('')
    setBaseUrl('')
    const [saved] = await Promise.all([loadKey(vault, nextId), update(next)])
    // A newer switch owns the selection now.
    if (seq !== switchSeq.current) return
    // Committed with the check: left to a later render, the key could land after the user focused the field
    // (keyTyped set too late to stop it) and their typing would be appended to it.
    if (!keyTyped.current) flushSync(() => setApiKey(saved))
  }

  const choose = (p: CatalogProvider, hit: CatalogHit) => void switchProvider(p.id, hit.route.id)

  // The engine started to rank the models for this device. Leaving the screen lets its worker and GPU
  // memory go, unless a download runs or the on-device model is the default (the features will use it).
  const localDefault = useRef(isLocal)
  localDefault.current = isLocal
  useEffect(
    () => () => {
      if (!localDefault.current) releaseEngine()
    },
    [],
  )
  const chooseLocal = (modelId: string) => void switchProvider(LOCAL_PROVIDER, modelId)

  const applyPreset = (preset: (typeof PRESETS)[number]) => {
    setBaseUrl(preset.baseUrl)
    setCustomModel(preset.model)
    setStatus(null)
  }

  const saveConnection = async (e: FormEvent) => {
    e.preventDefault()
    await saveKey(vault, providerId, apiKey)
    const next: AiConfig = { ...config, providerId, baseUrl: baseUrl.trim() || undefined }
    if (isCustom) next.modelId = customModel.trim() || undefined
    await update(next)
    setStatus({ kind: 'ok', text: t('ai.savedConnection') })
  }

  /** A real, minimal call from this browser: the only proof that the route works here. */
  const test = async () => {
    if (!provider || !selected || endpoint !== 'ok') return
    setStatus(null)
    // Offline, a call proves nothing about the route (and the AI code may not even load).
    if (!navigator.onLine) {
      setStatus({ kind: 'error', text: t('ai.offline') })
      return
    }
    setTesting(true)
    try {
      const { generateText } = await import('ai')
      const lm = await createModel({ provider, modelId: selected.info.id, apiKey: apiKey.trim() })
      const res = await generateText({
        model: lm,
        prompt: 'Reply with the single word OK.',
        maxOutputTokens: 16,
        // One attempt: the outcome is recorded as this device's verdict.
        maxRetries: 0,
      })
      setChecks(await saveCheck(vault, provider, { outcome: 'works', at: Date.now() }))
      recordUsage(
        ws,
        usageEvent(
          'explainCard',
          selected.info,
          { inputTokens: res.totalUsage.inputTokens ?? 0, outputTokens: res.totalUsage.outputTokens ?? 0 },
          Date.now(),
        ),
      )
      setUsageTick((n) => n + 1)
      setStatus({ kind: 'ok', text: t('ai.testOk') })
    } catch (err) {
      // Only a proven CORS refusal is recorded; offline or an unreachable server says nothing about the route.
      const kind = await classifyFailure(err, provider.api ?? '', { online: navigator.onLine, reach: reachOrigin })
      if (kind === 'cors') {
        setChecks(await saveCheck(vault, provider, { outcome: 'blocked', at: Date.now() }))
        setStatus({ kind: 'error', text: t('ai.statusBlocked') })
      } else if (kind === 'offline') {
        setStatus({ kind: 'error', text: t('ai.offline') })
      } else if (kind === 'network') {
        setStatus({ kind: 'error', text: t('ai.unreachable') })
      } else {
        setStatus({ kind: 'error', text: t('ai.failed', { reason: errorText(err) }) })
      }
    } finally {
      setTesting(false)
    }
  }

  const refresh = async () => {
    setRefreshing(true)
    setRefreshMsg(null)
    try {
      const next = await refreshCatalog(catalog)
      await saveCatalog(vault, next)
      setCatalog(next)
      setRefreshMsg({ kind: 'ok', text: t('ai.catalogUpdated') })
    } catch (err) {
      setRefreshMsg({ kind: 'error', text: t('ai.failed', { reason: errorText(err) }) })
    } finally {
      setRefreshing(false)
    }
  }

  let shown = Math.min(localHits.length, MAX_RESULTS)
  // On-device has no route status: it is either downloaded here or not.
  const selectedStatus = provider && !isLocal ? routeStatus(provider, checks, now) : undefined
  const onDevice = (
    <OnDevice snap={local} configuredId={isLocal ? config.modelId : undefined} onUseAsDefault={chooseLocal} />
  )

  return (
    <div className={styles.stack}>
      <ListGroup title={t('ai.model')}>
        {isLocal ? (
          <ListRow
            title={selected ? <span translate="no">{selected.info.name}</span> : t('ai.chooseModel')}
            subtitle={selected ? t('ai.localFree') : undefined}
            trailing={
              selected ? (
                selectedLocalReady ? (
                  <span className={cx(styles.badge, styles.badgeGood)}>{t('ai.localBadgeReady')}</span>
                ) : (
                  <span className={styles.badge}>{t('ai.localBadgeMissing')}</span>
                )
              ) : undefined
            }
          />
        ) : (
          <ListRow
            title={selected ? selected.info.name : t('ai.chooseModel')}
            subtitle={
              selected && provider
                ? t('ai.through', { provider: provider.name }) +
                  (selected.info.cost ? ` · ${priceText(t, locale, selected.info.cost)}` : '')
                : undefined
            }
            trailing={selectedStatus ? <StatusBadge status={selectedStatus} /> : undefined}
          />
        )}
      </ListGroup>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={providerSelectId}>
          {t('ai.provider')}
        </label>
        <select
          id={providerSelectId}
          className={styles.select}
          value={orphan ? '' : providerId}
          onChange={(e) => void switchProvider(e.target.value)}
        >
          {orphan && (
            <option value="" disabled>
              {t('ai.chooseProvider')}
            </option>
          )}
          <optgroup label={t('ai.recommendedProviders')}>
            {providerOptions.recommended.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </optgroup>
          <optgroup label={t('ai.otherProviders')}>
            {providerOptions.others.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </optgroup>
          <option value={LOCAL_PROVIDER}>{t('ai.localProvider')}</option>
          <option value={CUSTOM_PROVIDER}>{customName}</option>
        </select>
        <p className={styles.hint}>{t('ai.providerHint')}</p>
        {orphan && (
          <p className={styles.error} role="alert">
            {t('ai.orphan', { provider: providerId })}
          </p>
        )}
      </div>

      {isLocal && onDevice}

      <section className={styles.stack} aria-labelledby="ai-catalog-h">
        <div className={styles.row}>
          <h2 id="ai-catalog-h" className={styles.heading}>
            {t('ai.catalog')}
          </h2>
          <span className={styles.spacer} />
          <Button icon={<RefreshCw size={16} aria-hidden="true" />} loading={refreshing} onClick={refresh}>
            {t('ai.refreshCatalog')}
          </Button>
        </div>
        <p className={styles.hint}>
          {t('ai.catalogDate', { date: formatDate(locale, new Date(catalog.generatedAt)) })}
        </p>
        {refreshMsg && (
          <p className={refreshMsg.kind === 'ok' ? styles.success : styles.error} role="status">
            {refreshMsg.text}
          </p>
        )}
        <Field
          type="search"
          label={t('ai.searchModels')}
          hint={t('ai.searchHint')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          enterKeyHint="search"
        />
        <div className={styles.row}>
          <label className={styles.check} htmlFor={browserId}>
            <input
              id={browserId}
              type="checkbox"
              checked={browserOnly}
              onChange={(e) => setBrowserOnly(e.target.checked)}
            />
            {t('ai.filterBrowser')}
          </label>
          <label className={styles.check} htmlFor={structuredId}>
            <input
              id={structuredId}
              type="checkbox"
              checked={structured}
              onChange={(e) => setStructured(e.target.checked)}
            />
            {t('ai.filterStructured')}
          </label>
        </div>
        <p className={styles.hint} role="status">
          {total > MAX_RESULTS
            ? t('ai.modelCountMore', { count: total, shown: MAX_RESULTS })
            : t('ai.modelCount', { count: total })}
        </p>
        {total === 0 && !(isCustom && query.trim() === '') && <p className={styles.muted}>{t('ai.noMatch')}</p>}
        {localHits.length > 0 && (
          <section className={styles.tight} aria-labelledby="ai-group-on-device">
            <div className={styles.row}>
              <h3 id="ai-group-on-device" className={styles.label}>
                {t('ai.localProvider')}
              </h3>
              <span className={styles.hint}>{t('ai.localFree')}</span>
            </div>
            <ul className={cx(styles.list, styles.card)} aria-label={t('ai.localProvider')}>
              {localHits.slice(0, MAX_RESULTS).map((m) => {
                const isSelected = isLocal && m.id === config.modelId
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      className={styles.modelRow}
                      aria-pressed={isSelected}
                      onClick={() => chooseLocal(m.id)}
                    >
                      <span className={styles.modelName}>
                        <span translate="no">{localModelName(m)}</span>
                        <span translate="no">{m.id}</span>
                      </span>
                      <span className={styles.row}>
                        {localChoice?.model.id === m.id && (
                          <span className={styles.badge}>{t('ai.recommendedModel')}</span>
                        )}
                        {isSelected && <Check size={18} aria-hidden="true" />}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        )}
        {groups.map((g) => {
          if (shown >= MAX_RESULTS) return null
          const hits = g.hits.slice(0, MAX_RESULTS - shown)
          shown += hits.length
          const rec = recommendedModel(catalog, g.provider.id)
          const own = hits.some((h) => h.entry.vendor === g.provider.id)
          const headingId = `ai-group-${g.provider.id}`
          return (
            <section key={g.provider.id} className={styles.tight} aria-labelledby={headingId}>
              <div className={styles.row}>
                <h3 id={headingId} className={styles.label} translate="no">
                  {g.provider.name}
                </h3>
                {own && <span className={styles.hint}>{t('ai.ownApi')}</span>}
                <span className={styles.spacer} />
                <StatusBadge status={routeStatus(g.provider, checks, now)} />
              </div>
              <ul className={cx(styles.list, styles.card)} aria-label={g.provider.name}>
                {hits.map((h) => {
                  const isSelected = g.provider.id === config.providerId && h.route.id === config.modelId
                  return (
                    <li key={`${h.route.provider}/${h.route.id}`}>
                      <button
                        type="button"
                        className={styles.modelRow}
                        aria-pressed={isSelected}
                        onClick={() => choose(g.provider, h)}
                      >
                        <span className={styles.modelName}>
                          <span translate="no">{h.entry.name}</span>
                          <span>
                            <span translate="no">{h.route.id}</span>
                            {h.route.cost ? ` · ${priceText(t, locale, h.route.cost)}` : ''}
                          </span>
                        </span>
                        <span className={styles.row}>
                          {rec && rec.route.id === h.route.id && (
                            <span className={styles.badge}>{t('ai.recommendedModel')}</span>
                          )}
                          {isSelected && <Check size={18} aria-hidden="true" />}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}
      </section>

      {provider && !orphan && !isLocal && (
        <form className={styles.stack} onSubmit={saveConnection} aria-labelledby="ai-conn-h">
          <h2 id="ai-conn-h" className={styles.heading}>
            {t('ai.connection', { provider: provider.name })}
          </h2>
          {isCustom && (
            <>
              <p className={styles.hint}>{t('ai.customHint')}</p>
              <fieldset className={styles.fieldset}>
                <legend className={styles.label}>{t('ai.presets')}</legend>
                <div className={styles.row}>
                  {PRESETS.map((p) => (
                    <Button key={p.id} onClick={() => applyPreset(p)}>
                      {p.label}
                    </Button>
                  ))}
                </div>
              </fieldset>
            </>
          )}
          {provider.browser.headers && (
            <p className={styles.hint}>
              {t('ai.headerNote', {
                provider: provider.name,
                header: Object.keys(provider.browser.headers).join(', '),
              })}
            </p>
          )}
          {provider.browser.limits === 'unreadable_errors' && <p className={styles.hint}>{t('ai.limitUnreadable')}</p>}
          {selectedStatus && <p className={styles.hint}>{statusText(t, locale, selectedStatus)}</p>}
          <Field
            label={isCustom ? t('ai.apiKeyOptional') : t('ai.apiKey')}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onFocus={() => {
              keyTyped.current = true
            }}
            onChange={(e) => {
              keyTyped.current = true
              setApiKey(e.target.value)
            }}
            hint={t('ai.apiKeyHint')}
          />
          <Field
            label={t('ai.baseUrl')}
            type="url"
            inputMode="url"
            spellCheck={false}
            value={baseUrl}
            placeholder={catalogProvider?.api ?? ''}
            onChange={(e) => setBaseUrl(e.target.value)}
            hint={isCustom ? t('ai.corsHint') : t('ai.baseUrlHint')}
            error={
              endpoint === 'insecure'
                ? t('ai.endpointInsecure')
                : endpoint === 'invalid'
                  ? t('ai.endpointInvalid')
                  : undefined
            }
          />
          {isCustom && (
            <Field
              label={t('ai.modelName')}
              spellCheck={false}
              autoCapitalize="off"
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
            />
          )}
          <div className={styles.row}>
            <Button type="submit" variant="primary">
              {t('ai.saveConnection')}
            </Button>
            <Button
              loading={testing}
              disabled={!selected || endpoint !== 'ok' || (!isCustom && !apiKey.trim())}
              onClick={() => void test()}
            >
              {t('ai.test')}
            </Button>
          </div>
          {status && (
            <p className={status.kind === 'ok' ? styles.success : styles.error} role="status">
              {status.text}
            </p>
          )}
        </form>
      )}

      {!isLocal && onDevice}

      <Segmented<AiLanguage>
        label={t('ai.outputLanguage')}
        value={config.language}
        onChange={(v) => {
          setLanguageStatus(null)
          update({ ...config, language: v }).then(
            () => setLanguageStatus({ kind: 'ok', text: t('ai.languageSaved') }),
            (err: unknown) => setLanguageStatus({ kind: 'error', text: t('ai.failed', { reason: errorText(err) }) }),
          )
        }}
        options={[
          { value: 'auto', label: t('ai.languageAuto') },
          { value: 'en', label: 'English', lang: 'en' },
          { value: 'de', label: 'Deutsch', lang: 'de' },
          { value: 'fr', label: 'Français', lang: 'fr' },
        ]}
      />
      {languageStatus && (
        <p className={languageStatus.kind === 'ok' ? styles.success : styles.error} role="status">
          {languageStatus.text}
        </p>
      )}

      <AutoQuestions monthCost={monthCost} />

      <section className={styles.card} aria-labelledby="ai-cost-h">
        <h2 id="ai-cost-h" className={styles.label}>
          {t('ai.monthCost')}
        </h2>
        <p className={styles.stat} data-testid="ai-month-cost">
          {formatUsd(locale, monthCost)}
        </p>
        <p className={styles.hint}>{t('ai.monthCostHint')}</p>
      </section>
    </div>
  )
}

type T = ReturnType<typeof useT>
type Locale = ReturnType<typeof useLocale>

function priceText(t: T, locale: Locale, cost: { input: number; output: number }): string {
  return t('ai.price', { input: formatUsd(locale, cost.input), output: formatUsd(locale, cost.output) })
}

function statusText(t: T, locale: Locale, s: RouteStatus): string {
  switch (s.kind) {
    case 'device':
      return t('ai.statusDevice', { date: formatDate(locale, new Date(s.at)) })
    case 'server':
      return t('ai.statusServer')
    case 'blocked':
      return t('ai.statusBlocked')
    case 'moved':
      return t('ai.statusMoved', { from: s.from })
    case 'unknown':
      return t('ai.statusUnknown')
  }
}

function StatusBadge({ status }: { status: RouteStatus }) {
  const t = useT()
  switch (status.kind) {
    case 'device':
      return <span className={cx(styles.badge, styles.badgeGood)}>{t('ai.badgeDevice')}</span>
    case 'server':
      return <span className={styles.badge}>{t('ai.badgeServer')}</span>
    case 'blocked':
      return <span className={styles.badge}>{t('ai.badgeBlocked')}</span>
    case 'moved':
      return <span className={styles.badge}>{t('ai.badgeMoved')}</span>
    case 'unknown':
      return <span className={styles.badge}>{t('ai.badgeUnknown')}</span>
  }
}
