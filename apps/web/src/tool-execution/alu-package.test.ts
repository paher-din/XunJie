import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { canonicalValue } from '@xunjie/contracts/execution'
import { aluPackage, aluCoursePackage } from '../../../../components/alu-experiment/package.mjs'

describe('ALU course package version 2', () => {
  it('declares the three operations, the expanded state and a distinct check scaffold', async () => {
    const component = await aluPackage()
    const manifest = component.manifest
    if (manifest.formatVersion !== 3) throw new Error('ALU package is not a format 3 runtime')
    expect(manifest.formatVersion).toBe(3)
    expect(manifest.version).toBe(2)
    expect(manifest.stateVersion).toBe(2)
    expect(manifest.runtime.operations.map(operation => operation.operationId))
      .toEqual(['run-single', 'observe-enabled', 'check-all'])
    const check = manifest.runtime.operations.find(operation => operation.operationId === 'check-all')!
    const single = manifest.runtime.operations.find(operation => operation.operationId === 'run-single')!
    const observe = manifest.runtime.operations.find(operation => operation.operationId === 'observe-enabled')!
    expect(check.parameters).toEqual({ type: 'object', properties: {} })
    expect(single.parameters).toMatchObject({ type: 'object', properties: { A: { type: 'number' }, Cin: { type: 'number' } } })
    expect(observe.parameters).toEqual(single.parameters)
    expect(single.observation.scaffoldResourceId).toBe(observe.observation.scaffoldResourceId)
    expect(check.observation.scaffoldResourceId).not.toBe(single.observation.scaffoldResourceId)
    const scaffoldPath = (id: string) => manifest.runtime.resources.find(resource => resource.resourceId === id)?.path
    expect(scaffoldPath(check.observation.scaffoldResourceId)).toBe('check.sv')
    expect(scaffoldPath(single.observation.scaffoldResourceId)).toBe('single.sv')
    if (manifest.stateShape.type !== 'object') throw new Error('ALU state is not an object')
    expect(new Set(Object.keys(manifest.stateShape.properties))).toEqual(new Set(['A', 'B', 'Cin', 'M', 'S', 'activationRevision',
      'enabledBasis', 'feedbackPolicy', 'inputRevision', 'pendingActivation', 'pendingActivationBase',
      'pendingActivationRevision', 'selectedCheck', 'selectedCheckBasis', 'selectedObservation', 'selectedObservationRevision']))
    expect(manifest.initialState).toMatchObject({ A: 0, B: 0, M: 0, S: 0, Cin: 0, feedbackPolicy: 'live', enabledBasis: '' })
    expect(component.runtimeResources).toHaveLength(manifest.runtime.resources.length)
  })

  it('publishes a plan with all three operations and student material with the mapping, 4096 domain and examples', async () => {
    const course = await aluCoursePackage()
    expect(course.release.executionPlan?.components[0]?.configurationDigest).toBe(
      createHash('sha256').update(JSON.stringify(canonicalValue(course.release.components![0]!.configuration))).digest('hex'))
    expect(course.release.executionPlan?.components[0]?.operations).toEqual(['run-single', 'observe-enabled', 'check-all'])
    expect(course.release.executionPlan?.planVersion).toBe(2)
    expect(course.release.requirements).toContain('4096')
    expect(course.release.requirements).toContain('运行')
    const material = await readFile(new URL('../../../../components/alu-experiment/learning.md', import.meta.url), 'utf8')
    expect(material).toContain('SW3…SW0')
    expect(material).toContain('4096')
    expect(material).toContain('1536')
    expect(material).toContain('1111 / 0000 / 1 / 00 / 1')
    expect(material).toContain('1111 / 1111 / 1 / 01 / 1')
    expect(material).not.toContain('always_comb')
    const starter = await readFile(new URL('../../../../components/alu-experiment/alu.sv', import.meta.url), 'utf8')
    expect(starter).toContain('TODO')
    expect(starter).not.toContain("F = ~A")
    expect(starter).not.toContain('case')
    const scaffold = await readFile(new URL('../../../../components/alu-experiment/check.sv', import.meta.url), 'utf8')
    expect(scaffold).toContain('ROUND')
    expect(scaffold).toContain('SAMPLE')
    expect(scaffold).toContain('for (i = 0; i < 4096; i = i + 1)')
    expect(scaffold).not.toContain('case (')
  })
})
