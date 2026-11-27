/** 对话加载骨架：只给形状，不使用任何“正在打开…”文字。 */
export function ConversationSkeleton() {
  return <div className="conversation-skeleton" role="status" aria-label="正在准备课程对话">
    <span className="conversation-skeleton-row is-user" aria-hidden="true" />
    <span className="conversation-skeleton-row is-wide" aria-hidden="true" />
    <span className="conversation-skeleton-row is-mid" aria-hidden="true" />
    <span className="conversation-skeleton-row is-short" aria-hidden="true" />
  </div>
}
