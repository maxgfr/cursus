import { Check, RefreshCw } from 'lucide-react'
import { type FormEvent, useEffect, useId, useMemo, useState } from 'react'
import { paths } from '../../../app/routes.ts'
import { useWorkspace } from '../../../app/workspaceContext.tsx'
import { findModel, findProvider, refreshCatalog } from '../../../core/ai/catalog'
import type { Catalog, CatalogModel, CatalogProvider } from '../../../core/ai/catalogTrim'
import { providerBaseUrl } from '../../../core/ai/catalogTrim'
import { createModel } from '../../../core/ai/client'
import { usageEvent } from '../../../core/ai/usage'
import { formatDate, formatUsd } from '../../../i18n/format.ts'
import { useLocale, useT } from '../../../i18n/react.tsx'
import { Button } from '../../../ui/components/Button.tsx'
import { Field } from '../../../ui/components/Field.tsx'
import { ListGroup, ListRow } from '../../../ui/components/List.tsx'
import { Segmented } from '../../../ui/components/Segmented.tsx'
import { cx } from '../../../ui/cx.ts'
import { Screen } from '../../../ui/shell/Screen.tsx'
import styles from '../../Understand/shared/ai.module.css'
import {
  type AiConfig,
  type AiLanguage,
  effectiveProvider,
  type AiSettings as Loaded,
  loadAiSettings,
  loadKey,
  monthCostOf,
  recordUsage,
  saveCatalog,
  saveConfig,
  saveKey,
  useVault,
} from '../../Understand/shared/aiConfig.ts'

const MAX_RESULTS = 40

interface Row {
  provider: CatalogProvider
  model: CatalogModel
}

function filterModels(catalog: Catalog, query: string, browserOnly: boolean, structured: boolean): Row[] {
  const q = query.trim().toLowerCase()
  const out: Row[] = []
  for (const provider of catalog.providers) {
    if (browserOnly && !provider.browserCallable) continue
    for (const model of provider.models) {
      if (structured && !model.capabilities.structured_output) continue
      const hay = `${model.name} ${model.id} ${provider.name} ${provider.id}`.toLowerCase()
      if (q && !q.split(/\s+/).every((w) => hay.includes(w))) continue
      out.push({ provider, model })
    }
  }
  return out
}

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

function Editor({ initial }: { initial: Loaded }) {
  const t = useT()
  const locale = useLocale()
  const vault = useVault()
  const ws = useWorkspace()
  const [config, setConfig] = useState<AiConfig>(initial.config)
  const [catalog, setCatalog] = useState<Catalog>(initial.catalog)
  const [apiKey, setApiKey] = useState(initial.apiKey)
  const [baseUrl, setBaseUrl] = useState(initial.config.baseUrl ?? '')
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

  const provider = findProvider(catalog, config.providerId ?? '')
  const model = findModel(catalog, config.providerId ?? '', config.modelId ?? '')
  const rows = useMemo(
    () => filterModels(catalog, query, browserOnly, structured),
    [catalog, query, browserOnly, structured],
  )
  const monthCost = monthCostOf(ws, catalog, Date.now())

  const update = async (next: AiConfig) => {
    setConfig(next)
    await saveConfig(vault, next)
  }

  const choose = async (r: Row) => {
    setStatus(null)
    if (r.provider.id !== config.providerId) {
      setApiKey(await loadKey(vault, r.provider.id))
      setBaseUrl('')
      await update({ ...config, providerId: r.provider.id, modelId: r.model.id, baseUrl: undefined })
    } else {
      await update({ ...config, modelId: r.model.id })
    }
  }

  const saveConnection = async (e: FormEvent) => {
    e.preventDefault()
    if (!provider) return
    await saveKey(vault, provider.id, apiKey)
    await update({ ...config, baseUrl: baseUrl.trim() || undefined })
    setStatus({ kind: 'ok', text: t('ai.savedConnection') })
  }

  const test = async () => {
    if (!provider || !model) return
    setTesting(true)
    setStatus(null)
    try {
      const { generateText } = await import('ai')
      const lm = await createModel({
        provider: effectiveProvider(provider, baseUrl),
        modelId: model.id,
        apiKey: apiKey.trim(),
      })
      const res = await generateText({ model: lm, prompt: 'Reply with the single word OK.', maxOutputTokens: 16 })
      recordUsage(
        ws,
        usageEvent(
          'explainCard',
          model,
          { inputTokens: res.totalUsage.inputTokens ?? 0, outputTokens: res.totalUsage.outputTokens ?? 0 },
          Date.now(),
        ),
      )
      setUsageTick((n) => n + 1)
      setStatus({ kind: 'ok', text: t('ai.testOk') })
    } catch (err) {
      setStatus({ kind: 'error', text: t('ai.failed', { reason: err instanceof Error ? err.message : String(err) }) })
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
      setRefreshMsg({
        kind: 'error',
        text: t('ai.failed', { reason: err instanceof Error ? err.message : String(err) }),
      })
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className={styles.stack}>
      <ListGroup title={t('ai.model')}>
        <ListRow
          title={model ? model.name : t('ai.chooseModel')}
          subtitle={provider ? provider.name : undefined}
          trailing={provider ? <CallableBadge provider={provider} /> : undefined}
        />
      </ListGroup>

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
          {t('ai.modelCount', { count: rows.length })}
        </p>
        <ul className={styles.list} aria-label={t('ai.models')}>
          {rows.slice(0, MAX_RESULTS).map((r) => {
            const selected = r.provider.id === config.providerId && r.model.id === config.modelId
            return (
              <li key={`${r.provider.id}/${r.model.id}`}>
                <button
                  type="button"
                  className={styles.modelRow}
                  aria-pressed={selected}
                  onClick={() => void choose(r)}
                >
                  <span className={styles.modelName}>
                    <span translate="no">{r.model.name}</span>
                    <span>
                      <span translate="no">{r.provider.name}</span>
                      {r.model.cost
                        ? ` · ${t('ai.price', { input: formatUsd(locale, r.model.cost.input), output: formatUsd(locale, r.model.cost.output) })}`
                        : ''}
                    </span>
                  </span>
                  <span className={styles.row}>
                    <CallableBadge provider={r.provider} />
                    {selected && <Check size={18} aria-hidden="true" />}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </section>

      {provider && (
        <form className={styles.stack} onSubmit={saveConnection} aria-labelledby="ai-conn-h">
          <h2 id="ai-conn-h" className={styles.heading}>
            {t('ai.connection', { provider: provider.name })}
          </h2>
          <Field
            label={t('ai.apiKey')}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            hint={t('ai.apiKeyHint')}
          />
          <Field
            label={t('ai.baseUrl')}
            type="url"
            inputMode="url"
            spellCheck={false}
            value={baseUrl}
            placeholder={providerBaseUrl(provider) ?? ''}
            onChange={(e) => setBaseUrl(e.target.value)}
            hint={t('ai.baseUrlHint')}
          />
          <div className={styles.row}>
            <Button type="submit" variant="primary">
              {t('ai.saveConnection')}
            </Button>
            <Button loading={testing} disabled={!model || !apiKey.trim()} onClick={() => void test()}>
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

      <Segmented<AiLanguage>
        label={t('ai.outputLanguage')}
        value={config.language}
        onChange={(v) => {
          setLanguageStatus(null)
          update({ ...config, language: v }).then(
            () => setLanguageStatus({ kind: 'ok', text: t('ai.languageSaved') }),
            (err: unknown) =>
              setLanguageStatus({
                kind: 'error',
                text: t('ai.failed', { reason: err instanceof Error ? err.message : String(err) }),
              }),
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

function CallableBadge({ provider }: { provider: CatalogProvider }) {
  const t = useT()
  return provider.browserCallable ? (
    <span className={cx(styles.badge, styles.badgeGood)}>{t('ai.browserCallable')}</span>
  ) : (
    <span className={styles.badge}>{t('ai.needsProxy')}</span>
  )
}
