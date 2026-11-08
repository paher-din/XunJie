export function ProgressBar({ percent, done }: { percent: number; done?: boolean }) {
  return (
    <div className="progress">
      <span className={done ? 'done' : ''} style={{ width: percent + '%' }} />
    </div>
  )
}
