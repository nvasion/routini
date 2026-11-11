// The images a fleet host pulls: the published defaults (.github/workflows/images.yml)
// and the ROUTINI_FLEET_* overrides.

import { describe, it, expect } from 'vitest'
import { fleetAgentImages, fleetEnvImages, fleetEgressImage } from '../server/src/engine/fleetImages'

describe('fleet images', () => {
  it('defaults Claude Code and Omnimancer to their GHCR images', () => {
    expect(fleetAgentImages({})).toEqual({
      claude: 'ghcr.io/nvasion/routini-agent-claude:latest',
      omnimancer: 'ghcr.io/nvasion/routini-agent-omnimancer:latest',
    })
    expect(fleetEgressImage({})).toBe('ghcr.io/nvasion/routini-egress:latest')
  })

  it('takes each agent image from its own variable', () => {
    const images = fleetAgentImages({
      ROUTINI_FLEET_AGENT_IMAGE_OMNIMANCER: 'registry.example.com/omni:1',
    })
    expect(images.claude).toBe('ghcr.io/nvasion/routini-agent-claude:latest')
    expect(images.omnimancer).toBe('registry.example.com/omni:1')
  })

  it('lets environments use every published agent image, Claude Code first', () => {
    expect(fleetEnvImages({})).toEqual([
      'ghcr.io/nvasion/routini-agent-claude:latest',
      'ghcr.io/nvasion/routini-agent-omnimancer:latest',
    ])
    expect(fleetEnvImages({ ROUTINI_FLEET_ENV_IMAGES: ' a:1, b:2 ' })).toEqual(['a:1', 'b:2'])
  })
})
