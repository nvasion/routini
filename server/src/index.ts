import { createApp } from './app.js'
import { loadConfig } from './config.js'

const config = loadConfig()
const app = createApp(config)

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`Server running on http://localhost:${config.port}`)
})
