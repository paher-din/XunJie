import { useNavigate } from 'react-router-dom'
import { ProfileCard as ProfileCardView } from '@xunjie/ui/foundation'
import type { IconName } from '@xunjie/ui/icons'
import { useAccount } from '../lib/account'
import { useSettings } from '../lib/settings'
import { AccountAvatar } from './AccountAvatar'

const IDENT: Array<[string, string]> = [
  ['学号', '2026010817'], ['院系', '数字技术学院'], ['专业', '计算机科学'],
]
const ACCOUNT: Array<[string, string]> = [
  ['学习空间', '本地学习空间'], ['有效期', '2026.09 – 2027.07'], ['加入日期', '2026-09-01'],
]
const RECORDS: Array<{ n: string; unit: string; label: [string, string]; icon: IconName }> = [
  { n: '3', unit: '件', label: ['个人项目', '作品'], icon: 'folder-with-files' },
  { n: '2', unit: '条', label: ['教师', '反馈'], icon: 'chat-square-line' },
  { n: '47', unit: '次', label: ['Agent ', '学习问答'], icon: 'chat-round-question-mark' },
]

/** 旧版演示数据与路由适配；资料卡由正式组件库提供。 */
export function ProfileCard({ open, onClose, onAction }: { open: boolean; onClose: () => void; onAction: (msg: string) => void }) {
  const navigate = useNavigate()
  const { name } = useAccount()
  const { portrait } = useSettings()
  const go = (path: string) => { onClose(); navigate(path) }
  return <ProfileCardView open={open} name={name} avatar={<AccountAvatar />} roleLabel="学生" term="2026 秋季学期"
    roleDetails={['数字技术学院', '计算机科学', '2026 级']} identity={IDENT} accountFacts={ACCOUNT}
    accountLabel="本机账户" portrait={portrait} records={RECORDS} onClose={onClose}
    onLogout={() => { onClose(); onAction('退出登录将在后续版本提供') }}
    onAccountSettings={() => go('/settings/account')} onEditProfile={() => go('/settings/portrait')} />
}
