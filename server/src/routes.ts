import { Router } from 'express'
import { authRouter } from './routes/auth.js'
import { tasksRouter } from './routes/tasks.js'
import { settingsRouter } from './routes/settings.js'

export const router = Router()

router.use('/auth', authRouter)
router.use('/tasks', tasksRouter)
router.use('/settings', settingsRouter)

router.get('/version', (_req, res) => {
  res.json({ version: '0.1.0', name: 'routini' })
})
