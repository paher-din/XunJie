import { acceptsState, componentStateSchema, componentStateName, componentInstanceId } from '@xunjie/contracts/components';
import type { LearningActivity, WorkFile } from '@xunjie/contracts/learning-data';
import { StorageError } from '@xunjie/storage';

/** An imported view never defines its own permissions or a second state owner. */
export function validateComponentFiles(activity: LearningActivity, files: WorkFile[]) {
  for (const file of files) {
    if (file.mediaType !== 'application/vnd.xunjie.component-state+json') continue;
    const binding = activity.course?.components?.find(item => componentStateName(item.key) === file.name);
    if (!binding || file.kind !== 'state' || file.encoding !== 'json') throw new StorageError('invalid');
    let value;
    try { value = componentStateSchema.parse(JSON.parse(file.value)); } catch { throw new StorageError('invalid'); }
    const definition = binding.definition, manifest = definition.manifest;
    if (value.instanceId !== componentInstanceId(activity.activityId, binding.key) || value.componentId !== manifest.componentId
      || value.version !== manifest.version || value.definitionDigest !== definition.digest || value.stateVersion !== manifest.stateVersion
      || !acceptsState(manifest.stateShape, value.content)) throw new StorageError('invalid');
  }
}
