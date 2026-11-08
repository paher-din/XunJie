import { SproutMascot } from '../brand/SproutMascot'
import type { SproutMascotProps } from '../brand/SproutMascot'

/** 已确认的双叶芽平面形象；首页与工作区共用轮廓、五官与道具。 */
export function MascotSvg({ motion = 'idle', ...props }: SproutMascotProps) {
  return <SproutMascot motion={motion} {...props} />
}
