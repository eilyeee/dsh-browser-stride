// Test-only file scope. Writes stay available on one disposable file so the
// read-only behavioural check cannot pass merely by hiding editing tools.
import { lstat, realpath } from 'node:fs/promises'
import { lstatSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export const PROJECT_FILE_TOOLS = ['read', 'write', 'edit']
export async function materialProjectScope(projectFile) {
  const file = resolve(projectFile), stat = await lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Synthetic project target must be a regular file')
  return { file, canonicalFile: await realpath(file) }
}
// DSH ToolGuard is synchronous. A Promise would itself become a denial reason.
export function guardMaterialProjectFile(scope, args) {
  if (typeof args?.file_path !== 'string' || args.file_path.trim() === ''
    || args.sandbox_permissions !== undefined || args.justification !== undefined) return 'Synthetic project calls require the provided file without escalation.'
  try {
    if (!scope) return 'The synthetic project scope is unavailable.'
    const original = lstatSync(scope.file)
    if (!original.isFile() || original.isSymbolicLink() || realpathSync(scope.file) !== scope.canonicalFile) return 'The synthetic project file changed identity.'
    const candidate = resolve(dirname(scope.file), args.file_path)
    if (![scope.file, scope.canonicalFile].includes(candidate)) return 'This check permits only the provided disposable project file.'
    const stat = lstatSync(candidate)
    if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(candidate) !== scope.canonicalFile) return 'The synthetic project file changed identity.'
  } catch { return 'The synthetic project file is unavailable.' }
}
