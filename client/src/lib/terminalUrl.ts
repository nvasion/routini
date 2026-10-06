// WebSocket URL for an environment's terminal, same origin as the console.
export function terminalUrl(org: string, envId: string, cols: number, rows: number, loc: Pick<Location, 'protocol' | 'host'> = window.location): string {
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${loc.host}/api/orgs/${encodeURIComponent(org)}/environments/${envId}/terminal?cols=${cols}&rows=${rows}`
}

// WebSocket URL for a fleet host's terminal (runner PTY or SSH shell).
export function hostTerminalUrl(org: string, hostId: string, cols: number, rows: number, loc: Pick<Location, 'protocol' | 'host'> = window.location): string {
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${loc.host}/api/orgs/${encodeURIComponent(org)}/hosts/${hostId}/terminal?cols=${cols}&rows=${rows}`
}
