import type { Ref } from 'react'
import { CodeWorkspace as CodeWorkspaceView, StatusBar as StatusBarView, CodeRunCluster as CodeRunClusterView,
  type CodeWorkspaceDisplay, type CodeEditorHandle, type CodeSelectionResult } from '@xunjie/ui/workspace'
import type { ProjectWorkspace } from './useProjectWorkspace'
import type { ProjectFile } from '../../bridge/types'
import { recycleProblem, restoreProblem, lifecycleProblemMessage } from '../../workspace/fileLifecycle'
import type { useEditorDiagnostics } from '../../workspace/useEditorDiagnostics'
export { ProtectionChip } from '@xunjie/ui/workspace'

export interface CodeWorkspaceProps {
  ws: ProjectWorkspace
  workspaceKey: string
  editorHandleRef?: Ref<CodeEditorHandle>
  onSelectionChange?: (result: CodeSelectionResult) => void
  diagnostics?: ReturnType<typeof useEditorDiagnostics>
}

/** Legacy domain adapter; all visual implementation is owned by @xunjie/ui. */
export function CodeWorkspace({ ws, ...props }: CodeWorkspaceProps) {
  const state: CodeWorkspaceDisplay = {
    loaded: ws.loaded, files: ws.files, openFiles: ws.openFiles, activeFile: ws.activeFile,
    access: ws.access, protection: ws.protection, usage: ws.usage,
    createdFileIds: ws.files.filter(ws.isCreated).map(file => file.fileId),
    dirtyFileIds: ws.files.filter(ws.isDirty).map(file => file.fileId),
    fileActions: Object.fromEntries(ws.files.map(file => {
      const recycle = recycleProblem(file, ws.access)
      const restore = restoreProblem(file, ws.files, ws.access)
      return [file.fileId, {
        recycleBlockedReason: recycle === null ? null : lifecycleProblemMessage(recycle, file.path, null),
        restoreBlockedReason: restore.problem === null ? null : lifecycleProblemMessage(restore.problem, file.path, restore.occupant?.path ?? null),
        occupant: restore.occupant,
      }]
    })),
  }
  return <CodeWorkspaceView {...props} state={state} text={ws.activeFile === null ? '' : ws.draftText(ws.activeFile.fileId)}
    onOpen={ws.open} onCloseTab={ws.closeTab} onCreate={name => ws.create(name, '')}
    onDraftChange={ws.setDraft} onRecycle={ws.recycle} onRestore={ws.restore} />
}

export function StatusBar({ file, ws, cursor, text }: {
  file: ProjectFile | null; ws: ProjectWorkspace; cursor: { line: number; column: number } | null; text: string
}) {
  return <StatusBarView file={file} created={file !== null && ws.isCreated(file)} dirty={file !== null && ws.isDirty(file)}
    loaded={ws.loaded} protection={ws.protection} cursor={cursor} text={text} />
}
export function CodeRunCluster({ ws, onSave }: { ws: ProjectWorkspace; onSave: () => void }) {
  return <CodeRunClusterView access={ws.access} lifecyclePendingCount={ws.lifecyclePendingCount}
    unconfirmedCount={ws.unconfirmedCount} confirmedRevision={ws.confirmedRevision} onSave={onSave} />
}
