// What an action executor (http / ssh / imap) needs from its caller: an id for
// log context and string-valued config. The engine maps each step's typed
// config onto this shape.
export interface ActionTask {
  id: string
  name?: string
  config: Record<string, string>
}
