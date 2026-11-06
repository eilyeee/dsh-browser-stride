// Development distribution only: a standalone Host package plus unpacked Chrome files.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { crc32, deflateRawSync } from 'node:zlib'
import { mkdtemp, mkdir, readFile, writeFile, cp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export function zipFiles(files) {
  const local = [], central = []; let offset = 0
  for (const [path, bytes] of files) {
    if (!path || path.startsWith('/') || path.split('/').some(part => part === '..') || path.includes('\\')) throw new Error('Unsafe archive path')
    const name = Buffer.from(path), data = deflateRawSync(bytes), sum = crc32(bytes)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8)
    header.writeUInt16LE(33, 12) // 1980-01-01, the deterministic ZIP epoch.
    header.writeUInt32LE(sum, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26)
    const directory = Buffer.alloc(46)
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(8, 10)
    directory.writeUInt16LE(33, 14)
    directory.writeUInt32LE(sum, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42)
    local.push(header, name, data); central.push(directory, name); offset += header.length + name.length + data.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}
async function listFiles(root, prefix = '') {
  const result = []
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw new Error('Release inputs must not contain symlinks')
    if (entry.isDirectory()) result.push(...await listFiles(root, path))
    else if (entry.isFile()) result.push([path, await readFile(join(root, path))])
  }
  return result
}
export async function prepareRelease(repoRoot, output) {
  const json = async path => JSON.parse(await readFile(join(repoRoot, path), 'utf8'))
  const rootManifest = await json('package.json'), bridge = await json('packages/browser/bridge-browser/package.json')
  const extension = await json('extensions/dsh-browser/package.json'), chrome = await json('extensions/dsh-browser/dist/manifest.json')
  const version = rootManifest.version
  if ([bridge.version, extension.version, chrome.version].some(value => value !== version)) throw new Error('Build matching Host and extension versions before packaging')
  const stage = await mkdtemp(join(tmpdir(), 'stride-release-'))
  const packageDir = join(stage, 'host')
  await mkdir(packageDir)
  await mkdir(output, { recursive: false })
  try {
    // Only tracked/public source files are eligible. npm's broad src glob must
    // never sweep up an ignored local planning document or real-site evidence.
    const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'packages/browser/bridge-browser/src'], { cwd: repoRoot, encoding: 'utf8' })
    if (listed.status !== 0) throw new Error('Cannot enumerate public package sources')
    for (const path of listed.stdout.split('\0').filter(Boolean)) {
      const target = join(packageDir, relative('packages/browser/bridge-browser', path))
      await mkdir(dirname(target), { recursive: true }); await cp(join(repoRoot, path), target, { dereference: false })
    }
    const libRoot = join(repoRoot, 'packages/browser/bridge-browser/lib')
    for (const path of ['index.js', 'protocol.js', 'client.js']) {
      await mkdir(join(packageDir, 'lib'), { recursive: true }); await cp(join(libRoot, path), join(packageDir, 'lib', path))
    }
    for (const [path, data] of await listFiles(join(libRoot, 'types'))) if (path.endsWith('.d.ts')) {
      const target = join(packageDir, 'lib/types', path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, data)
    }
    await cp(join(repoRoot, 'packages/browser/bridge-browser/cordis.patch.yml'), join(packageDir, 'cordis.patch.yml'))
    for (const path of ['LICENSE', 'NOTICE.md']) await cp(join(repoRoot, path), join(packageDir, path))
    const { devDependencies, scripts, ...manifest } = bridge
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({ ...manifest, files: ['lib', 'src', 'cordis.patch.yml', 'LICENSE', 'NOTICE.md'] }, null, 2) + '\n')
    const hostName = `dsh-browser-stride-host-${version}.tgz`, chromeName = `dsh-browser-stride-chrome-${version}.zip`
    const packed = spawnSync('pnpm', ['pack', '--out', join(output, hostName)], { cwd: packageDir, encoding: 'utf8' })
    if (packed.status !== 0) throw new Error('Host package packing failed')
    await writeFile(join(output, chromeName), zipFiles(await listFiles(join(repoRoot, 'extensions/dsh-browser/dist'))))
    const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' })
    const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' })
    const metadata = { development: true, version, dshVersion: rootManifest.dependencies['@deepseek-ai/dsh'], wireProtocol: 4,
      commit: git.status === 0 ? git.stdout.trim() : undefined, dirty: dirty.stdout.trim() !== '', host: hostName, chrome: chromeName }
    await writeFile(join(output, 'versions.json'), JSON.stringify(metadata, null, 2) + '\n')
    await writeFile(join(output, 'install-host.mjs'), `import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const metadata=JSON.parse(readFileSync(new URL('./versions.json',import.meta.url)));
const name=metadata.host,path=fileURLToPath(new URL('./'+name,import.meta.url));
const sums=readFileSync(new URL('./SHA256SUMS',import.meta.url),'utf8').trim().split('\\n');
const expected=sums.find(line=>line.endsWith('  '+name))?.slice(0,64);
if(createHash('sha256').update(readFileSync(path)).digest('hex')!==expected)throw Error('Host archive checksum mismatch');
const child=spawnSync(process.env.DSH_BIN||'dsh',['plugin','--profile','web','add','-w','file:'+path],{stdio:'inherit',shell:false});
if(child.status!==0)process.exit(child.status||1);
console.log('Installed. Keep the original DSH home/profile. When tasks are idle, restart that Host; reload the matching browser extension.');
`)
    await writeFile(join(output, 'README.md'), `# DSH Stride ${version} — 开发版\n\n需 Node ${rootManifest.engines.node}、DSH ${metadata.dshVersion}。这份包未声明正式支持或浏览器商店发布。\n\n1. 先核对 SHA256SUMS。校验可发现文件变化，不能证明来源可信。\n2. 保持原 DSH_HOME 和 web profile，在本目录执行 node install-host.mjs。无需本仓库源码或全局升级 DSH；DSH_BIN 可指定现有 dsh 可执行文件。\n3. 等正在运行的任务结束后，重启原 Host。安装脚本不会替你关闭运行中的 Host。\n4. 解压 ${chromeName} 到固定目录，在 chrome://extensions 开启开发者模式，加载该目录。更新时覆盖同一目录并点击重新加载，以保留扩展安装身份和配对。\n5. 打开扩展设置，核对 Host/扩展版本均为 ${version}。已有页面重新点击工具栏图标授权；聊天和任务资料保留，未决保存须先核对实际结果。\n\nHost 插件和 Chrome 扩展分别安装。GitHub 插件入口安装仓库根目录、商店自动更新、Firefox 和 Desktop 集成均不属于此开发包验收。\n\n卸载插件使用 dsh plugin --profile web remove @eilyeee/dsh-browser-stride；不会自动删除对话和配对文件。回退前停止任务并备份原 DSH home；数据降级兼容性没有保证。\n`)
    const files = await listFiles(output)
    await writeFile(join(output, 'SHA256SUMS'), files.map(([name, bytes]) => `${createHash('sha256').update(bytes).digest('hex')}  ${name}`).join('\n') + '\n')
    return metadata
  } finally { await rm(stage, { recursive: true, force: true }) }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoRoot = resolve(import.meta.dirname, '..')
  const outputIndex = process.argv.indexOf('--out')
  const parent = join(repoRoot, '.stride-private/releases')
  await mkdir(parent, { recursive: true })
  const version = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')).version
  const output = outputIndex >= 0 ? resolve(process.argv[outputIndex + 1]) : join(parent, version)
  console.log(JSON.stringify(await prepareRelease(repoRoot, output)))
}
