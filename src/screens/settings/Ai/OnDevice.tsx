import type { BrowserModel } from 'llm-models/browser'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { GpuReport, SpaceVerdict } from '../../../core/ai/local'
import { formatBytes, formatNumber } from '../../../i18n/format.ts'
import { intlTag } from '../../../i18n/index.ts'
import { useLocale, useT } from '../../../i18n/react.tsx'
import { Button } from '../../../ui/components/Button.tsx'
import { cx } from '../../../ui/cx.ts'
import aiStyles from '../../Understand/shared/ai.module.css'
import styles from './OnDevice.module.css'
import {
  cancelDownload,
  checkDevice,
  downloadModel,
  modelState,
  type OnDeviceSnapshot,
  recheck,
  refreshModel,
  removeModel,
} from './onDeviceStore.ts'
import { whenIdleOrSeen } from './whenIdleOrSeen.ts'

type T = ReturnType<typeof useT>
type Locale = ReturnType<typeof useLocale>

function formatUnit(locale: Locale, value: number, unit: 'megabyte' | 'gigabyte'): string {
  return new Intl.NumberFormat(intlTag(locale), {
    style: 'unit',
    unit,
    unitDisplay: 'short',
    maximumFractionDigits: 0,
  }).format(value)
}

function formatPercent(locale: Locale, ratio: number): string {
  return new Intl.NumberFormat(intlTag(locale), { style: 'percent', maximumFractionDigits: 0 }).format(ratio)
}

/** "Qwen3 1.7B": the series and size, as llm-models names the model. */
export function localModelName(model: BrowserModel): string {
  return model.params_b === null ? model.series : `${model.series} ${model.params_b}B`
}

export interface OnDeviceProps {
  snap: OnDeviceSnapshot
  /** The on-device model the settings name, if the provider is on-device. */
  configuredId: string | undefined
  /** Makes `modelId` the default model (the provider becomes on-device). */
  onUseAsDefault: (modelId: string) => void
}

/**
 * "On this device": what the device can run, the model picked for it and why, then its download,
 * removal and use as the default model. Every figure is structured; llm-models' English reason is not
 * shown as such.
 */
export function OnDevice({ snap, configuredId, onUseAsDefault }: OnDeviceProps) {
  const t = useT()
  const { device } = snap

  // Not at mount: the detection (a chunk load, then a GPU probe) waits for an idle moment or for the card to
  // come into view, so it never competes with the screen's first interaction (typing in the search).
  const section = useRef<HTMLElement>(null)
  useEffect(() => whenIdleOrSeen(section.current, () => void checkDevice()), [])

  const configured = configuredId ? snap.service?.find(configuredId) : undefined
  const model = configured ?? (device.kind === 'ready' ? device.choice.model : undefined)

  let body: ReactNode
  if (device.kind === 'checking') {
    body = (
      <p className={aiStyles.hint} role="status">
        {t('ai.localChecking')}
      </p>
    )
  } else if (device.kind === 'failed') {
    body = (
      <>
        <p className={aiStyles.error} role="alert">
          {t('ai.localCheckFailed', { reason: device.message })}
        </p>
        <div className={styles.actions}>
          <Button onClick={() => void recheck()}>{t('ai.localRetry')}</Button>
        </div>
      </>
    )
  } else if (device.kind === 'unsupported') {
    body = <Unsupported reason={device.reason} gpu={device.gpu} />
  } else if (model) {
    body = (
      <ModelCard
        key={model.id}
        snap={snap}
        model={model}
        gpu={device.gpu}
        recommended={model.id === device.choice.model.id}
        isDefault={configured !== undefined && configured.id === model.id}
        onUseAsDefault={onUseAsDefault}
      />
    )
  }

  return (
    <section ref={section} className={aiStyles.stack} aria-labelledby="ai-local-h" data-testid="on-device">
      <div className={aiStyles.tight}>
        <h2 id="ai-local-h" className={aiStyles.heading}>
          {t('ai.localProvider')}
        </h2>
        <p className={aiStyles.hint}>{t('ai.localIntro')}</p>
      </div>
      {body}
    </section>
  )
}

function Unsupported({ reason, gpu }: { reason: 'no-webgpu' | 'no-adapter' | 'too-little-memory'; gpu?: GpuReport }) {
  const t = useT()
  const locale = useLocale()
  if (reason === 'no-webgpu') return <p className={aiStyles.muted}>{t('ai.localNoWebgpu')}</p>
  if (reason === 'no-adapter') return <p className={aiStyles.muted}>{t('ai.localNoAdapter')}</p>
  // The adapter's limits are enough, but no model fits the memory budget (an estimate on Safari).
  if (gpu && limitsOk(gpu)) {
    const budget = formatUnit(locale, gpu.memoryBudgetMB, 'megabyte')
    return (
      <div className={aiStyles.tight}>
        <p className={aiStyles.muted}>{t('ai.localNothingFits', { budget })}</p>
        <MemorySource gpu={gpu} />
      </div>
    )
  }
  return <p className={aiStyles.muted}>{t('ai.localTooLittleMemory')}</p>
}

/** WebLLM's floor (see detectLocalSupport): below it, no model starts whatever its size. */
function limitsOk(gpu: GpuReport): boolean {
  return (
    gpu.maxBufferSize >= 256 * 1024 * 1024 &&
    gpu.maxStorageBufferBindingSize >= 128 * 1024 * 1024 &&
    gpu.maxComputeWorkgroupStorageSize >= 32 * 1024
  )
}

function MemorySource({ gpu }: { gpu: GpuReport }) {
  const t = useT()
  const locale = useLocale()
  const budget = formatUnit(locale, gpu.memoryBudgetMB, 'megabyte')
  if (gpu.memorySource === 'default' || gpu.deviceMemoryGiB === null) {
    return <span className={styles.note}>{t('ai.localMemoryEstimate', { budget })}</span>
  }
  return (
    <span className={styles.note}>
      {t('ai.localMemoryReported', { ram: formatUnit(locale, gpu.deviceMemoryGiB, 'gigabyte') })}
    </span>
  )
}

interface ModelCardProps {
  snap: OnDeviceSnapshot
  model: BrowserModel
  gpu: GpuReport
  recommended: boolean
  isDefault: boolean
  onUseAsDefault: (modelId: string) => void
}

type FocusTarget = 'cancel' | 'start' | 'use' | 'keep' | 'remove'

function ModelCard({ snap, model, gpu, recommended, isDefault, onUseAsDefault }: ModelCardProps) {
  const t = useT()
  const locale = useLocale()
  const state = modelState(snap, model.id)
  const downloading = snap.downloading === model.id
  const busyElsewhere = snap.downloading !== null && !downloading
  const [confirming, setConfirming] = useState(false)
  const [removing, setRemoving] = useState(false)
  const name = localModelName(model)

  // Focus follows the action: the button that replaces the one just pressed takes it.
  const card = useRef<HTMLDivElement>(null)
  const pendingFocus = useRef<FocusTarget | null>(null)
  useEffect(() => {
    const target = pendingFocus.current
    if (!target) return
    const el = card.current?.querySelector<HTMLButtonElement>(`[data-focus="${target}"]`)
    if (el && !el.disabled) {
      el.focus()
      pendingFocus.current = null
    }
  })
  // A download ending on its own removes Cancel: hand focus to what comes next, not to the page.
  const wasDownloading = useRef(downloading)
  useEffect(() => {
    if (wasDownloading.current && !downloading) {
      const lost = document.activeElement === null || document.activeElement === document.body
      if (lost && !pendingFocus.current) pendingFocus.current = state.cache?.complete ? 'use' : 'start'
    }
    wasDownloading.current = downloading
  }, [downloading, state.cache?.complete])

  useEffect(() => {
    if (state.cache === null) void refreshModel(model)
  }, [model, state.cache])

  const total = state.cache?.totalBytes ?? state.downloadBytes
  const size = total === null ? null : formatBytes(locale, total)
  const complete = state.cache?.complete === true
  const partial = !complete && (state.cache?.cachedBytes ?? 0) > 0
  const spaceRefused = state.space !== null && !state.space.ok

  const start = () => {
    setConfirming(false)
    pendingFocus.current = 'cancel'
    void downloadModel(model)
  }
  const cancel = () => {
    pendingFocus.current = 'start'
    cancelDownload()
  }
  const remove = async () => {
    setRemoving(true)
    await removeModel(model)
    setRemoving(false)
    setConfirming(false)
    pendingFocus.current = 'start'
  }

  const memoryNeed = formatUnit(locale, Math.ceil(model.vram_required_mb), 'megabyte')
  const memoryBudget = formatUnit(locale, gpu.memoryBudgetMB, 'megabyte')
  const family =
    model.params_b === null
      ? t('ai.localFamilyNoParams', { family: model.series, bits: model.weight_bits })
      : t('ai.localFamily', {
          family: model.series,
          params: formatNumber(locale, model.params_b, 1),
          bits: model.weight_bits,
        })

  const outcome = state.outcome
  let status = ''
  let statusError = false
  if (downloading) status = t('ai.localDownloadStarted')
  else if (outcome?.kind === 'no-space') {
    status = spaceText(t, locale, outcome.space)
    statusError = true
  } else if (outcome?.kind === 'failed') {
    status = t('ai.localFailed', { reason: outcome.message })
    statusError = true
  } else if (complete) status = t('ai.localDownloaded')
  else if (outcome?.kind === 'cancelled') status = t('ai.localCancelled')
  else if (outcome?.kind === 'removed') status = t('ai.localRemoved')

  return (
    <div className={aiStyles.card} ref={card}>
      <div className={aiStyles.row}>
        <span className={styles.name} translate="no">
          {name}
        </span>
        {recommended && <span className={aiStyles.badge}>{t('ai.localRecommended')}</span>}
        {complete && <span className={cx(aiStyles.badge, aiStyles.badgeGood)}>{t('ai.localBadgeReady')}</span>}
      </div>
      <dl className={styles.facts} aria-label={t('ai.localFacts', { model: name })}>
        <div className={styles.fact}>
          <dt>{t('ai.localSizeLabel')}</dt>
          <dd>{size ? t('ai.localSize', { size }) : '—'}</dd>
        </div>
        <div className={styles.fact}>
          <dt>{t('ai.localMemoryLabel')}</dt>
          <dd>
            <span>{t('ai.localMemory', { need: memoryNeed, budget: memoryBudget })}</span>
            <MemorySource gpu={gpu} />
          </dd>
        </div>
        <div className={styles.fact}>
          <dt>{t('ai.localFamilyLabel')}</dt>
          <dd translate="no">{family}</dd>
        </div>
        {model.quality && (
          <div className={styles.fact}>
            <dt>{t('ai.localScoreLabel')}</dt>
            <dd>
              <span translate="no">
                {model.quality.metric} {formatNumber(locale, model.quality.value, 1)}
              </span>
              <span className={styles.note} lang="en" translate="no">
                {model.quality.source}
              </span>
            </dd>
          </div>
        )}
      </dl>
      {recommended && <p className={styles.note}>{t('ai.localWhy')}</p>}

      {downloading && (
        <div className={aiStyles.tight}>
          <progress
            className={styles.meter}
            max={1}
            value={state.progress ?? 0}
            aria-label={t('ai.localProgress')}
            aria-valuetext={formatPercent(locale, state.progress ?? 0)}
          />
          <p className={cx(aiStyles.hint, styles.percent)} aria-hidden="true">
            {t('ai.localDownloading', { percent: formatPercent(locale, state.progress ?? 0) })}
          </p>
        </div>
      )}

      {!downloading && partial && state.cache && total !== null && (
        <p className={aiStyles.hint}>
          {t('ai.localPartial', {
            done: formatBytes(locale, state.cache.cachedBytes),
            total: formatBytes(locale, total),
          })}
        </p>
      )}
      {!downloading && !complete && spaceRefused && state.space && outcome?.kind !== 'no-space' && (
        <p className={aiStyles.error}>{spaceText(t, locale, state.space)}</p>
      )}
      {isDefault && (
        <p className={aiStyles.hint}>{complete ? t('ai.localIsDefault') : t('ai.localDefaultNotDownloaded')}</p>
      )}

      <p className={statusError ? aiStyles.error : complete ? aiStyles.success : aiStyles.hint} role="status">
        {status}
      </p>

      {confirming ? (
        <div className={styles.confirm}>
          <p>{t('ai.localRemoveConfirm', { size: size ?? '—' })}</p>
          <div className={styles.actions}>
            <Button variant="danger" loading={removing} onClick={() => void remove()}>
              {t('ai.localRemoveYes')}
            </Button>
            <Button
              data-focus="keep"
              onClick={() => {
                setConfirming(false)
                pendingFocus.current = 'remove'
              }}
            >
              {t('ai.localKeep')}
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.actions}>
          {downloading ? (
            <Button data-focus="cancel" onClick={cancel}>
              {t('ai.localCancel')}
            </Button>
          ) : complete ? (
            !isDefault && (
              <Button data-focus="use" variant="primary" onClick={() => onUseAsDefault(model.id)}>
                {t('ai.localUseDefault')}
              </Button>
            )
          ) : (
            state.cache !== null && (
              <Button data-focus="start" variant="primary" disabled={spaceRefused || busyElsewhere} onClick={start}>
                {partial ? t('ai.localResume') : size ? t('ai.localDownload', { size }) : t('ai.localDownloadUnsized')}
              </Button>
            )
          )}
          {!downloading && (complete || partial) && (
            <Button
              data-focus="remove"
              variant="plain"
              onClick={() => {
                setConfirming(true)
                pendingFocus.current = 'keep'
              }}
            >
              {t('ai.localRemove')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

function spaceText(t: T, locale: Locale, space: SpaceVerdict): string {
  if (space.ok) return ''
  if (space.reason === 'unknown') return t('ai.localSpaceUnknown')
  return t('ai.localNoSpace', {
    need: formatBytes(locale, space.needBytes),
    free: formatBytes(locale, space.freeBytes),
    reserve: formatBytes(locale, space.reserveBytes),
  })
}
