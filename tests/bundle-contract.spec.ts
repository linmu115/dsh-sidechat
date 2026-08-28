import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function sourceFiles(root: string): string[] {
  const parts: string[] = []
  for (const name of readdirSync(root)) {
    const path = join(root, name)
    if (statSync(path).isDirectory()) parts.push(...sourceFiles(path))
    else if (/\.(?:ts|tsx|css)$/.test(name)) parts.push(readFileSync(path, 'utf8'))
  }
  return parts
}

describe('consumer bundle contract', () => {
  it('ships the live Manager model-select contract in the 0.3.2 package', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      version: string
      files: string[]
      peerDependencies: Record<string, string>
    }
    expect(packageJson.version).toBe('0.3.2')
    expect(packageJson.files).toContain('dsh-management')
    expect(packageJson.files).toContain('docs/changes')
    expect(packageJson.peerDependencies['@deepseek-ai/dsh-settings']).toBe('*')
    expect(packageJson.peerDependencies['@deepseek-ai/dsh-host-webserver']).toBe('*')

    const panel = readFileSync(join(process.cwd(), 'dsh-management', 'panel.yaml'), 'utf8')
    for (const contract of [
      'contractVersion: 2',
      'type: model-select',
      'default: null',
      'allowInherit: true',
      'apply: save',
      'kind: dsh-settings',
      'namespace: dsh-sidechat',
      'key: defaultModelRoute',
      'actions: []',
    ]) expect(panel).toContain(contract)
    expect(panel).not.toContain('restart-required')

    const patch = readFileSync(join(process.cwd(), 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('defaultModelRoute: null')
  })

  it('keeps host and plugin peers version-open', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      peerDependencies: Record<string, string>
    }
    expect(new Set(Object.values(packageJson.peerDependencies))).toEqual(new Set(['*']))
    expect(packageJson.peerDependencies['dsh-annotation-core']).toBe('*')
    expect(packageJson.peerDependencies['dsh-better-sidebar']).toBe('*')
  })

  it('contains no legacy annotation state, quote codec, hidden chip, or copied core runtime', () => {
    const files = sourceFiles(join(process.cwd(), 'src'))
    const source = files.join('\n')
    for (const forbidden of [
      'dsh-sidechat-annotations',
      'dsh-sidechat-hidden',
      'buildQuoteBlock',
      'data-dsh-sidechat-reference-dock',
      'createPendingReferenceSet',
      'Note: {note}',
      '注解：{note}',
    ]) expect(source).not.toContain(forbidden)
    for (const file of files) {
      for (const statement of file.matchAll(/import[^\n;]*dsh-annotation-core[^\n;]*/g)) {
        expect(statement[0]).toMatch(/^import\s+type\b/)
      }
    }

    const bundle = join(process.cwd(), 'lib', 'client.js')
    if (existsSync(bundle)) {
      const text = readFileSync(bundle, 'utf8')
      expect(text).not.toMatch(/require\(['"]dsh-annotation-core(?:\/[^'"]*)?['"]\)/)
      expect(text).not.toContain('createPendingReferenceSet')
    }
  })

  it('build purity rejects any future core value import', () => {
    const config = readFileSync(join(process.cwd(), 'tsdown.config.ts'), 'utf8')
    expect(config).toContain("source === 'dsh-annotation-core'")
    expect(config).toContain("source.startsWith('dsh-annotation-core/')")
  })
})
