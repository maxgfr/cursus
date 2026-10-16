import { describe, expect, test } from 'bun:test'
import type { AiJob } from '../../core/ai/jobs'
import { JOBS_KEY } from '../../core/ai/jobs'
import { isActiveJob, jobOf, STORED_JOBS_KEY } from './autoQuestions'

const job = (id: string, sourceId: string, status: AiJob['status'], updatedAt: number): AiJob => ({
  id,
  sourceId,
  reason: 'added',
  status,
  createdAt: 0,
  updatedAt,
  spent: 0,
  progress: { done: [], total: 0 },
  proposed: 0,
  added: 0,
  duplicates: 0,
})

describe('autoQuestions helper', () => {
  test('reads the queue where the jobs keep it', () => {
    expect(STORED_JOBS_KEY).toBe(JOBS_KEY)
  })

  test("a source's newest job wins", () => {
    const jobs = [job('a', 's1', 'done', 5), job('b', 's1', 'failed', 9), job('c', 's2', 'queued', 20)]
    expect(jobOf(jobs, 's1')?.id).toBe('b')
    expect(jobOf(jobs, 's3')).toBeUndefined()
  })

  test('active jobs are those still to run or waiting for a connection or a model', () => {
    expect(
      ['queued', 'running', 'waiting', 'needs-model'].every((s) => isActiveJob({ status: s as AiJob['status'] })),
    ).toBe(true)
    expect(['done', 'failed', 'cancelled'].some((s) => isActiveJob({ status: s as AiJob['status'] }))).toBe(false)
  })
})
