import test from 'node:test'
import assert from 'node:assert/strict'
import { inflateRawSync, crc32 } from 'node:zlib'
import { zipFiles } from '../package-release.mjs'
test('Chrome archive preserves entry paths, bytes and integrity fields', () => {
  const bytes = Buffer.from('Synthetic extension payload 中文')
  const archive = zipFiles([['panel/index.html', bytes]])
  assert.equal(archive.readUInt32LE(0), 0x04034b50)
  assert.equal(archive.readUInt32LE(14), crc32(bytes))
  const nameLength = archive.readUInt16LE(26), size = archive.readUInt32LE(18)
  assert.equal(archive.subarray(30, 30 + nameLength).toString(), 'panel/index.html')
  assert.deepEqual(inflateRawSync(archive.subarray(30 + nameLength, 30 + nameLength + size)), bytes)
  assert.equal(archive.readUInt32LE(archive.length - 22), 0x06054b50)
  assert.throws(() => zipFiles([['../private', bytes]]), /Unsafe archive/)
})
