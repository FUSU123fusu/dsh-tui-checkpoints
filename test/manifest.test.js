/**
 * manifest.test.js — validate dsh-plugin.json against the TUI admission
 * schema's hard requirements (hand-rolled, zero deps): required fields,
 * id/version patterns, registry-pinned contract hashes, permission enum,
 * namespaced command ids.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// Pinned from dsh-ecosystem-spec registry-0.1.json.
const REGISTRY = {
  'storage.local': { version: '0.1', schemaHash: 'sha256:0825964a6fa23ce8a536c3c4c649c58a174c2984f27cabda9fea9d72fe88bf2f' },
  'commands': { version: '0.1', schemaHash: 'sha256:44fd09e55246deef61dae0f4d07b84ec88160201226d414b29d46fc759be75b1' },
  'messages.observe': { version: '0.1', schemaHash: 'sha256:666030568d12b319d159a7c1d3b60df883ac2142fe4699d60b3e780c8a3f9286' },
}
const PERMISSIONS = new Set(['messages.observe.read', 'storage.local.read', 'storage.local.write', 'commands.invoke'])

const manifest = JSON.parse(readFileSync(new URL('../dsh-plugin.json', import.meta.url), 'utf8'))

test('dsh-plugin.json passes TUI admission hard requirements', () => {
  assert.equal(manifest.$schema, 'https://dsh.community/schemas/dsh-plugin-0.1.json')
  assert.match(manifest.id, /^[a-z0-9]+([.-][a-z0-9]+)*$/)
  assert.ok(manifest.id.length >= 3)
  assert.equal(typeof manifest.name, 'string')
  assert.match(manifest.version, /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/)
  assert.equal(manifest.manifestVersion, '0.1')
  assert.match(manifest.apiVersion, /^0\.1(\.x)?$/)
  assert.ok(typeof manifest.entry === 'string' && !manifest.entry.startsWith('/') && !manifest.entry.includes('..'))

  // Capability refs must resolve to the registry with matching hashes.
  for (const tier of ['required', 'optional']) {
    for (const ref of manifest.requires.capabilities[tier]) {
      const known = REGISTRY[ref.name]
      assert.ok(known !== undefined, `unknown capability ${ref.name}`)
      assert.equal(ref.version, known.version, `${ref.name} version drift`)
      assert.equal(ref.schemaHash, known.schemaHash, `${ref.name} schemaHash drift`)
    }
  }
  // v0.1 MUST NOT declare requires.services.
  assert.ok(manifest.requires.services === undefined || manifest.requires.services.length === 0)

  for (const permission of manifest.permissions) {
    assert.ok(PERMISSIONS.has(permission.name), `unknown permission ${permission.name}`)
    assert.ok(typeof permission.scope === 'string' && permission.scope.length > 0)
  }

  const ids = new Set()
  for (const command of manifest.contributes.commands) {
    assert.match(command.id, /^[a-z0-9]+([.-][a-z0-9]+)*\.[a-z0-9]+([.-][a-z0-9]+)*$/, `command id ${command.id} not namespaced`)
    assert.ok(command.id.startsWith(`${manifest.id}.`), `command id ${command.id} outside plugin namespace`)
    assert.ok(!ids.has(command.id), `duplicate command id ${command.id}`)
    ids.add(command.id)
    assert.ok(command.title.length > 0)
  }

  assert.ok(manifest.license.length > 0)
  assert.ok(manifest.source.repository.startsWith('https://'))
  assert.equal(manifest.provides, undefined)
})
