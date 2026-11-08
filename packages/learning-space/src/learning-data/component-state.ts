import { matchesComponentState, componentStateName } from '@xunjie/contracts/components';
import type { LearningActivity, WorkFile } from '@xunjie/contracts/learning-data';
import { teachingArtifactRevisionSchema } from '@xunjie/contracts/teaching-artifacts';
import { StorageError, type OwnedStorage } from '@xunjie/storage';

/** The current binding gates writes; retained revisions validate immutable historical state. */
export async function validateComponentFiles(activity: LearningActivity, files: WorkFile[], storage?: Pick<OwnedStorage, 'read'>, historical = false) {
  for (const file of files) {
    let binding = activity.course?.components?.find(item => componentStateName(item.key) === file.name);
    if (!binding && storage && file.name.startsWith('components/artifact-')) {
      let state: { componentId?: string; version?: number };
      try { state = JSON.parse(file.value); } catch { throw new StorageError('invalid'); }
      const { rows } = await storage.read(`SELECT r.body,a.body AS artifact FROM teaching_artifact_revisions r
        JOIN teaching_artifacts a USING(artifact_id) WHERE a.activity_id=$1 AND r.artifact_id=$2 AND r.version=$3`,
        [activity.activityId, state.componentId, state.version]);
      for (const row of rows) {
        const revision = teachingArtifactRevisionSchema.parse(row.body), artifact = row.artifact as { activeRevisionId: string | null };
        if ((historical || artifact.activeRevisionId === revision.revisionId) && componentStateName(revision.binding.key) === file.name) binding = revision.binding;
      }
    }
    if (file.mediaType !== 'application/vnd.xunjie.component-state+json' && !binding) continue;
    if (!binding || !matchesComponentState(binding, activity.activityId, file)) throw new StorageError('invalid');
  }
  if (storage && !historical) {
    const { rows } = await storage.read("SELECT body FROM teaching_artifacts WHERE activity_id=$1 AND body->>'activeRevisionId' IS NOT NULL", [activity.activityId]);
    for (const row of rows) {
      const artifact = row.body as { artifactId: string };
      if (!files.some(file => file.name === componentStateName(`artifact-${artifact.artifactId}`))) throw new StorageError('invalid');
    }
  }
}
