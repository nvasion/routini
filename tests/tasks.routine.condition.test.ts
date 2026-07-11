/**
 * Unit tests for the routine step condition evaluator.
 *
 * Covers:
 *  - isValidConditionSyntax: recognizes valid patterns, rejects invalid ones
 *  - evaluateCondition: correct boolean outcomes for all recognized patterns
 *    including edge cases (undefined previous, invalid status values, extra
 *    whitespace, pattern not recognized).
 */

import { describe, expect, it } from 'vitest'
import {
  evaluateCondition,
  isValidConditionSyntax,
  type StepContext,
} from '../server/src/tasks/routine/condition.js'

// ---------------------------------------------------------------------------
// isValidConditionSyntax
// ---------------------------------------------------------------------------

describe('isValidConditionSyntax', () => {
  // ── Valid === patterns ──────────────────────────────────────────────────

  it('accepts: previous.status === \'succeeded\'', () => {
    expect(isValidConditionSyntax("previous.status === 'succeeded'")).toBe(true)
  })

  it('accepts: previous.status === \'failed\'', () => {
    expect(isValidConditionSyntax("previous.status === 'failed'")).toBe(true)
  })

  it('accepts: previous.status === \'running\'', () => {
    expect(isValidConditionSyntax("previous.status === 'running'")).toBe(true)
  })

  it('accepts: previous.status === \'queued\'', () => {
    expect(isValidConditionSyntax("previous.status === 'queued'")).toBe(true)
  })

  // ── Valid !== patterns ──────────────────────────────────────────────────

  it('accepts: previous.status !== \'succeeded\'', () => {
    expect(isValidConditionSyntax("previous.status !== 'succeeded'")).toBe(true)
  })

  it('accepts: previous.status !== \'failed\'', () => {
    expect(isValidConditionSyntax("previous.status !== 'failed'")).toBe(true)
  })

  // ── Extra whitespace is tolerated ───────────────────────────────────────

  it('accepts extra spaces around the operator', () => {
    expect(isValidConditionSyntax("previous.status  ===  'succeeded'")).toBe(true)
    expect(isValidConditionSyntax("previous.status  !==  'failed'")).toBe(true)
  })

  it('accepts leading/trailing whitespace in the expression', () => {
    expect(isValidConditionSyntax("  previous.status === 'succeeded'  ")).toBe(true)
  })

  // ── Invalid patterns ────────────────────────────────────────────────────

  it('rejects an empty string', () => {
    expect(isValidConditionSyntax('')).toBe(false)
  })

  it('rejects a random string', () => {
    expect(isValidConditionSyntax('always')).toBe(false)
  })

  it('rejects an unknown status value', () => {
    expect(isValidConditionSyntax("previous.status === 'pending'")).toBe(false)
    expect(isValidConditionSyntax("previous.status === 'done'")).toBe(false)
  })

  it('rejects == (single equals)', () => {
    expect(isValidConditionSyntax("previous.status == 'succeeded'")).toBe(false)
  })

  it('rejects != (not !==)', () => {
    expect(isValidConditionSyntax("previous.status != 'failed'")).toBe(false)
  })

  it('rejects a reference other than previous', () => {
    expect(isValidConditionSyntax("current.status === 'succeeded'")).toBe(false)
    expect(isValidConditionSyntax("task.status === 'succeeded'")).toBe(false)
  })

  it('rejects property access other than .status', () => {
    expect(isValidConditionSyntax("previous.result === 'succeeded'")).toBe(false)
  })

  it('rejects an eval-like string', () => {
    expect(isValidConditionSyntax("process.exit(1)")).toBe(false)
  })

  it('rejects a string that starts correctly but has trailing garbage', () => {
    expect(isValidConditionSyntax("previous.status === 'succeeded' && true")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// evaluateCondition
// ---------------------------------------------------------------------------

const succeeded: StepContext = { previous: { status: 'succeeded' } }
const failed: StepContext = { previous: { status: 'failed' } }
const running: StepContext = { previous: { status: 'running' } }
const queued: StepContext = { previous: { status: 'queued' } }
const noPrevious: StepContext = { previous: undefined }

describe('evaluateCondition — === patterns', () => {
  it('returns true when previous.status matches ===', () => {
    expect(evaluateCondition("previous.status === 'succeeded'", succeeded)).toBe(true)
    expect(evaluateCondition("previous.status === 'failed'", failed)).toBe(true)
    expect(evaluateCondition("previous.status === 'running'", running)).toBe(true)
    expect(evaluateCondition("previous.status === 'queued'", queued)).toBe(true)
  })

  it('returns false when previous.status does not match ===', () => {
    expect(evaluateCondition("previous.status === 'succeeded'", failed)).toBe(false)
    expect(evaluateCondition("previous.status === 'failed'", succeeded)).toBe(false)
  })

  it('returns false when previous is undefined and === is used', () => {
    expect(evaluateCondition("previous.status === 'succeeded'", noPrevious)).toBe(false)
    expect(evaluateCondition("previous.status === 'failed'", noPrevious)).toBe(false)
  })
})

describe('evaluateCondition — !== patterns', () => {
  it('returns true when previous.status does not match !==', () => {
    expect(evaluateCondition("previous.status !== 'succeeded'", failed)).toBe(true)
    expect(evaluateCondition("previous.status !== 'failed'", succeeded)).toBe(true)
  })

  it('returns false when previous.status matches !==', () => {
    expect(evaluateCondition("previous.status !== 'succeeded'", succeeded)).toBe(false)
    expect(evaluateCondition("previous.status !== 'failed'", failed)).toBe(false)
  })

  it('returns true when previous is undefined (undefined !== \'succeeded\')', () => {
    // undefined !== 'succeeded' is true — step runs when no prior result exists
    expect(evaluateCondition("previous.status !== 'succeeded'", noPrevious)).toBe(true)
  })

  it('returns true when previous is undefined (undefined !== \'failed\')', () => {
    expect(evaluateCondition("previous.status !== 'failed'", noPrevious)).toBe(true)
  })
})

describe('evaluateCondition — edge cases', () => {
  it('returns false for an unrecognized pattern (fail-safe)', () => {
    expect(evaluateCondition('always', succeeded)).toBe(false)
    expect(evaluateCondition('', succeeded)).toBe(false)
    expect(evaluateCondition("previous.status == 'succeeded'", succeeded)).toBe(false)
  })

  it('returns false for a condition with an invalid status literal', () => {
    // isValidConditionSyntax would reject this, but evaluateCondition must also
    // handle it safely if somehow stored (defence in depth).
    expect(evaluateCondition("previous.status === 'done'", succeeded)).toBe(false)
  })

  it('tolerates extra whitespace in the condition string', () => {
    expect(evaluateCondition("  previous.status  ===  'succeeded'  ", succeeded)).toBe(true)
    expect(evaluateCondition("  previous.status  !==  'failed'  ", succeeded)).toBe(true)
  })
})
