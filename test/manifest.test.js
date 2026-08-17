/**
 * manifest.test.js — validate dsh-plugin.json against the TUI admission
 * v0.15 hard requirements (hand-rolled, zero deps): required fields,
 * id/version patterns, facets.host shape, registry-pinned contract
 * coordinates, permission enum, namespaced command ids.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// Pinned from dsh-ecosystem-spec registry-0.15.json (std imports).
// v0.15 references contracts by Kubernetes-style coordinates; there is no
// per-contract schemaHash on std imports anymore.
const COORDINATES = new Set([
  'commands.dsh/v1alpha1#Command',
  'messages.dsh/v1alpha1#MessageObserver',
  'storage.dsh/v1alpha1#LocalStorage',
])
// Pinned from dsh-ecosystem-spec permissions-0.1.json.
const PERMISSIONS = new Set([
  'commands.invoke',
  'messages.observe.read',
  'storage.local.read',
  'storage.local.write',
  'session.input.intercept',
  'session.rewind.intercept',
  'session.switch.intercept',
  'session.compact.intercept',
])

const manifest = JSON.parse(readFileSync(new URL('../dsh-plugin.json', import.meta.url), 'utf8'))

test('dsh-plugin.json passes TUI admission v0.15 hard requirements', () => {
  assert.equal(manifest.$schema, 'https://dsh.community/schemas/dsh-plugin-0.15.json')
  assert.match(manifest.id, /^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)+$/)
  assert.ok(manifest.id.length >= 3)
  assert.equal(typeof manifest.name, 'string')
  assert.match(manifest.version, /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/)
  assert.equal(manifest.manifestVersion, '0.15')

  // v0.15 moves entry/apiVersion into facets.host; the top-level fields are removed.
  assert.ok(manifest.facets && typeof manifest.facets === 'object', 'facets required')
  assert.ok(typeof manifest.facets.host?.entry === 'string' && manifest.facets.host.entry.length > 0, 'facets.host.entry required')
  assert.ok(!manifest.facets.host.entry.startsWith('/') && !manifest.facets.host.entry.includes('..'))
  assert.equal(manifest.facets.host.apiVersion, 'v1alpha1')
  assert.equal(manifest.entry, undefined, 'top-level entry removed in v0.15')
  assert.equal(manifest.apiVersion, undefined, 'top-level apiVersion removed in v0.15')
  assert.equal(manifest.facets.client, undefined, 'client is a reserved facet name')
  assert.equal(manifest.facets.worker, undefined, 'worker is a reserved facet name')

  // Contract refs must resolve to the pinned registry coordinates.
  assert.ok(Array.isArray(manifest.requires.contracts), 'requires.contracts required')
  const seen = new Set()
  for (const ref of manifest.requires.contracts) {
    const key = `${ref.apiVersion}#${ref.kind}`
    assert.ok(COORDINATES.has(key), `unknown contract coordinate ${key}`)
    assert.ok(!seen.has(key), `duplicate contract coordinate ${key}`)
    seen.add(key)
    if (ref.optional === true) {
      assert.ok(typeof ref.fallback === 'string' && ref.fallback.length > 0, `optional contract ${key} requires a TUI fallback`)
    }
  }
  // v0.1 capability names must not survive the migration.
  assert.equal(manifest.requires.capabilities, undefined, 'requires.capabilities removed in v0.15')
  // requires.services stays inadmissible.
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

  assert.ok(Array.isArray(manifest.subscriptions))
  assert.ok(manifest.license.length > 0)
  assert.ok(manifest.source.repository.startsWith('https://'))
  assert.equal(manifest.provides, undefined)
})
