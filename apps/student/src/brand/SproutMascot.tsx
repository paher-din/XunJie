import { useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import registration from '../../public/brand/sprout/registration.json'
import accessories from '../../public/brand/sprout/accessories/registration.json'
import rig from '../../public/brand/sprout/rig/registration.json'
import eyes from '../../public/brand/sprout/rig/eye-masks.json'
import type { SproutExpression, SproutMotion, SproutTool } from './artwork'
import { poseTransforms, REST } from './motion'
import { useSproutAnimation } from './useSproutAnimation'
import './brand.css'

export interface SproutMascotProps {
  expression?: SproutExpression
  tool?: SproutTool
  motion?: SproutMotion
  label?: string
  className?: string
  /** Replay a finite response without remounting the character or resetting its idle clock. */
  replay?: number
  /** Review controls; omitted in product use. */
  previewTime?: number
  speed?: number
  paused?: boolean
}
const ASSETS = `${import.meta.env.BASE_URL}brand/sprout/`
const decoded = new Map<string, Promise<boolean>>()
function prepare(source: string) {
  if (!decoded.has(source)) {
    const image = new Image()
    image.src = ASSETS + source
    decoded.set(source, image.decode().then(() => true).catch(() => { decoded.delete(source); return false }))
  }
  return decoded.get(source)!
}
const PARTS = {
  handLeft: 'M233 808C230 754 279 730 323 741C370 749 399 771 399 814C400 856 368 881 320 881C269 882 234 851 233 808Z',
  handRight: 'M916 924C916 881 955 861 997 864C1036 865 1072 891 1072 929C1072 969 1036 992 990 991C945 989 916 964 916 924Z',
  footLeft: 'M434 1090C478 1080 558 1090 607 1127C633 1154 603 1209 535 1208C471 1207 441 1188 434 1156Z',
  footRight: 'M666 1118C715 1108 815 1097 845 1131C877 1167 851 1212 789 1212C717 1211 692 1198 680 1174Z',
  leafLeft: 'M310 175L661 175L676 330L684 360L691 379L701 397L710 420L714 433L691 432L650 414L300 416Z',
  leafRight: 'M680 65L1000 65L1000 410L744 437L714 437L704 410L699 390L691 365L680 350Z',
}
const NEUTRAL = poseTransforms(REST)

export function SproutMascot({ expression = 'idle', tool = 'none', motion = 'none', label, className = '', replay = 0, previewTime, speed = 1, paused = false }: SproutMascotProps) {
  const prefix = `sprout-${useId().replaceAll(':', '')}`
  const [shownTool, setShownTool] = useState<SproutTool>('none')
  const [ready, setReady] = useState(false)
  // 换装相位：新道具先进场（透明 + 眼镜从下方升起），旧道具反向淡出后再卸载。
  const [entered, setEntered] = useState(true)
  const [leavingTool, setLeavingTool] = useState<SproutTool | null>(null)
  const previousShownTool = useRef<SproutTool>('none')
  useEffect(() => {
    let current = true
    void Promise.all([prepare('master.png'), prepare(`rig/${rig.source}`), ...accessories.poses[tool].map(layer => prepare(`accessories/${layer.source}`))])
      .then(loaded => { if (current && loaded.every(Boolean)) { setShownTool(tool); setReady(true) } })
    return () => { current = false }
  }, [tool])
  useEffect(() => {
    if (!ready || shownTool === previousShownTool.current) return
    const previous = previousShownTool.current
    previousShownTool.current = shownTool
    setEntered(false)
    const fadeIn = setTimeout(() => setEntered(true), 40)
    let fadeOut: ReturnType<typeof setTimeout> | undefined
    if (previous !== 'none') {
      setLeavingTool(previous)
      fadeOut = setTimeout(() => setLeavingTool(null), 420)
    }
    return () => { clearTimeout(fadeIn); if (fadeOut) clearTimeout(fadeOut) }
  }, [shownTool, ready])
  const { svgRef, bind } = useSproutAnimation({ motion, tool: shownTool, ready, replay, previewTime, speed, paused })
  const subject = registration.poses.none
  const layers = accessories.poses[shownTool]
  const leavingLayers = leavingTool ? accessories.poses[leavingTool] : []
  const picture = <image href={ASSETS + subject.source} width="1254" height="1254" />
  const plate = <image href={ASSETS + `rig/${rig.source}`} width={rig.width} height={rig.height} transform={`matrix(${rig.matrix.join(' ')})`} />
  // The original diagonal color seam exaggerates the lean. Rebalance only this
  // band with the source palette; leave the silhouette and all original parts intact.
  // Counter-rotate the division so its edge contacts are level in the neutral stance.
  const colorDivision = <g mask={`url(#${prefix}-division-band)`}>
    <rect width="1254" height="1254" fill="#98a4ea" />
    <path transform={`rotate(${-rig.neutralRotation} ${rig.pivot.join(' ')})`} d="M-200 -200H1500V850H1020Q660 935 270 850H-200Z" fill="#b0b8ef" />
  </g>
  const original = (clip: string) => <g clipPath={`url(#${prefix}-${clip})`}><g mask={`url(#${prefix}-subject)`}>{picture}</g></g>
  // 与骨架 equip 下探-亮出同拍：旧道具在下探段淡出，新道具在亮出段淡入；
  // 眼镜绑在脸上，额外从下方升起到眼位。CSS 过渡负责插值，减少动效时瞬时切换。
  const propStyle = (layer: typeof layers[number], phase: 'enter' | 'idle' | 'leave'): CSSProperties => ({
    opacity: phase === 'idle' ? 1 : 0,
    transform: layer.hand === 'none' && phase !== 'idle' ? 'translateY(150px)' : undefined,
    transitionDelay: phase === 'idle' ? '240ms' : '0ms',
  })
  const prop = (layer: typeof layers[number], index: number, phase: 'enter' | 'idle' | 'leave') => (
    <g key={`${phase}-${index}`} data-accessory={layer.source} style={propStyle(layer, phase)}>
      <g transform={`matrix(${layer.matrix.join(' ')})`}>
        <g mask={`url(#${prefix}-prop-${phase === 'leave' ? 'out' : 'in'}-${index})`}><image href={ASSETS + 'accessories/' + layer.source} width={layer.width} height={layer.height} /></g>
      </g>
    </g>
  )
  const propsFor = (hand: string) => <>
    {layers.map((layer, index) => layer.hand === hand ? prop(layer, index, entered ? 'idle' : 'enter') : null)}
    {leavingLayers.map((layer, index) => layer.hand === hand ? prop(layer, index, 'leave') : null)}
  </>
  return (
    <svg ref={svgRef} viewBox="0 0 1000 1200" className={`sprout-mascot ${className}`.trim()}
      data-motion={motion} data-expression={expression} data-tool={shownTool} data-rig-ready={ready}
      role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <defs>
        <mask id={`${prefix}-subject`} maskUnits="userSpaceOnUse" x="0" y="0" width="1254" height="1254"><path d={subject.mask} fill="white" /></mask>
        <linearGradient id={`${prefix}-division-fade`} x1="0" y1="630" x2="0" y2="1010" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="white" stopOpacity="0" /><stop offset=".1053" stopColor="white" />
          <stop offset=".8947" stopColor="white" /><stop offset="1" stopColor="white" stopOpacity="0" />
        </linearGradient>
        <mask id={`${prefix}-division-band`} maskUnits="userSpaceOnUse" x="0" y="0" width="1254" height="1254"><rect y="630" width="1254" height="380" fill={`url(#${prefix}-division-fade)`} /></mask>
        <mask id={`${prefix}-plate`} maskUnits="userSpaceOnUse" x="0" y="0" width="1254" height="1254" style={{ maskType: 'alpha' }}>{plate}</mask>
        <mask id={`${prefix}-torso`} maskUnits="userSpaceOnUse" x="0" y="0" width="1254" height="1254">
          <path d={subject.mask} fill="white" /><rect width="1254" height="419" fill="black" />
          {['handLeft', 'handRight', 'footLeft', 'footRight'].map(part => <path key={part} d={PARTS[part as keyof typeof PARTS]} fill="black" />)}
          <path d={eyes.eyeLeft} fill="black" /><path d={eyes.eyeRight} fill="black" />
        </mask>
        {Object.entries(PARTS).map(([part, path]) => <clipPath key={part} id={`${prefix}-${part}`}><path d={path} /></clipPath>)}
        {Object.entries(eyes).map(([part, path]) => <clipPath key={part} id={`${prefix}-${part}`}><path d={path} /></clipPath>)}
        <clipPath id={`${prefix}-stem`}><ellipse cx="710" cy="437" rx="25" ry="20" /></clipPath>
        <clipPath id={`${prefix}-body`}><rect y="419" width="1254" height="728" /></clipPath>
        <clipPath id={`${prefix}-mouth`}><rect x="619" y="768" width="102" height="59" /></clipPath>
        {layers.map((layer, index) => <mask key={`in-${index}`} id={`${prefix}-prop-in-${index}`} maskUnits="userSpaceOnUse" x="0" y="0" width={layer.width} height={layer.height}><path d={layer.mask} fill="white" /></mask>)}
        {leavingLayers.map((layer, index) => <mask key={`out-${index}`} id={`${prefix}-prop-out-${index}`} maskUnits="userSpaceOnUse" x="0" y="0" width={layer.width} height={layer.height}><path d={layer.mask} fill="white" /></mask>)}
      </defs>
      <g transform="translate(-148 -45)"><g transform={`rotate(${rig.neutralRotation} ${rig.pivot.join(' ')})`}>
        <g ref={bind.root} data-part="root" transform={NEUTRAL.root}>
          {ready ? <>
            <g ref={bind.torso} data-part="torso" transform={NEUTRAL.torso}>
              <g mask={`url(#${prefix}-subject)`} clipPath={`url(#${prefix}-body)`}>
                {plate}<g mask={`url(#${prefix}-plate)`}>{colorDivision}</g>
              </g>
              <g mask={`url(#${prefix}-torso)`}>{picture}{colorDivision}</g>
              {original('mouth')}
              {/* Reuse the original, unobstructed forehead texture beneath the lids. */}
              <g clipPath={`url(#${prefix}-eyeLeft)`}><image href={ASSETS + subject.source} width="1254" height="1254" transform="translate(0 100)" /></g>
              <g clipPath={`url(#${prefix}-eyeRight)`}><image href={ASSETS + subject.source} width="1254" height="1254" transform="translate(0 160)" /></g>
              <g ref={bind.stem} data-part="stem" transform={NEUTRAL.stem}>
                {original('stem')}
                <g ref={bind.leafLeft} data-part="leafLeft" transform={NEUTRAL.leafLeft}>{original('leafLeft')}</g>
                <g ref={bind.leafRight} data-part="leafRight" transform={NEUTRAL.leafRight}>{original('leafRight')}</g>
              </g>
              <g ref={bind.face} data-part="face" transform={NEUTRAL.face}>
                <g ref={bind.eyeLeft} data-part="eyeLeft" transform={NEUTRAL.eyeLeft}>{original('eyeLeft')}</g>
                <g ref={bind.eyeRight} data-part="eyeRight" transform={NEUTRAL.eyeRight}>{original('eyeRight')}</g>
                {propsFor('none')}
              </g>
              <g ref={bind.handLeft} data-part="handLeft" transform={NEUTRAL.handLeft}>{propsFor('left')}{original('handLeft')}</g>
              <g ref={bind.handRight} data-part="handRight" transform={NEUTRAL.handRight}>{propsFor('right')}{original('handRight')}</g>
            </g>
            <g transform="translate(0 -11)"><g ref={bind.footLeft} data-part="footLeft" transform={NEUTRAL.footLeft}>{original('footLeft')}</g></g>
            <g transform="translate(0 12)"><g ref={bind.footRight} data-part="footRight" transform={NEUTRAL.footRight}>{original('footRight')}</g></g>
          </> : <g mask={`url(#${prefix}-subject)`}>{picture}</g>}
        </g>
      </g></g>
    </svg>
  )
}

export { XunjieLogo } from './XunjieLogo'
