/**
 * Safe condition evaluator for routine step conditions.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Security
 * ─────────────────────────────────────────────────────────────────────────────
 * Conditions are user-supplied strings stored alongside routine steps. This
 * module deliberately avoids `eval()` and the `Function()` constructor — doing
 * so would let an attacker execute arbitrary server-side JavaScript by storing
 * a malicious condition. Instead the evaluator recognises only the two patterns
 * documented below and returns `false` for anything else (fail-safe: skip the
 * step rather than unexpectedly execute it).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Supported condition syntax
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   previous.status === '<RunStatus>'   – run if previous step has that status
 *   previous.status !== '<RunStatus>'   – run if previous step lacks that status
 *
 * Where <RunStatus> is one of: queued | running | succeeded | failed
 *
 * The `previous` reference always points to the most recently *executed* step's
 * run (skipped steps do not update it). For the first step, `previous` is
 * undefined; a condition referencing `previous.status === 'succeeded'` on the
 * first step therefore evaluates to `false` and the step is skipped.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Validation
 * ─────────────────────────────────────────────────────────────────────────────
 * `isValidConditionSyntax` is exported for use in the validation layer so
 * malformed condition strings are rejected at create / update time rather than
 * silently skipping steps at runtime.
 */

import type { RunStatus } from '../types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StepContext {
  /**
   * The status reported by the most recently *executed* step's run.
   * Undefined when no prior step has run (i.e. the first step, or all
   * preceding steps were skipped).
   */
  previous: { status: RunStatus } | undefined
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** All valid RunStatus literals — used to reject nonsense values in conditions. */
const VALID_STATUSES = new Set<string>(['queued', 'running', 'succeeded', 'failed'])

/** Matches: `previous.status === 'value'` (optional whitespace around ===) */
const EQ_PATTERN = /^previous\.status\s*===\s*'([^']*)'$/

/** Matches: `previous.status !== 'value'` (optional whitespace around !==) */
const NEQ_PATTERN = /^previous\.status\s*!==\s*'([^']*)'$/

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns `true` when `condition` is a syntactically valid step condition that
 * the evaluator recognises. Used by the validation layer (see
 * `tasks/validation.ts`) to reject unrecognized expressions at write time.
 */
export function isValidConditionSyntax(condition: string): boolean {
  const t = condition.trim()

  const eqMatch = EQ_PATTERN.exec(t)
  if (eqMatch) return VALID_STATUSES.has(eqMatch[1])

  const neqMatch = NEQ_PATTERN.exec(t)
  if (neqMatch) return VALID_STATUSES.has(neqMatch[1])

  return false
}

/**
 * Parse and evaluate a step condition string against the given runtime context.
 *
 * @param condition  The raw condition string stored on the RoutineStep.
 * @param ctx        Runtime context containing the previous step's result.
 * @returns          `true`  → the step should run
 *                   `false` → the step should be skipped
 */
export function evaluateCondition(condition: string, ctx: StepContext): boolean {
  const t = condition.trim()

  const eqMatch = EQ_PATTERN.exec(t)
  if (eqMatch) {
    const expected = eqMatch[1]
    // Guard against a condition with an invalid status literal.
    if (!VALID_STATUSES.has(expected)) return false
    return ctx.previous?.status === (expected as RunStatus)
  }

  const neqMatch = NEQ_PATTERN.exec(t)
  if (neqMatch) {
    const expected = neqMatch[1]
    if (!VALID_STATUSES.has(expected)) return false
    return ctx.previous?.status !== (expected as RunStatus)
  }

  // Unrecognized pattern — fail safe: skip the step.
  return false
}
