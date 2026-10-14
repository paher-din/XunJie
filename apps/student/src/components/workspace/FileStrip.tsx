import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Icon, type IconName } from '../../icons'
import type { ProjectFile } from '../../bridge/types'
import {
  WORKSPACE_LIMITS,
  formatBytes,
  languageOf,
  problemMessage,
  type CreateOutcome,
} from '../../lib/projectFiles'
import { lifecycleProblemMessage } from '../../workspace/fileLifecycle'

/**
 * 文件条：已打开的文件标签 + 全部文件列表；新建入口在列表底部，
 * 点它就地变成命名框（IDE 的行内命名），不弹模态窗、不要填路径。
 *
 * 这是「文件操作组件」落在既有中心容器里的最小形态——不新增页面或导航，工具标签
 * （设计 / 虚拟板 / 波形）仍然是课程工具包声明的那几枚，文件标签只在工具内部。
 *
 * 关标签只关视图，文件实例还在项目里（从「文件」列表可以再打开）；回收/恢复是**本机意图**，
 * 入口在文件列表的行内动作区，真正的业务命令随下一次「确认保存」发出，界面对未确认的意图
 * 如实标注，不冒充已生效（05 设计决定第 4 条）。
 */

function fileIcon(path: string): IconName {
  const language = languageOf(path)
  return language === 'plaintext' || language === 'markdown' ? 'file-text' : 'file-code'
}

function splitPath(path: string): { dir: string; base: string } {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? { dir: '', base: path } : { dir: `${path.slice(0, slash + 1)}`, base: path.slice(slash + 1) }
}

export interface FileStripHandle {
  /** 打开列表并直接进入行内命名（空工作区的「新建文件」按钮用）。 */
  startNaming: () => void
}

export interface FileStripProps {
  /** 项目里期望 active 的文件。 */
  files: ProjectFile[]
  /** 期望 recycled 的实例（含待确认回收）：草稿与历史仍保留，等学生明确恢复或下一次确认。 */
  recycledFiles: ProjectFile[]
  openFiles: ProjectFile[]
  activeFileId: string | null
  isDirty: (file: ProjectFile) => boolean
  isCreated: (file: ProjectFile) => boolean
  /** 期望生命周期与最近确认不一致（含本机新建）：行内标「待确认」。 */
  lifecyclePending: (file: ProjectFile) => boolean
  canCreate: boolean
  /** 不可新建时的原因，作为入口提示。 */
  createBlockedReason: string | null
  /** 当前作品是否允许回收/恢复（暂停、终态、只读都不允许）。 */
  canManage: boolean
  /** 项目级不可回收/恢复的原因（暂停、只读），作区标题下的说明。 */
  manageBlockedReason: string | null
  /** 这个实例不能回收的原因；null = 可以回收。 */
  recycleBlockedReason: (file: ProjectFile) => string | null
  /** 这个实例不能恢复的原因；null = 可以恢复。 */
  restoreBlockedReason: (file: ProjectFile) => string | null
  /** 占用这个实例路径的另一个期望 active 实例；有它就在行内说清先去哪一行回收。 */
  restoreOccupant: (file: ProjectFile) => ProjectFile | null
  /** 当前 active 文件数与正文总量，命名框下方给读数。 */
  usage: { activeFiles: number; activeBytes: number }
  menuOpen: boolean
  onMenuOpenChange: (open: boolean) => void
  onOpen: (fileId: string) => void
  onClose: (fileId: string) => void
  onCreate: (name: string) => CreateOutcome
  onRecycle: (fileId: string) => void
  onRestore: (fileId: string) => void
}

export const FileStrip = forwardRef<FileStripHandle, FileStripProps>(function FileStrip({
  files,
  recycledFiles,
  openFiles,
  activeFileId,
  isDirty,
  isCreated,
  lifecyclePending,
  canCreate,
  createBlockedReason,
  canManage,
  manageBlockedReason,
  recycleBlockedReason,
  restoreBlockedReason,
  restoreOccupant,
  usage,
  menuOpen,
  onMenuOpenChange,
  onOpen,
  onClose,
  onCreate,
  onRecycle,
  onRestore,
}: FileStripProps, ref) {
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)

  useImperativeHandle(ref, () => ({
    startNaming: () => {
      onMenuOpenChange(true)
      setName('')
      setError(null)
      setNaming(true)
    },
  }))

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) {
        onMenuOpenChange(false)
        setNaming(false)
        setError(null)
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onMenuOpenChange(false)
        setNaming(false)
        setError(null)
        menuButtonRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen, onMenuOpenChange])

  useEffect(() => {
    if (naming) inputRef.current?.focus()
  }, [naming])

  function startNaming() {
    setName('')
    setError(null)
    setNaming(true)
  }

  function cancelNaming() {
    setNaming(false)
    setError(null)
  }

  function submitName() {
    const outcome = onCreate(name)
    if (!outcome.ok) {
      setError(problemMessage(outcome.problem))
      return
    }
    cancelNaming()
    onMenuOpenChange(false)
  }

  return (
    <div className="cw-filestrip">
      <div className="cw-filelist" ref={wrapRef}>
        <button
          ref={menuButtonRef}
          type="button"
          className="cw-stripbtn"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => {
            if (menuOpen) cancelNaming()
            onMenuOpenChange(!menuOpen)
          }}
        >
          <Icon name="folder-with-files" size={15} tone="neutral" />
          <span>文件</span>
          <b>{files.length}</b>
        </button>
        {menuOpen && (
          <div className="cw-filemenu" role="menu" aria-label="项目文件">
            {files.length === 0 && recycledFiles.length === 0 && <p className="cw-filemenu-empty">这个项目还没有文件</p>}
            {files.map((file) => {
              const recycleBlocked = recycleBlockedReason(file)
              return (
                // 行容器本身不参与可访问性树：里面是「打开」与「回收」两个平级按钮，
                // 不做嵌套交互元素，键盘也能分别到达；身份挂在行上供定位。
                <div
                  key={file.fileId}
                  className={file.fileId === activeFileId ? 'cw-filemenu-row active' : 'cw-filemenu-row'}
                  role="presentation"
                  data-fileid={file.fileId}
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="cw-filemenu-open"
                    onClick={() => {
                      onOpen(file.fileId)
                      onMenuOpenChange(false)
                    }}
                  >
                    <Icon name={fileIcon(file.path)} size={15} tone="neutral" />
                    <span className="cw-filemenu-path">{file.path}</span>
                    {isCreated(file) ? (
                      <span className="cw-tag-new">新建</span>
                    ) : (
                      isDirty(file) && <i className="cw-dot" title="有未确认修改" />
                    )}
                    {file.confirmed !== null && lifecyclePending(file) && <span className="cw-tag-pending">待确认恢复</span>}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="cw-filemenu-recycle"
                    aria-label={`回收 ${file.path}`}
                    disabled={recycleBlocked !== null}
                    title={recycleBlocked ?? undefined}
                    onClick={() => onRecycle(file.fileId)}
                  >
                    回收
                  </button>
                </div>
              )
            })}

            {recycledFiles.length > 0 && (
              <div className="cw-filerecycled">
                <p className="cw-filerecycled-title">已回收的实例</p>
                {!canManage && manageBlockedReason !== null && <p className="cw-lifecycle-blocked">{manageBlockedReason}</p>}
                {recycledFiles.map((file) => {
                  const restoreBlocked = restoreBlockedReason(file)
                  const occupant = restoreOccupant(file)
                  return (
                    <div key={file.fileId} className="cw-filerecycled-row" data-fileid={file.fileId}>
                      <Icon name={fileIcon(file.path)} size={15} tone="neutral" />
                      <span className="cw-filemenu-path">{file.path}</span>
                      {lifecyclePending(file) && <span className="cw-tag-pending">待确认回收</span>}
                      <button
                        type="button"
                        role="menuitem"
                        className="cw-filerecycled-restore"
                        aria-label={`恢复 ${file.path}`}
                        disabled={restoreBlocked !== null}
                        title={restoreBlocked ?? undefined}
                        onClick={() => onRestore(file.fileId)}
                      >
                        恢复
                      </button>
                      {occupant && (
                        <p className="cw-lifecycle-blocked">
                          {lifecycleProblemMessage('path-occupied', file.path, occupant.path)}
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            <div className="cw-filemenu-foot">
              {naming ? (
                <div className="cw-filemenu-new">
                  <input
                    ref={inputRef}
                    className={error ? 'cw-name-input invalid' : 'cw-name-input'}
                    value={name}
                    placeholder="例如 words.c"
                    autoComplete="off"
                    spellCheck={false}
                    aria-label="新文件名"
                    onChange={(event) => {
                      setError(null)
                      setName(event.target.value)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        submitName()
                      }
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        event.stopPropagation()
                        cancelNaming()
                      }
                    }}
                  />
                  <p className={error ? 'cw-name-error' : 'cw-name-quota'}>
                    {error ??
                      `active 文件 ${usage.activeFiles + 1} / ${WORKSPACE_LIMITS.maxActiveFiles} · 正文总量 ${formatBytes(usage.activeBytes)} / ${formatBytes(WORKSPACE_LIMITS.maxActiveBytes)}`}
                  </p>
                </div>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  className="cw-filemenu-row cw-filemenu-add"
                  onClick={startNaming}
                  disabled={!canCreate}
                  title={canCreate ? undefined : (createBlockedReason ?? '当前不能新建文件')}
                >
                  <Icon name="add" size={15} tone="neutral" />
                  <span>新建文件</span>
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="cw-filetabs" role="tablist" aria-label="已打开的文件">
        {openFiles.map((file) => {
          const { dir, base } = splitPath(file.path)
          const active = file.fileId === activeFileId
          return (
            // 标签盒本身不参与可访问性树：里面是「激活」与「关闭」两个平级按钮，
            // 不做嵌套交互元素，键盘也能分别到达
            <div key={file.fileId} className={active ? 'cw-filetab active' : 'cw-filetab'} role="presentation">
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className="cw-filetab-main"
                title={file.path}
                onClick={() => onOpen(file.fileId)}
              >
                <Icon name={fileIcon(file.path)} size={14} tone="neutral" />
                {dir && <span className="cw-filetab-dir">{dir}</span>}
                <span className="cw-filetab-name">{base}</span>
                {isCreated(file) ? <span className="cw-tag-new">新建</span> : isDirty(file) ? <i className="cw-dot" /> : null}
              </button>
              <button
                type="button"
                className="cw-filetab-x"
                aria-label={`关闭 ${file.path} 的标签`}
                title="关闭标签（文件仍在项目里）"
                onClick={() => onClose(file.fileId)}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          )
        })}
        {openFiles.length === 0 && <span className="cw-filetabs-empty">没有打开的文件</span>}
      </div>
    </div>
  )
})
