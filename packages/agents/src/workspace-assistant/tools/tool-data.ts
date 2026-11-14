import type { createLearningData } from '@xunjie/learning-space/learning-data';

type Data = ReturnType<typeof createLearningData>;
/** The Agent reads the actual learning owner; it owns neither a duplicate workspace nor a data coordinator. */
export type TeachingToolData = {
  open: Data['open'];
  works: Pick<Data['works'], 'content' | 'inspectVersion'>;
  drafts: Pick<Data['drafts'], 'verifyReferences'>;
  pdf: Pick<Data['pdf'], 'read' | 'reading' | 'find'>;
  materials: Pick<Data['materials'], 'readRange'>;
  search: Data['search'];
  artifacts: Pick<Data['artifacts'], 'publish' | 'list' | 'read' | 'receipt' | 'revision'>;
  executions: Pick<Data['executions'], 'read' | 'artifact' | 'controlReceipt'> & {
    agent: Pick<Data['executions']['agent'], 'dispatch' | 'control' | 'original' | 'read' | 'status' | 'cleanupStatus' | 'cleanup'>;
  };
};
