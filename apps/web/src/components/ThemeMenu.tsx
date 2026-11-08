import { ThemeMenu as ThemeMenuView } from '@xunjie/ui/foundation'
import { setThemePreference, useTheme } from '../lib/theme'

export function ThemeMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { preference } = useTheme()
  return <ThemeMenuView open={open} preference={preference} onChange={setThemePreference} onClose={onClose} />
}
