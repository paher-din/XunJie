import { matchesComponentState, componentStateName } from '@xunjie/contracts/components';
import type { LearningActivity, WorkFile } from '@xunjie/contracts/learning-data';
import { StorageError } from '@xunjie/storage';

/** An imported view never defines its own permissions or a second state owner. */
export function validateComponentFiles(activity: LearningActivity, files: WorkFile[]) {
  for (const file of files) {
    const binding = activity.course?.components?.find(item => componentStateName(item.key) === file.name);
    if (file.mediaType !== 'application/vnd.xunjie.component-state+json' && !binding) continue;
    if (!binding || !matchesComponentState(binding, activity.activityId, file)) throw new StorageError('invalid');
  }
}
