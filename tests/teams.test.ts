/**
 * Unit tests for server/src/integrations/teams.ts — the Microsoft Teams
 * webhook URL validator and Adaptive Card payload builder. postTeamsMessage
 * itself is exercised indirectly via the 'teams' provider test in
 * tests/integrationProviders.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { validateTeamsWebhookUrl, teamsMessagePayload } from '../server/src/integrations/teams'

describe('validateTeamsWebhookUrl', () => {
  it('returns the parsed URL for a valid logic.azure.com webhook', () => {
    const url = validateTeamsWebhookUrl('https://prod-01.westus.logic.azure.com/workflows/x')
    expect(url).toBeInstanceOf(URL)
    expect(url.hostname).toBe('prod-01.westus.logic.azure.com')
  })

  it('accepts each documented Microsoft webhook host suffix', () => {
    for (const url of [
      'https://contoso.webhook.office.com/hook',
      'https://contoso.powerplatform.com/hook',
      'https://contoso.powerautomate.com/hook',
    ]) {
      expect(() => validateTeamsWebhookUrl(url)).not.toThrow()
    }
  })

  it('rejects an unparseable URL', () => {
    expect(() => validateTeamsWebhookUrl('not a url')).toThrow('Teams webhook URL is not a valid URL')
  })

  it('rejects a non-https URL', () => {
    expect(() => validateTeamsWebhookUrl('http://prod-01.westus.logic.azure.com/workflows/x')).toThrow(
      'Teams webhook URL must use https',
    )
  })

  it('rejects a URL with embedded credentials', () => {
    expect(() =>
      validateTeamsWebhookUrl('https://user:pass@prod-01.westus.logic.azure.com/workflows/x'),
    ).toThrow('Teams webhook URL must not contain embedded credentials')
  })

  it('rejects a host that is not a Microsoft webhook host', () => {
    expect(() => validateTeamsWebhookUrl('https://evil.example.com/hook')).toThrow(
      'Teams webhook URL host is not a Microsoft webhook host',
    )
  })

  it('rejects a host that merely contains a suffix as a substring, not as its true suffix', () => {
    expect(() => validateTeamsWebhookUrl('https://logic.azure.com.evil.com/hook')).toThrow(
      'Teams webhook URL host is not a Microsoft webhook host',
    )
  })
})

describe('teamsMessagePayload', () => {
  it('includes a title TextBlock when a title is given', () => {
    const payload = teamsMessagePayload('hello world', 'My Title') as any
    expect(payload.type).toBe('message')
    expect(payload.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive')
    const body = payload.attachments[0].content.body
    expect(body).toHaveLength(2)
    expect(body[0]).toEqual({ type: 'TextBlock', text: 'My Title', weight: 'Bolder', size: 'Medium', wrap: true })
    expect(body[1]).toEqual({ type: 'TextBlock', text: 'hello world', wrap: true })
  })

  it('omits the title TextBlock when no title is given', () => {
    const payload = teamsMessagePayload('hello world') as any
    const body = payload.attachments[0].content.body
    expect(body).toHaveLength(1)
    expect(body[0]).toEqual({ type: 'TextBlock', text: 'hello world', wrap: true })
  })
})
