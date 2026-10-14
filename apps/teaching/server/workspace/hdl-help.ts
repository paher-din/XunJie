import type { Transaction } from '../db/transaction.ts';
import type { ActorContext } from '../../contracts/access/index.ts';
import type { HdlHelpSelection } from '../../contracts/workspace/hdl-help.ts';
import type { AuthorizedHdlHelpContext } from '../../contracts/tutoring/index.ts';
import type { HdlBuild } from '../../contracts/runner/hdl.ts';
import { readHdlBuild,readHdlSession,readHdlOperation } from './hdl.ts';
import { readActivity } from '../design/activities.ts';
import { readAttempt,readJobs } from '../db/records-adapter.ts';
import { canonical } from '../records/commands.ts';
import { configurationHash } from '../../runner/hdl-profile.ts';
import { ApiError } from '../app/errors.ts';

// Called only inside the caller's authorization transaction; no network or model access.
export function readAuthorizedHdlHelp(tx:Transaction,actor:ActorContext,attemptId:string,selection:HdlHelpSelection,generation:string):AuthorizedHdlHelpContext {
  const attempt=readAttempt(tx,attemptId),stored=readHdlBuild(tx,actor,selection.buildId),build=stored.result;
  const activity=readActivity(tx,actor.courseId,attempt.activityVersionId),runtime=activity.runtimeProfile;
  const job=readJobs(tx,actor.courseId).find(value=>value.jobId===stored.jobId);
  if(!('kind' in runtime)||!build||!job||job.stopRequested||!['succeeded','failed'].includes(job.status)
    ||!['succeeded','failed'].includes(build.status)||!build.terminationConfirmed
    ||build.identity.scope.attemptId!==attemptId||build.identity.scope.courseId!==actor.courseId
    ||build.identity.scope.studentId!==attempt.studentId||build.identity.scope.activityVersionId!==attempt.activityVersionId
    ||build.identity.recoveryGeneration!==generation||build.snapshotId!==selection.snapshotId
    ||build.snapshotHash!==stored.request.snapshot.hash||canonical(build.board)!==canonical(runtime.configuration.board)
    ||build.configurationHash!==configurationHash(runtime.configuration.board)
    ||build.runtimeProfileVersion!==runtime.configuration.runtime.runtimeProfileVersion
    ||build.engineVersion!==runtime.configuration.runtime.engineVersion||build.imageDigest!==runtime.configuration.runtime.buildImage)
    throw new ApiError('INVALID_REFERENCE');
  const normalized:HdlBuild=JSON.parse(JSON.stringify(build));
  const context:AuthorizedHdlHelpContext={workspaceRevision:attempt.workspaceRevision,snapshotId:selection.snapshotId,snapshotHash:build.snapshotHash,build:normalized};
  if(selection.sessionId){
    const session=readHdlSession(tx,actor,selection.sessionId);
    if(build.status!=='succeeded'||session.buildId!==build.buildId||session.snapshotId!==build.snapshotId||session.snapshotHash!==build.snapshotHash
      ||session.identity.recoveryGeneration!==generation||canonical(session.identity.scope)!==canonical(build.identity.scope)
      ||session.status!=='active'||session.stopRequested||session.terminationConfirmed||session.pendingOperationId
      ||session.boardProfileVersion!==build.board.boardProfileVersion||session.mappingVersion!==build.board.mappingVersion
      ||session.runtimeProfileVersion!==build.runtimeProfileVersion||session.engineVersion!==build.engineVersion)
      throw new ApiError('STATE_CONFLICT');
    context.session=session;
    if(selection.operationId){
      const operation=readHdlOperation(tx,actor,selection.operationId);
      if(!operation.result||operation.status!=='succeeded'||operation.sessionId!==session.sessionId
        ||operation.result.sequence!==session.confirmedSequence||operation.result.sessionRevision!==session.sessionRevision
        ||operation.result.finalFrame.simTimePs!==session.simTimePs)throw new ApiError('STATE_CONFLICT');
      context.operation=operation.result;
    }
  }else if(selection.operationId)throw new ApiError('INVALID_REFERENCE');
  return context;
}
