import { forwardRef, type ComponentProps } from 'react'
import { Button as AstryxButton } from '@astryxdesign/core/Button'
import '@astryxdesign/core/astryx.css'
import './destructive-button.css'

export type DestructiveButtonProps = Omit<ComponentProps<typeof AstryxButton>, 'variant' | 'size' | 'isDisabled' | 'ref'> & {
  disabled?: boolean
}

/** Astryx destructive button with XunJie's sizing and theme tokens. */
export const DestructiveButton = forwardRef<HTMLButtonElement, DestructiveButtonProps>(function DestructiveButton(
  { disabled, className, ...props }, ref,
) {
  return <AstryxButton {...props} ref={ref} variant="destructive" size="md" isDisabled={disabled}
    className={['xj-destructive-button', className].filter(Boolean).join(' ')} />
})
