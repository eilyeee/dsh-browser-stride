// Package the standalone Host and the unpacked Chrome extension together.
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
    const chromeFiles = await listFiles(join(repoRoot, 'extensions/dsh-browser/dist'))
    for (const path of ['LICENSE', 'NOTICE.md']) chromeFiles.push([path, await readFile(join(repoRoot, path))])
    await writeFile(join(output, chromeName), zipFiles(chromeFiles))
    const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' })
    const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' })
    const development = !/^[1-9]\d*\.\d+\.\d+$/.test(version)
    const metadata = { development, version, dshVersion: rootManifest.dependencies['@deepseek-ai/dsh'], wireProtocol: 4,
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
    const title = development ? `DSH Stride ${version} 开发包` : `DSH Stride ${version}`
    const scope = development
      ? '本包用于验证 DSH Web 与 Chrome 的连接和页面控制。'
      : '此版本支持 DSH Web 普通对话、Chrome 配对与分组页面控制。托管 /browser 任务仍处于预览阶段。'
    await writeFile(join(output, 'README.md'), `# ${title}

${scope}

需要 Node ${rootManifest.engines.node}、DSH ${metadata.dshVersion} 和 Chrome ${chrome.minimum_chrome_version}+。

1. 从可信来源取得同一版本的文件，按 SHA256SUMS 核对校验和。校验可以发现文件变化。
2. 更新前等正在运行的对话和任务结束。保留原 DSH_HOME 和 web profile，在本目录执行 node install-host.mjs。DSH_BIN 可以指定现有 dsh 可执行文件。
3. 启动 DSH Web。更新时重启原 Host，安装脚本会让原进程继续运行，便于你选择重启时机。
4. 解压 ${chromeName} 到固定目录。在 chrome://extensions 开启开发者模式并加载该目录。更新时覆盖同一目录，再点击「重新加载」，即可沿用原扩展安装和配对。
5. 打开扩展设置，核对 Host 和扩展均为 ${version}。首次安装时点击「连接本机 DSH」，再到 DSH 网页「设置 → 通用 → 浏览器配对」核对并确认校验码。
6. 回到要控制的标签页，点击 Chrome 工具栏上的 DSH Stride 图标授权。更新后也要点一次。对话和任务资料仍可使用。若有操作结果待核对，先检查页面实际结果。

下载新版后分别更新 Host 插件和 Chrome 扩展。更多用法见[项目说明](https://github.com/eilyeee/dsh-browser-stride/blob/main/README.zh.md)。

卸载 Host 插件使用 dsh plugin --profile web remove @eilyeee/dsh-browser-stride。对话和配对文件仍会保留。回退前请停止任务并备份原 DSH home，方便恢复较早的数据。
`)
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
