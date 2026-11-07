/** A view-independent admission gate, not an execution queue or ledger. */
interface AluAdmission { busy: boolean; candidateSince: number | null }
const admissions = new WeakMap<object, Map<string, AluAdmission>>()
export function aluAdmission(workspace: object, instanceId: string): AluAdmission {
  let instances = admissions.get(workspace)
  if (!instances) { instances = new Map(); admissions.set(workspace, instances) }
  let gate = instances.get(instanceId)
  if (!gate) { gate = { busy: false, candidateSince: null }; instances.set(instanceId, gate) }
  return gate
}
