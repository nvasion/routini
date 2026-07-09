/**
 * Public entry point for the AI settings module.
 *
 * Consumers should import from here rather than reaching into individual
 * files so the internals can be reorganised without changing import paths.
 */

export { AiSettingsStore } from './store.js'
export type { AiSettingsStoreOptions } from './store.js'
export { createAiSettingsRouter } from './routes.js'
export {
  validateUpdateAiSettings,
  AI_API_KEY_MAX_LENGTH,
  AI_MAX_TOKENS_MAX,
  AI_MAX_TOKENS_MIN,
  AI_MODEL_MAX_LENGTH,
  AI_TEMPERATURE_MAX,
  AI_TEMPERATURE_MIN,
} from './validation.js'
export {
  Encryptor,
  EncryptionError,
  AI_ENCRYPTION_KEY_BYTES,
  generateEncryptionKey,
  parseEncryptionKey,
} from './encryption.js'
export { AI_ENCRYPTION_KEY_ENV, resolveAiEncryptor } from './config.js'
export { VALID_AI_PROVIDERS } from './types.js'
export type {
  AiProvider,
  AiModelParameters,
  AiSettingsView,
  UpdateAiSettingsInput,
} from './types.js'
