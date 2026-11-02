import { targetBuild } from './vite.shared.ts'

export default targetBuild('src/content/debugger.ts', 'iife', 'debugger-content.js', false)
