import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { IntegrationIcon, initials } from './IntegrationIcon'
import { INTEGRATION_ICONS } from './integrationIcons'

describe('IntegrationIcon', () => {
  it('draws a known mark in currentColor', () => {
    const { container } = render(<IntegrationIcon id="azure-devops" name="Azure DevOps" />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('fill')).toBe('currentColor')
    expect(svg.querySelectorAll('path').length).toBe(INTEGRATION_ICONS['azure-devops']!.paths.length)
  })

  it('falls back to initials for an integration without a mark', () => {
    const { container } = render(<IntegrationIcon id="ttyy" name="ttyy.ai" />)
    expect(container.querySelector('svg')).toBeNull()
    expect(container.textContent).toBe('TT')
  })

  it('uses the Factory mark as a mask so it stays monochrome', () => {
    const { container } = render(<IntegrationIcon id="factory" name="Factory" />)
    expect(container.querySelector('svg')).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('every mark has a viewBox and at least one path', () => {
    for (const [id, icon] of Object.entries(INTEGRATION_ICONS)) {
      expect(icon.viewBox, id).toMatch(/^0 0 \d+ \d+$/)
      expect(icon.paths.length, id).toBeGreaterThan(0)
    }
  })

  it('initials', () => {
    expect(initials('Microsoft Teams')).toBe('MT')
    expect(initials('ttyy.ai')).toBe('TT')
    expect(initials('')).toBe('?')
  })
})
